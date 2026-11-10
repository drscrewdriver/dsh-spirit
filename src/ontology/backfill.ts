/**
 * 历史会话回填（Phase E）：扫既有会话日志（经 DRSC API，不直读其 db），把过去的交付补成本体记录。
 *
 * 为什么排在最后、且强门控（Agent C 的硬前置）：
 * - 历史正文可能含密钥/PII ⇒ 每条信号先 dropIfSecret，含密整段丢；
 * - 回填产物打 TRUST_BACKFILL，注入读面排除（只进翻阅/timeline/resource），绝不回灌当前上下文；
 * - delivery id 确定性（dlv-<session>/<turn>）⇒ 重扫主键冲突即 no-op，天然幂等；再加 meta done 集跳过整会话；
 * - 缺省 dryRun：不显式 dryRun:false 不落库（照 journal-export 先例）；backfillEnabled 关 ⇒ 直接拒。
 *
 * 冷路径：走 extractor 的异步批 + 退避节律，绝不与每轮 pre-step 共线程。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { SpiritConfig, SpiritBackfillStatus, SpiritBackfillRunResult } from '../contract.js';
import type { MinimalLogger } from '../persona/store.js';
import type { DrscSessionRow } from '../drsc/client.js';
import { dropIfSecret } from './scrub.js';
import { resolveWorkspaceId } from './workspace.js';
import type { OntologySignals } from './watcher.js';
import type { OntologyExtractor } from './extractor.js';

/** meta 单键：已回填会话 id 集（跳过整会话重扫；delivery 级幂等另由主键冲突兜）。 */
export const BACKFILL_DONE_KEY = 'ontology.backfill.done';
const PAGE = 200;
/**
 * 每批进抽取器的轮数（≤ 抽取器 QUEUE_MAX=24）。取 8：回填的轮正文可能很长（1200+1200 字/轮），
 * 单批越小，单次 LLM 调用越快、越不容易撞超时；失败时抽取器会再对半拆批隔离坏轮。
 */
const QUEUE_CHUNK = 8;
const USER_CHARS = 1200;
const ASSISTANT_CHARS = 1200;

/** DRSC 扫描面（注入以便测试用假实现；生产是 DrscClient 的薄适配）。cwd 作工作区标识（与在线 workspaceIdOfAgent 取 session header.cwd 同源）。 */
export interface BackfillScan {
  sessions(offset: number, limit: number): Promise<{ total: number; rows: Array<{ sessionId: string; cwd?: string }> }>;
  sessionAll(sessionId: string): Promise<DrscSessionRow[]>;
}

export interface BackfillDeps {
  db: () => DatabaseSync | null;
  scan: () => BackfillScan | undefined;
  extractor: OntologyExtractor;
  cfg: () => SpiritConfig;
  logger: MinimalLogger;
  clock?: () => number;
}

export interface BackfillResult {
  ok: boolean;
  reason?: 'disabled' | 'no-scan' | 'degraded';
  /** 失败时的真实原因（抽取器 status.error 原文）：面板直接展示，不再只给笼统 degraded。 */
  error?: string;
  dryRun: boolean;
  sessionsScanned: number;
  sessionsSkipped: number;
  turnsQueued: number;
}

function clamp(text: string, maxChars: number): string {
  return Array.from(text).join('').length <= maxChars ? text : Array.from(text).slice(0, maxChars).join('');
}

/** 一会话的 DRSC 行 → 按 turn 分组的回填信号（只取 user/assistant 正文，工具/路径不回填）。 */
export function rowsToSignals(sessionId: string, workspaceId: string, rows: readonly DrscSessionRow[]): OntologySignals[] {
  interface Turn { turnSeq: number; tsMs: number; user: string[]; assistant: string[] }
  const byTurn = new Map<number, Turn>();
  for (const row of rows) {
    const turn = Number(row.turn);
    if (!Number.isFinite(turn)) continue;
    let slot = byTurn.get(turn);
    if (slot === undefined) {
      slot = { turnSeq: turn, tsMs: row.time, user: [], assistant: [] };
      byTurn.set(turn, slot);
    }
    slot.tsMs = Math.max(slot.tsMs, row.time);
    const safe = dropIfSecret(row.text);
    if (safe === null) continue; // 含密整段丢
    if (row.kind === 'user/message') slot.user.push(safe);
    else if (row.kind === 'assistant/message') slot.assistant.push(safe);
  }
  const out: OntologySignals[] = [];
  for (const slot of byTurn.values()) {
    const userText = clamp(slot.user.join('\n'), USER_CHARS);
    const assistantText = clamp(slot.assistant.join('\n'), ASSISTANT_CHARS);
    if (userText === '' && assistantText === '') continue; // 无叙事价值的轮不回填
    out.push({
      key: `${sessionId}/${slot.turnSeq}`,
      sessionId,
      workspaceId,
      turnSeq: slot.turnSeq,
      tsMs: slot.tsMs,
      userText,
      assistantText,
      todoTitles: [],
      toolNames: [],
      pathBases: [],
      backfill: true,
    });
  }
  return out.sort((a, b) => a.turnSeq - b.turnSeq);
}

