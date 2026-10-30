/**
 * 采集与生效确认：`session/event` → 轮内信号累加器；自家注入行进日志 → 提交指纹。
 *
 * 两个顺序敏感的点（都是姊妹包踩过的位置）：
 * 1. **确认判定必须排在其它过滤之前**。若先按 `source.kind === 'user'` 之类的条件短路，
 *    自家行（`kind: 'plugin:spirit'`）会在到达确认逻辑前就被丢掉，指纹永不提交，
 *    表现是"每轮都重发同一张卡"或"永远不再发卡"两种相反的错觉。
 * 2. **不猜字段**：事件形状读不到就什么也不做（漏采下一轮还会补上，猜错则是静默失真）。
 */

import type { Context } from '@deepseek-ai/cordis';
// 事件名靠这包的 module augmentation 进入类型域；不拉进来 `ctx.on('session/event')` 会报
// `not assignable to keyof Events`（看着像事件名写错，实际是声明没进程序）。
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent';

import { SPIRIT_SOURCE_KIND } from '../contract.js';
import type { Spirit } from '../spirit.js';
import { sessionIdOfSession } from '../util/host-shape.js';

export interface ObserveHookDeps {
  spirit: Spirit;
  logger: { warn(message: string): void };
  now?: () => number;
}

export function registerCardObserve(ctx: Context, deps: ObserveHookDeps): void {
  const now = deps.now ?? Date.now;
  ctx.on('session/event', (session, event) => {
    try {
      const raw = event as { type?: unknown; seq?: unknown; data?: unknown } | null | undefined;
      const type = typeof raw?.type === 'string' ? raw.type : '';
      if (type === '') return;
      const data = (raw?.data ?? {}) as { id?: unknown; source?: { kind?: unknown } };
      const seq = typeof raw?.seq === 'number' ? raw.seq : undefined;
      const sessionId = sessionIdOfSession(session);

      // ── 第一段：必须先于任何业务过滤的两个对账动作 ──
      // 1) 生效确认：自家行 kind 不是 user，先按 user 过滤就会永不确认，
      //    表现为"同一档反复重发"或"再也不发卡"两种相反的错觉。
      if (type === 'user/message' && data.source?.kind === SPIRIT_SOURCE_KIND && typeof data.id === 'string') {
        // seq 一并传下去：它是"下一轮回到表面核卡还在不在"的唯一凭据
        deps.spirit.confirmInjected(data.id, seq);
      }
      // 2) 压缩重置：不重置则卡被摘要掉后 `unchanged` 门永久阻止重发
      //    （不报错，只是"压缩一次后角色再也没情绪"）。
      if (type === 'compaction/end' && sessionId !== '') {
        deps.spirit.resetCardState(sessionId, 'compact');
      }

      // ── 第二段：喂采集器 ──
      if (!deps.spirit.shouldObserve()) return;
      if (sessionId === '') return;
      deps.spirit.observeEvent(sessionId, { type, data: raw?.data }, now());
    } catch (err) {
      deps.logger.warn(`[spirit] 事件采集异常（忽略本轮）：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // agent 创建时若是压缩/清空带来的重建，同样重置发卡凭据（两个信号各自都会漏）
  ctx.on('agent/created', (payload) => {
    try {
      const source = (payload as { source?: unknown }).source;
      if (source !== 'compact' && source !== 'clear') return undefined;
      const agent = (payload as { agent?: { session?: unknown; id?: unknown } }).agent;
      const key = sessionIdOfSession(agent?.session) || String(agent?.id ?? '');
      if (key !== '') deps.spirit.resetCardState(key, source);
    } catch {
      /* 重建路径不抛 */
    }
    return undefined;
  });

  // agent 销毁即释放其运行态；会话级采集态随 session/end 语义自然淘汰（有顶在 watcher 侧）
  ctx.on('agent/disposed', (payload: unknown) => {
    try {
      const agent = (payload as { agent?: { id?: unknown } } | null | undefined)?.agent;
      if (typeof agent?.id === 'string') deps.spirit.release(agent.id);
    } catch {
      /* 销毁路径不抛 */
    }
  });
}
