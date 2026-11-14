/**
 * 全域搜索组合（v0.8.14 / v19 加实体关联展开）：体验轨 + 其它轨 + 实体关联记录，按时间倒序。
 *
 * 关联展开的语义：某个词命中了一个**实体**（任一别名），那么"属于这个实体的交付与任务线"
 * 也算这个搜索的答案——这正是多名称搜索的价值。命中行带 `via=<entityId>` 标明"打哪来的"。
 *
 * 上游知识（prime-memory 的 L1）**不进结果**：只回计数的是 `linkedEntityRecords` 的内部产物，
 * 正文由模型走 `memory_search`（不造第二真源）。
 *
 * 本文件不出现在任何 SQL（门禁 TA.6(b) 的安全边际：跨轨读取都在各自读面里做完）。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { SpiritSearchHit } from '../contract.js';
import { resolveEchoId } from '../echo/identity.js';
import { linkedEntityRecords, resolveEntityIds } from './entity-alias-search.js';
import { searchExperiences } from './experience-search.js';
import { searchRecords } from './records-search.js';

/**
 * 按文本搜所有记录类型（不让"类型"把已经存在的东西挡在搜索外面）。
 *
 * @param db - 权威库；unavailable ⇒ []
 * @param q - 搜索词
 * @param limit - 返回条数上限（默认 24）
 */
export function searchAll(db: DatabaseSync | null | undefined, q: string, limit = 24): SpiritSearchHit[] {
  const term = q.trim();
  if (db === null || db === undefined || term === '') return [];

  // 实体多名称 → 关联展开（v19）：先解析实体，再把"属于它"的交付/任务线并进来
  const entityIds = resolveEntityIds(db, term, 3);
  const linked = linkedEntityRecords(db, entityIds);

  const merged: SpiritSearchHit[] = [
    ...searchExperiences(db, term, 6).map((hit) => ({ ...hit })),
    ...searchRecords(db, term, 6).map((hit) => ({ ...hit })),
    ...linked.hits,
  ];

  // 去重：同一交付既可能直接命中、又可能经实体关联命中（后者信息量更低，先入者胜）
  const seen = new Set<string>();
  const deduped: SpiritSearchHit[] = [];
  for (const hit of merged) {
    const key = `${hit.kind}:${hit.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(hit);
  }
  deduped.sort((a, b) => b.ts - a.ts);
  return deduped.slice(0, Math.max(1, Math.min(60, Math.floor(limit)))).map((hit) => {
    const echoId = resolveEchoId(db, hit.kind, hit.id);
    return echoId === undefined ? hit : { ...hit, echoId };
  });
}