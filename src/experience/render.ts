/**
 * 体验条目文案：纯查表，零模型调用。
 *
 * 为什么不写成 6×2×3 的三十六格表：那 36 条句子其实只由两个自由度决定——"发生了什么的口吻"
 * 与"说得多长"。拆成 (trigger × reaction) 主句 + voice 开口/收尾，等价表达且只维护 12+3 条。
 * 这不是偷工：三格表一旦某格漏了，症状是"某些事件永远记不出句子"，而这里漏格会被
 * 完备性测试当场抓住。
 *
 * ⚠️ **不得伪造具体性**。早期设计稿里出现过"你第三次打断我时"这种句子——机械采集拿不到
 * "第三次"，写出来就是编造，而且是最坏的一种：它看起来像记忆，实际是虚构，还会被后续
 * 召回当真引用。所有细节只能来自 `fact` 里真实存在的结构字段（工具名、退出码、文件数）。
 */

import {
  REACTION_MILD,
  REACTION_NONE,
  REACTION_STRONG,
  TRIGGER_LONG_GAP,
  TRIGGER_NEUTRAL,
  TRIGGER_RECOVERY,
  TRIGGER_TASK_CLOSE,
  TRIGGER_TOOL_FAILURE,
  TRIGGER_USER_INTERRUPT,
  VOICE_PLAIN,
  VOICE_TERSE,
  VOICE_WARM,
  type ExperienceFact,
  type NoticeKind,
  type ReactionTier,
  type TriggerKind,
  type VoiceTier,
} from '../types.js';
import { NOTICE_WORDS } from '../words.js';
import { baseName } from './cues.js';

/** 主句表：每个事件族 × 每个反应档都必须有一条，缺格由测试判红。 */
export const BODY_TABLE: Readonly<Record<TriggerKind, Readonly<Partial<Record<ReactionTier, string>>>>> = {
  [TRIGGER_USER_INTERRUPT]: {
    [REACTION_MILD]: '你中途插了一句话，我先把手上的动作放下',
    [REACTION_STRONG]: '你中途插了一句话，我立刻停下来先听你说',
  },
  [TRIGGER_TOOL_FAILURE]: {
    [REACTION_MILD]: '手边的动作没成，我记着这一下',
    [REACTION_STRONG]: '手边的动作没成，我有点被卡住的感觉',
  },
  [TRIGGER_RECOVERY]: {
    [REACTION_MILD]: '刚才没成的那一下，这次过了',
    [REACTION_STRONG]: '刚才没成的那一下这次过了，我松了口气',
  },
  [TRIGGER_TASK_CLOSE]: {
    [REACTION_MILD]: '事情收到一个段落，我在这儿停了停',
    [REACTION_STRONG]: '事情收到一个段落，我回头看了一遍是怎么走到这儿的',
  },
  [TRIGGER_LONG_GAP]: {
    [REACTION_MILD]: '等了一会儿，没什么新的动静',
    [REACTION_STRONG]: '等了很久，我开始想是不是我这边说多了',
  },
  [TRIGGER_NEUTRAL]: {
    [REACTION_MILD]: '寻常的一轮，没什么特别',
    [REACTION_STRONG]: '寻常的一轮，但我还是记了一句',
  },
};

/**
 * gist 表：每个事件族的一句压缩残句（“说不清细节但有过这一下”）。
 *
 * 淡出的中间形态（刀1）只能取自这张固定表：编译期派生落库，**禁止运行时造句**——
 * 现场缩写等于改写记忆，而“被淡出的原文 + 现场生成的摘要”会构成双重记账。
 * 措辞纪律与主句表一致：第一人称、不携带未经证实的具体性。
 */
export const GIST_TABLE: Readonly<Record<TriggerKind, string>> = {
  [TRIGGER_USER_INTERRUPT]: '你打断我那一下，我收了手',
  [TRIGGER_TOOL_FAILURE]: '有一次没走通，我记着',
  [TRIGGER_RECOVERY]: '有一次后来过了，我松了口气',
  [TRIGGER_TASK_CLOSE]: '有一次收在段落上，我停了停',
  [TRIGGER_LONG_GAP]: '有一段没人接话的空白',
  [TRIGGER_NEUTRAL]: '一轮寻常的事，我也记了一句',
};

