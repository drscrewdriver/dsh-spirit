/**
 * 每轮编译：信号 → 体验条目草稿（纯函数，零模型调用）。
 *
 * 这是"记录"的主干：先验信号形状（只收结构化事实），再定事件族，再问人格
 * "这件事你在意吗"，在意才选面、定档、出句。整条链路没有任何一次模型调用，
 * 所以它的成本是每轮几微秒——这是"记录过程的点滴"能常态开着的唯一理由。
 *
 * 三种出口必须分清楚（都写成"没记"会丢诊断信息）：
 * - `{ok:false}` 信号包越界（含自由文本）⇒ 拒绝整包，调用方告警；
 * - `{ok:true, draft:undefined}` 人格不在意 ⇒ 正常跳过，不告警；
 * - `{ok:true, draft}` ⇒ 落库。
 */

import { shouldRecord, pickNotice, pickReaction, wantsDetail } from './select.js';
import { classifyTrigger, isStructuredOnly, type EventConfig } from './events.js';
import { renderExperienceText } from './render.js';
import { LANE_LIVE, type ExperienceDraft, type PersonaCard, type TurnSignals } from '../types.js';

export type CompileResult =
  | { ok: true; draft: ExperienceDraft | undefined }
  | { ok: false; reason: string };

/** 从信号拼出结构化事实（不新增任何需要读文本的字段）。 */
function factOf(signals: TurnSignals) {
  const base = signals.facts;
  return {
    ...base,
    toolCalls: signals.toolCalls,
    toolFailures: signals.toolFailures,
    userChars: signals.userChars,
    gapMs: signals.gapMs,
    turnSpan: base.turnSpan ?? ([signals.turnSeq, signals.turnSeq] as [number, number]),
  };
}

/**
 * 编译一轮。
 *
 * @param signals 本轮结构化信号
 * @param persona 当前人格（决定记不记、记哪一面、说多细）
 * @param cfg 事件判定阈值
 */
export function compileTurn(signals: TurnSignals, persona: PersonaCard, cfg: EventConfig): CompileResult {
  if (!isStructuredOnly(signals)) {
    return { ok: false, reason: '信号包携带自由文本字段，整包拒绝（情绪判定不得读对话内容）' };
  }
  const trigger = classifyTrigger(signals, cfg);
  if (!shouldRecord(trigger, persona)) return { ok: true, draft: undefined };
  const fact = factOf(signals);
  const draft: ExperienceDraft = {
    trigger,
    notice: pickNotice(trigger, persona),
    reaction: pickReaction(trigger, persona),
    text: renderExperienceText({
      trigger,
      notice: pickNotice(trigger, persona),
      reaction: pickReaction(trigger, persona),
      fact,
      detail: wantsDetail(trigger, persona),
      voice: persona.voice,
    }),
    lane: LANE_LIVE,
    fact,
  };
  // 文案表缺格会渲染出空句：宁可报"这条没记"，也不留一条空条目占预算、占面板
  return draft.text === '' ? { ok: false, reason: `文案表缺格：${trigger}` } : { ok: true, draft };
}
