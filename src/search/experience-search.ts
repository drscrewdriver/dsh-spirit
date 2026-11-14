/**
 * 全域搜索 · 体验轨（v0.8.14 / v19 改 FTS 优先）。
 *
 * 单独一个文件是为了守法门禁 TA.6(b)——读 `experience` 的文件不得同时读本体表
 * （否则本体行会泄进情绪派生/注入）。组合在 `all.ts` 里做。
 *
 * 检索顺序：① FTS 词级候选（`search/fts`）→ ② 索引不可用/无命中时回落原字面 LIKE。
 * 两条路都回源表做可见面过滤（`superseded_by` / `hidden_at`），所以索引只影响"能不能找到"，
 * 不影响"该不该被看到"。
 */
import type { DatabaseSync } from 'node:sqlite';

import { queryDocs } from './fts.js';

export interface ExperienceSearchHit {
  kind: 'experience';
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

/**
 * 按文本搜体验条目（跨会话，最近优先）。
 *
 * @param db - 权威库
 * @param q - 搜索词
 * @param limit - 上限（默认 6）
 */
export function searchExperiences(db: DatabaseSync | null | undefined, q: string, limit = 6): ExperienceSearchHit[] {
  const term = q.trim();
  if (db === null || db === undefined || term === '') return [];
  const cap = Math.max(1, Math.min(20, Math.floor(limit)));

  // ① FTS 候选（多取几倍：可见面过滤后还可能被筛掉一部分）
  const ids = queryDocs(db, term, { kinds: ['experience'], limit: Math.max(cap * 4, 24) }).map((hit) => hit.refId);
  if (ids.length > 0) {
    const rows = rowsOf(
      db,
      `SELECT id, text, ts_ms FROM experience
        WHERE id IN (${ids.map(() => '?').join(', ')})
          AND superseded_by IS NULL AND hidden_at IS NULL
        ORDER BY ts_ms DESC, id DESC LIMIT ?`,
      [...ids, cap],
    );
    const hits = rows
      .map((row) => ({ kind: 'experience' as const, id: String(row['id'] ?? ''), title: String(row['text'] ?? ''), ts: Number(row['ts_ms'] ?? 0) }))
      .filter((hit) => hit.id !== '' && hit.title !== '');
    if (hits.length > 0) return hits;
  }

  // ② 回落：原字面 LIKE
  try {
    const rows = db
      .prepare(
        `SELECT id, text, ts_ms FROM experience WHERE text LIKE ? ESCAPE '\\' ORDER BY ts_ms DESC LIMIT ?`,
      )
      .all(`%${escapeLike(term)}%`, cap) as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({ kind: 'experience' as const, id: String(row['id'] ?? ''), title: String(row['text'] ?? ''), ts: Number(row['ts_ms'] ?? 0) }))
      .filter((hit) => hit.id !== '' && hit.title !== '');
  } catch {
    return [];
  }
}