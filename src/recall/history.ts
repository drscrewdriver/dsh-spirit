/**
 * 历史路（路 B）：让"被勾起"的旧片段进卡。
 *
 * 两个来源、一条纪律：**任一路拿不到都不编造**。
 * - 自家条目库（旧会话/本会话早些时候的体验句）——总是可用，除非库降级；
 * - DRSC 检索面（会话原文）——未安装/超时/字段形状未知 ⇒ 整段省略。
 *
 * 超时是必须的：这条路在 `agent/pre-step` 的串行路径上，一次 loopback 抖动就变成
 * "用户等半秒看一句回忆"。**对话延迟永远比少一条回忆贵**。
 */

import type { DrscClient } from '../drsc/client.js';
import type { DrscProbe } from '../drsc/probe.js';
import { hitToCandidate } from '../drsc/segments.js';
import type { ExperienceStore } from '../store/experience.js';
import { isOwnCardText } from '../slot/render.js';

export interface HistoryInput {
  /** 本轮新用户消息（截断后当查询串；本模块不存原文）。 */
  query: string;
  sessionId?: string;
  limit: number;
  maxCharsPerEntry: number;
  timeoutMs: number;
  now: number;
  /** 已经在"刚刚"段出现的文本，避免同句进两段。 */
  exclude?: ReadonlySet<string>;
}

export type HistoryLane = 'none' | 'local' | 'drsc' | 'local+drsc' | 'drsc-timeout';

export interface HistoryResult {
  excerpts: string[];
  sourceRefs: string[];
  laneUsed: HistoryLane;
}

export interface HistoryDeps {
  store: ExperienceStore;
  /** DRSC 缺席时传 undefined ⇒ 只走本地。 */
  client?: DrscClient;
  probe?: DrscProbe;
}

/** 带超时的等待：超时返回 undefined，不抛。 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  if (!(timeoutMs > 0)) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } catch {
    // 客户端内部已把网络错误包成 DrscClientError；这里再兜一层，任何异常都只停用该路
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 取历史片段。
 *
 * 顺序固定：先自家条目（更贴近"我记得"），再 DRSC 原文（更贴近"当时那句话说的是…"）。
 * 两路都不做名次归并——它们语义不同，归并不会带来信息，只会让"刚发生"被"被勾起"挤掉。
 */
export async function recallHistory(deps: HistoryDeps, input: HistoryInput): Promise<HistoryResult> {
  const exclude = input.exclude ?? new Set<string>();
  const excerpts: string[] = [];
  const sourceRefs: string[] = [];
  let lane: HistoryLane = 'none';

  /**
   * 同句只留一次。真机实采到的形状：两个会话各有一条 `tool_failure` 条目，
   * 而同一触发器编译出的**文案相同** ⇒ 卡里连着两行一模一样的「想起：…」。
   * 不去重不只是难看：它白占卡片预算（把本来能进来的另一段挤掉），且读起来像故障。
   */
  const seen = new Set<string>();
  const pushExcerpt = (text: string, ref: string): void => {
    if (seen.has(text)) return;
    seen.add(text);
    excerpts.push(text);
    sourceRefs.push(ref);
  };

  const local = deps.store.searchLocal(input.query, { sessionId: input.sessionId, limit: input.limit });
  for (const entry of local) {
    if (excerpts.length >= input.limit) break;
    if (exclude.has(entry.text)) continue;
    if (isOwnCardText(entry.text)) continue; // 自家卡行不当历史记回来
    pushExcerpt(entry.text, entry.sourceRef ?? `spirit:${entry.id}`);
    lane = 'local';
  }

  if (excerpts.length < input.limit && deps.client !== undefined && deps.probe !== undefined) {
    if (await deps.probe.usable()) {
      const remain = input.limit - excerpts.length;
      const options = {
        now: input.now,
        halfLifeMs: 0, // 历史路的相关度由 rank 决定，这里不再叠加近因（避免旧事被时间惩罚两次）
        maxChars: input.maxCharsPerEntry,
        isOwnCard: isOwnCardText,
      };
      const hits = await withTimeout(deps.client.search(input.query, remain * 2), input.timeoutMs);
      if (hits === undefined) {
        lane = excerpts.length > 0 ? 'local' : 'drsc-timeout';
      } else {
        const candidates = hits
          .map((hit) => hitToCandidate(hit, options))
          .filter((candidate) => candidate !== undefined);
        let added = 0;
        for (const candidate of candidates) {
          if (excerpts.length >= input.limit) break;
          if (candidate === undefined || exclude.has(candidate.excerpt)) continue;
          const before = excerpts.length;
          pushExcerpt(candidate.excerpt, candidate.sourceRef);
          if (excerpts.length > before) added += 1;
        }
        if (added > 0) lane = lane === 'local' ? 'local+drsc' : 'drsc';
      }
    }
  }

  return { excerpts, sourceRefs, laneUsed: lane };
}

/** 只在有查询串时才值得走历史路（空查询会捞回一堆无关行）。 */
export function queryWorthRecall(query: string, minChars = 2): boolean {
  return query.replace(/[\s\p{P}]/gu, '').length >= minChars;
}
