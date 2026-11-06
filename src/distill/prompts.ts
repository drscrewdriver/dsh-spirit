/**
 * 长觉的 prompt 单源与返回校验（v0.3.5）。
 *
 * 三条设计决定：
 * 1. **输入只给查表产物**：条目 id/text/gist + 结构化 fact 摘要——text 本来就是编译期
 *    查表产出的第一人称句，不含用户原文；`fact` 里最敏感的字段（用户话语引用）
 *    被 G20 断言排除在构造之外（红线：用户原文永不进 cues，也永不进 prompt 出境）。
 * 2. **输出是 JSON 契约，工程侧校验后落库**：模型永远不碰文件系统、不写状态位；
 *    evidence 必须 ⊆ 本批 id（幻觉证据直接整条丢弃），文本钳 120 字。
 * 3. **只在显式陈述因果时才写因果边**（姊妹包图谱投影的实战纪律：LLM 最爱把
 *    时间相邻脑补成因果——这里用 prompt 明说 + 校验侧要求 evidence 双端在场兜底）。
 */
import { EDGE_RELATION_MAX } from '../store/edges.js';
import { INSIGHT_TEXT_MAX } from '../store/insights.js';

export interface BatchEntry {
  id: string;
  text: string;
  gist: string | null;
  trigger: string;
  notice: string;
  /** 结构化事实的展示摘要（tool/路径 basename 等，绝不含用户话语引用字段）。 */
  factBits: string;
}

export interface ProposalTopic {
  name: string;
  entryIds: string[];
}
export interface ProposalInsight {
  topicName: string;
  text: string;
  evidenceIds: string[];
}
export interface ProposalEdge {
  from: string;
  to: string;
  relation: string;
  evidenceIds: string[];
  confidence: number;
}
export interface InductionResult {
  topics: ProposalTopic[];
  insights: ProposalInsight[];
  edges: ProposalEdge[];
}

export interface CollisionVerdict {
  /** 两条洞察 id。 */
  a: string;
  b: string;
  action: 'conflict' | 'duplicate';
}

const INDUCTION_SYSTEM = [
  '你在帮助一条记事鱼整理它的体验记忆。鱼记录的是它自己经历了什么（第一人称短句），不是客观事实清单。',
  '任务：读一批最近的体验条目，输出 JSON（只输出 JSON，不要解释文字）：',
  '{',
  '  "topics": [{"name": "主题名（≤16字，人话）", "entry_ids": ["条目id", ...]}],',
  '  "insights": [{"topic": "主题名", "text": "这个主题的一句话总结（≤60字，用鱼的口吻、第一人称视角）", "evidence": ["支撑该总结的条目id", ...]}],',
  '  "edges": [{"from": "条目id", "to": "条目id", "relation": "导致|因为|修复了|取代|（或一个≤8字的关系词）", "evidence": ["条目id", ...], "confidence": 0-1000}],',
  '}',
  '规则：',
  '- entry_ids / evidence 里只能出现我给你的条目 id，不许发明 id。',
  '- 只有条目内容**明确表现出**先后因果时才写 edge；时间相邻不等于因果。',
  '- 主题数量 ≤6 个，宁少勿滥；归不进主题的条目可以不进任何主题。',
  '- insight 是"这段时间的主线"级别的总结，不是条目复读。',
].join('\n');

const COLLISION_SYSTEM = [
  '你在帮助一条记事鱼检查它对同一件事的两笔记忆是否互相矛盾。',
  '任务：读若干洞察对（同主题下的新旧总结），输出 JSON（只输出 JSON）：',
  '{ "verdicts": [{"a": "第一条id", "b": "第二条id", "action": "conflict 或 duplicate"}] }',
  '规则：',
  '- conflict = 两笔账对不上（对同一件事给出相反/不兼容的判断），需要主人来裁决信哪条。',
  '- duplicate = 说的是同一件事、口径一致，只是表述不同。',
  '- 拿不准就不写这对（宁可漏判，不误判——机器绝不自动删记忆）。',
].join('\n');

function renderBatch(entries: readonly BatchEntry[]): string {
  return entries
    .map((entry) => {
      const gist = entry.gist === null || entry.gist === '' ? '' : ` ｜残句: ${entry.gist}`;
      const facts = entry.factBits === '' ? '' : ` ｜${entry.factBits}`;
      return `- [${entry.id}] (${entry.trigger}/${entry.notice}) ${entry.text}${gist}${facts}`;
    })
    .join('\n');
}

