/**
 * 记录选择器：一件事值不值得记、记哪一面、反应多大。
 *
 * 这一层是"人格"真正起作用的地方——不是靠一段描述文本，而是靠**它决定记什么**：
 * - `salience === 0` ⇒ 不记。**"不记什么"同样是人格表达**，两个人格在同一场会话里
 *   会留下不同的手记；顺带把条目库压到"有摩擦或有结论的轮次"这个量级。
 * - `focus` ⇒ 同一件事注意到哪一面（`tool_failure` 可以被记成"我出了错"，
 *   也可以被记成"手边的工具不顺"——归因方向就是人格）。
 *
 * 全部是纯查表，零模型调用：情绪的来源可以是机械的，但**必须是本地可判的**，
 * 否则对话内容（网页、文件正文）就能操纵角色状态。
 */

import {
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
  type NoticeKind,
  type PersonaCard,
  type ReactionTier,
  type SalienceWeight,
  type TriggerKind,
} from '../types.js';

/**
 * 每个事件族可能注意到的面（按偏好度排序）。
 *
 * 顺序有意义：排在前面的是"更常归因到的方向"。人格的 `focus` 命中多个候选时取候选表里
 * 靠前的那个，这样同一个人格在同一事件流上产出稳定（同态断言依赖这一点）。
 */
const TRIGGER_NOTICE_CANDIDATES: Readonly<Record<TriggerKind, readonly NoticeKind[]>> = {
  [TRIGGER_USER_INTERRUPT]: [NOTICE_USER_STATE, NOTICE_TASK_STALL, NOTICE_SELF_MISTAKE],
  [TRIGGER_TOOL_FAILURE]: [NOTICE_ENVIRONMENT, NOTICE_SELF_MISTAKE, NOTICE_TASK_STALL],
  [TRIGGER_RECOVERY]: [NOTICE_SELF_MISTAKE, NOTICE_TASK_PROGRESS],
  [TRIGGER_TASK_CLOSE]: [NOTICE_TASK_PROGRESS, NOTICE_BEING_ACKNOWLEDGED],
  [TRIGGER_LONG_GAP]: [NOTICE_BEING_IGNORED, NOTICE_USER_STATE],
  [TRIGGER_NEUTRAL]: [NOTICE_TASK_PROGRESS, NOTICE_ENVIRONMENT],
};

/** 在意度；未声明的事件族按 `0`（不记）处理，缺键不会被当成"默认要记"。 */
export function salienceOf(persona: PersonaCard, trigger: TriggerKind): SalienceWeight {
  const raw = persona.salience[trigger];
  return raw === 1 || raw === 2 || raw === 0 ? raw : 0;
}

/** 该事件值不值得记。 */
export function shouldRecord(trigger: TriggerKind, persona: PersonaCard): boolean {
  return salienceOf(persona, trigger) >= 1;
}

/**
 * 选一面：候选表 ∩ 人格 focus，按候选表顺序取第一个；
 * 交集为空 ⇒ 退候选表首项（**不留空**：空 notice 会让条目渲染出半句话）。
 */
export function pickNotice(trigger: TriggerKind, persona: PersonaCard): NoticeKind {
  const candidates = TRIGGER_NOTICE_CANDIDATES[trigger];
  for (const candidate of candidates) {
    if (persona.focus.includes(candidate)) return candidate;
  }
  return candidates[0] ?? NOTICE_ENVIRONMENT;
}

/**
 * 定反应强度。
 *
 * 规则（唯一实现点，别在调用方再判一次）：
 * - `salience === 0` ⇒ `none`（本来就不该走到这里，兜底返回 none 而不是抛）
 * - `salience === 2` 且**不是中性轮** ⇒ `strong`
 * - 其余 ⇒ `mild`
 *
 * 中性轮不给 `strong` 是刻意的：没事发生却记一条"很在意"，角色看起来像情绪失控，
 * 而这条记录还没有任何依据。
 */
export function pickReaction(trigger: TriggerKind, persona: PersonaCard): ReactionTier {
  const weight = salienceOf(persona, trigger);
  if (weight === 0) return REACTION_NONE;
  if (weight === 2 && trigger !== TRIGGER_NEUTRAL) return REACTION_STRONG;
  return REACTION_MILD;
}

/** 该事件是否值得多带一句注意到的细节（`salience === 2`）。 */
export function wantsDetail(trigger: TriggerKind, persona: PersonaCard): boolean {
  return salienceOf(persona, trigger) === 2;
}

/** 供测试与面板核对事件族完备性（每个 trigger 都必须有候选表，漏一个就跑不出 notice）。 */
export const COVERED_TRIGGERS: readonly TriggerKind[] = Object.keys(TRIGGER_NOTICE_CANDIDATES) as TriggerKind[];
