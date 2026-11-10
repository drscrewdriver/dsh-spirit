/**
 * 事务轨的落库前闸（与 `experience/events.ts` 的 `isStructuredOnly` 并联）。
 *
 * 两条闸各有职责，不可互相替代：
 * - `isStructuredOnly` 守情绪轨：信号包里出现自由文本字段 ⇒ 整包拒（情绪判定不许读正文）。
 * - `isSemanticAllowed` 守事务轨：事务轨本来就要写文本（`card_line`/`summary`），所以
 *   它守的是"来源标记合法 + 黑名单不命中 + 禁读面字段不得混进包"。
 *
 * 任一失败即整包拒收——闸的判据是形状，不是内容：解释内容就等于把黑名单变成
 * 一个可被引用的字符串面，那正是跨轮持久注入位的形状。
 */

import { SOURCE_TRUST_VALUES, type SourceTrust } from '../types.js';
import { hitsInjection } from '../words.js';

/** 禁读面字段：这些字段只要作为字符串出现就说明采集侧越过了边界（情绪轨的 STRUCTURED_BANNED_FIELDS 是它的超集）。 */
export const SEMANTIC_BANNED_FIELDS: readonly string[] = ['toolOutput', 'userText', 'snippet', 'content', 'rawText'];

/** 事务轨的语义包形状（`summary` 可空：结构信号行常常没有摘要，宁缺毋造）。 */
export interface SemanticPack {
  source_trust: SourceTrust;
  card_line: string;
  summary?: string | null;
}

/**
 * 校验一份事务轨语义包。
 *
 * 计划口径签名是 `(pack: Record<string, unknown>) => boolean`，所以这里收 unknown：
 * 字段按 `SemanticPack` 逐条断言，缺字段不等于"没问题"而是"形状不对" ⇒ 拒。
 */
export function isSemanticAllowed(pack: Record<string, unknown>): boolean {
  if (typeof pack !== 'object' || pack === null) return false;

  for (const field of SEMANTIC_BANNED_FIELDS) {
    if (typeof pack[field] === 'string') return false;
  }

  const trust = pack['source_trust'];
  if (typeof trust !== 'string' || !(SOURCE_TRUST_VALUES as readonly string[]).includes(trust)) return false;

  const cardLine = pack['card_line'];
  if (typeof cardLine !== 'string' || cardLine.trim() === '') return false;
  if (hitsInjection(cardLine)) return false;

  const summary = pack['summary'];
  if (summary !== undefined && summary !== null) {
    if (typeof summary !== 'string' || summary.trim() === '') return false;
    if (hitsInjection(summary)) return false;
  }

  return true;
}
