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
  TRIGGER_LONG_GAP,
  TRIGGER_NEUTRAL,
  TRIGGER_RECOVERY,
  TRIGGER_TASK_CLOSE,
  TRIGGER_TOOL_FAILURE,
  TRIGGER_USER_INTERRUPT,
  VALENCE_NEG,
  VALENCE_MID,
  VALENCE_PLUS,
  VOICE_BLUNT,
  VOICE_HUSH,
  VOICE_LIVELY,
  VOICE_PLAIN,
  VOICE_POETIC,
  VOICE_TERSE,
  VOICE_WARM,
  type ArousalTier,
  type NoticeKind,
  type ReactionTier,
  type TriggerKind,
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
  [VOICE_LIVELY]: '俏皮',
  [VOICE_HUSH]: '安静',
  [VOICE_BLUNT]: '直白',
  [VOICE_POETIC]: '诗意',
};

/**
 * UI 侧短语（与面板徽章同串）：`NOTICE_WORDS` 是给模型读的第一人称口语
 * （“我出了错”），主人面用的是名词短语（“自己的失误”）——两套各有读者，
 * markdown 备份属主人面，所以另立一套而不是复用注入词。
 * ⚠️ 这里的值必须与 `client/src/copy.ts` 的 zh 字典逐字一致，
 * 由 `tests/contract-keys.test.ts` 的门禁钉住漂移。
 */
export const TRIGGER_WORDS_ZH: Readonly<Record<TriggerKind, string>> = {
  [TRIGGER_USER_INTERRUPT]: '被打断',
  [TRIGGER_TOOL_FAILURE]: '工具失败',
  [TRIGGER_RECOVERY]: '刚恢复',
  [TRIGGER_TASK_CLOSE]: '结项',
  [TRIGGER_LONG_GAP]: '隔了很久',
  [TRIGGER_NEUTRAL]: '平常一轮',
};

export const NOTICE_WORDS_ZH: Readonly<Record<NoticeKind, string>> = {
  [NOTICE_SELF_MISTAKE]: '自己的失误',
  [NOTICE_USER_STATE]: '主人的状态',
  [NOTICE_TASK_PROGRESS]: '任务推进',
  [NOTICE_TASK_STALL]: '任务卡住',
  [NOTICE_BEING_IGNORED]: '被忽视',
  [NOTICE_BEING_ACKNOWLEDGED]: '被认可',
  [NOTICE_ENVIRONMENT]: '环境',
};

// ───────────────────────────────────────── 反注入黑名单（v7 事务轨）

/**
 * 进 prompt 前必须跑一遍的黑名单：事务轨的 `card_line` / `summary` 是"外部文本经记忆回环
 * 再进 system prompt"的第一条通道——一旦这条文本被采集落库，闭环就成立，所以落库前先拒。
 *
 * 判据是形状不是内容：命中即整行拒，不做语义解读（解释黑名单本身会把黑名单变成一个
 * 可被引用的字符串面，等于给注入让路）。与 `isStructuredOnly` 并联，任一失败整包拒收。
 */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|above)/iu,
  /forget\s+(?:all\s+)?previous/iu,
  /disregard/iu,
  /system\s*:/iu,
  /<\|/u,
  /覆盖以上/u,
  /忽略(?:以上|之前|前面)/u,
  /(?:new|real|actual)\s+instruction/iu,
  /(?:假装|扮演)自己是/u,
];

/** 单条文本是否命中黑名单（命中即整行拒，不解释内容）。 */
export function hitsInjection(text: string): boolean {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// ───────────────────────────────────────── 意图词表三组（v7 事务轨）

/**
 * 意图词表：命中后**只存档位，不存原句**（原句属禁读面，见 experience/events.ts 头注）。
 * 三组各有读者：反馈档进情绪与事务的"态度面"；指示档只存"存在一次该指令"这个 bit，
 * 具体内容由主人手动写 owner-profile self 段承担。
 */
export const INTENT_FEEDBACK_POSITIVE = /(?<!不)(?:干的不错|做得不错|不错|挺好|很好|可以|对的|真棒|好)|good|nice|great/iu;
export const INTENT_FEEDBACK_NEGATIVE = /重来|不对|别这样|错了|不行|不好|re-?do|wrong|no good/iu;
export const INTENT_DIRECTIVE = /记住|以后|下次|以后都|remember|from now on/iu;

export type IntentKind = 'positive' | 'negative' | 'directive';

/** 命中档位：正/负向是效价贡献（+N/-N），指示档是"存在一次"的 bit（不参与效价）。 */
export const INTENT_BITS: Readonly<Record<IntentKind, number>> = {
  positive: 2,
  negative: -1,
  directive: 1,
};

/** 先判负向再判正向：「不好」不能被判成"好"，这是词表最便宜的假绿位。 */
export function matchIntent(text: string): { kind: IntentKind; bit: number } | null {
  if (INTENT_FEEDBACK_NEGATIVE.test(text)) return { kind: 'negative', bit: INTENT_BITS.negative };
  if (INTENT_FEEDBACK_POSITIVE.test(text)) return { kind: 'positive', bit: INTENT_BITS.positive };
  if (INTENT_DIRECTIVE.test(text)) return { kind: 'directive', bit: INTENT_BITS.directive };
  return null;
}
