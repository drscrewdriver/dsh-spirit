/**
 * 机械事件分类（每轮一次，零模型调用）。
 *
 * ⚠️ 本文件的硬边界：**只允许读结构化的、本地可判的事实**——工具调用数、退出码、
 * 是否有新用户消息、轮间隔、会话内的轮次序号。禁止读 assistant 文本、工具返回正文、
 * 文件内容、网页正文。理由不是"省事"，是安全：
 * 一旦情绪判定可读自由文本，任何进入上下文的外部内容（抓取的网页、读到的文件、
 * 被转述的他人话）只要能猜中词表，就能操纵角色的情绪状态——那是提示注入面，
 * 而且注入后的人格漂移看起来完全像"角色自己的反应"，事后无从追责。
 *
 * 判定顺序即优先级（先命中先取），顺序固定不可随意调换：
 * 纠正 > 失败 > 恢复 > 收尾 > 长间隔 > 中性。把 `recovery` 排在 `tool_failure` 之前
 * 会让"刚恢复"的那轮被记成"又坏了"，归因方向正好相反。
 */

import {
  TRIGGER_LONG_GAP,
  TRIGGER_NEUTRAL,
  TRIGGER_RECOVERY,
  TRIGGER_TASK_CLOSE,
  TRIGGER_TOOL_FAILURE,
  TRIGGER_USER_CORRECTION,
  type TriggerKind,
  type TurnSignals,
} from '../types.js';

/** 分类所需的最小配置面（由调用方从 `capture.gapThresholdMs` 传入）。 */
export interface EventConfig {
  gapThresholdMs: number;
}

/** 优先级表（顺序即语义，改动需同时改上面的注释）。 */
const PRIORITY: readonly TriggerKind[] = [
  TRIGGER_USER_CORRECTION,
  TRIGGER_TOOL_FAILURE,
  TRIGGER_RECOVERY,
  TRIGGER_TASK_CLOSE,
  TRIGGER_LONG_GAP,
  TRIGGER_NEUTRAL,
];

/** 单个信号 → 命中的事件族（都不命中就是中性轮）。 */
export function classifyTrigger(signals: TurnSignals, cfg: EventConfig): TriggerKind {
  if (signals.userCorrection) return TRIGGER_USER_CORRECTION;
  if (signals.toolFailures > 0) return TRIGGER_TOOL_FAILURE;
  if (signals.recovered) return TRIGGER_RECOVERY;
  if (signals.taskClosed) return TRIGGER_TASK_CLOSE;
  if (signals.gapMs >= cfg.gapThresholdMs) return TRIGGER_LONG_GAP;
  return TRIGGER_NEUTRAL;
}

/**
 * 校验一份信号是否只含结构化事实。
 *
 * 这条断言是给门禁/自检用的，不是给业务分支用的：任何携带**自由文本**字段的信号包
 * 都应当被拒（那说明采集侧越过了上面的边界）。文本类字段一律不判内容、直接拒绝整包。
 */
export function isStructuredOnly(signals: unknown): boolean {
  if (typeof signals !== 'object' || signals === null) return false;
  const record = signals as Record<string, unknown>;
  for (const key of ['assistantText', 'toolOutput', 'userText', 'content', 'snippet', 'rawText']) {
    if (typeof record[key] === 'string') return false;
  }
  return typeof record['turnSeq'] === 'number' && typeof record['toolCalls'] === 'number';
}

/** 导出优先级表（测试核对顺序语义用）。 */
export const TRIGGER_PRIORITY: readonly TriggerKind[] = PRIORITY;
