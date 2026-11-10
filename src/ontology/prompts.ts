/**
 * 本体抽取的 prompt 单源与输出校验（Phase B / TB.1）。
 *
 * 三条纪律（照 transaction/prompts.ts 与 distill/prompts.ts 的先例）：
 * 1. **只从给定内容归纳，不得发明 key**：每行必须回指某轮信号 key；校验侧 evidence/relations 只认批内。
 * 2. **实体 kind 单源**：只允许 ENTITY_KINDS 五词；越界丢弃该行该实体（不猜、不扩表）。
 * 3. **输出是 JSON 契约，工程侧校验后落库**：模型不碰文件系统、不写状态；长度全钳。
 *
 * 原料是脱敏后的正文（userText/assistantText）+ 结构信号（todo/tool/path）——这是本体层与遥测轨的关键差别：
 * 本体要"有内容的交付"，所以喂正文；但正文已 dropIfSecret，且落库的是抽象 gist/entities 而非原文。
 */
import type { EntityKind } from '../types.js';
import { ENTITY_KINDS } from '../types.js';
import type { OntologySignals } from './watcher.js';

export interface OntologyLimits {
  maxGistChars: number;
  maxSummaryChars: number;
  maxEntities: number;
  maxRelations: number;
}

export const ENTITY_ROLES: readonly string[] = ['actor', 'subject', 'object'];
const TASK_STATUSES: readonly string[] = ['open', 'progress', 'stalled', 'done'];

export interface OntologyEntityRef {
  kind: EntityKind;
  name: string;
  role: string;
}
export interface OntologyRelationRef {
  from: string;
  to: string;
  relation: string;
}
export interface OntologyTaskRef {
  title: string;
  status: string;
  nextStep: string;
}
export interface OntologyProposalRow {
  key: string;
  gist: string;
  summary: string;
  entities: OntologyEntityRef[];
  relations: OntologyRelationRef[];
  task: OntologyTaskRef | null;
}

const ONTOLOGY_SYSTEM = [
  '你在帮一条记事鱼把它这一轮做的事整理成"工作记忆"：不是流水账，而是有内容的交付 + 涉及的实体 + 归属的任务线。',
  '读一批每轮信号（用户原话、助手做了什么、todo、用到的工具/文件），输出 JSON（只输出 JSON）：',
  '{',
  '  "rows": [{',
  '    "key": "对应信号的 key，必须原样回指，不许发明",',
  '    "gist": "这一轮交付了什么，≤40字，第一人称，具体到事（不是『跑了工具』这种空话）",',
  '    "summary": "更完整的交付摘要，≤240字",',
  '    "entities": [{"kind": "person|project|module|concept|resource", "name": "实体名", "role": "actor|subject|object"}],',
  '    "relations": [{"from": "实体name", "to": "实体name", "relation": "≤8字关系词"}],',
  '    "task": {"title": "所属任务线名", "status": "open|progress|stalled|done", "next_step": "下一步（没有就空串）"} 或 null',
  '  }]',
  '}',
  '规则：',
  '- key 只能来自我给你的信号；对不上就丢掉整行。',
  '- entities 的 kind 只能用那五个词；relations 的 from/to 必须是本行 entities 里出现过的 name。',
  '- 只归纳信号里明确有的东西，别脑补因果、别把没提的实体塞进来。宁少勿滥。',
  '- task 只在能明确判断归属时才给，判不准就 null。',
].join('\n');

export const ONTOLOGY_SUMMARY_SYSTEM = ONTOLOGY_SYSTEM;

