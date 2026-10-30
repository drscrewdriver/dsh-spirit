/**
 * 枚举 → 对外词表的单源。
 *
 * 为什么单独一个文件：同一个枚举值会在三处被读到（人格区、体验条目、回忆卡）。
 * 三处各写一份中文，改了其一就会出现"卡片说卡住、手记写停滞"的自相矛盾，
 * 而这种矛盾对模型是噪声、对人是不信任感——且没有任何报错。
 *
 * 完备性由 `tests/words.test.ts` 机械守：每个枚举成员都必须有词，缺一条即红。
 */

import {
  AROUSAL_HIGH,
  AROUSAL_LOW,
  AROUSAL_NORMAL,
  NOTICE_BEING_ACKNOWLEDGED,
  NOTICE_BEING_IGNORED,
  NOTICE_ENVIRONMENT,
  NOTICE_SELF_MISTAKE,
  NOTICE_TASK_PROGRESS,
  NOTICE_TASK_STALL,
  NOTICE_USER_STATE,
  REACTION_MILD,
  REACTION_NONE,
  REACTION_STRONG,
  VALENCE_NEG,
  VALENCE_MID,
  VALENCE_PLUS,
  VOICE_PLAIN,
  VOICE_TERSE,
  VOICE_WARM,
  type ArousalTier,
  type NoticeKind,
  type ReactionTier,
  type ValenceTier,
  type VoiceTier,
} from './types.js';

export const NOTICE_WORDS: Readonly<Record<NoticeKind, string>> = {
  [NOTICE_SELF_MISTAKE]: '我出了错',
  [NOTICE_USER_STATE]: '你那边的状态',
  [NOTICE_TASK_PROGRESS]: '事情在往前走',
  [NOTICE_TASK_STALL]: '事情卡住了',
  [NOTICE_BEING_IGNORED]: '我没被搭理',
  [NOTICE_BEING_ACKNOWLEDGED]: '我被告知了',
  [NOTICE_ENVIRONMENT]: '手边的工具不顺',
};

export const REACTION_WORDS: Readonly<Record<ReactionTier, string>> = {
  [REACTION_NONE]: '没什么感觉',
  [REACTION_MILD]: '有点在意',
  [REACTION_STRONG]: '很在意',
};

export const VALENCE_WORDS: Readonly<Record<ValenceTier, string>> = {
  [VALENCE_NEG]: '不顺',
  [VALENCE_MID]: '平常',
  [VALENCE_PLUS]: '顺',
};

// ⚠ 计算键必须带方括号：写成 `AROUSAL_LOW: '…'` 会得到一个名为 "AROUSAL_LOW" 的键，
// 而不是档位值——查表当场落空且只在运行时才暴露（tsc 会拦，但这条错真出现过）。
export const AROUSAL_WORDS: Readonly<Record<ArousalTier, string>> = {
  [AROUSAL_LOW]: '提不起劲',
  [AROUSAL_NORMAL]: '平稳',
  [AROUSAL_HIGH]: '绷着',
};

export const VOICE_WORDS: Readonly<Record<VoiceTier, string>> = {
  [VOICE_PLAIN]: '平实',
  [VOICE_TERSE]: '简短',
  [VOICE_WARM]: '温和',
};
