/**
 * 存储不可用时的降级决策表。
 *
 * 核心判断：**"库打不开"不能变成"角色没有状态"**。体验卡的价值在"此刻是什么感觉"，
 * 这件事内存里就成立；落库与跨会话检索才是库的专属能力。所以：
 * - 打不开库 ⇒ 退 `memory-only`（本轮实时条目照进内存、卡照常出，只是不落库、不检索历史、
 *   不跨会话），并把原因一次性报出来；
 * - 连内存都不可用（配置关了）⇒ 才是 `off`。
 *
 * 反过来说，最坏的失败方式是在 hook 里抛穿主会话——那会让用户以为宿主坏了。
 */

export type DegradeMode = 'full' | 'memory-only' | 'off';

export interface DegradeDecision {
  mode: DegradeMode;
  /** 报给用户/日志的原因（不含敏感内容）。 */
  reason: string;
}

/** node:sqlite 不可用的典型错误名/文案（各 Node 版本措辞不同，取并集判断）。 */
const SQLITE_UNAVAILABLE = [
  'node:sqlite',
  'no such module',
  'err_unknown_builtin_module',
  'database is not open',
] as const;

/** 把未知异常收窄成一句可读原因（不泄露路径/SQL 细节）。 */
export function errReason(err: unknown): string {
  if (err instanceof Error) return err.name === 'Error' ? err.message : `${err.name}: ${err.message}`;
  return String(err);
}

/** 是否属于"这个 Node/宿主根本没有 sqlite 可用"这一类（不可重试，只能降级）。 */
export function isSqliteUnavailable(err: unknown): boolean {
  const text = errReason(err).toLowerCase();
  return SQLITE_UNAVAILABLE.some((needle) => text.includes(needle));
}

/**
 * 依据异常决定降级档位。
 *
 * @param err 打开/建表过程中抛出的异常
 */
export function decideDegrade(err: unknown): DegradeDecision {
  if (isSqliteUnavailable(err)) {
    return { mode: 'memory-only', reason: `node:sqlite 不可用（${errReason(err)}）——不落库、不检索历史，本轮实时条目与回忆卡照常` };
  }
  return { mode: 'memory-only', reason: `存储初始化失败（${errReason(err)}）——本轮实时条目与回忆卡照常，历史路停用` };
}
