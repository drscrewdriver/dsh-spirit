/**
 * 检索索引回填 · 本体轨（v19）：`task` / `txn_entry` / `entity` / `goal` + 别名表重建。
 *
 * ⚠️ 门禁 TA.6(b)：本文件**不得**出现 `FROM experience`（本体与体验必须分文件，
 * 否则本体行会泄进情绪派生与注入可见面）。体验轨回填在 `backfill-exp.ts`。
 *
 * 末尾顺手重建 `entity_alias`：把 `entity.name / aliases_json` 归一化成可精确命中的
 * alias_norm（多名称搜索的底座）。
 */
import type { DatabaseSync } from 'node:sqlite';

import { buildEntityAliases } from '../prime/entity-align.js';
import { indexDoc } from './fts.js';
import { indexText } from './tokens.js';

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

export interface OntologyBackfillResult {
  written: number;
  /** 重建出的别名条数（含已存在的，INSERT OR IGNORE 只计新增）。 */
  aliases: number;
}

/**
 * 回填本体轨索引并重建别名表。
 */
export function backfillOntologyIndex(db: DatabaseSync): OntologyBackfillResult {
  let written = 0;

  // ── task：标题 + 下一步（任务线是"最近在干什么"的主入口）──
  let lastRowid = 0;
  for (;;) {
    const rows = rowsOf(
      db,
      `SELECT rowid AS rid, id, updated_at, title, next_step FROM task WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      [lastRowid, BACKFILL_BATCH],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = asText(row['id']);
      if (id === '') continue;
      const ts = Number(row['updated_at'] ?? 0);
      if (indexDoc(db, 'task', id, Number.isFinite(ts) ? ts : 0, indexText(asText(row['title']), asText(row['next_step'])))) written += 1;
    }
    lastRowid = Number(rows[rows.length - 1]?.['rid'] ?? 0);
    if (rows.length < BACKFILL_BATCH) break;
  }

  // ── txn_entry（交付）：card_line + summary（summary 只进索引，返回的 title 仍是 card_line）──
  lastRowid = 0;
  for (;;) {
    const rows = rowsOf(
      db,
      `SELECT rowid AS rid, id, ts_ms, card_line, summary FROM txn_entry WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      [lastRowid, BACKFILL_BATCH],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = asText(row['id']);
      if (id === '') continue;
      const ts = Number(row['ts_ms'] ?? 0);
      if (indexDoc(db, 'delivery', id, Number.isFinite(ts) ? ts : 0, indexText(asText(row['card_line']), asText(row['summary'])))) written += 1;
    }
    lastRowid = Number(rows[rows.length - 1]?.['rid'] ?? 0);
    if (rows.length < BACKFILL_BATCH) break;
  }

  // ── entity：名字 + 全部别名（多名称搜索的索引面）──
  lastRowid = 0;
  for (;;) {
    const rows = rowsOf(
      db,
      `SELECT rowid AS rid, id, last_seen_ms, name, aliases_json FROM entity WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      [lastRowid, BACKFILL_BATCH],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = asText(row['id']);
      if (id === '') continue;
      const ts = Number(row['last_seen_ms'] ?? 0);
      const aliases = asText(row['aliases_json']);
      let aliasText = '';
      try {
        const parsed: unknown = JSON.parse(aliases === '' ? '[]' : aliases);
        if (Array.isArray(parsed)) aliasText = parsed.map((item) => String(item)).join(' ');
      } catch {
        /* 坏 JSON ⇒ 只用名字 */
      }
      if (indexDoc(db, 'entity', id, Number.isFinite(ts) ? ts : 0, indexText(asText(row['name']), aliasText))) written += 1;
    }
    lastRowid = Number(rows[rows.length - 1]?.['rid'] ?? 0);
    if (rows.length < BACKFILL_BATCH) break;
  }

  // ── goal：标题 + 为什么（目的层）──
  lastRowid = 0;
  for (;;) {
    const rows = rowsOf(
      db,
      `SELECT rowid AS rid, id, updated_at, title, why FROM goal WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      [lastRowid, BACKFILL_BATCH],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = asText(row['id']);
      if (id === '') continue;
      const ts = Number(row['updated_at'] ?? 0);
      if (indexDoc(db, 'goal', id, Number.isFinite(ts) ? ts : 0, indexText(asText(row['title']), asText(row['why'])))) written += 1;
    }
    lastRowid = Number(rows[rows.length - 1]?.['rid'] ?? 0);
    if (rows.length < BACKFILL_BATCH) break;
  }

  // 别名表：归一化 name + aliases_json → alias_norm（幂等，只增不删）
  const aliases = buildEntityAliases(db);
  return { written, aliases };
}