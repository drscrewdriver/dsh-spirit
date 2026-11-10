import type { DatabaseSync } from 'node:sqlite';

import { SLEEP_BACKOFF_BASE_MS, SLEEP_BACKOFF_CAP_MS, SLEEP_BATCH_MAX, SLEEP_DEDUP_MS, SLEEP_FAIL_PARK_STREAK } from '../distill/ruminate.js';
import { NoDistillRouteError, resolveDistillRoute, type DistillRoute, type LlmChannel } from '../distill/llm.js';
import type { MinimalLogger } from '../persona/store.js';
import type { SpiritConfig } from '../contract.js';
import { TRUST_DERIVED_SUMMARY } from '../types.js';
import { isSemanticAllowed } from './gate.js';
import { buildTxnUser, parseTxnOutput, validateTxnOutput, TXN_SUMMARY_SYSTEM, type TxnLimits, type TxnProposalRow } from './prompts.js';
import { TXN_CUE_KINDS, type TxnCueKind, type TxnStore } from '../store/transaction.js';
import { CUE_LIMITS, normalizeCue } from '../experience/cues.js';
import type { TxnSignals } from './watcher.js';

/** 单次调用的输出预算：不另开配置腿（txn 五腿是开关+区间），由批大小推——每行约 100 token 量级。 */
export const TXN_MAX_OUTPUT_TOKENS = 1_200;

export type TxnRejectPath =
  | 'disabled' | 'unsupported' | 'degraded' | 'running' | 'dedup-window' | 'backoff' | 'below-batch' | 'queue-full';

export type TxnEnqueueResult =
  | { accepted: true; key: string; scheduled: boolean }
  | { accepted: false; reason: TxnRejectPath };

type GatesResult = { accepted: true } | { accepted: false; reason: TxnRejectPath };

export interface TxnCollectReport {
  runId: string;
  batchSize: number;
  rowsProposed: number;
  rowsAccepted: number;
  rowsRejected: number;
  model: string;
  runMs: number;
}

export interface TxnCollectStatus {
  supported: boolean;
  running: boolean;
  phase: 'idle' | 'running' | 'done' | 'failed';
  detail: string;
  error: string;
  consecutiveFailures: number;
  nextAllowedAtMs: number;
  lastRunAtMs: number;
  lastReport?: TxnCollectReport;
}

export interface TxnCollectorDeps {
  db: () => DatabaseSync | null;
  store: TxnStore;
  channel: () => LlmChannel | undefined;
  defaultModel?: () => DistillRoute | undefined;
  cfg: () => SpiritConfig;
  logger: MinimalLogger;
  /** 注入时钟（退避窗口要能在测试里被读到，不能靠等）。 */
  clock?: () => number;
  /** 队列顶：无顶就是无界增长（照 ruminate 的 SLEEP_BATCH_MAX 口径）。 */
  queueMax?: number;
  /** 生产用 setTimeout；测试注入假调度器（不在测试里等真计时器）。任务可返回 promise 以便测试 await。 */
  schedule?: (task: () => unknown) => void;
}

// 信号 → cue 的 kind 就是单源词表里的三个（host 无 kind：见 watcher 头注的口径缺口）。
type CuePair = { cue: string; kind: TxnCueKind };

export class TxnCollector {
  private readonly deps: TxnCollectorDeps;
  private readonly clock: () => number;
  private readonly queueMax: number;
  private readonly schedule: (task: () => unknown) => void;
  private queue: TxnSignals[] = [];
  private running = false;
  private failStreak = 0;
  private nextAllowedAt = 0;
  private lastRunAt = 0;
  private statusValue: TxnCollectStatus = {
    supported: true, running: false, phase: 'idle', detail: '', error: '',
    consecutiveFailures: 0, nextAllowedAtMs: 0, lastRunAtMs: 0,
  };

  constructor(deps: TxnCollectorDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? Date.now;
    this.queueMax = deps.queueMax ?? SLEEP_BATCH_MAX;
    this.schedule = deps.schedule ?? ((task) => { setTimeout(task, 0); });
  }

