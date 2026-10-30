/**
 * DRSC 可用性探测（带 TTL 缓存）。
 *
 * 判定口径借用插件生态既有的四值语义——`skipped` 是**中性无据**，不是异常：
 * - `skipped`：本插件配置关了，或宿主里根本没有 collector。历史路停用，但这是
 *   完全正常的部署形状，**不该出现在故障提示里**（把"无法判定"当"异常"，用户会
 *   看到一屏假故障）。
 * - `ok`：`op=status` 通、包络合法。
 * - `warn`：配置声明要用，但请求失败/超时/包络破损——有据可疑，面板如实显示原因。
 * - `fail`：保留给"本插件自己坏了"，探测路径永不产出它。
 *
 * 缓存 TTL 的存在理由：探测每轮都做会把一个 loopback 请求压在每轮的串行路径上；
 * 而 collector 的同步周期本身是 30s 量级，15s 的缓存不会让结论变陈旧。
 */

import { VERDICT_OK, VERDICT_SKIPPED, VERDICT_WARN, type SpiritVerdict } from '../types.js';
import type { DrscClient } from './client.js';
import { DrscClientError } from './client.js';

export interface DrscProbeResult {
  verdict: SpiritVerdict;
  /** 判定依据（一句人话，供面板与日志；不含敏感内容）。 */
  reason?: string;
  sessionCount?: number;
  /** 已投影 segment 数（0 = 装了但还没内容，不是故障）。 */
  segmentCount?: number;
  checkedAtMs: number;
}

export interface DrscProbeDeps {
  client: DrscClient;
  /** 每次现读（配置可热更）。 */
  enabled: () => boolean;
  ttlMs: () => number;
  now?: () => number;
}

export class DrscProbe {
  private cached?: DrscProbeResult;

  constructor(private readonly deps: DrscProbeDeps) {}

  /** 命中缓存即不重复打网络。 */
  async check(): Promise<DrscProbeResult> {
    const now = (this.deps.now ?? Date.now)();
    if (this.cached !== undefined && now - this.cached.checkedAtMs < this.deps.ttlMs()) return this.cached;
    const result = await this.run(now);
    this.cached = result;
    return result;
  }

  /** 强制下次重新探测（收到宿主重启用 collector 之类的信号时用）。 */
  invalidate(): void {
    this.cached = undefined;
  }

  /** 是否可以直接用（调用方唯一的判断口径，避免到处比 verdict）。 */
  async usable(): Promise<boolean> {
    return (await this.check()).verdict === VERDICT_OK;
  }

  /**
   * 最后一次探测结论（面板读，**不打网络**）。
   *
   * 还没探过 ⇒ `skipped`（中性无据）。不能报 `warn`：面板会把"本插件还没走过一轮"
   * 显示成故障；也不能报 `ok`：那是假数据。
   */
  lastVerdict(): SpiritVerdict {
    return this.cached?.verdict ?? VERDICT_SKIPPED;
  }

  private async run(now: number): Promise<DrscProbeResult> {
    if (!this.deps.enabled()) {
      return { verdict: VERDICT_SKIPPED, reason: '未启用或宿主未装配 collector', checkedAtMs: now };
    }
    try {
      const status = await this.deps.client.status();
      // 上次同步失败是有据可疑（collector 在但投影链坏了），不是 ok；
      // 但**读不到** last_sync.ok 不算失败——未知不当异常（否则又是一屏假故障）。
      if (status.lastSyncOk === false) {
        return { verdict: VERDICT_WARN, reason: 'collector 上次同步失败', checkedAtMs: now };
      }
      return {
        verdict: VERDICT_OK,
        sessionCount: status.sessionCount,
        segmentCount: status.segmentCount,
        checkedAtMs: now,
      };
    } catch (err) {
      // 不可达/超时/包络破损都归 warn（有配置依据的可疑），绝不抛穿调用链
      const reason = err instanceof DrscClientError ? err.message : `collector 探测异常：${String(err)}`;
      return { verdict: VERDICT_WARN, reason, checkedAtMs: now };
    }
  }
}
