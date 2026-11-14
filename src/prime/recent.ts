/**
 * "最近做了什么"入口（v0.8.22）：按时间窗取生涯流程档行，供 `spirit_history` / `action=recent` 共用。
 *
 * 为什么单独成模块：模型问"这周/最近做了什么"时给不出关键词，`recall(q)` 天然不适用；
 * 这里只做**时间窗选取**（7 天 → week；30 天 → week+month；更久 → 再加里程碑），
 * 不引入新的存储语义，便于单测。
 */
import type { DistillDigestRow } from '../contract.js';

/** 按回看天数选档：≤7 天只要 week；≤30 天加 month；始终带里程碑。 */
export function selectRecentDigests(digests: readonly DistillDigestRow[], days: number): DistillDigestRow[] {
  const wanted = new Set<string>(['week', 'milestone']);
  if (days > 7) wanted.add('month');
  const order: Record<string, number> = { week: 0, month: 1, milestone: 2 };
  return digests
    .filter((digest) => wanted.has(digest.tier))
    .sort((left, right) => (order[left.tier] ?? 9) - (order[right.tier] ?? 9));
}

export interface RecentLine {
  tier: string;
  line: string;
}

/**
 * 取档内的行（可再按关键词过滤），并限量。
 *
 * @param days - 回看天数（只用于选档）
 * @param q - 可选关键词（空 = 全给）
 * @param limit - 行数上限（默认 12，封顶 30）
 */
export function recentLines(
  digests: readonly DistillDigestRow[],
  opts: { days?: number; q?: string; limit?: number } = {},
): RecentLine[] {
  const days = Number.isFinite(opts.days) ? Math.max(1, Math.floor(opts.days as number)) : 7;
  const keyword = (opts.q ?? '').trim();
  const limit = Math.max(1, Math.min(30, Math.floor(Number.isFinite(opts.limit) ? (opts.limit as number) : 12)));
  const out: RecentLine[] = [];
  for (const digest of selectRecentDigests(digests, days)) {
    for (const line of digest.summary.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      if (keyword !== '' && !trimmed.includes(keyword)) continue;
      out.push({ tier: digest.tier, line: trimmed });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
