/**
 * echo 链短语集（刀2 的 spirit 侧件）。
 *
 * 背景（取证过的事实，不是猜测）：姊妹记忆引擎的证据投影对 `user/message` 只放行
 * `source.kind==='user'`（插件注入行在那里被挡），但 `assistant/message` **原样进证据**。
 * 于是唯一活的跨域泄漏口是：模型复述了卡上的体验语 ⇒ 变成 assistant 发言 ⇒ 被蒸馏成事实。
 *
 * 本文件不修那条链（修它要动对方的提取面，且 spirit 不许出现对方的字面量——解耦闸）。
 * 这里提供的是**语汇可判别性的守门件**：
 * - `SPIRIT_PHRASES`：卡上会出现的全部固定语汇（九档 label/tendency、签名、声明、
 *   非医疗注、gist 残句），单源直接 import 自家常量，**不抄第二份**；
 * - `containsSpiritPhrase`：一段文本里是否含这些语汇——测试用它断言"卡文本确实整段
 *   可识别"（不可识别的文案等于把体验语洗成普通陈述，那才是最坏的失真）。
 *
 * 语汇纪律（写进 README 的那条）：卡文案保持不可蒸馏语——档位词短句、不陈述因果，
 * 即使被复述进事实层，产物也天然无信息量。本件盯的就是这条纪律不被后续改版悄悄放弃。
 */

import { MOOD_GRID, NON_MEDICAL_NOTE } from '../slot/grid.js';
import { GIST_TABLE } from '../experience/render.js';
import { SPIRIT_CARD_DISCLAIMER, SPIRIT_CARD_SIGNATURE } from '../slot/render.js';
import { VALENCE_TIERS, AROUSAL_TIERS } from '../types.js';

function collectPhrases(): string[] {
  const out: string[] = [SPIRIT_CARD_SIGNATURE, SPIRIT_CARD_DISCLAIMER, NON_MEDICAL_NOTE];
  for (const v of VALENCE_TIERS) {
    for (const a of AROUSAL_TIERS) {
      const cell = MOOD_GRID[v][a];
      out.push(cell.label, cell.tendency);
    }
  }
  for (const gist of Object.values(GIST_TABLE)) out.push(gist);
  // 去空串与重复（同串的 tendency 是合法合并，不算第二份拷贝）
  return [...new Set(out.filter((p) => p !== ''))];
}

/** 卡上可能出现的固定语汇全集（单源派生，勿手抄）。 */
export const SPIRIT_PHRASES: readonly string[] = collectPhrases();

/** 二字档词集合单独给需要“句子级口径”的调用方排除用（label 大多 2-4 字）。 */
export const SPIRIT_SHORT_LABELS: readonly string[] = SPIRIT_PHRASES.filter((p) => p.length <= 3);

/** gist 残句集单独导出（ab-report 用它把卡行归到 full/gist 形态）；仍是单源派生。 */
export const SPIRIT_GIST_SENTENCES: readonly string[] = Object.values(GIST_TABLE).filter((s) => s !== '');

/**
 * 文本是否含 spirit 语汇；命中返回命中的短语，未命中返回 null。
 *
 * ⚠ 匹配口径：本函数**不做短档位词的裸子串判定**——“顺手”“平常”这类二字档词
 * 在自然中文里必然误命中（真机跑自家 L1 盘就抓出一串假阳）。因此命中门槛是
 * `length >= 4` 的短语（gist 残句/签名/声明/长 tendency 句）；只含二字 label 的
 * 文本不算命中。需要句子级口径的调用方（如真机档脚本）用 SPIRIT_GIST_SENTENCES。
 */
export function containsSpiritPhrase(text: string): string | null {
  if (text === '') return null;
  for (const phrase of SPIRIT_PHRASES) {
    if (phrase.length >= 4 && text.includes(phrase)) return phrase;
  }
  return null;
}
