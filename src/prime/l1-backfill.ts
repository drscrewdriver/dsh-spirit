/**
 * 历史重建执行器（v0.8.24）：面板「全记忆重建」背后的 runner。
 *
 * 与旧 BackfillRunner 的差别：不再扫会话（DRSC），改为读上游 L1 做本体/交付/实体重建。
 * 接口保持不变（start/status + SpiritBackfillStatus），面板轮询无感切换。
 */
import type { SpiritBackfillRunResult, SpiritBackfillStatus } from '../contract.js';
import type { MinimalLogger } from '../persona/store.js';
import type { L1IngestResult } from './l1-ingest.js';

export interface L1BackfillDeps {
  run: (dryRun: boolean) => L1IngestResult;
  logger: MinimalLogger;
  clock?: () => number;
}

export class L1BackfillRunner {
  private readonly deps: L1BackfillDeps;
  private running = false;
  private progress: SpiritBackfillStatus = {
    running: false,
    phase: 'idle',
    dryRun: false,
    totalSessions: 0,
    doneSessions: 0,
    totalTurns: 0,
    doneTurns: 0,
    failedSessions: 0,
    lastError: '',
    startedAt: 0,
    finishedAt: 0,
  };

  constructor(deps: L1BackfillDeps) {
    this.deps = deps;
  }

  status(): SpiritBackfillStatus {
    return { ...this.progress };
  }

  /** 异步受理（面板连点只跑一次）；进度走 status()。 */
  start(dryRun: boolean): SpiritBackfillRunResult {
    if (this.running) return { accepted: false, reason: 'running' };
    this.running = true;
    const startedAt = (this.deps.clock ?? Date.now)();
    this.progress = { ...this.progress, running: true, phase: 'scanning', dryRun, startedAt, finishedAt: 0, lastError: '', failedSessions: 0, doneSessions: 0, doneTurns: 0 };
    void Promise.resolve()
      .then(() => {
        const result = this.deps.run(dryRun);
        this.progress = {
          ...this.progress,
          running: false,
          phase: 'done',
          totalSessions: result.total,
          doneSessions: result.total,
          totalTurns: result.tasks + result.deliveries,
          doneTurns: result.tasks + result.deliveries,
          finishedAt: (this.deps.clock ?? Date.now)(),
        };
        this.deps.logger.info(`[spirit] L1 重建完成：task ${result.tasks} · 交付 ${result.deliveries} · 实体 ${result.entities} · ref ${result.refs}`);
      })
      .catch((err: unknown) => {
        this.progress = {
          ...this.progress,
          running: false,
          phase: 'failed',
          lastError: err instanceof Error ? err.message : String(err),
          finishedAt: (this.deps.clock ?? Date.now)(),
        };
        this.deps.logger.warn(`[spirit] L1 重建失败：${this.progress.lastError}`);
      })
      .finally(() => {
        this.running = false;
      });
    return { accepted: true };
  }
}
