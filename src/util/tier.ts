/**
 * 档位与整数的双重防御钳制。
 *
 * 为什么必须有：写侧一旦被塞进非法值（脏配置、外部回写、未来某条 RPC 写入口），
 * 不能让它把整个会话掀掉。姊妹包为此修过一个真事故：`priority=-1` 让整段会话历史
 * 直接消失（写侧钳制 + 读侧自愈告警，不抛错、不静默丢弃）。本插件面对的是同一形状
 * 的风险——情绪档位与卡预算都是"脏一点就静默坏"的键。
 *
 * 口径：
 * - 写侧 `clampTier` / `clampInt`：非法值退合法域内兜底，**不抛**；
 * - 读侧 `isDirtyTier`：调用方据此告警并就地自愈，存量脏行不必迁移。
 */

/**
 * 把任意值收窄到枚举域内。
 *
 * @param value 待收窄值（unknown：外部来源一律当不可信）
 * @param allowed 取值域（单源来自 `src/types.ts`）
 * @param fallback 不在域内时的落点
 */
export function clampTier<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  return fallback;
}

/** 是否为脏值（读侧判定，配合一次性告警用；不做修正）。 */
export function isDirtyTier<T extends string>(value: unknown, allowed: readonly T[]): boolean {
  return !(typeof value === 'string' && (allowed as readonly string[]).includes(value));
}

/**
 * 整数钳制：非有限 → 兜底；小数向下取整；越界夹到端点。
 *
 * 用 `Number.isFinite` 而非 `!Number.isNaN`：`Infinity` 会把预算撑成无上限，
 * 负数会把开关变成反义——两者都得退兜底，不能只挡 NaN。
 */
export function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const int = Math.floor(value);
  if (int < lo) return lo;
  if (int > hi) return hi;
  return int;
}
