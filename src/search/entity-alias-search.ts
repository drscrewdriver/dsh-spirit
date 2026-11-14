/**
 * 实体多名称关联搜索（v19）。
 *
 * 解决的问题：同一个实体在库里可能叫很多名字（`dsh-spirit` / `spirit` / `小精灵`），
 * 而 `entity_alias` 里存的是归一化后的别名。用户搜任何一个名字，都应该：
 *   ① 找到这个实体 → ② 顺着关联找到"属于它"的交付与任务线。
 *
 * 硬边界（沿用「合并不可逆，误配比漏配贵」）：
 * - 本模块**只读**实体与关联表；确认合并的写入在面板 RPC 里，落点是 `entity_alias(source='user')`，
 *   永不改 `entity` 行、永不合并 id；
 * - 上游知识（prime-memory 的 L1）**只回计数**，不返回 ref id 与正文——正文由模型走 `memory_search`。
 *
 * 门禁：本文件**不出现** `FROM experience`（TA.6(b)）。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { SpiritSearchHit } from '../contract.js';
import { normalizeEntityName } from '../prime/entity-align.js';
import { queryDocs } from './fts.js';

/** 一次最多展开几个实体（再多会把搜索结果挤满）。 */
export const MAX_ENTITIES = 4;
/** 每个实体每类最多带几条关联记录。 */
export const PER_KIND = 3;

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
 * 把查询词解析成实体 id（三级：精确归一化 → 双向包含 → FTS 兜底），去重、有顶。
 *
 * 双向包含的两个方向都要：
 * - `alias LIKE %q%`：查询是别名的一部分（「kpe」→「linkperry」）；
 * - `q LIKE %alias%`：别名是查询的一部分（「腾讯云」→「腾讯」），只取 `length >= 2` 的别名，
 *   否则单字别名会把几乎所有查询都吸过去。
 */
export function resolveEntityIds(db: DatabaseSync | null | undefined, q: string, limit = MAX_ENTITIES): string[] {
  if (db === null || db === undefined) return [];
  const term = q.trim();
  if (term === '') return [];
  const cap = Math.max(1, Math.min(12, Math.floor(limit)));
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (id === '' || seen.has(id) || out.length >= cap) return;
    seen.add(id);
    out.push(id);
  };
  const norm = normalizeEntityName(term);

  // ① 精确归一化
  if (norm !== '') {
    for (const row of rowsOf(db, `SELECT entity_id FROM entity_alias WHERE alias_norm = ? LIMIT ?`, [norm, cap])) {
      push(String(row['entity_id'] ?? ''));
    }
  }

  // ② 双向包含
  if (norm !== '' && out.length < cap) {
    for (const row of rowsOf(
      db,
      `SELECT entity_id FROM entity_alias WHERE alias_norm LIKE ? ESCAPE '\\' LIMIT ?`,
      [`%${escapeLike(norm)}%`, cap],
    )) {
      push(String(row['entity_id'] ?? ''));
    }
    if (out.length < cap) {
      for (const row of rowsOf(
        db,
        `SELECT entity_id FROM entity_alias WHERE length(alias_norm) >= 2 AND ? LIKE '%' || alias_norm || '%' LIMIT ?`,
        [norm, cap * 2],
      )) {
        push(String(row['entity_id'] ?? ''));
      }
    }
  }

  // ③ FTS 兜底（分词级命中：别名里的一段词也能定位）
  if (out.length < cap) {
    for (const hit of queryDocs(db, term, { kinds: ['entity'], limit: cap })) push(hit.refId);
  }
  return out;
}

export interface LinkedEntityResult {
  hits: SpiritSearchHit[];
  /** 这些实体在上游知识里被引用过多少条（只给计数，正文走 memory_search）。 */
  upstreamKnowledge: number;
}

/**
 * 展开实体关联的交付与任务线（各 ≤ PER_KIND×实体数）。
 *
 * @param entityIds `resolveEntityIds` 的产物
 */
export function linkedEntityRecords(
  db: DatabaseSync | null | undefined,
  entityIds: readonly string[],
  opts: { perKind?: number } = {},
): LinkedEntityResult {
  if (db === null || db === undefined || entityIds.length === 0) return { hits: [], upstreamKnowledge: 0 };
  const perKind = Math.max(1, Math.min(10, Math.floor(opts.perKind ?? PER_KIND)));
  const ids = entityIds.slice(0, 12);
  const placeholders = ids.map(() => '?').join(', ');
  const hits: SpiritSearchHit[] = [];

  // 交付：delivery_entity → txn_entry（未取代）
  for (const row of rowsOf(
    db,
    `SELECT t.id AS id, t.card_line AS card_line, t.ts_ms AS ts, de.entity_id AS entity_id
       FROM delivery_entity de
       JOIN txn_entry t ON t.id = de.delivery_id
      WHERE de.entity_id IN (${placeholders}) AND t.superseded_by IS NULL
      ORDER BY t.ts_ms DESC LIMIT ?`,
    [...ids, perKind * ids.length],
  )) {
    hits.push({
      kind: 'delivery',
      id: String(row['id'] ?? ''),
      title: String(row['card_line'] ?? ''),
      ts: Number(row['ts'] ?? 0),
      via: String(row['entity_id'] ?? ''),
    });
  }

  // 任务线：delivery_entity → task_delivery → task（未撤销关联）
  for (const row of rowsOf(
    db,
    `SELECT k.id AS id, k.title AS title, k.updated_at AS ts, de.entity_id AS entity_id
       FROM delivery_entity de
       JOIN task_delivery td ON td.delivery_id = de.delivery_id AND td.superseded_at IS NULL
       JOIN task k ON k.id = td.task_id
      WHERE de.entity_id IN (${placeholders})
      ORDER BY k.updated_at DESC LIMIT ?`,
    [...ids, perKind * ids.length],
  )) {
    hits.push({
      kind: 'task',
      id: String(row['id'] ?? ''),
      title: String(row['title'] ?? ''),
      ts: Number(row['ts'] ?? 0),
      via: String(row['entity_id'] ?? ''),
    });
  }

  // 上游知识：只计数
  let upstreamKnowledge = 0;
  for (const row of rowsOf(
    db,
    `SELECT COUNT(*) AS n FROM entity_record_ref WHERE entity_id IN (${placeholders})`,
    ids,
  )) {
    const n = Number(row['n'] ?? 0);
    if (Number.isFinite(n)) upstreamKnowledge = n;
  }

  return { hits: hits.filter((hit) => hit.id !== '' && hit.title !== ''), upstreamKnowledge };
}