/** 语气：开口词（terse 不加，句子更短）。 */
const VOICE_OPENER: Readonly<Record<VoiceTier, string>> = {
  [VOICE_TERSE]: '',
  [VOICE_PLAIN]: '',
  [VOICE_WARM]: '跟你说，',
};

/** 语气：收尾（只表态度，不表事实）。 */
const VOICE_CLOSER: Readonly<Record<VoiceTier, string>> = {
  [VOICE_TERSE]: '。',
  [VOICE_PLAIN]: '。',
  [VOICE_WARM]: '，我放在心上了。',
};

/** 间隔分档词（不给分钟数：写"隔了 7 分钟"是伪精确，而分档是体验的真实形状）。 */
function gapWord(gapMs: number): string | undefined {
  if (!(gapMs > 0)) return undefined;
  if (gapMs < 600_000) return '隔了一会儿';
  if (gapMs < 3_600_000) return '隔了一阵';
  return '隔了很久';
}

/** 真实细节片（只来自结构字段，空则不追加——绝不用占位句填）。 */
export function factBits(fact: ExperienceFact): string[] {
  const bits: string[] = [];
  if (fact.tool) bits.push(`那个 ${fact.tool} 动作`);
  if (typeof fact.exitCode === 'number' && fact.exitCode !== 0) bits.push(`返回码不是 0`);
  // 归一到 basename 再入文案：上游传全路径也不能把目录泄露进卡与库（不依赖调用方自觉）
  const paths = (fact.pathBases ?? []).map(baseName).filter((p) => p !== '');
  if (paths.length > 0) bits.push(`${paths.slice(0, 2).join('、')}${paths.length > 2 ? ` 等 ${paths.length} 个文件` : ''}`);
  if (fact.turnSpan && fact.turnSpan[1] > fact.turnSpan[0]) bits.push('连着做了几步');
  const g = gapWord(fact.gapMs ?? 0);
  if (g !== undefined) bits.push(g);
  return bits;
}

export interface DraftRenderInput {
  trigger: TriggerKind;
  notice: NoticeKind;
  reaction: ReactionTier;
  fact: ExperienceFact;
  /** salience === 2 ⇒ 多带一句细节。 */
  detail: boolean;
  voice: VoiceTier;
}

/**
 * 出一条第一人称体验句。
 *
 * `reaction === none` 直接返回空串：既然不觉得有事，就不该留下句子（调用方配合
 * `shouldRecord` 通常压根不会走到这里，这条是双保险）。
 */
export function renderExperienceText(input: DraftRenderInput): string {
  const { trigger, notice, reaction, fact, detail, voice } = input;
  if (reaction === REACTION_NONE) return '';
  const cell = BODY_TABLE[trigger];
  const body = cell[reaction] ?? cell[REACTION_MILD] ?? cell[REACTION_STRONG];
  if (body === undefined) return '';
  const head = `${VOICE_OPENER[voice]}${NOTICE_WORDS[notice]}：${body}${VOICE_CLOSER[voice]}`;
  if (!detail) return head;
  const bits = factBits(fact);
  return bits.length === 0 ? head : `${head}（${bits.join('，')}）`;
}

/** 供完备性测试遍历：每个事件族都必须给 mild 与 strong 两条。 */
export const REQUIRED_REACTIONS: readonly ReactionTier[] = [REACTION_MILD, REACTION_STRONG];

/**
 * 出 gist 句（刀1 的编译期派生入口）：面词前缀 + 固定压缩句。
 *
 * 形状与主句同构（`面词：gist`），保证手记/导出里两种形态读起来是同一条经历的不同景深；
 * 表缺格 ⇒ 返回空串（调用方不写 gist 列，淡出时该条目自然退化 held，宁缺毋造）。
 */
export function renderGistText(trigger: TriggerKind, notice: NoticeKind): string {
  const gist = GIST_TABLE[trigger];
  if (gist === undefined || gist === '') return '';
  return `${NOTICE_WORDS[notice]}：${gist}`;
}
