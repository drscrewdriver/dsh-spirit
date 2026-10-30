/**
 * DRSC 行 → 「想起」候选的转换层。
 *
 * 为什么必须有一层转换：collector 给的是**会话原文投影**（seq/turn/kind/role/time/text），
 * 而回忆卡要的是"被勾起来的一段经历"。这一层只做三件事，且都是有理由的收窄：
 *
 * 1. **只保留对话行**（`user/message` / `assistant/message`）。`tool/call`、`tool/result`
 *    之类的行有正文但没有叙事价值，进卡只会挤掉有效内容。
 * 2. **回声过滤**（`isOwnCard` 谓词由调用方注入）。⚠️ 这里不能用 `isOwnExperienceSource`：
 *    DRSC 的 segment 行**不携带 source 字段**，署名形状在这条路上读不到——所以按
 *    **文本特征**判（自家卡的固定声明行）。写反判据的后果很具体：把"我上次很挫败"
 *    这类自己写的行当历史原文记回来，越记越多，就是回声室。
 * 3. **只带 `sourceRef`，不复制正文进条目库**。原文留在 collector 里；spirit 只存锚点，
 *    既不越界做别人的数据副本，也让"这条回忆从哪来"可回溯。
 *
 * `isOwnCard` 用注入而不是在这里硬编码特征串：卡文本形状属于 `slot/render`，
 * 在这里抄一份字面量就是第二份真源（render 改文案 ⇒ 过滤静默失效，无报错）。
 */

import { LANE_DRSC, type Lane } from '../types.js';
import { decayWeight } from '../util/decay.js';
import type { DrscSearchHit, DrscSessionRow } from './client.js';

/** 一条「想起」候选（进卡的原料，不是库内条目）。 */
export interface RecallCandidate {
  /** 稳定锚点 `drsc:<session>:<seq>`，可回溯到 collector 的行。 */
  sourceRef: string;
  lane: Lane;
  timeMs: number;
  /** 已按 `maxChars` 截断的脱敏正文片段。 */
  excerpt: string;
  /** 说话方；只有对话行才会有值（非对话行在转换阶段就被丢了）。 */
  role?: 'user' | 'assistant';
  /** 检索名次带来的先验（`op=search` 有，尾窗没有 ⇒ 1）。 */
  rankPrior: number;
}

/** 对话行的 kind 词表（宿主事件类型，非本仓枚举）。 */
const USER_ROW_KIND = 'user/message';
const ASSISTANT_ROW_KIND = 'assistant/message';

export function roleOfKind(kind: string): 'user' | 'assistant' | undefined {
  if (kind === USER_ROW_KIND) return 'user';
  if (kind === ASSISTANT_ROW_KIND) return 'assistant';
  return undefined;
}

/**
 * 近因权重：实现单源在 `util/decay.ts`（这里只转发，避免两个时间尺度上漂出两套公式）。
 */
export { decayWeight } from '../util/decay.js';

export interface ToCandidateOptions {
  now: number;
  halfLifeMs: number;
  /** 单条进卡的最大字符数（与 `recall.maxCharsPerEntry` 同源）。 */
  maxChars: number;
  /** 识别"这是我自己写的卡行"的谓词（由调用方从 render 层注入）。 */
  isOwnCard: (text: string) => boolean;
}

function excerptOf(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, Math.max(0, maxChars));
}

/**
 * 尾窗/整会话行 → 候选。非对话行与自家卡行返回 `undefined`（调用方跳过）。
 *
 * @param sessionId 锚点的会话身份由**调用方**传：`op=session` 的响应行里只有 seq/turn，
 *                  不携带 session id，拼错就回溯不到原行。
 */
export function rowToCandidate(
  sessionId: string,
  row: DrscSessionRow,
  options: ToCandidateOptions,
): RecallCandidate | undefined {
  const role = roleOfKind(row.kind);
  if (role === undefined) return undefined;
  if (options.isOwnCard(row.text)) return undefined;
  return {
    sourceRef: `drsc:${sessionId}:${row.seq}`,
    lane: LANE_DRSC,
    timeMs: row.time,
    excerpt: excerptOf(row.text, options.maxChars),
    role,
    rankPrior: 1,
  };
}

/** 检索命中 → 候选（带名次先验：rank 越小先验越大）。 */
export function hitToCandidate(hit: DrscSearchHit, options: ToCandidateOptions): RecallCandidate | undefined {
  const role = roleOfKind(hit.kind);
  if (role === undefined) return undefined;
  if (options.isOwnCard(hit.snippet)) return undefined;
  return {
    sourceRef: `drsc:${hit.sessionId}:${hit.seq}`,
    lane: LANE_DRSC,
    timeMs: hit.timeMs,
    excerpt: excerptOf(hit.snippet, options.maxChars),
    role,
    rankPrior: 1 / (1 + Math.max(0, hit.rank)),
  };
}

/**
 * 按"相关度先验 × 近因权重"降序取前 N。
 *
 * 权重相同则**按 sourceRef 稳定排序**：排序不稳定会让同一输入两次产出不同卡文本，
 * 同态断言（同 Mood + 同召回 ⇒ 字节全等）当场就破。
 */
export function selectCandidates(
  candidates: readonly RecallCandidate[],
  options: Pick<ToCandidateOptions, 'now' | 'halfLifeMs'>,
  maxResults: number,
): RecallCandidate[] {
  const scored = candidates.map((candidate) => ({
    candidate,
    score: candidate.rankPrior * decayWeight(candidate.timeMs, options.now, options.halfLifeMs),
  }));
  scored.sort((a, b) => (b.score - a.score) || (a.candidate.sourceRef < b.candidate.sourceRef ? -1 : 1));
  return scored.slice(0, Math.max(0, Math.floor(maxResults))).map((entry) => entry.candidate);
}
