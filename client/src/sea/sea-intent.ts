/**
 * 「记忆星海」页内跳转意图（v0.8.1）。
 *
 * 为什么需要一层模块单例：侧栏（dsh-brief-sidebar）只能通过 window 事件请求
 * "打开星海回响"，而面板是宿主 `main` 座位按需挂载的——事件到达时页面可能
 * 还没挂载。意图先落在这里，SeaPanel 挂载时 `take()`，已挂载时靠 `subscribe`
 * 当场切页签。token 单调递增，保证"连续两次深链"不会因为 React 批处理被吞。
 */
/**
 * 深链目标：`echo` = 翻阅 → 回响（条目面）；`graph` = 星海星图面。
 * 两个目标都是「回响」的邻居视图：前者看被召回的段落，后者看它们在星图上的位置。
 */
export type SeaIntentTarget = 'echo' | 'graph';

export type SeaIntent =
  | { tab: 'records'; view: 'echo' }
  | {
    tab: 'sea';
    /** v0.8.12：星图定位——按 echo 号打开星海并选中对应星点。 */
    focusEchoId?: string;
  };

export interface SeaIntentRequest {
  intent: SeaIntent;
  token: number;
}

type Listener = (request: SeaIntentRequest) => void;

let pending: SeaIntentRequest | undefined;
let token = 0;
const listeners = new Set<Listener>();

export const seaIntent = {
  /** 记录最新意图并通知已挂载的面板；返回本次 token。 */
  request(intent: SeaIntent): number {
    token += 1;
    const request = { intent, token };
    pending = request;
    for (const listener of listeners) listener(request);
    return token;
  },

  /** 取走挂载前积压的意图（取走即清空，避免重复应用）。 */
  take(): SeaIntentRequest | undefined {
    const request = pending;
    pending = undefined;
    return request;
  },

  /** 订阅后续意图；退订函数与 set 语义一致。 */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
