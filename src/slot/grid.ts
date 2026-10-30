/**
 * 情绪档网格：3×3 = 9 格的对外词与行为倾向。
 *
 * 为什么写成"状态词 + 行为倾向"而不是给模型一个数值：模型没有 valence/arousal 的行为先验，
 * `valence=-0.6` 对它是噪声；而"句子变短、不想解释第二遍"是它能直接执行的东西。
 * 同时这也是**伪精确防线**——没有校准规则时不许对外报数。
 *
 * `soft` 标记：该档需要降级措辞并附非医疗声明（极端负面不是用来"演得像"的）。
 */

import {
  AROUSAL_HIGH,
  AROUSAL_LOW,
  AROUSAL_NORMAL,
  VALENCE_MID,
  VALENCE_NEG,
  VALENCE_PLUS,
  type ArousalTier,
  type ValenceTier,
} from '../types.js';

export interface MoodCell {
  /** 状态词（进卡，2–4 字）。 */
  label: string;
  /** 第一人称行为倾向：模型能直接照做的那一句。 */
  tendency: string;
  /** 展示分级：需要附加非医疗声明的负面档。 */
  soft: boolean;
}

export const NON_MEDICAL_NOTE = '（这只是角色状态的写法，不是医学或心理判断。）';

/** 9 格全覆盖：缺格由 tests/slot.test.ts 的完备性断言判红。 */
export const MOOD_GRID: Readonly<Record<ValenceTier, Readonly<Record<ArousalTier, MoodCell>>>> = {
  [VALENCE_NEG]: {
    [AROUSAL_LOW]: { label: '往下沉', tendency: '话会变少，进度上我不主动推', soft: false },
    [AROUSAL_NORMAL]: { label: '有点堵', tendency: '句子短，不想解释第二遍', soft: false },
    [AROUSAL_HIGH]: { label: '烦躁压着', tendency: '语气会急，但只说一句就收', soft: true },
  },
  [VALENCE_MID]: {
    [AROUSAL_LOW]: { label: '发钝', tendency: '反应慢半拍，需要你说得具体点', soft: false },
    [AROUSAL_NORMAL]: { label: '平常', tendency: '按平时那样说', soft: false },
    [AROUSAL_HIGH]: { label: '绷着', tendency: '注意力集中但不松弛，答话偏硬', soft: false },
  },
  [VALENCE_PLUS]: {
    [AROUSAL_LOW]: { label: '松快', tendency: '愿意多说两句，也会留你插话的空', soft: false },
    [AROUSAL_NORMAL]: { label: '顺手', tendency: '语气放开，会主动想下一步', soft: false },
    [AROUSAL_HIGH]: { label: '来劲', tendency: '节奏加快，会先把结论抛出来', soft: false },
  },
};

/** 轴内档位序（用于"单轮最多跨几格"的钳制）。 */
export const VALENCE_ORDER: readonly ValenceTier[] = [VALENCE_NEG, VALENCE_MID, VALENCE_PLUS];
export const AROUSAL_ORDER: readonly ArousalTier[] = [AROUSAL_LOW, AROUSAL_NORMAL, AROUSAL_HIGH];

/** 中性格（陈旧与降级的落点）。 */
export function neutralCell(): MoodCell {
  return MOOD_GRID[VALENCE_MID][AROUSAL_NORMAL];
}

export function moodCell(valence: ValenceTier, arousal: ArousalTier): MoodCell {
  return MOOD_GRID[valence][arousal];
}

/** 把档位沿轴最多移动 `stepCap` 格（防"人格抽动"：一跨到底会让角色像换了一个人）。 */
export function stepToward<T extends string>(from: T, to: T, order: readonly T[], stepCap: number): T {
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return to;
  const distance = toIndex - fromIndex;
  if (distance === 0) return from;
  const capped = Math.max(-Math.max(1, Math.floor(stepCap)), Math.min(Math.max(1, Math.floor(stepCap)), distance));
  return order[fromIndex + capped] ?? to;
}
