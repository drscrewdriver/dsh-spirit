/**
 * 事务轨的接线面（T3.4）：`session/event` 旁路 → 信号包 → collector.enqueue。
 *
 * 三处顺序/边界纪律（都是本仓先例）：
 * 1. **这是旁路，不是 pre-step 串行链**。卡片链是同步的，事务轨要跑 LLM，绝不能把它挂进
 *    pre-step——挂了就是"每轮卡片等一次模型"。这里只观察、只入队，`enqueue` 本身不 await。
 * 2. **关时零副作用**：`txn.enabled=false` 时连采集都不做（不攒状态、不入队、不跑），
 *    与 `countAll()` 必须为 0 的灰度承诺成对。
 * 3. **不猜字段**：事件形状读不到就什么也不做；身份（sessionId / workspaceId）拿不到就跳过，
 *    宁缺毋造——猜出来的身份会把落库行标成错的会话。
 */

import type { Context } from '@deepseek-ai/cordis';
// 事件名靠这包的 module augmentation 进入类型域；不拉进来 `ctx.on('session/event')` 会报
// `not assignable to keyof Events`（看着像事件名写错，实际是声明没进程序）。
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent';

import type { SpiritConfig } from '../contract.js';
import type { TransactionWatcher } from '../transaction/watcher.js';
import type { TxnCollector } from '../transaction/collector.js';
import { sessionIdOfSession } from '../util/host-shape.js';

export interface TxnObserveDeps {
  watcher: TransactionWatcher;
  collector: TxnCollector;
  cfg: () => SpiritConfig;
  logger: { warn(message: string): void };
  now?: () => number;
}

/** 工作区标识：只读事件的 `workspace_id`，拿不到退空串（照 host-shape 的口径，不猜）。 */
function workspaceOfEventData(data: Record<string, unknown>): string {
  const value = data['workspace_id'];
  return typeof value === 'string' ? value : '';
}

export function registerTxnObserve(ctx: Context, deps: TxnObserveDeps): void {
  const now = deps.now ?? Date.now;

  ctx.on('session/event', (session, event) => {
    try {
      if (!deps.cfg().txn.enabled) return; // 关时：连采集都不做（零落库的半边靠这条）
      const raw = event as { type?: unknown; data?: unknown } | null | undefined;
      const type = typeof raw?.type === 'string' ? raw.type : '';
      if (type === '') return;
      const sessionId = sessionIdOfSession(session);
      if (sessionId === '') return;

      const data = (raw?.data ?? {}) as Record<string, unknown>;
      const workspaceId = workspaceOfEventData(data);
      deps.watcher.observe(sessionId, workspaceId, { type, data: raw?.data }, now());

      // 身份来自事件流本身（turn/end 带 session_id/turn_seq），测试里由假事件流喂
      if (type === 'turn/end' && deps.watcher.hasActivity(sessionId)) {
        const signals = deps.watcher.takeSignals(sessionId, now());
        if (signals === null) return; // 空轮 / 无身份：宁缺毋造
        const got = deps.collector.enqueue(signals);
        if (!got.accepted && got.reason !== 'queue-full') {
          // 闸拒只记日志不抛：闸语义是"本轮不跑"，不是出错
          deps.logger.warn(`[spirit] 事务轨本轮未受理（${got.reason}）`);
        }
      }
    } catch (err) {
      deps.logger.warn(`[spirit] 事务轨事件采集异常（忽略本轮）：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // 会话销毁：释放累加器（照 card-observe 先例——事务轨没有未竟账要结算）。
  // 注意键：watcher 按 sessionId 键（事件流只给会话），所以这里必须用会话键而不是 agentId。
  ctx.on('agent/disposed', (payload: unknown) => {
    try {
      if (!deps.cfg().txn.enabled) return;
      const agent = (payload as { agent?: { id?: unknown; session?: unknown } } | null | undefined)?.agent;
      const sessionId = sessionIdOfSession(agent?.session) || (typeof agent?.id === 'string' ? agent.id : '');
      if (sessionId !== '') deps.watcher.release(sessionId);
    } catch {
      /* 销毁路径不抛 */
    }
  });
}
