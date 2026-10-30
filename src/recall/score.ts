/**
 * 召回打分的纯函数层（路 A/路 B 共用的排序件）。
 *
 * 为什么单独一层：两条路都要"按相关度 × 近因权重排序后取前 N"，而**排序必须是稳定的**——
 * 不稳定会让同一份输入产出不同的卡文本，直接破掉"同 Mood + 同召回 ⇒ 字节全等"这条
 * 可测断言（也是"改一次看一眼，第二天又变了"这类玄学报告的根源）。
 */

import { decayWeight } from '../util/decay.js';

export interface Scored<T> {
  item: T;
  score: number;
}

export interface RankOptions {
  now: number;
  halfLifeMs: number;
  /** 取条目的时间戳（毫秒）。 */
  tsOf: (item: unknown) => number;
  /** 取稳定身份，用于同分时的确定序。 */
  idOf: (item: unknown) => string;
}

/** 按"权重 × 近因"降序；同分按时间倒序，再同按 id 升序（全序，无并列歧义）。 */
export function rankBy<T>(items: readonly T[], weightOf: (item: T) => number, opts: RankOptions): Scored<T>[] {
  const scored: Scored<T>[] = items.map((item) => ({ item, score: weightOf(item) * decayWeight(opts.tsOf(item), opts.now, opts.halfLifeMs) }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const tsA = opts.tsOf(a.item);
    const tsB = opts.tsOf(b.item);
    if (tsA !== tsB) return tsB - tsA;
    const idA = opts.idOf(a.item);
    const idB = opts.idOf(b.item);
    return idA < idB ? -1 : 1;
  });
  return scored;
}

/** 取前 N（N<=0 ⇒ 空；N 大于长度 ⇒ 全给，不抛）。 */
export function takeTop<T>(scored: readonly Scored<T>[], limit: number): T[] {
  return scored.slice(0, Math.max(0, Math.floor(limit))).map((entry) => entry.item);
}
