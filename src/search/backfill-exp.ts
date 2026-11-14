/**
 * 检索索引回填 · 体验轨（v19）：`experience` + `model_memory`。
 *
 * ⚠️ 门禁 TA.6(b)：本文件**不得**出现任何本体表（entity / task / txn_entry / goal …）的
 * `FROM`——读 experience 的源文件与本体表同文件会把本体行泄进情绪派生与注入可见面。
 * 本体轨回填在 `backfill-onto.ts`。
 *
 * 分批用 keyset（`rowid > ?`）而不是 OFFSET：本库 append-only 且只增不删，OFFSET 在
 * 大库上是 O(n) 递减扫描。
 */
import type { DatabaseSync } from 'node:sqlite';

import { indexDoc } from './fts.js';
import { indexText } from './tokens.js';

/** 每批行数：万级库约几十毫秒一批，兼顾内存与事务粒度。 */
export const BACKFILL_BATCH = 500;

function rowsOf(db: DatabaseSync, sql: string, params: readonly unknown[]): Array<Record<string, unknown>> {
  try {
    return db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 批内 cues（一条 entry 多行）→ entry_id ⇒ 空格连接。 */
function cueMapOf(db: DatabaseSync, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = rowsOf(db, `SELECT entry_id, cue FROM experience_cues WHERE entry_id IN (${placeholders})`, ids);
  for (const row of rows) {
    const id = asText(row['entry_id']);
    const cue = asText(row['cue']);
    if (id === '' || cue === '') continue;
    const prev = out.get(id);
    out.set(id, prev === undefined ? cue : `${prev} ${cue}`);
  }
  return out;
}

/**
 * 回填体验轨索引。
 *
 * @returns 实际写入（或刷新）的文档数
 */
export function backfillExperienceIndex(db: DatabaseSync): number {
  let written = 0;

  // ── experience：正文 + gist + cues 进同一文档（cue 是检索段的一等公民）──
  let lastRowid = 0;
  for (;;) {
    const rows = rowsOf(
      db,
      `SELECT rowid AS rid, id, ts_ms, text, gist FROM experience WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      [lastRowid, BACKFILL_BATCH],
    );
    if (rows.length === 0) break;
    const ids = rows.map((row) => asText(row['id'])).filter((id) => id !== '');
    const cues = cueMapOf(db, ids);
    for (const row of rows) {
      const id = asText(row['id']);
      if (id === '') continue;
      const ts = Number(row['ts_ms'] ?? 0);
      const text = indexText(asText(row['text']), asText(row['gist']), cues.get(id));
      if (indexDoc(db, 'experience', id, Number.isFinite(ts) ? ts : 0, text)) written += 1;
    }
    lastRowid = Number(rows[rows.length - 1]?.['rid'] ?? 0);
    if (rows.length < BACKFILL_BATCH) break;
  }

  // ── model_memory：两本账 + 日记（遗忘行也回填：写路径会把 forgotten_at 置回 NULL）──
  lastRowid = 0;
  for (;;) {
    const rows = rowsOf(
      db,
      `SELECT rowid AS rid, id, updated_at, text FROM model_memory WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      [lastRowid, BACKFILL_BATCH],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = asText(row['id']);
      if (id === '') continue;
      const ts = Number(row['updated_at'] ?? 0);
      if (indexDoc(db, 'memory', id, Number.isFinite(ts) ? ts : 0, asText(row['text']))) written += 1;
    }
    lastRowid = Number(rows[rows.length - 1]?.['rid'] ?? 0);
    if (rows.length < BACKFILL_BATCH) break;
  }

  return written;
}