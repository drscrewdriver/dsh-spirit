/**
 * 情绪档派生：条目 → 3×3 网格上的一格。
 *
 * **因果方向只有一个**：条目是因、档位是果（记忆骨架同理）。反过来说"先定情绪、再找证据"
 * 就是自我催眠——所以本函数只吃条目，不吃任何原始信号，也不吃模型输出。
 *
 * 三条防抖设计，都对应真实症状：
 * - **半衰期加权**：刚发生的事权重高，久远的条目权重降到 0.5 为止（不是 0）。
 * - **单轮跨格上限**（`stepCap`）：一跨到底会让角色像突然换了一个人（"人格抽动"）。
 * - **陈旧退中性**（`staleAfterMs`）：重启/长静默后，绝不能再把三天前的感觉当"现在"。
 *
 * 内部允许有连续计数（下面算 avgV/avgA 用），但**都不往外传**：`Mood` 只有档位与词。
 * 无校准规则就报 `valence=-0.83` 是伪精确，那比不报更容易误导人。
 */

import {
  AROUSAL_HIGH,
  AROUSAL_LOW,
  AROUSAL_NORMAL,
  REACTION_STRONG,
  TRIGGER_LONG_GAP,
  TRIGGER_NEUTRAL,
  TRIGGER_RECOVERY,
  TRIGGER_TASK_CLOSE,
  TRIGGER_TOOL_FAILURE,
  TRIGGER_USER_INTERRUPT,
  VALENCE_MID,
  VALENCE_NEG,
  VALENCE_PLUS,
  type ArousalTier,
  type ExperienceEntry,
  type Mood,
  type TriggerKind,
  type ValenceTier,
} from '../types.js';
import { decayWeight, isStale } from '../util/decay.js';
import { AROUSAL_ORDER, moodCell, stepToward, VALENCE_ORDER } from './grid.js';

export interface MoodConfig {
  halfLifeMs: number;
  stepCap: number;
  staleAfterMs: number;
}

/** 效价极性（-1..1 的内部量，只参与计算）。 */
const VALENCE_POLARITY: Readonly<Record<TriggerKind, number>> = {
  [TRIGGER_USER_INTERRUPT]: -0.4,
  [TRIGGER_TOOL_FAILURE]: -1,
  [TRIGGER_RECOVERY]: 0.9,
  [TRIGGER_TASK_CLOSE]: 0.6,
  [TRIGGER_LONG_GAP]: -0.5,
  [TRIGGER_NEUTRAL]: 0,
};

/** 唤起极性（-1..1；长间隔让人"沉下去"，失败与恢复都往上提）。 */
const AROUSAL_POLARITY: Readonly<Record<TriggerKind, number>> = {
  [TRIGGER_USER_INTERRUPT]: 0.8,
  [TRIGGER_TOOL_FAILURE]: 0.7,
  [TRIGGER_RECOVERY]: 0.5,
  [TRIGGER_TASK_CLOSE]: -0.5,
  [TRIGGER_LONG_GAP]: -0.9,
  [TRIGGER_NEUTRAL]: 0,
};

/** 反应档放大系数（`none` 的条目通常压根不存在，系数留 0 兜底）。 */
const REACTION_GAIN: Readonly<Record<ExperienceEntry['reaction'], number>> = {
  none: 0,
  mild: 1,
  [REACTION_STRONG]: 1.6,
};

/** 档位分界：内部均值落进哪一档。 */
function bandValence(avgV: number): ValenceTier {
  if (avgV <= -0.25) return VALENCE_NEG;
  if (avgV >= 0.25) return VALENCE_PLUS;
  return VALENCE_MID;
}

function bandArousal(avgA: number): ArousalTier {
  // avgA 已在 0..1；0.38/0.62 两刀——低唤起要真"沉"下去才算低，避免噪声抖档
  if (avgA <= 0.38) return AROUSAL_LOW;
  if (avgA >= 0.62) return AROUSAL_HIGH;
  return AROUSAL_NORMAL;
}

/**
 * 从条目派生档位。
 *
 * @param prev 上一轮的档位（首轮传 undefined ⇒ 不做跨格钳制）
 * @param entries 本会话近因条目（**升序**；调用方从库里按 `card.recentK` 取）
 * @param now 当前毫秒（注入，便于测试与可复现）
 */
export function deriveMood(
  prev: Mood | undefined,
  entries: readonly ExperienceEntry[],
  now: number,
  cfg: MoodConfig,
): Mood {
  const lastTsMs = entries.length > 0 ? (entries[entries.length - 1]?.tsMs ?? 0) : 0;
  let valence: ValenceTier = VALENCE_MID;
  let arousal: ArousalTier = AROUSAL_NORMAL;

  // 无条目或已陈旧 ⇒ 中性：这是"想不起来现在该有什么感觉"，不是"感觉很糟"
  if (entries.length > 0 && !isStale(lastTsMs, now, cfg.staleAfterMs)) {
    let weightSum = 0;
    let vSum = 0;
    let aSum = 0;
    for (const entry of entries) {
      const weight = decayWeight(entry.tsMs, now, cfg.halfLifeMs) * (REACTION_GAIN[entry.reaction] ?? 1);
      if (weight === 0) continue;
      weightSum += weight;
      vSum += weight * (VALENCE_POLARITY[entry.trigger] ?? 0);
      aSum += weight * (AROUSAL_POLARITY[entry.trigger] ?? 0);
    }
    if (weightSum > 0) {
      valence = bandValence(vSum / weightSum);
      arousal = bandArousal((aSum / weightSum + 1) / 2);
    }
  }

  // 跨格钳制：只在有上一档时生效（首轮直接落目标档）
  if (prev !== undefined) {
    valence = stepToward(prev.valence, valence, VALENCE_ORDER, cfg.stepCap);
    arousal = stepToward(prev.arousal, arousal, AROUSAL_ORDER, cfg.stepCap);
  }

  const cell = moodCell(valence, arousal);
  return {
    valence,
    arousal,
    label: cell.label,
    // revision 由调用方经 `withRevisionBump` 推进，本函数**不自己加**：它同时是
    // "要不要重发卡"的判据，每轮 +1 会让"没变化也重发"变成常态。
    revision: prev?.revision ?? 0,
    updatedAt: now,
  };
}

/** 档位是否发生变化（调用方据此决定重发卡还是沿用上一张）。 */
export function moodChanged(prev: Mood | undefined, next: Mood): boolean {
  if (prev === undefined) return true;
  return prev.valence !== next.valence || prev.arousal !== next.arousal;
}

/** 推进 revision（唯一允许改 revision 的地方，避免两处各加一次）。 */
export function withRevisionBump(prev: Mood | undefined, next: Mood): Mood {
  return moodChanged(prev, next) ? { ...next, revision: (prev?.revision ?? 0) + 1 } : next;
}