function readDone(db: DatabaseSync): Set<string> {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(BACKFILL_DONE_KEY) as { value?: unknown } | undefined;
    if (typeof row?.value !== 'string' || row.value === '') return new Set();
    const parsed: unknown = JSON.parse(row.value);
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeDone(db: DatabaseSync, done: ReadonlySet<string>): void {
  try {
    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(BACKFILL_DONE_KEY, JSON.stringify([...done]));
  } catch {
    // 写水位失败不抛穿：下次重扫靠 delivery 主键幂等兜底
  }
}

/**
 * 水位自愈：done 却库里查无该会话任何 dlv 行 ⇒ 旧版"零产出也当 done"写下的毒水位，摘掉重进本次重建。
 * 真没正文可记的会话会每次重建白跑一次 sessionAll（不花模型额度）——比历史永久丢失好。
 * 返回被摘掉的数（调用方落日志）。
 */
function prunePoisonedDone(db: DatabaseSync, done: Set<string>): number {
  try {
    const rows = db.prepare(`SELECT DISTINCT session_id FROM txn_entry WHERE id LIKE 'dlv-%'`).all() as Array<{ session_id: unknown }>;
    const produced = new Set(rows.map((r) => String(r['session_id'])));
    let pruned = 0;
    for (const id of [...done]) {
      if (!produced.has(id)) {
        done.delete(id);
        pruned += 1;
      }
    }
    return pruned;
  } catch {
    return 0; // 查不动就不修：宁可照旧跳过也不可全量重跑炸额度
  }
}

export class BackfillRunner {
  private readonly deps: BackfillDeps;
  private readonly clock: () => number;
  private running = false;
  private progress: SpiritBackfillStatus = {
    running: false, phase: 'idle', dryRun: true,
    totalSessions: 0, doneSessions: 0, totalTurns: 0, doneTurns: 0, failedSessions: 0,
    lastError: '', startedAt: 0, finishedAt: 0,
  };

  constructor(deps: BackfillDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? Date.now;
  }

  /** 进度快照（面板轮询面，照长觉 sleep-status）。 */
  status(): SpiritBackfillStatus {
    return { ...this.progress };
  }

  private precheck(): { ok: true; scan: BackfillScan; db: DatabaseSync } | { ok: false; reason: 'disabled' | 'no-scan' | 'degraded' | 'running' } {
    const cfg = this.deps.cfg();
    if (!cfg.ontology.enabled || !cfg.ontology.backfillEnabled) return { ok: false, reason: 'disabled' };
    const scan = this.deps.scan();
    if (scan === undefined) return { ok: false, reason: 'no-scan' };
    const db = this.deps.db();
    if (db === null) return { ok: false, reason: 'degraded' };
    if (this.running) return { ok: false, reason: 'running' };
    return { ok: true, scan, db };
  }

  /** 异步受理（RPC 用）：立即返回 accepted，进度走 status()；同步占 running 防连点双跑。 */
  start(dryRun: boolean): SpiritBackfillRunResult {
    const pre = this.precheck();
    if (!pre.ok) {
      const reason = pre.reason === 'degraded' ? 'disabled' : pre.reason;
      return { accepted: false, reason };
    }
    this.running = true;
    void this.process(dryRun, pre.scan, pre.db).catch((err) => {
      this.deps.logger.warn(`[spirit] 全记忆重建异常：${err instanceof Error ? err.message : String(err)}`);
    });
    return { accepted: true };
  }

  /** 同步跑完（测试/工装用）：等全程结束返回结果。 */
  async run(opts: { dryRun?: boolean } = {}): Promise<BackfillResult> {
    const dryRun = opts.dryRun === false ? false : true;
    const base = { dryRun, sessionsScanned: 0, sessionsSkipped: 0, turnsQueued: 0 };
    const pre = this.precheck();
    if (!pre.ok) {
      const reason = pre.reason === 'running' ? 'degraded' : pre.reason;
      return { ok: false, reason, ...base };
    }
    this.running = true;
    return this.process(dryRun, pre.scan, pre.db);
  }

  private async process(dryRun: boolean, scan: BackfillScan, db: DatabaseSync): Promise<BackfillResult> {
    const base = { dryRun, sessionsScanned: 0, sessionsSkipped: 0, turnsQueued: 0 };
    this.progress = {
      running: true, phase: 'scanning', dryRun,
      totalSessions: 0, doneSessions: 0, totalTurns: 0, doneTurns: 0, failedSessions: 0,
      lastError: '', startedAt: this.clock(), finishedAt: 0,
    };
    try {
      const done = readDone(db);
      const pruned = prunePoisonedDone(db, done);
      if (pruned > 0) this.deps.logger.warn(`[spirit] 全记忆重建：水位自愈——摘掉 ${pruned} 个被旧版零产出误标 done 的会话，重进重建`);
      let sessionsSkipped = 0;
      // 先收齐待重建会话（分页；done 集跳过；超大批续跑靠 done 集 + delivery 主键幂等）
      const pending: Array<{ sessionId: string; signals: OntologySignals[] }> = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await scan.sessions(offset, PAGE);
        if (page.rows.length === 0) break;
        for (const summary of page.rows) {
          const sessionId = summary.sessionId;
          if (sessionId === '') continue;
          if (done.has(sessionId)) { sessionsSkipped += 1; continue; }
          const rows = await scan.sessionAll(sessionId);
          // workspaceId 修复链：cwd → 同会话既有记录反查 → 全局桶（传空串会被写侧闸整批拒收——真机零记录事故根因之一）
          pending.push({ sessionId, signals: rowsToSignals(sessionId, resolveWorkspaceId(db, sessionId, summary.cwd ?? ''), rows) });
        }
        if (offset + PAGE >= page.total) break;
      }
      let totalTurns = 0;
      for (const s of pending) totalTurns += s.signals.length;
      this.progress.totalSessions = pending.length;
      this.progress.totalTurns = totalTurns;
      this.progress.phase = 'extracting';

      if (dryRun) {
        this.progress = { ...this.progress, running: false, phase: 'done', doneSessions: pending.length, doneTurns: totalTurns, failedSessions: 0, finishedAt: this.clock() };
        return { ok: true, ...base, sessionsScanned: pending.length, sessionsSkipped, turnsQueued: totalTurns };
      }

      // 真跑：逐会话按批**同步 await** 真落库（不再靠异步 enqueue）：{队列上限 + 去重窗}会把大批静默丢又误标 done。
      // 每会话每批都回写 doneSessions/doneTurns，面板轮询即可画进度条。中断可重跑续上（delivery id 主键幂等）。
      let sessionsScanned = 0;
      let turnsProcessed = 0;
      let failedSessions = 0;
      let lastError: string | undefined;
      for (const s of pending) {
        let okSession = true;
        for (let j = 0; j < s.signals.length; j += QUEUE_CHUNK) {
          const chunk = s.signals.slice(j, j + QUEUE_CHUNK);
          const status = await this.deps.extractor.processBatch(chunk);
          if (status.phase !== 'done') {
            okSession = false;
            lastError = status.error !== '' ? status.error : `phase=${status.phase}`;
            this.deps.logger.warn(`[spirit] 全记忆重建：会话 ${s.sessionId} 抽取未完成（${lastError}）`);
            break;
          }
          turnsProcessed += chunk.length;
          this.progress.doneTurns = turnsProcessed;
        }
        sessionsScanned += 1;
        this.progress.doneSessions = sessionsScanned;
        // 单会话失败不断整次重建：不标 done（下次重建会续上这一条），继续跑后面的会话。
        if (okSession) done.add(s.sessionId);
        else failedSessions += 1;
        this.progress.failedSessions = failedSessions;
        // 每会话都刷水位：中途断了，已完成的不白干、失败的留下次续
        writeDone(db, done);
      }
      const allOk = failedSessions === 0;
      this.progress = {
        ...this.progress, running: false, phase: 'done',
        doneSessions: sessionsScanned, doneTurns: turnsProcessed,
        lastError: allOk ? '' : (lastError ?? ''), finishedAt: this.clock(),
      };
      return {
        ok: allOk, ...(allOk ? {} : { reason: 'degraded' as const }),
        ...(allOk || lastError === undefined ? {} : { error: lastError }),
        ...base, sessionsScanned, sessionsSkipped, turnsQueued: turnsProcessed,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`[spirit] 历史回填异常：${msg}`);
      this.progress = { ...this.progress, running: false, phase: 'failed', lastError: msg, finishedAt: this.clock() };
      return { ok: false, reason: 'degraded', ...base };
    } finally {
      this.running = false;
    }
  }
}
