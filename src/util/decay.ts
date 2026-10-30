/**
 * 近因衰减（单一实现点）。
 *
 * 形状取自姊妹包的 `agingWeightOf`，**粒度改成毫秒**：记忆面的时效是"天"，
 * 情绪面的时效是"小时"，同一套公式、两个时间尺度。
 *
 * 地板 0.5 是刻意的：衰减只该让**相近强度之间**新鲜者优先，而不该让"相关但久远"的
 * 回忆彻底沉底——人会想起很久以前的事，只要它真的相关。`halfLifeMs <= 0` 即关闭衰减。
 */

export function decayWeight(timeMs: number, now: number, halfLifeMs: number): number {
  if (!(halfLifeMs > 0)) return 1;
  const delta = Math.max(0, now - timeMs);
  return Math.max(0.5, Math.pow(0.5, delta / halfLifeMs));
}

/** 是否已陈旧（超过 `staleAfterMs` 没有任何新条目）。`staleAfterMs <= 0` = 关闭陈旧判定。 */
export function isStale(lastTsMs: number, now: number, staleAfterMs: number): boolean {
  if (!(staleAfterMs > 0)) return false;
  return now - lastTsMs > staleAfterMs;
}
