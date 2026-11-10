/**
 * 事务轨的 prompt 单源与输出校验（T3.2）。
 *
 * 与 `distill/prompts.ts` 的关系是**同构不同责**：那边读的是查表产物（第一人称感受句），
 * 这边读的是结构信号包——所以 prompt 明说"只从结构信号里归纳"。这条纪律不是客套话：
 * 采集侧（watcher.ts）本来就只喂白名单字段，prompt 写一遍是让模型知道边界，校验侧才是真闸。
 *
 * 校验只钳形状与归属，不判内容——内容闸在 `transaction/gate.ts`。两道闸混写会错位：
 * 测试就读不到"到底哪一道闸在起作用"（这是本文件最容易被写坏的地方）。
 *
 * 三条口径：
 * 1. `key`（session/turn）是批次对账身份：模型不得发明，发明即整条丢弃（照 G18 先例）。
 * 2. `evidence` 必须全部 ⊆ 本批 key：发明 id 整条丢弃（照 distill/prompts.ts 先例）。
 * 3. kind 只对单源词表（TXN_CUE_KINDS）负责——"本批信号里没有这个 kind"是采集侧的判定，
 *    不是校验侧的：校验侧拿不到信号的原始来源，硬判就会把因果链写进校验。字母给的签名是
 *    (raw, batchIds)，这里照字母执行，第 3 参是配置区间（不写死数字，写死就是把配置键变摆设）。
 */

import { CUE_LIMITS, normalizeCue } from '../experience/cues.js';
import { TXN_CUE_KINDS, type TxnCueKind, type TxnSemantic } from '../store/transaction.js';
import type { TxnSignals } from './watcher.js';

/** gist_key 的顶（spec 口径 ≤20 字）。 */
export const TXN_GIST_MAX = 20;

export interface TxnLimits {
  maxCardLineChars: number;
  maxSummaryChars: number;
}

export interface TxnProposalCue {
  cue: string;
  kind: TxnCueKind;
}

export interface TxnProposalRow {
  key: string;
  cardLine: string;
  summary: string;
  gistKey: string;
  semantic: TxnSemantic;
  cues: TxnProposalCue[];
  /** 归属本批的 key（校验侧已过滤，模型发明的 key 不在这里）。 */
  evidence: string[];
}

const SYSTEM_LINES = [
  '你在帮助一条记事鱼整理它这一轮做了什么（事务记录），不是它感觉如何。',
  '任务：读一批结构信号（每轮一条），输出 JSON（只输出 JSON，不要解释文字）：',
  '{',
  '  "rows": [{',
  '    "key": "信号给的 key（原样照抄，不许发明）",',
  '    "card_line": "这一轮做了什么，≤60字，第一人称",',
  '    "summary": "200-500字的事务说明（只用于翻阅/详情，不进注入卡）",',
  '    "gist_key": "≤20字残句（what + 资源锚）",',
  '    "semantic": {"what":"","who":"","when":"","next":"","topics":[""],',
  '"entities":["文件名或实体名，禁全路径"]},',
  '    "cues": [{"cue":"实体名或文件 basename","kind":"file|person|tool|topic"}],',
  '    "evidence": ["本批 key", "..."]',
  '  }]',
  '}',
  '规则：',
  '- 只能从结构信号里归纳（工具名、路径 basename、todo 标题、意图档位）。',
  '- 信号里没有的内容一律不写：模型没有读正文的能力，写具体 = 幻觉。',
  '- 意图只给档位与贡献值，不许把用户的话抄进 summary。',
  '- cues 的 kind 只能用单源词表里的四个，不许发明 kind。',
  '- evidence 只能写本批的 key，不许发明 key。',
  '- 宁少勿滥：一条信号最多一行；没有可归纳的内容就整行不写。',
];

/** 单源 prompt（与 distill 的 SLEEP_SUMMARY_SYSTEM 同族形状，但读者不同）。 */
export const TXN_SUMMARY_SYSTEM = SYSTEM_LINES.join('\n');

