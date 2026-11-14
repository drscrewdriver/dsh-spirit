/**
 * 回响原文回填（v0.8.3）：把「只有摘要、没有原文」的旧条目补回整张卡。
 *
 * 为什么要单独一条路：
 * - v11 落档只存了 preview（侧栏一行）；v12 才开始存 text（查看器整张卡）。
 *   于是升级前落的行 text=''，查看器只能回退「早期落档无原文（只有摘要）」。
 * - 原文其实还在：DRSC 会话日志里那条 `<system-reminder>` 卡是原样留着的（spirit 注入的是
 *   一条 message，不是改别的东西）。所以能按「摘要相同」或「时间最近」把它捞回来。
 *
 * 纪律：
 * - 只补空值（store.setText 带 `text = ''` 条件），绝不覆盖已有原文；
 * - 窗口有顶（缺省 7 天、单次 500 条、单会话候选有顶），冷路径一次后不再跑；
 * - 只认标记 `SPIRIT_CARD_SIGNATURE`，不猜别的东西是卡；
 * - 库/扫描不可用 ⇒ 整段休眠（不上报失败，不阻塞启动）。
 */
import type { DrscSessionRow } from '../drsc/client.js';
import { previewOfEcho } from '../echo-log.js';
import { SPIRIT_CARD_SIGNATURE } from '../slot/render.js';
import type { MinimalLogger } from '../persona/store.js';
import type { EchoRecallStore } from '../store/echo-recall.js';

/** 缺省回抽窗口：一周（用户点名「至少抽一周内的历史」）。 */
export const ECHO_BACKFILL_DAYS = 7;
/** 缺省单次处理上限（含跨会话），防止首次升级扫太久。 */
export const ECHO_BACKFILL_LIMIT = 500;
/** 时间兜底匹配的容差：卡与会话日志里的落点差通常 <1s，给 2 分钟足够宽松又不至于认错。 */
const TIME_TOLERANCE_MS = 120_000;
/** 摘要对不上时的时间兜底容差：DRSC 会改写正文（插空格/脱敏），宁可多给点窗口也不丢条目。 */
const TIME_TOLERANCE_LOOSE_MS = 10 * 60_000;
/** 单会话最多取几张卡（同一会话里卡数与条目数同阶，再多也没用）。 */
const CARD_LIMIT = 200;

export interface EchoTextScan {
  sessionAll(sessionId: string): Promise<DrscSessionRow[]>;
}

export interface EchoTextBackfillDeps {
  store: EchoRecallStore;
  scan: () => EchoTextScan | undefined;
  logger: MinimalLogger;
  now?: () => number;
}

export interface EchoTextBackfillResult {
  /** 是否真的跑了一遍（false = 库/扫描缺席、或窗口内没有待补条目）。 */
  ran: boolean;
  /** 窗口内「有摘要没原文」的条目数。 */
  pending: number;
  /** 真正补上原文的条目数。 */
  filled: number;
  /** 扫过的会话数（去重后）。 */
  sessions: number;
}

interface CardCandidate {
  at: number;
  text: string;
  preview: string;
  used: boolean;
}

/** 一条 DRSC 行是不是回响卡（只认签名行，不认「状态：」这种可能出现在别处的词）。 */
function isEchoCard(row: DrscSessionRow): boolean {
  return typeof row.text === 'string' && row.text.includes(SPIRIT_CARD_SIGNATURE);
}

/** 从会话日志里挑出所有回响卡（按时间升序，单会话有顶）。 */
export function cardsOf(rows: readonly DrscSessionRow[]): CardCandidate[] {
  const cards: CardCandidate[] = [];
  for (const row of rows) {
    if (!isEchoCard(row)) continue;
    cards.push({ at: Number(row.time ?? 0), text: row.text, preview: previewOfEcho(row.text), used: false });
    if (cards.length >= CARD_LIMIT) break;
  }
  return cards.sort((left, right) => left.at - right.at);
}

