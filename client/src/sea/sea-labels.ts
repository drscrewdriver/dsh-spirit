/**
 * 星海界面的标签映射（trigger / 主题 → 文案键）。
 *
 * 单独一个文件的原因：星海面板与人设面板都要用 `TRIGGER_LABEL`，
 * 而"键名字面量出现在源码里"本身就是 `tests/client-copy.test.ts` 的死文案判据——
 * 两处各抄一份映射迟早会对不齐，收成一处。
 */
import type { NoticeKind, TriggerKind } from '../../../src/types.js';
import type { CopyKey } from '../copy.js';

export const TRIGGER_LABEL: Record<TriggerKind, CopyKey> = {
  user_interruption: 'sea.trigUserInterruption',
  tool_failure: 'sea.trigToolFailure',
  recovery: 'sea.trigRecovery',
  task_close: 'sea.trigTaskClose',
  long_gap: 'sea.trigLongGap',
  neutral: 'sea.trigNeutral',
};

/** 在意面标签（手记卡片与 persona 共用：不给主人看 slug，与姊妹包的簇名同一纪律）。 */
export const NOTICE_LABEL: Record<NoticeKind, CopyKey> = {
  self_mistake: 'sea.noticeSelfMistake',
  user_state: 'sea.noticeUserState',
  task_progress: 'sea.noticeTaskProgress',
  task_stall: 'sea.noticeTaskStall',
  being_ignored: 'sea.noticeBeingIgnored',
  being_acknowledged: 'sea.noticeBeingAcknowledged',
  environment: 'sea.noticeEnvironment',
};

/** 图上出现顺序（与 `TRIGGER_PRIORITY` 不同：这里按"离主人多远"排，读图更顺）。 */
export const TRIGGER_ORDER: readonly TriggerKind[] = [
  'user_interruption',
  'long_gap',
  'task_close',
  'neutral',
  'recovery',
  'tool_failure',
];

export const THEME_LABEL: Record<string, CopyKey> = {
  starfield: 'sea.themeStarfield',
  aurora: 'sea.themeAurora',
  ink: 'sea.themeInk',
};