/** 渲染一批信号给 LLM。 */
export function buildOntologyUser(batch: readonly OntologySignals[]): string {
  return batch.map((s) => {
    const lines = [`[key=${s.key}]`];
    if (s.userText !== '') lines.push(`用户: ${s.userText}`);
    if (s.assistantText !== '') lines.push(`助手: ${s.assistantText}`);
    if (s.todoTitles.length > 0) lines.push(`todo: ${s.todoTitles.join(' / ')}`);
    if (s.toolNames.length > 0) lines.push(`工具: ${s.toolNames.join(', ')}`);
    if (s.pathBases.length > 0) lines.push(`文件: ${s.pathBases.join(', ')}`);
    return lines.join('\n');
  }).join('\n\n');
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function clampStr(value: unknown, maxChars: number): string {
  return Array.from(str(value)).slice(0, maxChars).join('');
}

/**
 * 校验 LLM 输出：key⊆批、kind∈五词、role∈三档、relations 端点在本行 entities 内、长度钳、去重。
 * 幻觉 key / 越界 kind 的实体或整行直接丢（不部分采信半个身份）。
 */
export function validateOntologyOutput(
  raw: Record<string, unknown> | null,
  batchKeys: ReadonlySet<string>,
  limits: OntologyLimits,
): OntologyProposalRow[] {
  if (raw === null || !Array.isArray(raw['rows'])) return [];
  const out: OntologyProposalRow[] = [];
  for (const item of raw['rows'] as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const key = str(o['key']);
    if (key === '' || !batchKeys.has(key)) continue; // 幻觉 key ⇒ 丢整行
    const gist = clampStr(o['gist'], limits.maxGistChars);
    if (gist === '') continue; // 宁缺毋造：无 gist 的交付不落
    const summary = clampStr(o['summary'], limits.maxSummaryChars);

    const entities: OntologyEntityRef[] = [];
    const seenEntity = new Set<string>();
    const rawEntities = Array.isArray(o['entities']) ? o['entities'] : [];
    for (const e of rawEntities) {
      if (entities.length >= limits.maxEntities) break;
      if (typeof e !== 'object' || e === null) continue;
      const eo = e as Record<string, unknown>;
      const kind = str(eo['kind']);
      const name = clampStr(eo['name'], 60);
      const role = str(eo['role']);
      if (!(ENTITY_KINDS as readonly string[]).includes(kind)) continue; // 越界 kind ⇒ 丢该实体
      if (name === '' || !ENTITY_ROLES.includes(role)) continue;
      const dedupKey = `${kind}:${name.toLowerCase()}`;
      if (seenEntity.has(dedupKey)) continue;
      seenEntity.add(dedupKey);
      entities.push({ kind: kind as EntityKind, name, role });
    }

    const entityNames = new Set(entities.map((e) => e.name.toLowerCase()));
    const relations: OntologyRelationRef[] = [];
    const rawRelations = Array.isArray(o['relations']) ? o['relations'] : [];
    for (const r of rawRelations) {
      if (relations.length >= limits.maxRelations) break;
      if (typeof r !== 'object' || r === null) continue;
      const ro = r as Record<string, unknown>;
      const from = clampStr(ro['from'], 60);
      const to = clampStr(ro['to'], 60);
      const relation = clampStr(ro['relation'], 8);
      // 端点必须在本行 entities 内（否则关系悬空）；不自环。
      if (from === '' || to === '' || relation === '' || from.toLowerCase() === to.toLowerCase()) continue;
      if (!entityNames.has(from.toLowerCase()) || !entityNames.has(to.toLowerCase())) continue;
      relations.push({ from, to, relation });
    }

    let task: OntologyTaskRef | null = null;
    const rawTask = o['task'];
    if (typeof rawTask === 'object' && rawTask !== null) {
      const t = rawTask as Record<string, unknown>;
      const title = clampStr(t['title'], 60);
      const status = str(t['status']);
      if (title !== '' && TASK_STATUSES.includes(status)) {
        task = { title, status, nextStep: clampStr(t['next_step'] ?? t['nextStep'], 80) };
      }
    }

    out.push({ key, gist, summary, entities, relations, task });
  }
  return out;
}

/** 宽容 JSON 提取（照 distill/prompts.ts 同法：取第一个平衡的 {…}）。 */
export function parseOntologyOutput(text: string): Record<string, unknown> | null {
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