  /**
   * 攒一条信号。这里**没有任何 await**：会话链路不能等 LLM。
   * 攒够 `txn.batchMin` 才跑；关时连队列都不攒（零落库的半边靠这条）。
   */
  enqueue(signals: TxnSignals): TxnEnqueueResult {
    const gates = this.gates();
    if (!gates.accepted) return { accepted: false, reason: gates.reason };
    if (this.queue.length >= this.queueMax) return { accepted: false, reason: 'queue-full' };
    if (this.queue.some((item) => item.key === signals.key)) return { accepted: true, key: signals.key, scheduled: false };
    this.queue.push(signals);
    const cfg = this.deps.cfg();
    // 顶是"拒收"不是"触发"（顶就是顶，不能当批触发器用）
    if (this.queue.length < cfg.txn.batchMin) return { accepted: true, key: signals.key, scheduled: false };
    // 受理即预占去重窗（照 ruminate 先例：两次快速连点不会双跑）
    this.lastRunAt = this.clock();
    this.schedule(() => this.runInner().catch((err: unknown) => {
      this.deps.logger.warn(`[spirit] 事务采集任务体异常（已收敛进状态）：${err instanceof Error ? err.message : String(err)}`);
    }));
    return { accepted: true, key: signals.key, scheduled: true };
  }

  /** 跑一次（测试/工装入口：生产路径由 enqueue 触发，这里可被同步 await）。 */
  async flush(): Promise<TxnCollectStatus> {
    const gates = this.gates();
    if (!gates.accepted) {
      this.statusValue = { ...this.statusValue, phase: 'failed', error: gates.reason, detail: `拒收：${gates.reason}` };
      return this.statusValue;
    }
    const cfg = this.deps.cfg();
    if (this.queue.length < cfg.txn.batchMin) {
      this.statusValue = { ...this.statusValue, phase: 'failed', error: 'below-batch', detail: `还没攒够（${this.queue.length}/${cfg.txn.batchMin}）` };
      return this.statusValue;
    }
    return this.runInner();
  }

  status(): TxnCollectStatus {
    return this.statusValue;
  }

  /** 队列里攒了多少条（只读，供对账）。 */
  pending(): number {
    return this.queue.length;
  }

  /** 闸：顺序照字母（disabled → 通道 → 库 → running → 去重窗 → 退避）。 */
  private gates(): GatesResult {
    const cfg = this.deps.cfg();
    if (!cfg.txn.enabled) return { accepted: false, reason: 'disabled' };
    if (this.deps.channel() === undefined) return { accepted: false, reason: 'unsupported' };
    if (this.deps.db() === null || !this.deps.store.persistent) return { accepted: false, reason: 'degraded' };
    if (this.running) return { accepted: false, reason: 'running' };
    const now = this.clock();
    if (now - this.lastRunAt < SLEEP_DEDUP_MS) return { accepted: false, reason: 'dedup-window' };
    if (now < this.nextAllowedAt) return { accepted: false, reason: 'backoff' };
    return { accepted: true };
  }

