/**
 * 宿主能力探测与降级决策。
 *
 * 为什么要探测而不是假定存在：本插件声明的是**多条 rc 线**，各线的服务面不一致
 * （`webRuntime`→`webStartup` 更名、`snapshotEvents()` 方法与 `events` 数组两种形状、
 * 有的线根本没有 `systemPrompt.section`）。假定存在的结果不是降级，是**启动失败拖垮宿主 fiber**。
 *
 * 纪律：所有读取都经 `getService`/属性 try 兜住——cordis 的 ctx 代理在**未声明 inject**
 * 时属性读会抛，不是一句 `undefined` 那么客气。
 */

/** 探测到的能力位；`false` 即对应功能整段停用（不是报错）。 */
export interface HostCapabilities {
  /** `ctx.systemPrompt.section` 可用 ⇒ 人格区进系统提示。 */
  systemPromptSection: boolean;
  /** `ctx.sessions` 服务可用 ⇒ 能拿 surface.nodes 做取代态对账。 */
  sessionsService: boolean;
  /** 宿主有 `registerMessageProjection`（v0.1 不用，仅作信息位记录）。 */
  registerMessageProjection: boolean;
  /** 有 webServer/connection ⇒ 能挂 RPC 面。 */
  rpcSurface: boolean;
}

/** 会话事件的可读形状。 */
export type SessionEventsShape = 'events' | 'snapshotEvents' | 'none';

function isFunction(value: unknown): value is () => unknown {
  return typeof value === 'function';
}

/**
 * 宽容取服务：先试直接属性读，再试 `ctx.get(name)`，两者都抛/都缺 ⇒ `undefined`。
 *
 * 顺序不能反：直接属性读在已声明 inject 时最快且类型最准；`ctx.get` 是未声明时的兜底。
 */
export function getService(ctx: unknown, name: string): unknown {
  if (typeof ctx !== 'object' || ctx === null) return undefined;
  const record = ctx as Record<string, unknown>;
  try {
    const direct = record[name];
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    /* 未声明 inject 的属性读会抛：落到 ctx.get */
  }
  const get = record['get'];
  if (isFunction(get)) {
    try {
      return (get as (key: string) => unknown).call(ctx, name);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function probeCapabilities(ctx: unknown): HostCapabilities {
  const systemPrompt = getService(ctx, 'systemPrompt') as Record<string, unknown> | undefined;
  const sessions = getService(ctx, 'sessions') as Record<string, unknown> | undefined;
  return {
    systemPromptSection:
      systemPrompt !== undefined && isFunction(systemPrompt['section']),
    sessionsService: sessions !== undefined,
    registerMessageProjection:
      sessions !== undefined && isFunction(sessions['registerMessageProjection']),
    rpcSurface:
      getService(ctx, 'webServer') !== undefined || getService(ctx, 'connection') !== undefined,
  };
}

/** 判定会话事件形状（宿主自 0.2.0-rc.1 起 `Session.events` 有缺失面，不是所有线都有数组）。 */
export function detectSessionEventsShape(session: unknown): SessionEventsShape {
  if (typeof session !== 'object' || session === null) return 'none';
  const record = session as Record<string, unknown>;
  if (Array.isArray(record['events'])) return 'events';
  if (isFunction(record['snapshotEvents'])) return 'snapshotEvents';
  return 'none';
}

/**
 * 三级取形读会话事件：数组属性 → `snapshotEvents()` 方法 → 空数组。
 *
 * 返回空数组**不等于**"这个会话没有事件"（可能只是形状不认识），调用方据此只能退
 * 粗标记，不能把"读不到"当成"不存在"来清状态——那是姊妹包 issue #8 修过的同类误判。
 */
export function readSessionEvents(session: unknown): readonly Record<string, unknown>[] {
  if (typeof session !== 'object' || session === null) return [];
  const record = session as Record<string, unknown>;
  if (Array.isArray(record['events'])) return record['events'] as readonly Record<string, unknown>[];
  const snap = record['snapshotEvents'];
  if (isFunction(snap)) {
    try {
      const out = (snap as () => unknown).call(session);
      return Array.isArray(out) ? (out as readonly Record<string, unknown>[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}
