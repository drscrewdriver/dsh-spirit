/**
 * 生涯流程预总结档（v0.8.18，三档）：把上游 L1 的**流程性**记录先总结，存进 spirit 自己的库。
 *
 * 三档（防失忆）：
 * - `week`：近 7 天滚动（近期不失忆），period_key=ISO 周；
 * - `month`：近 30 天滚动（中期概览），period_key=YYYY-MM；
 * - `milestone`：done/交付类只增不改，period_key=上游 record_id（天然去重）。
 *
 * 归属边界：只写 `category='procedural'`；知识性归上游（只走 entity_record_ref，不落正文）。
 * 幂等：同主键覆盖；摘要为空不写（保留旧档）；上游不可用 ⇒ 跳过。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { DistillDigestRow } from '../contract.js';
import type { ProceduralSummary } from './distill-summary.js';
import { readSessionDigests } from './session-digest.js';
import { searchL1Records } from './l1-source.js';
import { loadAliasIndex, matchEntitiesWithIndex } from './entity-align.js';

export type DigestTier = 'session' | 'week' | 'month' | 'milestone';

/** 一档的摘要行文本（日期 · 类型 · 正文）。 */
export function digestTextOf(summary: ProceduralSummary): string {
  if (summary.lines.length === 0) return '';
  return summary.lines.map((line) => `${line.date} · ${line.type} · ${line.text}`).join('\n');
}

/** ISO 周键（YYYY-Www，UTC 口径）。 */
export function weekKeyOf(ms: number): string {
  const date = new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now());
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = target.getUTCDay() === 0 ? 7 : target.getUTCDay();
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 月键（YYYY-MM，UTC 口径）。 */
export function monthKeyOf(ms: number): string {
  const date = new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now());
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 里程碑语义：done/完成/交付/已关闭/上线。 */
const MILESTONE_PATTERN = /(done|完成|交付|已关闭|上线|落地|发布)/iu;

function emptyRow(): undefined {
  return undefined;
}

/**
 * 写入一档（幂等：主键 (category, tier, period_key) 覆盖；空摘要不写）。
 */
export function writeDigest(
  db: DatabaseSync | null | undefined,
  input: { tier: DigestTier; periodKey: string; windowDays: number; summary: ProceduralSummary; entities?: string[]; now?: number },
): DistillDigestRow | undefined {
  if (db === null || db === undefined || input.periodKey === '') return emptyRow();
  const text = digestTextOf(input.summary);
  if (text === '') return emptyRow();
  const now = input.now ?? Date.now();
  const periodEnd = new Date(now).toISOString();
  const periodStart = new Date(now - input.windowDays * 86_400_000).toISOString();
  const entities = input.entities ?? [];
  try {
    db.prepare(
      `INSERT INTO distill_digest
         (category, tier, period_key, window_days, generated_at, period_start, period_end, count, summary, source_ids_json, entities_json)
       VALUES ('procedural', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(category, tier, period_key) DO UPDATE SET
         window_days = excluded.window_days,
         generated_at = excluded.generated_at,
         period_start = excluded.period_start,
         period_end = excluded.period_end,
         count = excluded.count,
         summary = excluded.summary,
         source_ids_json = excluded.source_ids_json,
         entities_json = excluded.entities_json`,
    ).run(
      input.tier,
      input.periodKey,
      input.windowDays,
      now,
      periodStart,
      periodEnd,
      input.summary.count,
      text,
      JSON.stringify(input.summary.lines.map((line) => line.sourceId)),
      JSON.stringify(entities),
    );
    return {
      category: 'procedural',
      tier: input.tier,
      periodKey: input.periodKey,
      windowDays: input.windowDays,
      generatedAt: now,
      count: input.summary.count,
      summary: text,
      entities,
    };
  } catch {
    return undefined;
  }
}

