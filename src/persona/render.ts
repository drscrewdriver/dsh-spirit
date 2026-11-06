/**
 * 人格区文本（进系统提示的稳定投影源）。
 *
 * 三条纪律：
 * 1. **固定字段序 + 纯函数**：同一张卡两次渲染必须字节全等。这条不是审美问题——
 *    人格区落在系统提示（node 0），一旦内容每轮抖动，整个请求前缀就每轮 miss；
 *    实测推导下 100 轮长会话会多算约百万级 token（见计划 findings）。
 * 2. **文本里不出现时间戳/轮次/情绪值/路径**：那些都是易变量，属于回忆卡（尾部），
 *    不属于人格区（前缀）。
 * 3. **超预算截在整行边界**：半句"不会做…"会被模型当成开放条件，比丢掉这条更糟。
 */

import { VOICE_WORDS } from '../words.js';
import { byteLen, truncateToLine } from '../util/text.js';
import type { PersonaCard } from '../types.js';

/** 人格区最小展示名（空 name 不会走到这里：校验与 sanitize 都已兜底）。 */
export const PERSONA_LINE_LIMITS = { maxItemsPerLine: 6 } as const;

/**
 * 组一张卡的稳定区文本。
 *
 * @param card 人格卡
 * @param budgetBytes 字节顶（来自 `persona.budgetBytes`）
 * @returns 稳定文本；`card` 无内容时返回 `''`（空串即物理离场，宿主不会拼进系统提示）
 */
export function composePersonaText(card: PersonaCard, budgetBytes: number): string {
  const lines: string[] = [];
  lines.push(`[角色] ${card.name}`);
  // 昵称行（v0.3.4）：主人日常怎么喊这条鱼（常用称呼，空 ⇒ 整行物理离场）
  // 行标签与字段同名「昵称」：曾写作「也叫」，会被读成“不常用的别名”——与语义相反，已修
  const aliases = (card.aliases ?? []).slice(0, PERSONA_LINE_LIMITS.maxItemsPerLine);
  if (aliases.length > 0) lines.push(`[昵称] ${aliases.join('、')}`);
  // 自称行：模型可经 spirit_selfname 工具自己增删（累积式），主人可改可删；空 ⇒ 整行离场
  const selfNames = (card.selfNames ?? []).slice(0, PERSONA_LINE_LIMITS.maxItemsPerLine);
  if (selfNames.length > 0) lines.push(`[自称] ${selfNames.join('、')}`);
  lines.push(`[语气] ${VOICE_WORDS[card.voice]}`);
  const values = card.values.slice(0, PERSONA_LINE_LIMITS.maxItemsPerLine);
  if (values.length > 0) lines.push(`[看重] ${values.join('；')}`);
  const boundaries = card.boundaries.slice(0, PERSONA_LINE_LIMITS.maxItemsPerLine);
  if (boundaries.length > 0) lines.push(`[不会做] ${boundaries.join('；')}`);
  const text = lines.join('\n');
  return truncateToLine(text, budgetBytes);
}

/** 预算是否装得下整张卡（面板与 lint 用，不参与渲染）。 */
export function personaTextFits(card: PersonaCard, budgetBytes: number): boolean {
  return byteLen(composePersonaText(card, Number.MAX_SAFE_INTEGER)) <= budgetBytes;
}

/**
 * 主人段的稳定区文本（与 `composePersonaText` 同三条纪律：固定字段序、纯函数、
 * 整行边界截断；预算独立键 `owner.budgetBytes`，不挤人格区）。
 *
 * 段序：**自述优先**（主人手写的比图谱投影的权威），同步段在后；
 * 两段皆空 ⇒ 返回 `''` 物理离场（宿主不会拼进系统提示，零副作用）。
 * 多行内容逐行进线，`truncateToLine` 的字节顶天然截掉装不下的实体行（宁缺勿断）。
 */
export function composeOwnerText(profile: { selfText: string; syncText: string }, budgetBytes: number): string {
  const lines: string[] = [];
  if (profile.selfText.trim() !== '') lines.push(`[主人] ${profile.selfText.trim()}`);
  if (profile.syncText.trim() !== '') lines.push(`[主人的背景(同步)] ${profile.syncText.trim()}`);
  return truncateToLine(lines.join('\n'), budgetBytes);
}