  /** 任务体：不再过闸（窗刚被自己预占，重检必自拦——照 ruminate round-29 的修法）。 */
  private async runInner(): Promise<TxnCollectStatus> {
    if (this.running) return this.statusValue;
    const cfg = this.deps.cfg();
    const batch = this.queue.splice(0, this.queueMax);
    const batchKeys = new Set(batch.map((signal) => signal.key));
    const started = this.clock();
    this.running = true;
    this.lastRunAt = started;
    this.statusValue = { ...this.statusValue, running: true, phase: 'running', detail: `攒 ${batch.length} 条信号`, error: '' };
    try {
      const route = resolveDistillRoute(cfg.distill, {
        llm: () => undefined,
        defaultModel: () => this.deps.defaultModel?.(),
        logger: this.deps.logger,
      });
      const channel = this.deps.channel();
      if (channel === undefined) throw new NoDistillRouteError('llm 通道缺席');
      const raw = await channel.complete({
        route,
        system: TXN_SUMMARY_SYSTEM,
        user: buildTxnUser(batch),
        maxTokens: TXN_MAX_OUTPUT_TOKENS,
        timeoutMs: cfg.txn.collectorTimeoutMs,
      });
      const rows = validateTxnOutput(parseTxnOutput(raw.text), batchKeys, limitsOf(cfg.txn));
      const signalByKey = new Map(batch.map((signal) => [signal.key, signal]));

      let accepted = 0;
      let rejected = 0;
      for (const row of rows) {
        if (!isSemanticAllowed({ source_trust: TRUST_DERIVED_SUMMARY, card_line: row.cardLine, summary: row.summary })) {
          rejected += 1;
          continue;
        }
        const signal = signalByKey.get(row.key);
        const result = this.deps.store.insert({
          id: `txn-${row.key}`,
          sessionId: signal?.sessionId ?? '',
          workspaceId: signal?.workspaceId ?? '',
          tsMs: signal?.tsMs ?? this.clock(),
          turnSeq: signal?.turnSeq ?? 0,
          cardLine: row.cardLine,
          summary: row.summary,
          gistKey: row.gistKey,
          semantic: row.semantic,
          sourceTrust: TRUST_DERIVED_SUMMARY,
          cues: [...mergeCues(row, signal)],
        });
        if (result.ok) accepted += 1;
        else rejected += 1;
      }

      this.failStreak = 0;
      this.nextAllowedAt = 0;
      this.statusValue = {
        ...this.statusValue,
        running: false,
        phase: 'done',
        detail: `落库 ${accepted} / 拒 ${rejected}`,
        consecutiveFailures: 0,
        nextAllowedAtMs: 0,
        lastRunAtMs: this.lastRunAt,
        lastReport: {
          runId: `tx-${this.lastRunAt.toString(36)}`,
          batchSize: batch.length,
          rowsProposed: rows.length,
          rowsAccepted: accepted,
          rowsRejected: rejected,
          model: `${route.provider}/${route.model}`,
          runMs: this.clock() - started,
        },
      };
      return this.statusValue;
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 300) : String(err);
      const configError = err instanceof NoDistillRouteError; // 确定性失败：不进连败计数（照 ruminate 口径）
      if (!configError) {
        this.failStreak += 1;
        this.nextAllowedAt = this.clock() + Math.min(SLEEP_BACKOFF_BASE_MS * 2 ** (this.failStreak - 1), SLEEP_BACKOFF_CAP_MS);
        if (this.failStreak >= SLEEP_FAIL_PARK_STREAK) {
          const interval = this.deps.cfg().distill.intervalMs;
          this.nextAllowedAt = this.clock() + (interval > 0 ? interval : SLEEP_BACKOFF_CAP_MS);
        }
      }
      this.statusValue = {
        ...this.statusValue,
        running: false,
        phase: 'failed',
        error: message,
        detail: configError ? '路由配置类错误（不进退避）' : `退避至 ${this.nextAllowedAt}`,
        consecutiveFailures: this.failStreak,
        nextAllowedAtMs: this.nextAllowedAt,
        lastRunAtMs: this.lastRunAt,
      };
      return this.statusValue;
    } finally {
      // 跑完必须复位（照 ruminate 先例）：running 不复位会把后续 enqueue 全判成 'running'。
      this.running = false;
    }
  }
}

/** 校验用的区间取自配置（写死数字就是把配置键变摆设）。 */
function limitsOf(txn: { maxCardLineChars: number; maxSummaryChars: number }): TxnLimits {
  return { maxCardLineChars: txn.maxCardLineChars, maxSummaryChars: txn.maxSummaryChars };
}

/**
 * 信号派生 cue 与 LLM 派生 cue 合并（同一口径只能有一份：归一在 normalizeCue，顶在 store 侧）。
 * 这里只出"未绑身份"的 cue 对——`txnId` 由 store 补，collector 不造身份。
 */
function mergeCues(row: TxnProposalRow, signal: TxnSignals | undefined): CuePair[] {
  const out = new Map<string, CuePair>();
  const add = (token: string, kind: TxnCueKind): void => {
    const clean = normalizeCue(token);
    if (clean === '' || !(TXN_CUE_KINDS as readonly string[]).includes(kind)) return;
    out.set(`${kind}:${clean}`, { cue: clean, kind });
  };
  if (signal !== undefined) {
    for (const base of signal.pathBases) add(base, 'file');
    for (const tool of signal.toolNames) add(tool, 'tool');
    for (const title of signal.todoTitles) {
      const token = title.split(/\s+/u)[0] ?? '';
      if (token !== '') add(token, 'topic');
    }
  }
  for (const cue of row.cues) add(cue.cue, cue.kind);
  return [...out.values()].slice(0, CUE_LIMITS.maxPerEntry);
}