/** 里程碑：只插不改（INSERT OR IGNORE），period_key=上游 record_id。 */
function writeMilestone(
  db: DatabaseSync,
  row: { recordId: string; text: string; count: number; now: number; entities: string[] },
): boolean {
  try {
    const result = db.prepare(
      `INSERT OR IGNORE INTO distill_digest
         (category, tier, period_key, window_days, generated_at, period_start, period_end, count, summary, source_ids_json, entities_json)
       VALUES ('procedural', 'milestone', ?, 90, ?, '', '', ?, ?, ?, ?)`,
    ).run(row.recordId, row.now, row.count, row.text, JSON.stringify([row.recordId]), JSON.stringify(row.entities));
    return Number(result.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

export interface BuildDigestsResult {
  week: DistillDigestRow | undefined;
  month: DistillDigestRow | undefined;
  /** 新插入的里程碑数（已存在的不计）。 */
  milestones: number;
  /** 参与总结的流程性记录数（week 档口径）。 */
  weekCount: number;
  knowledgeCount: number;
  available: boolean;
}

/**
 * 生成三档（week / month / milestone）。上游不可用 ⇒ available=false 且不写。
 *
 * @param summarize - 摘要函数（默认由调用方注入 summarizeProcedural，保持本模块不直连 L1 语义）
 */
export function buildDigests(
  db: DatabaseSync | null | undefined,
  summarize: (opts: { days: number; perBucket: number }) => ProceduralSummary,
  opts: {
    now?: number;
    milestoneLimit?: number;
    dbPath?: string;
    /** v0.8.25：会话档作 week/month 的输入（先按会话去重，再跨会话聚合）；省略则用逐条摘要。 */
    summarizeSessions?: (opts: { days: number; perBucket: number }) => ProceduralSummary;
  } = {},
): BuildDigestsResult {
  const now = opts.now ?? Date.now();
  const empty: BuildDigestsResult = { week: undefined, month: undefined, milestones: 0, weekCount: 0, knowledgeCount: 0, available: false };
  if (db === null || db === undefined) return empty;

  const weekSummary = opts.summarizeSessions !== undefined ? opts.summarizeSessions({ days: 7, perBucket: 8 }) : summarize({ days: 7, perBucket: 8 });
  const monthSummary = opts.summarizeSessions !== undefined ? opts.summarizeSessions({ days: 30, perBucket: 12 }) : summarize({ days: 30, perBucket: 12 });
  if (!weekSummary.available && !monthSummary.available) return empty;

  // 实体串联（v0.8.18）：档文本里出现的 spirit 实体 → entities_json（按实体查询就靠它）
  // 别名索引一次加载（批量匹配），避免每行都扫库。
  const aliasIndex = loadAliasIndex(db);
  const entitiesOf = (summary: ProceduralSummary): string[] => matchEntitiesWithIndex(aliasIndex, summary.lines.map((line) => `${line.type} ${line.text}`).join('\n'), 12);

  const week = writeDigest(db, { tier: 'week', periodKey: weekKeyOf(now), windowDays: 7, summary: weekSummary, entities: entitiesOf(weekSummary), now });
  const month = writeDigest(db, { tier: 'month', periodKey: monthKeyOf(now), windowDays: 30, summary: monthSummary, entities: entitiesOf(monthSummary), now });

  // 里程碑：近 90 天 L1 work_task 中的 done/交付语义（只读；按 record_id 去重）
  let milestones = 0;
  const milestoneLimit = Math.max(1, Math.min(30, Math.floor(opts.milestoneLimit ?? 30)));
  const rows = searchL1Records({ days: 90, limit: 200, ...(opts.dbPath === undefined ? {} : { dbPath: opts.dbPath }) }).filter((row) => row.type === 'work_task' && MILESTONE_PATTERN.test(row.content));
  for (const row of rows.slice(0, milestoneLimit)) {
    const text = `${new Date(row.tsMs).toISOString().slice(0, 10)} · ${row.type} · ${row.content.replace(/\s+/gu, ' ').slice(0, 120)}`;
    if (writeMilestone(db, { recordId: row.id, text, count: 1, now, entities: matchEntitiesWithIndex(aliasIndex, row.content, 8) })) milestones += 1;
  }

  return {
    week,
    month,
    milestones,
    weekCount: weekSummary.count,
    knowledgeCount: weekSummary.knowledgeCount,
    available: true,
  };
}

/**
 * 读档：week/month 各取最新一条；milestone 取最近 N 条。
 */
export function readDigests(
  db: DatabaseSync | null | undefined,
  opts: { tiers?: DigestTier[]; milestoneLimit?: number; sessionLimit?: number } = {},
): DistillDigestRow[] {
  if (db === null || db === undefined) return [];
  const tiers = opts.tiers ?? ['week', 'month', 'milestone'];
  const out: DistillDigestRow[] = [];
  try {
    for (const tier of tiers.filter((item) => item !== 'milestone' && item !== 'session')) {
      const row = db
        .prepare(
          `SELECT category, tier, period_key, window_days, generated_at, count, summary, entities_json, stale_at
           FROM distill_digest WHERE category = 'procedural' AND tier = ?
           ORDER BY generated_at DESC LIMIT 1`,
        )
        .get(tier) as Record<string, unknown> | undefined;
      if (row !== undefined) out.push(toDigestRow(row));
    }
    if (tiers.includes('session')) {
      out.push(...readSessionDigests(db, opts.sessionLimit ?? 10));
    }
    if (tiers.includes('milestone')) {
      const limit = Math.max(0, Math.min(30, Math.floor(opts.milestoneLimit ?? 5)));
      if (limit > 0) {
        const rows = db
          .prepare(
            `SELECT category, tier, period_key, window_days, generated_at, count, summary, entities_json, stale_at
             FROM distill_digest WHERE category = 'procedural' AND tier = 'milestone'
             ORDER BY generated_at DESC LIMIT ?`,
          )
          .all(limit) as Array<Record<string, unknown>>;
        for (const row of rows) out.push(toDigestRow(row));
      }
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * 里程碑失效标注（v20，派生、可重算；**只影响展示**）。
 *
 * 三分支（保守，宁可晚标不可误标）：
 * - 来源 id 全部能在 `entity_record_ref` 找到，**且这些引用指向的实体已不存在** ⇒ 标 `now`；
 * - 有任何一个 id 找不到引用行（无证据）⇒ `NULL`；
 * - 至少一个引用仍指向活实体 ⇒ `NULL`。
 *
 * 局限（写清楚，不装作能看见上游）：真正的“上游记录已退场”需要上游证据面，
 * 本判定只看 spirit 侧引用是否还有活实体支撑；上游退场而引用未清时不会标。
 */
export function markDigestStale(
  db: DatabaseSync | null | undefined,
  opts: { now?: number } = {},
): { marked: number; cleared: number } {
  if (db === null || db === undefined) return { marked: 0, cleared: 0 };
  const now = Math.floor(opts.now ?? Date.now());
  let marked = 0;
  let cleared = 0;
  try {
    const rows = db
      .prepare(`SELECT period_key, source_ids_json, stale_at FROM distill_digest WHERE tier = 'milestone'`)
      .all() as Array<Record<string, unknown>>;
    const refAlive = db.prepare(
      `SELECT 1 FROM entity_record_ref r JOIN entity e ON e.id = r.entity_id
        WHERE r.upstream_record_id = ? LIMIT 1`,
    );
    const refAny = db.prepare(`SELECT 1 FROM entity_record_ref WHERE upstream_record_id = ? LIMIT 1`);
    const update = db.prepare(`UPDATE distill_digest SET stale_at = ? WHERE category = 'procedural' AND tier = 'milestone' AND period_key = ?`);
    for (const row of rows) {
      let ids: string[] = [];
      try {
        const parsed: unknown = JSON.parse(String(row['source_ids_json'] ?? '[]'));
        if (Array.isArray(parsed)) ids = parsed.map((id) => String(id)).filter((id) => id !== '');
      } catch {
        ids = [];
      }
      let alive = 0;
      let gone = 0;
      let unknown = 0;
      for (const id of ids) {
        if (refAlive.get(id) !== undefined) alive += 1;
        else if (refAny.get(id) !== undefined) gone += 1;
        else unknown += 1;
      }
      const stale = alive === 0 && gone > 0 && unknown === 0 ? now : null;
      const previous = typeof row['stale_at'] === 'number' ? Number(row['stale_at']) : null;
      if (stale === previous) continue;
      update.run(stale, String(row['period_key'] ?? ''));
      if (stale === null) cleared += 1;
      else marked += 1;
    }
  } catch {
    return { marked, cleared };
  }
  return { marked, cleared };
}

function toDigestRow(raw: Record<string, unknown>): DistillDigestRow {
  let entities: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(raw['entities_json'] ?? '[]'));
    if (Array.isArray(parsed)) entities = parsed.map((item) => String(item));
  } catch {
    /* 坏 JSON ⇒ 无实体 */
  }
  return {
    category: 'procedural',
    tier: String(raw['tier'] ?? 'week') as DigestTier,
    periodKey: String(raw['period_key'] ?? ''),
    windowDays: Number(raw['window_days'] ?? 7),
    generatedAt: Number(raw['generated_at'] ?? 0),
    ...(typeof raw['period_start'] === 'string' && String(raw['period_start']) !== '' ? { periodStart: String(raw['period_start']) } : {}),
    count: Number(raw['count'] ?? 0),
    summary: String(raw['summary'] ?? ''),
    entities,
    ...(typeof raw['stale_at'] === 'number' && Number.isFinite(raw['stale_at']) ? { staleAt: Number(raw['stale_at']) } : {}),
  };
}
