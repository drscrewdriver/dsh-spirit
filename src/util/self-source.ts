/**
 * 自家注入行的**唯一**识别口径。
 *
 * 为什么单源：这个判据同时管三件事——① 本轮行是不是我写的（统计/对账）、
 * ② 从 DRSC 拉回的历史里要不要剔掉我自己（回声过滤）、③ 条目要不要落库。
 * 两处各抄一份就会漂移，而漂移的后果是**静默的**：份额统计归零、或者自家体验卡
 * 被当成历史原文记回来，两者都不报错。
 *
 * 双形状是换代现实：v4 写 `{kind:'plugin:spirit'}`，v3 旧行是 `{kind:'plugin',plugin:'spirit'}`
 * （宿主 v3→v4 迁移把后者升格）。只认 v4 会在读老会话时整段失效。
 */

import { SPIRIT_SOURCE_KIND } from '../contract.js';

/** v3 旧形状里的子系统名，从 kind 常量派生（不写第二份字面量）。 */
const LEGACY_SUBSYSTEM = SPIRIT_SOURCE_KIND.slice('plugin:'.length);

/** 只读 interested 字段的安全取形（宿主各线形状不一，任何异常一律判否）。 */
function field(src: unknown, key: 'kind' | 'plugin'): string | undefined {
  if (typeof src !== 'object' || src === null) return undefined;
  const raw = (src as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw : undefined;
}

/** 本插件产出的注入行署名（v4 与 v3 两代形状都认）。 */
export function isOwnExperienceSource(src: unknown): boolean {
  if (field(src, 'kind') === SPIRIT_SOURCE_KIND) return true;
  return field(src, 'kind') === 'plugin' && field(src, 'plugin') === LEGACY_SUBSYSTEM;
}

/**
 * 从会话事件里取署名并判断是否自家行。
 *
 * ⚠️ 事件形状在各线不一致（`payload.event.source` / `payload.source`），
 * 取不到即判否——**宁可漏判自家行（多一次无害重注），不可误判用户行为自家行**
 * （那会把用户真说的话从统计与对账里抹掉）。
 */
export function isOwnExperienceFromEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const record = event as Record<string, unknown>;
  return isOwnExperienceSource(record['source']);
}
