/**
 * 实体双向对齐（v0.8.18）：spirit `entity` ↔ 上游 graph_node / repo_key / workspace。
 *
 * 纪律：
 * 1. **只建链接，不新建/不合并实体**（合并不可逆，误配比漏配贵）；
 * 2. 归一化保守（小写 + 去空白/标点/括号），不做模糊/向量匹配；
 * 3. 知识性只存 `entity_record_ref`（id/type/ts），**不存正文**；
 * 4. 不读 experience（守 TA.6(b)），不写上游。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { L1EntityRow, L1RecordRow } from './l1-source.js';
import { META_KEY_ALIAS_STAMP } from '../db/schema.js';

/**
 * 归一化算法版本（B-3）：算法一改，`entity_alias.alias_norm` 全部失效 ⇒ 必须重建。
 * 戳变而未重建会出现"搜得到旧的、搜不到新的"，且两边都不报错。
 */
export const ENTITY_NORMALIZE_STAMP = 'nfkc-v2';

/**
 * 归一化实体名：**NFKC**（全角→半角）+ 去零宽 + 小写 + 去空白/标点/括号。
 *
 * 为什么加 NFKC：`ＤＳＨ`（全角）与 `dsh` 在原实现里是两条别名，用户搜不到自己填过的东西。
 * 为什么不做繁简折叠：需要大映射表且有语义误伤（人名/品牌里「發」≠「发」），
 * 繁简差异交给"疑似同一实体"的人工确认（`suggestEntityMerges`）。
 */
