/**
 * 近因路（路 A）：本会话刚发生的体验条目 → 进卡片段。
 *
 * **零滞后是这条路的立身之本**：它只读实时钩子写进内存镜像/库的条目，绝不为了"更全"
 * 去等 DRSC——collector 是扫盘投影（interval 30s、新鲜度 ≤1 分钟），当前会话刚产生的
 * 回合很可能不在里面。等它就等于把"即时回忆"做成"延迟回忆"。
 *
 * 排序：先按近因权重，同分按 tsMs、再按 id 稳定序——排序不稳定会直接破
 * "同 Mood + 同召回 ⇒ 卡文本字节全等"这条可测断言。
 */

import { rankBy, takeTop } from './score.js';
import type { ExperienceEntry } from '../types.js';

export interface RecentOptions {
  now: number;
  halfLifeMs: number;
  limit: number;
}

/** 近因路取片段（返回体验句文本，按新→旧）。 */
export function recentLines(entries: readonly ExperienceEntry[], opts: RecentOptions): string[] {
  const usable = entries.filter((entry) => entry.supersededBy === undefined && entry.text !== '');
  const ranked = rankBy(
    usable,
    () => 1,
    { now: opts.now, halfLifeMs: opts.halfLifeMs, tsOf: (item) => (item as ExperienceEntry).tsMs, idOf: (item) => (item as ExperienceEntry).id },
  );
  return takeTop(ranked, opts.limit).map((entry) => entry.text);
}

/** 近因路是否有条目可给（决定"要不要发卡"时比数组长短更直白）。 */
export function hasRecent(entries: readonly ExperienceEntry[]): boolean {
  return entries.some((entry) => entry.supersededBy === undefined && entry.text !== '');
}
