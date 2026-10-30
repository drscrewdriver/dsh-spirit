/**
 * 跨会话基调（只在新会话首轮出现的一行）。
 *
 * 口径：**读自家条目，不读别人的库、不做检索**。上一会话"我们一起经历了什么"由
 * spirit 自己记下过的那几条决定——这既满足"新会话第一轮就有连续性"，又不至于把
 * spirit 长成第二个记忆引擎（跨会话检索、实体图、时效治理都不在这条路上）。
 *
 * 措辞只允许引用**确实写过的句子**，不总结、不推断、不补细节：
 * "上次我们收尾在……"后面接的是上一会话最后一条体验句，不是对它的事后归纳。
 */

import type { ExperienceEntry } from '../types.js';

export interface ToneOptions {
  /** 单行字符顶（与 `recall.maxCharsPerEntry` 共用）。 */
  maxChars: number;
}

/** 是否值得给一行基调：少于两条就说明上次也没什么起伏。 */
export const MIN_TONE_ENTRIES = 2;

/**
 * 由上一会话的条目产出一行基调。
 *
 * @returns `''` = 不给（条目不足、全是空句，或调用方关掉了跨会话）
 */
export function previousTone(entries: readonly ExperienceEntry[], opts: ToneOptions): string {
  const usable = entries.filter((entry) => entry.supersededBy === undefined && entry.text.trim() !== '');
  if (usable.length < MIN_TONE_ENTRIES) return '';
  const last = usable[usable.length - 1];
  if (last === undefined) return '';
  const text = last.text.trim().replace(/\s+/gu, ' ');
  const clipped = text.length > opts.maxChars ? text.slice(0, Math.max(0, opts.maxChars)) : text;
  // 计数说法只在真的多于两条时给（只有两条却说"那几轮"就是编造）
  const head = usable.length > MIN_TONE_ENTRIES ? '上次我们那几轮里，最后留在身上的是一句：' : '上次我们收尾在：';
  return `${head}${clipped}`;
}