/**
 * 摘要比对用的归一化：**吃掉所有空白**。
 *
 * DRSC 的 `redact=1` 会在分段边界插空格（实测 `线程：` 变成 `线 程：`），逐字比较
 * 会把本该匹配上的两卡判成不同人。段内文字与顺序都没变，去掉空白后仍然可靠。
 */
function squash(text: string): string {
  return text.replaceAll(/\s+/gu, '');
}

/**
 * 为一个待补条目挑卡：
 * 1. 摘要（归一化后）一致优先（最稳，跨重启/跨版本都对得上）；
 * 2. 摘要对不上（DRSC 侧脱敏改写过正文）才退到时间最近，且必须在容差内。
 *
 * 摘要非空却对不上时也允许时间兜底——DRSC 会把正文明文替换掉，preview 自然变了；
 * 反过来「摘要为空」（v10 行）只能走时间（用严容差）。
 */
export function pickCard(pending: { at: number; preview: string }, cards: CardCandidate[]): CardCandidate | undefined {
  const free = cards.filter((card) => !card.used);
  if (free.length === 0) return undefined;
  const wanted = squash(pending.preview);
  if (wanted !== '') {
    const exact = free.find((card) => squash(card.preview) === wanted);
    if (exact !== undefined) return exact;
  }
  // 摘要为空 = 旧版没存摘要，只能时间；摘要对不上 = 正文被改写，窗口放宽。
  const tolerance = wanted === '' ? TIME_TOLERANCE_MS : TIME_TOLERANCE_LOOSE_MS;
  let best: CardCandidate | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const card of free) {
    const gap = Math.abs(card.at - pending.at);
    if (gap <= tolerance && gap < bestGap) {
      best = card;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * 跑一次回填（冷路径，调用方自己安排时机）。
 *
 * 会话维度：先按 `pendingText` 聚合出会话集合，再逐会话拉一次全文（一次网络往返），
 * 会话内按条目逐条挑卡；单会话失败只 warn，继续下一个。
 */
export async function backfillEchoText(deps: EchoTextBackfillDeps): Promise<EchoTextBackfillResult> {
  const now = deps.now ?? Date.now;
  const since = now() - ECHO_BACKFILL_DAYS * 86_400_000;
  const pending = deps.store.pendingText(since, ECHO_BACKFILL_LIMIT);
  if (pending.length === 0) return { ran: false, pending: 0, filled: 0, sessions: 0 };
  const scan = deps.scan();
  if (scan === undefined) return { ran: false, pending: pending.length, filled: 0, sessions: 0 };

  const bySession = new Map<string, typeof pending>();
  for (const row of pending) {
    if (row.sessionId === '') continue;
    const bucket = bySession.get(row.sessionId);
    if (bucket === undefined) bySession.set(row.sessionId, [row]);
    else bucket.push(row);
  }

  let filled = 0;
  let sessions = 0;
  for (const [sessionId, rows] of bySession) {
    sessions += 1;
    let cards: CardCandidate[];
    try {
      cards = cardsOf(await scan.sessionAll(sessionId));
    } catch (err) {
      deps.logger.warn(`回响原文回填：会话读取失败（跳过该会话）：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (cards.length === 0) continue;
    // 老的先补：一张卡只配一条，顺序乱了会把两条的卡配反。
    for (const row of [...rows].sort((left, right) => left.at - right.at)) {
      const card = pickCard(row, cards);
      if (card === undefined) continue;
      card.used = true;
      if (row.hasText) {
        // 原文已经有了，只缺摘要（v10 行）——补上它才能回到侧栏列表。
        if (deps.store.setPreview(sessionId, row.id, card.preview)) filled += 1;
        continue;
      }
      if (deps.store.setText(sessionId, row.id, card.text, card.preview)) filled += 1;
    }
  }
  if (filled > 0) deps.logger.warn(`回响原文回填：补回 ${filled}/${pending.length} 条（近 ${ECHO_BACKFILL_DAYS} 天，${sessions} 个会话）`);
  return { ran: true, pending: pending.length, filled, sessions };
}
