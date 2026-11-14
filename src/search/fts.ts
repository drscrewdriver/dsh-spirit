/**
 * FTS5 检索索引（v19）：**派生缓存**，不是真源。
 *
 * 定性先说清楚（与 `entry_vector` / `action_bias` / `topic` 同族）：
 * - 允许 DELETE / 整表重建——删光不丢任何真源信息，`ensureSearchIndex` 从各源表回灌；
 * - 绝不进 `recent()` / `deriveMood` / 注入指纹：它是**查得到的另一条路**，不是新的可见面；
 * - 真源仍是 experience / model_memory / txn_entry / task / entity / goal，
 *   `experience` 的「无 DELETE」红线不受影响（这里删的是索引行，不是经历行）。
 *
 * 两张表：
 * - `search_doc(doc_rowid, doc_key, kind, ref_id, ts_ms, text_hash, stamp)`：文档登记表，
 *   `doc_rowid` 与 FTS 的 rowid 一一对应（FTS 是 contentless，自己不存正文）；
 * - `search_fts(tokens)`：FTS5 contentless + `contentless_delete=1`，只存 token 串。
 *   为什么 contentless：正文已经在源表里，再存一份就是双真源；代价是 `'rebuild'` 指令
 *   不可用（contentless 禁），所以全量重建由本模块自己循环回灌。
 *
 * 降级纪律（与 `db/degrade.ts` 同哲学）：任何失败只返回空/不动，**绝不抛穿**——
 * 检索是增强面，不能把一次 append 或一轮对话拖死。
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  META_KEY_SEARCH_BACKFILL,
  META_KEY_SEARCH_DISABLED,
  META_KEY_SEARCH_STAMP,
} from '../db/schema.js';
import { buildMatchQuery, tokenizeForIndex } from './tokens.js';
import { tokenizerStamp } from './tokenizer.js';

export const SEARCH_DOC_TABLE = 'search_doc';
export const SEARCH_FTS_TABLE = 'search_fts';

/** 可被检索的文档类型（与 `SpiritSearchHit.kind` 对齐 + 实体别名域）。 */
export const SEARCH_KINDS = ['experience', 'memory', 'delivery', 'task', 'entity', 'goal'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export interface FtsHit {
  kind: SearchKind;
  refId: string;
  tsMs: number;
  /** BM25 原始分（负值=更相关），只用于调试/排序，不对外暴露。 */
  rank: number;
}

/** 表不可用的负缓存：同一次进程里不反复撞「no such table」。 */
const unavailable = new WeakSet<DatabaseSync>();

/** 把整条索引链判死（本进程内后续查询一律回落 LIKE），并把原因写进 meta。 */
export function markSearchIndexUnusable(db: DatabaseSync | null | undefined, reason: string): void {
  if (db === null || db === undefined) return;
  unavailable.add(db);
  try {
    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(META_KEY_SEARCH_DISABLED, reason.slice(0, 200));
  } catch {
    /* meta 写不进去也不能抛 */
  }
}

/**
 * 建 FTS5 虚表（幂等，永不抛）。
 *
 * 为什么不在 `SCHEMA_STATEMENTS` 里：`applySchema` 无错误隔离，一条建表失败会让整库开不起来。
 * FTS5 / `contentless_delete` 依赖 SQLite 版本，属于「增强能力」：建不出来只应失去检索质量。
 *
 * @returns 索引是否可用（false ⇒ 调用方回落 LIKE）
 */
export function ensureSearchFtsTable(db: DatabaseSync | null | undefined): boolean {
  if (db === null || db === undefined) return false;
  if (unavailable.has(db)) return false;
  const disabled = metaGet(db, META_KEY_SEARCH_DISABLED);
  if (disabled !== undefined && disabled !== '') return false;
  try {
    db.prepare(`SELECT 1 FROM ${SEARCH_DOC_TABLE} LIMIT 1`).get();
  } catch {
    // 登记表都不存在 ⇒ 库还没迁移到位，不是 FTS 的问题
    unavailable.add(db);
    return false;
  }
  try {
    db.prepare(`SELECT 1 FROM ${SEARCH_FTS_TABLE} LIMIT 1`).get();
    return true;
  } catch {
    /* 落下去建表 */
  }
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${SEARCH_FTS_TABLE} USING fts5(tokens, content='', contentless_delete=1)`);
    return true;
  } catch (err) {
    markSearchIndexUnusable(db, `建 FTS 表失败：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 索引是否可用（表存在且可读）。不可用 ⇒ 调用方回落 LIKE。 */
export function searchIndexUsable(db: DatabaseSync | null | undefined): boolean {
  if (db === null || db === undefined) return false;
  if (unavailable.has(db)) return false;
  const disabled = metaGet(db, META_KEY_SEARCH_DISABLED);
  if (disabled !== undefined && disabled !== '') return false;
  try {
    db.prepare(`SELECT 1 FROM ${SEARCH_DOC_TABLE} LIMIT 1`).get();
    db.prepare(`SELECT 1 FROM ${SEARCH_FTS_TABLE} LIMIT 1`).get();
    return true;
  } catch {
    unavailable.add(db);
    return false;
  }
}

function hashOf(tokens: string): string {
  return createHash('sha1').update(tokens, 'utf8').digest('hex').slice(0, 16);
}

function rowsOf(db: DatabaseSync, sql: string, params: readonly unknown[] = []): Array<Record<string, unknown>> {
  try {
    return db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function metaGet(db: DatabaseSync, key: string): string | undefined {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined;
    return typeof row?.value === 'string' ? row.value : undefined;
  } catch {
    return undefined;
  }
}

export function searchIndexMeta(db: DatabaseSync): { stamp?: string; backfilled: boolean } {
  return { stamp: metaGet(db, META_KEY_SEARCH_STAMP), backfilled: metaGet(db, META_KEY_SEARCH_BACKFILL) === '1' };
}

export function writeSearchIndexMeta(db: DatabaseSync, stamp: string): void {
  const write = (key: string, value: string): void => {
    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  };
  write(META_KEY_SEARCH_STAMP, stamp);
  write(META_KEY_SEARCH_BACKFILL, '1');
}

/**
 * 登记 / 更新一条文档索引（幂等）。
 *
 * 内容哈希没变 ⇒ 直接跳过（避免每轮 append 都重写 FTS 行）。
 *
 * @returns 是否真的写了索引
 */
export function indexDoc(
  db: DatabaseSync | null | undefined,
  kind: SearchKind,
  refId: string,
  tsMs: number,
  text: string,
): boolean {
  if (db === null || db === undefined || refId === '') return false;
  if (!searchIndexUsable(db)) return false;
  const tokens = tokenizeForIndex(text);
  if (tokens === '') return false;
  const stamp = tokenizerStamp();
  const hash = hashOf(tokens);
  const key = `${kind}:${refId}`;
  try {
    const existing = db
      .prepare(`SELECT doc_rowid, text_hash FROM ${SEARCH_DOC_TABLE} WHERE doc_key = ?`)
      .get(key) as { doc_rowid?: number; text_hash?: string } | undefined;
    if (existing !== undefined && existing.text_hash === hash) {
      db.prepare(`UPDATE ${SEARCH_DOC_TABLE} SET ts_ms = ? WHERE doc_key = ?`).run(tsMs, key);
      return false;
    }
    let rowid: number;
    if (existing !== undefined && typeof existing.doc_rowid === 'number') {
      rowid = existing.doc_rowid;
      db.prepare(`UPDATE ${SEARCH_DOC_TABLE} SET ts_ms = ?, text_hash = ?, stamp = ? WHERE doc_key = ?`).run(tsMs, hash, stamp, key);
      db.prepare(`DELETE FROM ${SEARCH_FTS_TABLE} WHERE rowid = ?`).run(rowid);
    } else {
      const inserted = db
        .prepare(
          `INSERT INTO ${SEARCH_DOC_TABLE} (doc_key, kind, ref_id, ts_ms, text_hash, stamp)
           VALUES (?, ?, ?, ?, ?, ?)
           RETURNING doc_rowid`,
        )
        .get(key, kind, refId, tsMs, hash, stamp) as { doc_rowid?: number } | undefined;
      rowid = typeof inserted?.doc_rowid === 'number' ? inserted.doc_rowid : -1;
      if (rowid < 0) return false;
    }
    db.prepare(`INSERT INTO ${SEARCH_FTS_TABLE} (rowid, tokens) VALUES (?, ?)`).run(rowid, tokens);
    return true;
  } catch {
    // 索引写失败不影响真源写入（调用方都在真源事务之后/之内独立 try）
    return false;
  }
}

/** 摘掉一条文档索引（源行被遗忘时用；缺了也无害——查询会按源表状态二次过滤）。 */
export function dropDoc(db: DatabaseSync | null | undefined, kind: SearchKind, refId: string): void {
  if (db === null || db === undefined || refId === '') return;
  try {
    const row = db
      .prepare(`SELECT doc_rowid FROM ${SEARCH_DOC_TABLE} WHERE doc_key = ?`)
      .get(`${kind}:${refId}`) as { doc_rowid?: number } | undefined;
    if (typeof row?.doc_rowid !== 'number') return;
    db.prepare(`DELETE FROM ${SEARCH_FTS_TABLE} WHERE rowid = ?`).run(row.doc_rowid);
    db.prepare(`DELETE FROM ${SEARCH_DOC_TABLE} WHERE doc_rowid = ?`).run(row.doc_rowid);
  } catch {
    /* 派生缓存，失败不抛 */
  }
}

/**
 * 检索：返回源表 id + 时间 + BM25 分（**不返回正文**，正文由调用方按自己的可见面取，
 * 这样 `superseded_by` / `hidden_at` / `forgotten_at` 等状态过滤永远只有一处真源）。
 *
 * @param kinds 限定文档类型（空数组 ⇒ 全类型）
 * @param limit 候选上限（调用方再按自己的语义截断）
 */
export function queryDocs(
  db: DatabaseSync | null | undefined,
  q: string,
  opts: { kinds?: readonly SearchKind[]; limit?: number } = {},
): FtsHit[] {
  if (db === null || db === undefined) return [];
  if (!searchIndexUsable(db)) return [];
  const match = buildMatchQuery(q);
  if (match === null) return [];
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
  const kinds = (opts.kinds ?? []).filter((kind) => (SEARCH_KINDS as readonly string[]).includes(kind));
  const kindClause = kinds.length === 0 ? '' : ` AND d.kind IN (${kinds.map(() => '?').join(', ')})`;
  const rows = rowsOf(
    db,
    `SELECT d.kind AS kind, d.ref_id AS ref_id, d.ts_ms AS ts_ms, bm25(${SEARCH_FTS_TABLE}) AS rank
       FROM ${SEARCH_FTS_TABLE}
       JOIN ${SEARCH_DOC_TABLE} d ON d.doc_rowid = ${SEARCH_FTS_TABLE}.rowid
      WHERE ${SEARCH_FTS_TABLE} MATCH ?${kindClause}
      ORDER BY rank
      LIMIT ?`,
    [match, ...kinds, limit],
  );
  const out: FtsHit[] = [];
  for (const row of rows) {
    const kind = String(row['kind'] ?? '');
    const refId = String(row['ref_id'] ?? '');
    if (refId === '' || !(SEARCH_KINDS as readonly string[]).includes(kind)) continue;
    out.push({ kind: kind as SearchKind, refId, tsMs: Number(row['ts_ms'] ?? 0), rank: Number(row['rank'] ?? 0) });
  }
  return out;
}

/** 索引规模（面板/日志用）。 */
export function searchIndexStats(db: DatabaseSync | null | undefined): { docs: number; usable: boolean; stamp?: string } {
  if (db === null || db === undefined) return { docs: 0, usable: false };
  if (!searchIndexUsable(db)) return { docs: 0, usable: false };
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${SEARCH_DOC_TABLE}`).get() as { n?: number } | undefined;
    return { docs: Number(row?.n ?? 0), usable: true, stamp: metaGet(db, META_KEY_SEARCH_STAMP) };
  } catch {
    return { docs: 0, usable: false };
  }
}

/** 清空索引（重建前置步；contentless 表禁 'rebuild' 指令，只能自己删）。 */
export function clearSearchIndex(db: DatabaseSync): void {
  db.exec(`DELETE FROM ${SEARCH_FTS_TABLE}`);
  db.exec(`DELETE FROM ${SEARCH_DOC_TABLE}`);
}