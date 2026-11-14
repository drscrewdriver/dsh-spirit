/**
 * L1 → 生涯**流程性**预总结（v0.8.18）。
 *
 * 归属边界（用户口径）：**知识性归上游 dsh-prime-memory**（work_fact / work_method / 坑 / 决定 / 规范），
 * 由它的 `memory_search` 提供；spirit 只取**流程性**（work_task / episodic：进展、阶段、到哪了），
 * 预先总结成自己的生涯流程档。两类混桶会把"方法论"抄成 spirit 的记忆——那是越界。
 *
 * 本版确定性摘要（不调模型）：按时间倒序、每条压一行、带日期；后续可在此接 LLM。
 */
import type { L1RecordRow } from './l1-source.js';
import { searchL1Records } from './l1-source.js';

/** 流程性类型（spirit 的地盘）。 */
const PROCEDURAL_TYPES = new Set(['work_task', 'episodic']);

/** 知识性类型（上游地盘，spirit 只计数不摘要）。 */
const KNOWLEDGE_TYPES = new Set([
  'work_fact',
  'work_method',
  'tool_experience',
  'common_pitfalls_experience',
  'important_decision_experience',
  'development_practice_specification',
  'development_code_specification',
  'development_test_specification',
  'project_architecture',
  'project_tech_stack',
  'user_communication',
  'instruction',
  'work_artifact',
]);

export type L1Category = 'procedural' | 'knowledge';

/** 类型归类（未列出默认知识性：不动别人的地盘）。 */
export function classifyL1Type(type: string): L1Category {
  if (PROCEDURAL_TYPES.has(type)) return 'procedural';
  if (KNOWLEDGE_TYPES.has(type)) return 'knowledge';
  return 'knowledge';
}

/** 一条流程摘要行。 */
export interface ProceduralLine {
  /** YYYY-MM-DD。 */
  date: string;
  /** L1 类型（work_task/episodic）。 */
  type: string;
  text: string;
  sourceId: string;
}

export interface ProceduralSummary {
  /** 流程性记录总数（截断前）。 */
  count: number;
  lines: ProceduralLine[];
  /** 知识性记录数（只计数，不摘；指路上游 memory_search）。 */
  knowledgeCount: number;
  days: number;
  /** 上游可用（库/表缺失 ⇒ false）。 */
  available: boolean;
}

function dateOf(tsMs: number): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return '—';
  const date = new Date(tsMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 压成单行：折叠空白、去掉行首项目符号、按上限截断（码点安全）。 */
export function toSummaryText(content: string, maxChars = 120): string {
  const flat = content.replace(/\s+/gu, ' ').replace(/^[·•\-\s]+/u, '').trim();
  const chars = Array.from(flat);
  if (chars.length <= maxChars) return flat;
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

/**
 * 生成流程性摘要（知识性只计数）。
 *
 * @param opts.q - 关键词（先过滤再分类）
 * @param opts.days - 回看天数（默认 7）
 * @param opts.perBucket - 条数上限（默认 8，封顶 20）
 * @param opts.dbPath - 覆盖上游库路径（测试）
 */
export function summarizeProcedural(opts: { q?: string; days?: number; perBucket?: number; dbPath?: string } = {}): ProceduralSummary {
  const days = Number.isFinite(opts.days) ? Math.max(1, Math.floor(opts.days as number)) : 7;
  const cap = Math.max(1, Math.min(20, Math.floor(Number.isFinite(opts.perBucket) ? (opts.perBucket as number) : 8)));
  const rows: L1RecordRow[] = searchL1Records({
    days,
    limit: 200,
    ...(opts.q === undefined || opts.q.trim() === '' ? {} : { q: opts.q }),
    ...(opts.dbPath === undefined ? {} : { dbPath: opts.dbPath }),
  });
  const procedural: L1RecordRow[] = [];
  let knowledgeCount = 0;
  for (const row of rows) {
    if (classifyL1Type(row.type) === 'procedural') procedural.push(row);
    else knowledgeCount += 1;
  }
  return {
    count: procedural.length,
    lines: procedural.slice(0, cap).map((row) => ({ date: dateOf(row.tsMs), type: row.type, text: toSummaryText(row.content), sourceId: row.id })),
    knowledgeCount,
    days,
    available: rows.length > 0,
  };
}