export function normalizeEntityName(value: string): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u2060\ufeff]/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-·:：/\\|.]+/gu, '')
    .replace(/[（）()【】[\]「」『』"'“”‘’]/gu, '');
}

/** 路径末段（E:\a\b\dsh-spirit → dsh-spirit）。 */
export function lastPathSegment(value: string): string {
  const parts = value.split(/[\\/]+/u).filter((item) => item.trim() !== '');
  return parts.length === 0 ? '' : parts[parts.length - 1]!;
}

/** spirit entity → entity_alias（幂等）。 */
export function buildEntityAliases(db: DatabaseSync | null | undefined): number {
  if (db === null || db === undefined) return 0;
  let count = 0;
  try {
    const rows = db.prepare(`SELECT id, name, aliases_json FROM entity`).all() as Array<Record<string, unknown>>;
    const insert = db.prepare(`INSERT OR IGNORE INTO entity_alias (alias_norm, entity_id, source) VALUES (?, ?, 'spirit')`);
    for (const row of rows) {
      const id = String(row['id'] ?? '');
      if (id === '') continue;
      const names: string[] = [String(row['name'] ?? '')];
      try {
        const parsed: unknown = JSON.parse(String(row['aliases_json'] ?? '[]'));
        if (Array.isArray(parsed)) names.push(...parsed.map((item) => String(item)));
      } catch {
        /* 坏 JSON ⇒ 只用 name */
      }
      for (const name of names) {
        const norm = normalizeEntityName(name);
        if (norm === '') continue;
        count += Number(insert.run(norm, id).changes ?? 0);
      }
    }
  } catch {
    return count;
  }
  return count;
}

export interface AlignResult {
  links: number;
  /** 上游实体中未能对齐的（只计数，不建实体）。 */
  unmatched: number;
}

/**
 * 上游实体 → spirit entity 链接（精确归一化匹配；repo/workspace 用末段匹配）。
 */
export function buildEntityLinks(db: DatabaseSync | null | undefined, upstream: readonly L1EntityRow[], now = Date.now()): AlignResult {
  if (db === null || db === undefined || upstream.length === 0) return { links: 0, unmatched: 0 };
  let links = 0;
  let unmatched = 0;
  try {
    const lookup = (norm: string): string[] => {
      const rows = db.prepare(`SELECT entity_id FROM entity_alias WHERE alias_norm = ?`).all(norm) as Array<Record<string, unknown>>;
      return rows.map((row) => String(row['entity_id'] ?? '')).filter((id) => id !== '');
    };
    const insert = db.prepare(
      `INSERT OR IGNORE INTO entity_upstream_link (entity_id, upstream_kind, upstream_id, confidence, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    );
    for (const item of upstream) {
      const candidates = new Set<string>();
      for (const alias of [item.name, ...item.aliases]) {
        const norm = normalizeEntityName(alias);
        if (norm !== '') for (const id of lookup(norm)) candidates.add(id);
      }
      // repo/workspace：按路径末段再匹配一次（codex 仓库 / 项目目录）
      for (const raw of [item.repoKey, item.workspaceId]) {
        const seg = normalizeEntityName(lastPathSegment(raw));
        if (seg !== '') for (const id of lookup(seg)) candidates.add(id);
      }
      if (candidates.size === 0) {
        unmatched += 1;
        continue;
      }
      const kind = item.repoKey !== '' ? 'repo_key' : 'graph_node';
      const upstreamId = item.repoKey !== '' ? item.repoKey : item.name;
      for (const entityId of candidates) {
        links += Number(insert.run(entityId, kind, upstreamId, now).changes ?? 0);
      }
    }
  } catch {
    return { links, unmatched };
  }
  return { links, unmatched };
}

/** 别名索引一条：归一化名 → entity id。 */
export interface AliasIndexEntry {
  alias: string;
  entityId: string;
}

/** 一次读出别名表（批量匹配用；避免每条文本都扫库）。 */
export function loadAliasIndex(db: DatabaseSync | null | undefined): AliasIndexEntry[] {
  if (db === null || db === undefined) return [];
  try {
    return (db.prepare(`SELECT alias_norm, entity_id FROM entity_alias`).all() as Array<Record<string, unknown>>)
      .map((row) => ({ alias: String(row['alias_norm'] ?? ''), entityId: String(row['entity_id'] ?? '') }))
      .filter((entry) => entry.alias.length >= 3 && entry.entityId !== '');
  } catch {
    return [];
  }
}

/** 用已加载的索引匹配实体（纯内存，供档生成批量用）。 */
export function matchEntitiesWithIndex(index: readonly AliasIndexEntry[], text: string, limit = 8): string[] {
  const normText = normalizeEntityName(text);
  if (normText === '') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of index) {
    if (seen.has(entry.entityId)) continue;
    if (normText.includes(entry.alias)) {
      seen.add(entry.entityId);
      out.push(entry.entityId);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** 从文本中找命中的 spirit 实体（保守：按归一化后的包含关系）。 */
export function matchEntitiesInText(db: DatabaseSync | null | undefined, text: string, limit = 8): string[] {
  if (db === null || db === undefined || text.trim() === '') return [];
  return matchEntitiesWithIndex(loadAliasIndex(db), text, limit);
}

/**
 * 知识性记录 → entity_record_ref（只存 id/type/ts，**不存正文**）。
 * 流程性记录不写 ref（由调用方收集 entities_json）。
 */
export function linkKnowledgeRecords(db: DatabaseSync | null | undefined, rows: readonly L1RecordRow[]): number {
  if (db === null || db === undefined || rows.length === 0) return 0;
  let inserted = 0;
  try {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO entity_record_ref (entity_id, upstream_record_id, l1_type, ts_ms) VALUES (?, ?, ?, ?)`,
    );
    const knowledge = new Set([
      'work_fact', 'work_method', 'tool_experience', 'common_pitfalls_experience', 'important_decision_experience',
      'development_practice_specification', 'development_code_specification', 'development_test_specification',
      'project_architecture', 'project_tech_stack', 'user_communication', 'instruction', 'work_artifact',
    ]);
    for (const row of rows) {
      if (!knowledge.has(row.type)) continue;
      for (const entityId of matchEntitiesInText(db, row.content, 4)) {
        inserted += Number(insert.run(entityId, row.id, row.type, row.tsMs).changes ?? 0);
      }
    }
  } catch {
    return inserted;
  }
  return inserted;
}

/**
 * 保证别名表与当前归一化算法一致（幂等；B-3）。
 *
 * 戳变 ⇒ 删 `source='spirit'` 的旧键后整表重建；`source='user'`（面板人工确认的别名）
 * **永不删**——那是人的判断，不能被算法换代抹掉。
 *
 * 失败只 warn、不抛（别名重建是增强面，不能阻开库）；停不下来的旧表比没有表好。
 */
export function ensureEntityAliases(
  db: DatabaseSync | null | undefined,
  opts: { warn?: (message: string) => void } = {},
): { rebuilt: boolean; aliases: number } {
  if (db === null || db === undefined) return { rebuilt: false, aliases: 0 };
  let stored: string | undefined;
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY_ALIAS_STAMP) as { value?: string } | undefined;
    stored = typeof row?.value === 'string' ? row.value : undefined;
  } catch {
    return { rebuilt: false, aliases: 0 };
  }
  if (stored === ENTITY_NORMALIZE_STAMP) return { rebuilt: false, aliases: 0 };
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`DELETE FROM entity_alias WHERE source = 'spirit'`);
      const aliases = buildEntityAliases(db);
      db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(META_KEY_ALIAS_STAMP, ENTITY_NORMALIZE_STAMP);
      db.exec('COMMIT');
      return { rebuilt: true, aliases };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败也只能继续走降级 */
      }
      throw err;
    }
  } catch (err) {
    opts.warn?.(`[spirit] 别名表重建失败（沿用旧表）：${err instanceof Error ? err.message : String(err)}`);
    return { rebuilt: false, aliases: 0 };
  }
}

/** 按实体名/别名解析到 entity id（精确归一化）。 */
export function resolveEntityId(db: DatabaseSync | null | undefined, entity: string): string | undefined {
  if (db === null || db === undefined || entity.trim() === '') return undefined;
  const norm = normalizeEntityName(entity);
  if (norm === '') return undefined;
  try {
    const hit = db.prepare(`SELECT entity_id FROM entity_alias WHERE alias_norm = ? LIMIT 1`).get(norm) as { entity_id?: string } | undefined;
    if (typeof hit?.entity_id === 'string' && hit.entity_id !== '') return hit.entity_id;
    const fuzzy = db.prepare(`SELECT entity_id FROM entity_alias WHERE alias_norm LIKE ? ESCAPE '\\' LIMIT 1`).get(`%${norm.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`) as { entity_id?: string } | undefined;
    return typeof fuzzy?.entity_id === 'string' && fuzzy.entity_id !== '' ? fuzzy.entity_id : undefined;
  } catch {
    return undefined;
  }
}
