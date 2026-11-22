/**
 * 交付 id 前缀单源判定（v0.9.1）：星图投影、毒水位自愈、以及任何"这条是不是交付"的判定，
 * 一律从这里走，不许再在调用方写 `startsWith('dlv-')` 或 `LIKE 'dlv-%'`。
 *
 * 为什么必须单源——同一家族已经断过两次：
 * - `ontology/extractor.ts` 从会话轮抽交付，id = `dlv-<key>`（key = `<session>/<turn>`）；
 * - `prime/l1-ingest.ts`（v0.8.24）从上游 L1 记忆重建，id = `l1-dlv:<record_id>`。
 *   写路径换了前缀，而 `rpc.ts` 的 sea-graph 投影还按老前缀筛，prime 整理出的 139 条交付
 *   在星图上全数蒸发（用户实报「从 prime-memory 整理出来的记忆在星图里无显示」）。
 * 再出现第三种生产者时，只需要改这一个函数 + 它的表驱动测试，不再 hunt-and-fix。
 *
 * 边界纪律：步骤遥测行（`txn-<session>/<turn>`，事务采集器产物）**不是**交付——
 * 它进翻阅/timeline，不进星图情绪层。判定按前缀白名单收口，不做"排除法"。
 */

/** 会话抽取轨交付前缀（`dlv-<key>`）。 */
export const DELIVERY_ID_PREFIX = 'dlv-';

/** 上游 L1 重建轨交付前缀（`l1-dlv:<record_id>`）。 */
export const L1_DELIVERY_ID_PREFIX = 'l1-dlv:';

/** 这条 txn_entry id 是不是交付点（星图可画 / 回填水位可认）。空串与缺格不算。 */
export function isDeliveryId(id: string): boolean {
  return id.startsWith(DELIVERY_ID_PREFIX) || id.startsWith(L1_DELIVERY_ID_PREFIX);
}

/**
 * SQL 谓词版（供必须走 `LIKE` 的查询侧使用，如 backfill 的"有产出会话"探测）。
 * 与 `isDeliveryId` 同一对前缀，两处若漂移以本常量为源。
 */
export const DELIVERY_ID_SQL_LIKE: readonly string[] = ['dlv-%', 'l1-dlv%'];

/** 拼成 `WHERE id LIKE ? OR id LIKE ?` 的占位符串与参数（调用方自行接 IN/OR 形状）。 */
export function deliveryIdLikeClause(column = 'id'): { clause: string; params: string[] } {
  const parts = DELIVERY_ID_SQL_LIKE.map(() => `${column} LIKE ?`);
  return { clause: parts.join(' OR '), params: [...DELIVERY_ID_SQL_LIKE] };
}
