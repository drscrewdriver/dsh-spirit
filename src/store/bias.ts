/**
 * 条件化 bias 的派生缓存表（刀4 的存储面）。
 *
 * 定性（重要，这是全仓唯一允许 UPDATE 业务列的表）：
 * - **可重算派生缓存，不是经历真源**——删光可以从 experience 重建，所以它不受
 *   append-only 纪律约束（append-only 在这里反而会坏语义：「短期抑制」需要过期值，
 *   无界追加的历史行永远读不到顶）。`db/schema.ts` 头注与本文件互为声明。
 * - 写只在冷路径（turn/end 结算里由编排层带来）；读是 pre-step 的 O(1) 主键查表，
 *   **禁扫表**（每轮现算等价 LIKE 全扫，违背"对话延迟永远比少一条回忆贵"）。
 * - 过期不删行：读侧按半衰期判过期（量化档，与 recall/form 的注意力权重同式同律），
 *   行留着但值失效——与库的「不 DELETE」总纪律保持同形。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { MinimalLogger } from '../persona/store.js';

export class BiasStore {
  /** 降级内存镜像（有顶）。 */
  private readonly mirror = new Map<string, { band: number; tsMs: number }>();

  constructor(private readonly deps: { db: DatabaseSync | null; logger: MinimalLogger }) {}

  /**
   * 冷路径 upsert：调用方（编排层）已做过取严比较，这里写入收到的值本身
   * （镜像里同键更弱时不回落，防乱序覆盖）；band <= 0 = 显式撤销，允许覆盖。
   */
  upsert(workspaceId: string, actionKey: string, band: number, tsMs: number): void {
    if (actionKey === '') return;
    const key = `${workspaceId}\u0000${actionKey}`;
    const prevMirror = this.mirror.get(key);
    const finalBand = band <= 0 ? band : (prevMirror !== undefined && prevMirror.band > band ? prevMirror.band : band);
    this.mirror.set(key, { band: finalBand, tsMs });
    if (this.mirror.size > 200) {
      const oldest = this.mirror.keys().next();
      if (!oldest.done) this.mirror.delete(oldest.value);
    }
    if (this.deps.db === null) return;
    try {
      this.deps.db
        .prepare(
          `INSERT INTO action_bias (workspace_id, action_key, band, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(workspace_id, action_key) DO UPDATE SET band = excluded.band, updated_at = excluded.updated_at`,
        )
        .run(workspaceId, actionKey, finalBand, tsMs);
    } catch (err) {
      // 派生缓存写失败不升级成对话故障：下一轮查表拿旧值或拿不到，都能如实降级
      this.deps.logger.warn(`[spirit] bias 写入失败（本轮用镜像值）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * pre-step 读面：O(1) 主键查表 + 半衰期过期判定。
   *
   * 过期规则与注意力权重同律：跨过一个完整半衰期 ⇒ 档降一级（strong→hesitant），
   * 跨过两个 ⇒ 失效。量化保证同一 half-life 窗口内读数稳定（不随每轮 now 漂移）。
   *
   * @param halfLifeMs 0 ⇒ 不过期（pin 基线用）
   */
  read(workspaceId: string, actionKey: string, now: number, halfLifeMs: number): number | undefined {
    const key = `${workspaceId}\u0000${actionKey}`;
    let band: number | undefined;
    let updatedAt: number | undefined;
    if (this.deps.db !== null) {
      try {
        const raw = this.deps.db
          .prepare(`SELECT band, updated_at FROM action_bias WHERE workspace_id = ? AND action_key = ?`)
          .get(workspaceId, actionKey) as { band?: number; updated_at?: number } | undefined;
        if (raw !== undefined && typeof raw.band === 'number') {
          band = raw.band;
          updatedAt = typeof raw.updated_at === 'number' ? raw.updated_at : undefined;
        }
      } catch {
        band = undefined; // 查表失败 = 没有教训，不编造
      }
    }
    if (band === undefined) {
      const hit = this.mirror.get(key);
      if (hit === undefined) return undefined;
      band = hit.band;
      updatedAt = hit.tsMs;
    }
    if (band <= 0) return undefined;
    if (updatedAt === undefined || !(halfLifeMs > 0)) return band;
    const crossed = Math.floor(Math.max(0, now - updatedAt) / halfLifeMs);
    const decayed = band - crossed;
    return decayed > 0 ? decayed : undefined;
  }
}