function renderSignals(signals: readonly TxnSignals[]): string {
  return signals
    .map((signal) => {
      const intent = signal.intent === undefined ? '' : ` ｜意图: ${signal.intent.kind}(${signal.intent.bit})`;
      const titles = signal.todoTitles.length === 0 ? '' : ` ｜todo: ${signal.todoTitles.join(' / ')}`;
      const tools = signal.toolNames.length === 0 ? '' : ` ｜tool: ${signal.toolNames.join(', ')}`;
      const paths = signal.pathBases.length === 0 ? '' : ` ｜path: ${signal.pathBases.join(', ')}`;
      const hosts = signal.urlHosts.length === 0 ? '' : ` ｜host: ${signal.urlHosts.join(', ')}`;
      return `- [${signal.key}] (turn ${signal.turnSeq})${intent}${titles}${tools}${paths}${hosts}`;
    })
    .join('\n');
}

/** 摘要调用（单次 LLM 调用）的 user 文本。 */
export function buildTxnUser(signals: readonly TxnSignals[]): string {
  return `这一批结构信号（每轮一条）：\n${renderSignals(signals)}`;
}

function strArray(value: unknown, cap: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()).slice(0, cap)
    : [];
}

/** 取第一个平衡 `{`（照 parseJsonLoose 先例：解释文字被剥，坏 json 不连坐整批）。 */
export function parseTxnOutput(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 输出校验：长度钳配置区间、key/evidence ⊆ 本批、kind ⊆ 单源词表。
 * 发明 key 的整条丢弃（一条没有可解释来源的行比没有更糟）。
 */
export function validateTxnOutput(raw: Record<string, unknown> | null, batchKeys: ReadonlySet<string>, limits: TxnLimits): TxnProposalRow[] {
  const out: TxnProposalRow[] = [];
  if (raw === null || !Array.isArray(raw['rows'])) return out;

  for (const item of raw['rows'] as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const key = typeof o['key'] === 'string' ? o['key'].trim() : '';
    if (!batchKeys.has(key)) continue;

    const cardLine = typeof o['card_line'] === 'string' ? o['card_line'].trim().slice(0, limits.maxCardLineChars) : '';
    const summary = typeof o['summary'] === 'string' ? o['summary'].trim().slice(0, limits.maxSummaryChars) : '';
    const gistKey = typeof o['gist_key'] === 'string' ? o['gist_key'].trim().slice(0, TXN_GIST_MAX) : '';
    if (cardLine === '') continue;

    const pack = typeof o['semantic'] === 'object' && o['semantic'] !== null ? (o['semantic'] as Record<string, unknown>) : {};
    const semantic: TxnSemantic = {};
    for (const field of ['what', 'who', 'when', 'next'] as const) {
      const value = pack[field];
      if (typeof value === 'string' && value.trim() !== '') semantic[field] = value.trim();
    }
    const topics = strArray(pack['topics'], CUE_LIMITS.maxPerEntry);
    if (topics.length > 0) semantic.topics = topics;
    const entities = strArray(pack['entities'], CUE_LIMITS.maxPerEntry).map((entity) => normalizeCue(entity));
    if (entities.length > 0) semantic.entities = entities;

    const cues: TxnProposalCue[] = [];
    for (const rawCue of Array.isArray(o['cues']) ? (o['cues'] as unknown[]) : []) {
      const cue = typeof rawCue === 'object' && rawCue !== null ? (rawCue as Record<string, unknown>) : {};
      const kind = typeof cue['kind'] === 'string' ? cue['kind'].trim() : '';
      if (!(TXN_CUE_KINDS as readonly string[]).includes(kind)) continue;
      const clean = normalizeCue(typeof cue['cue'] === 'string' ? cue['cue'] : '');
      if (clean === '') continue;
      cues.push({ cue: clean, kind: kind as TxnCueKind });
      if (cues.length >= CUE_LIMITS.maxPerEntry) break;
    }

    const evidence = strArray(o['evidence'], batchKeys.size).filter((id) => batchKeys.has(id));
    if (Array.isArray(o['evidence']) && o['evidence'].length > 0 && evidence.length === 0) continue; // 全幻觉 evidence ⇒ 整条丢

    out.push({ key, cardLine, summary, gistKey, semantic, cues, evidence });
  }
  return out;
}
