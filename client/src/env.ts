/**
 * 浏览器半的运行环境类型面（刻意最小）：只按本 bundle 真正触达的能力建模。
 *
 * 官方 `dsh-client-modules` 不随包发布浏览器侧类型，多写一分就是将来对不上的假承诺。
 */

/** handoff 工厂的 require 参数：bundle 以 CJS 形态跑在 `factory(require)` 里。 */
declare const require: (id: string) => unknown;

/** 对宿主 require 的受控出口。 */
export function hostRequire(id: string): unknown {
  return require(id);
}

export interface SpiritClientCtx {
  slots: {
    inject(slot: string, factory: () => unknown): unknown;
    register(options: Record<string, unknown>, component: unknown): unknown;
  };
  /** 按名取客户端服务（不把可选服务写进声明式 inject：晚到会永久挂起 apply）。 */
  get(name: string): unknown;
}

/** 组件 props 里能拿到的会话上下文（宿主 zone 注入形状；两种形状都得接）。 */
export interface SeatProps {
  sessionId?: string;
  session?: { sessionId?: string };
}

/** 取会话 id：`props.sessionId` 与 `props.session.sessionId` 两条线各给过一种。 */
export function sessionIdOf(props: SeatProps): string {
  return props.sessionId ?? props.session?.sessionId ?? '';
}
