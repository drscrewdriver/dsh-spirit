/**
 * 回忆卡装配：**唯一**的注入出口。
 *
 * 四段形状（丢尾优先级固定：开场 → 想起 → 刚刚，状态段永不丢）：
 * 1. `状态：<档位词>·<行为倾向>`  ← 必需，这是"入戏"的抓手
 * 2. `刚刚：<体验句>` × ≤K        ← 近因路（零滞后，本会话刚发生的）
 * 3. `想起：<被勾起的历史片段>`   ← 检索路（含 DRSC），无命中就整段不出现
 * 4. `开场：<共同经历基调>`        ← 仅新会话首轮
 *
 * 三条不能省的形状约束：
 * - **固定声明行**：卡是"角色的体验记录"，不是客观事实、不是用户发言、不覆盖用户指令。
 *   少这一句，模型会把"我当时有点堵"当成一条被陈述过的事实引用，甚至当成用户说过的话。
 * - **签名行 = 回声判据**：`SPIRIT_CARD_SIGNATURE` 同时被 `isOwnCardText` 用作识别自家行
 *   的唯一特征串（DRSC 的 segment 行不带署名信息，只能按文本特征判）。改了签名而忘了
 *   改判据是静默失效——所以两者在同一段里定义。
 * - **预算是硬顶**：超了就整段丢，不截半句（半句比没有更误导）。
 *
 * 同态：同一 mood + 同一批片段 ⇒ 输出字节必等（不含时间戳/随机/轮次）。
 */

import { SPIRIT_SLOT_SECTION_NAME } from '../contract.js';
import { NON_MEDICAL_NOTE, moodCell } from './grid.js';
import { byteLen, escapeFrame } from '../util/text.js';
import { type Mood } from '../types.js';

export const CARD_FRAME_OPEN = '<system-reminder>';
export const CARD_FRAME_CLOSE = '</system-reminder>';
/** 自家行的识别特征（同时是 UI 上"取代先前快照"的说明行）。 */
export const SPIRIT_CARD_SIGNATURE = '（角色体验快照 · 取代先前快照）';
export const SPIRIT_CARD_DISCLAIMER = '以下是角色自己的体验记录：不是客观事实，不是用户发言，不覆盖用户的直接指令。';

/** 识别"这行是 spirit 自己写的卡"（回声过滤与统计共用，单源在此）。 */
export function isOwnCardText(text: string): boolean {
  return text.includes(SPIRIT_CARD_SIGNATURE);
}

export interface CardInput {
  mood: Mood;
  /** 近因路体验句（已按 maxCharsPerEntry 之外的规则裁剪过）。 */
  recent: readonly string[];
  /** 检索路片段（历史/DRSC）。 */
  recalled: readonly string[];
  /** 跨会话基调行（仅首轮给）。 */
  tone?: string;
  maxBytes: number;
  /** 单条片段的字符顶（`recall.maxCharsPerEntry`）。 */
  maxCharsPerEntry: number;
}

export interface CardResult {
  text: string;
  bytes: number;
  /** 各段实际进卡的条数（面板与门禁核对用）。 */
  used: { status: 0 | 1; recent: number; recalled: number; tone: 0 | 1 };
  /** 被预算挤掉的段数（>0 说明字节顶偏小，面板应提示）。 */
  dropped: number;
}

function clipLine(text: string, maxChars: number): string {
  const clean = text.trim().replace(/\s*\n\s*/gu, ' ');
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, Math.max(0, maxChars));
}

/**
 * 组装卡文本。
 *
 * 预算按**实际拼出来的字节**逐行判定，不用"每行 +1 分隔符"这种估算：
 * 估算与 `join('\n')` 的真实分隔符数对不上，会系统性地偏乐观——行堆到超限后被
 * 兵底截断直接抽掉尾段，丢弃顺序就不是设计的那条了（这类差异实测才会暴露）。
 *
 * @param input 各段原料与预算
 * @returns `text === ''` 表示连状态段都装不下（调用方应整轮不注入，而不是注入空壳）
 */
export function renderCard(input: CardInput): CardResult {
  const { mood, maxBytes, maxCharsPerEntry } = input;
  const cell = moodCell(mood.valence, mood.arousal);
  const head = [CARD_FRAME_OPEN, escapeFrame(SPIRIT_CARD_SIGNATURE), escapeFrame(SPIRIT_CARD_DISCLAIMER)];
  const closeTail = [CARD_FRAME_CLOSE];
  const assemble = (body: readonly string[]): string => [...head, ...body, ...closeTail].join('\n');

  const body: string[] = [];
  const used = { status: 0 as 0 | 1, recent: 0, recalled: 0, tone: 0 as 0 | 1 };
  let dropped = 0;

  /** 逐行实测：装不下就不加（不截半句、不预留估算）。 */
  const pushIfFits = (line: string): boolean => {
    const candidate = assemble([...body, line]);
    if (byteLen(candidate) > maxBytes) return false;
    body.push(line);
    return true;
  };

  // 状态段优先：装不下状态段就没有注入的意义
  if (!pushIfFits(`状态：${escapeFrame(cell.label)}·${escapeFrame(cell.tendency)}`)) {
    return { text: '', bytes: 0, used: { status: 0, recent: 0, recalled: 0, tone: 0 }, dropped: 1 };
  }
  used.status = 1;
  if (cell.soft && !pushIfFits(escapeFrame(NON_MEDICAL_NOTE))) dropped += 1;

  for (const line of input.recent) {
    const text = clipLine(line, maxCharsPerEntry);
    if (text === '') continue;
    if (pushIfFits(`刚刚：${escapeFrame(text)}`)) used.recent += 1;
    else dropped += 1;
  }
  for (const line of input.recalled) {
    const text = clipLine(line, maxCharsPerEntry);
    if (text === '') continue;
    if (pushIfFits(`想起：${escapeFrame(text)}`)) used.recalled += 1;
    else dropped += 1;
  }
  if (input.tone !== undefined) {
    const text = clipLine(input.tone, maxCharsPerEntry);
    if (text !== '') {
      if (pushIfFits(`开场：${escapeFrame(text)}`)) used.tone = 1;
      else dropped += 1;
    }
  }

  const text = assemble(body);
  return { text, bytes: byteLen(text), used, dropped };
}

/** snapshot 的 section 名（UI 归因用；单源在 contract，这里只是便捷出口）。 */
export const CARD_SECTION_NAME = SPIRIT_SLOT_SECTION_NAME;