/** 归纳调用（调用#1）的 user 文本。 */
export function buildInductionUser(entries: readonly BatchEntry[], knownTopics: readonly string[]): string {
  const topicLine = knownTopics.length > 0 ? `已有主题（优先复用这些名字，别造同义词）：${knownTopics.join('、')}\n\n` : '';
  return `${topicLine}最近的体验条目：\n${renderBatch(entries)}`;
}

export const INDUCTION_PROMPT_SYSTEM = INDUCTION_SYSTEM;

/** 碰撞判定（调用#2）的 user 文本：新洞察 vs 同题既有洞察。 */
export function buildCollisionUser(pairs: ReadonlyArray<{ a: { id: string; text: string }; b: { id: string; text: string } }>): string {
  const lines = pairs.map((p) => `- a=[${p.a.id}] ${p.a.text}\n  b=[${p.b.id}] ${p.b.text}`);
  return `待检查的洞察对（同主题）：\n${lines.join('\n')}`;
}

export const COLLISION_PROMPT_SYSTEM = COLLISION_SYSTEM;

/** 宽容 JSON 提取：模型偶尔会在 JSON 前后包话，取第一个平衡的 { 到其配对 }。 */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
}

/**
 * 归纳输出校验：evidence/entry_ids ⊆ 本批、文本钳长度、confidence 钳区间。
 * 幻觉 id 整条丢弃（不部分采信：一条没有合法证据的"洞察"比没有更糟）。
 */
export function validateInduction(raw: Record<string, unknown> | null, batchIds: ReadonlySet<string>): InductionResult {
  const out: InductionResult = { topics: [], insights: [], edges: [] };
  if (raw === null) return out;
  if (Array.isArray(raw['topics'])) {
    for (const item of raw['topics'] as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const name = typeof o['name'] === 'string' ? o['name'].trim().slice(0, 40) : '';
      const ids = strArray(o['entry_ids'] ?? o['entryIds']).filter((id) => batchIds.has(id));
      if (name === '' || ids.length === 0) continue;
      out.topics.push({ name, entryIds: ids });
    }
  }
  if (Array.isArray(raw['insights'])) {
    for (const item of raw['insights'] as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const topic = typeof o['topic'] === 'string' ? o['topic'].trim().slice(0, 40) : '';
      const text = typeof o['text'] === 'string' ? o['text'].trim().slice(0, INSIGHT_TEXT_MAX) : '';
      const evidence = strArray(o['evidence'] ?? o['evidenceIds']).filter((id) => batchIds.has(id));
      if (topic === '' || text === '' || evidence.length === 0) continue;
      out.insights.push({ topicName: topic, text, evidenceIds: evidence });
    }
  }
  if (Array.isArray(raw['edges'])) {
    for (const item of raw['edges'] as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const from = typeof o['from'] === 'string' ? o['from'].trim() : '';
      const to = typeof o['to'] === 'string' ? o['to'].trim() : '';
      const relation = typeof o['relation'] === 'string' ? o['relation'].trim().slice(0, EDGE_RELATION_MAX) : '';
      const evidence = strArray(o['evidence'] ?? o['evidenceIds']).filter((id) => batchIds.has(id));
      // 双端必须在批内且不同；evidence 必须同时含双端（「边必须可解释」的最低门槛）
      if (!batchIds.has(from) || !batchIds.has(to) || from === to || relation === '') continue;
      if (!evidence.includes(from) || !evidence.includes(to)) continue;
      const confidence = typeof o['confidence'] === 'number' && Number.isFinite(o['confidence']) ? Math.max(0, Math.min(1000, Math.round(o['confidence']))) : 700;
      out.edges.push({ from, to, relation, evidenceIds: evidence.slice(0, 24), confidence });
    }
  }
  return out;
}

/** 碰撞输出校验：只认 conflict/duplicate 两判词，id 必须在给出的对里。 */
export function validateCollisions(raw: Record<string, unknown> | null, pairIds: ReadonlySet<string>): CollisionVerdict[] {
  const out: CollisionVerdict[] = [];
  if (raw === null || !Array.isArray(raw['verdicts'])) return out;
  for (const item of raw['verdicts'] as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const a = typeof o['a'] === 'string' ? o['a'].trim() : '';
    const b = typeof o['b'] === 'string' ? o['b'].trim() : '';
    const action = o['action'];
    if (a === '' || b === '' || a === b) continue;
    if (!pairIds.has(a) || !pairIds.has(b)) continue;
    if (action !== 'conflict' && action !== 'duplicate') continue;
    out.push({ a, b, action });
  }
  return out;
}
