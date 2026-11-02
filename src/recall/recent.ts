/**
 * 近因路（路 A）：本会话刚发生的体验条目 → 进卡片段。
 *
 * **零滞后是这条路的立身之本**：它只读实时钩子写进内存镜像/库的条目，绝不为了“更全”
 * 去等 DRSC——collector 是扫盘投影（interval 30s、新鲜度 ≤1 分钟），当前会话刚产生的
 * 回合很可能不在里面。等它就等于把“即时回忆”做成“延迟回忆”。
 *
 * 排序：先按近因权重，同分按 tsMs、再按 id 稳定序——排序不稳定会直接破
 * “同 Mood + 同召回 ⇒ 卡文本字节全等”这条可测断言。
 *
 * v0.2 淡出腿（recentForms）：形态档位是排序**之后**的投影，不改排序公式本身——
 * 候选池按 limit 取满再逐条降级，降级不足时由调用方（spirit）扩大候选重取。
 */

import { rankBy, takeTop } from './score.js';
import { formDigest, formOf, formText, feedbackFirst, type EntryForm, type FadeConfig } from './form.js';
import type { ExperienceEntry } from '../types.js';

export interface RecentOptions {
  now: number;
  halfLifeMs: number;
  limit: number;
}

/** 淡出候选项：条目 + 实际形态 + 进卡文本（held 为空串）。 */
export interface FormedEntry {
  entry: ExperienceEntry;
  form: EntryForm;
  text: string;
}

export interface RecentFadeOptions extends RecentOptions {
  fade: FadeConfig;
}

/** 近因路取片段（返回体验句文本，按新→旧；fade 缺省 = v0.1 行为逐字节不变）。 */
export function recentLines(entries: readonly ExperienceEntry[], opts: RecentOptions & { fade?: FadeConfig }): string[] {
  return recentForms(entries, opts).map((formed) => formed.text).filter((text) => text !== '');
}

/**
 * 近因路取形态（刀1 的执行面）：排序 → 反馈重排 → 逐条定档 → 按 limit 取满非 held。
 *
 * 重排只改“先进哪条”不改“进不进”：held 的判定始终由 formOf（salience×注意力）说了算。
 */
export function recentForms(entries: readonly ExperienceEntry[], opts: RecentOptions & { fade?: FadeConfig }): FormedEntry[] {
  const usable = entries.filter((entry) => entry.supersededBy === undefined && entry.text !== '');
  const ranked = takeTop(
    rankBy(
      usable,
      () => 1,
      { now: opts.now, halfLifeMs: opts.halfLifeMs, tsOf: (item) => (item as ExperienceEntry).tsMs, idOf: (item) => (item as ExperienceEntry).id },
    ),
    opts.limit,
  );
  const fade = opts.fade;
  if (fade === undefined || !fade.fadeEnabled) {
    // v0.1 兼容臂：无反馈重排、无档位，文本即原文（逐字节回归冻结在这里，不在渲染侧）
    return ranked.map((entry) => ({ entry, form: 'full' as const, text: entry.text }));
  }
  // 反馈只重排（两轴分离）：未打分保持原序，打分不改任何条目能不能进卡
  const ordered = fade.feedbackEnabled && ranked.some((entry) => typeof entry.feedbackScore === 'number')
    ? feedbackFirst(ranked, (entry) => entry.feedbackScore ?? 0)
    : ranked;
  const formed = ordered.map((entry) => {
    const form = formOf(entry, opts.now, fade);
    return { entry, form, text: formText(entry, form) };
  });
  return formed.filter((item) => item.text !== '');
}

/** 形态摘要（进指纹：同档位集合 ⇒ 同摘要；不含时间戳）。 */
export function formsDigest(formed: readonly FormedEntry[]): string {
  return formDigest(formed.map((item) => item.form));
}

/** 近因路是否有条目可给（决定“要不要发卡”时比数组长短更直白）。 */
export function hasRecent(entries: readonly ExperienceEntry[]): boolean {
  return entries.some((entry) => entry.supersededBy === undefined && entry.text !== '');
}
