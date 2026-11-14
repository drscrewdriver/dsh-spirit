/**
 * 全域搜索 · 非体验轨（v0.8.14 / v19 改 FTS 优先）：任务线 / 交付 / 记着 / 目的 / 实体。
 *
 * 门禁 TA.6(b)：读 `experience` 的文件不得同时读本体表，所以体验轨单独放
 * `experience-search.ts`，本文件**不出现** `FROM experience`。
 *
 * 每种类型都走同一条形状：① FTS 候选 id → ② 回源表（带各自的状态过滤与排序）→
 * ③ 无候选/索引不可用 ⇒ 回落原字面 LIKE。候选来源换了，**排序与过滤不换**。
 */
import type { DatabaseSync } from 'node:sqlite';

import { queryDocs, type SearchKind } from './fts.js';

export interface RecordSearchHit {
  kind: 'task' | 'delivery' | 'memory' | 'goal' | 'entity';
  id: string;
  title: string;
  ts: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function rowsOf(db: DatabaseSync, sql: string, params: readonly unknown[]): Array<Record<string, unknown>> {
  try {
    return db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

interface KindSpec {
  kind: RecordSearchHit['kind'];
  /** FTS 命中后回源表的查询（占位符：ids…, cap）；titleCol 决定返回的标题列 */
  byIds: string;
  titleCol: string;
  /** 回落路径（字面 LIKE） */
  byLike: string;
}

/** 五类的两条路都收在这张表里：新增一类只加一行，不复制第三份 SQL。 */
const SPECS: readonly KindSpec[] = [
  {
    kind: 'task',
    titleCol: 'title',
    byIds: `SELECT id, title, updated_at AS ts FROM task WHERE id IN (%IDS%) ORDER BY updated_at DESC LIMIT ?`,
    byLike: `SELECT id, title, updated_at AS ts FROM task WHERE title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?`,
  },
  {
    kind: 'delivery',
    titleCol: 'card_line',
    byIds: `SELECT id, card_line, ts_ms AS ts FROM txn_entry WHERE id IN (%IDS%) AND superseded_by IS NULL ORDER BY ts_ms DESC LIMIT ?`,
    byLike: `SELECT id, card_line, ts_ms AS ts FROM txn_entry WHERE card_line LIKE ? ESCAPE '\\' ORDER BY ts_ms DESC LIMIT ?`,
  },
  {
    kind: 'memory',
    titleCol: 'text',
    byIds: `SELECT id, text, updated_at AS ts FROM model_memory WHERE id IN (%IDS%) AND forgotten_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
    byLike: `SELECT id, text, updated_at AS ts FROM model_memory WHERE text LIKE ? ESCAPE '\\' AND forgotten_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
  },
  {
    kind: 'goal',
    titleCol: 'title',
    byIds: `SELECT id, title, updated_at AS ts FROM goal WHERE id IN (%IDS%) ORDER BY updated_at DESC LIMIT ?`,
    byLike: `SELECT id, title, updated_at AS ts FROM goal WHERE title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?`,
  },
  {
    kind: 'entity',
    titleCol: 'name',
    byIds: `SELECT id, name, last_seen_ms AS ts FROM entity WHERE id IN (%IDS%) ORDER BY importance DESC LIMIT ?`,
    byLike: `SELECT id, name, last_seen_ms AS ts FROM entity WHERE name LIKE ? ESCAPE '\\' OR aliases_json LIKE ? ESCAPE '\\' ORDER BY importance DESC LIMIT ?`,
  },
];

/**
 * 按文本搜非体验轨记录。
 *
 * @param db - 权威库
 * @param q - 搜索词
 * @param perKind - 每类上限（默认 6）
 */
export function searchRecords(db: DatabaseSync | null | undefined, q: string, perKind = 6): RecordSearchHit[] {
  const term = q.trim();
  if (db === null || db === undefined || term === '') return [];
  const like = `%${escapeLike(term)}%`;
  const cap = Math.max(1, Math.min(20, Math.floor(perKind)));
  const out: RecordSearchHit[] = [];

  for (const spec of SPECS) {
    const ids = queryDocs(db, term, { kinds: [spec.kind as SearchKind], limit: Math.max(cap * 4, 24) }).map((hit) => hit.refId);
    let rows: Array<Record<string, unknown>> = [];
    if (ids.length > 0) {
      const sql = spec.byIds.replace('%IDS%', ids.map(() => '?').join(', '));
      rows = rowsOf(db, sql, [...ids, cap]);
    }
    if (rows.length === 0) {
      // 回落：实体多一个别名列，故按 kind 判一次（其余单列）
      rows = spec.kind === 'entity' ? rowsOf(db, spec.byLike, [like, like, cap]) : rowsOf(db, spec.byLike, [like, cap]);
    }
    for (const row of rows) {
      out.push({ kind: spec.kind, id: String(row['id'] ?? ''), title: String(row[spec.titleCol] ?? ''), ts: Number(row['ts'] ?? 0) });
    }
  }
  return out.filter((hit) => hit.id !== '' && hit.title !== '');
}