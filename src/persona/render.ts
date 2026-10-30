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
