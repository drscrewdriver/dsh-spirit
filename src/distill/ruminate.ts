/**
 * RuminateRunner —— 长觉（v0.3.5）：异步 LLM 归纳 pass。
 *
 * 与小睡（DreamRunner）的分工是刻意的两档并存，不是一个函数的两个参数：
 * 小睡=确定性、同步、零模型、秒回；长觉=归纳、异步、花真 token、有进度/取消/退避。
 * 把两者塞进一个 run(kind) 会让响应形状分裂（契约单源纪律），故并列成两个 Runner。
 *
 * 正交性（用户点名）：长觉只**读**工作记忆（在场条目），写的全在派生域
 * （topic/insight/causal_edge/sleep_run/meta）——注入指纹的输入面永远不碰蒸馏产物，
 * G15 实闸 + 行为例（蒸完整轮后 persona-preview 逐字不变）双保险。
 *
 * 失败态分类是账单元：瞬态故障进指数退避（120s→15min）；NoDistillRouteError 是配置事实，
 * **不进退避**（对它退避等于把没接线伪装成模型慢）；连败 3 次 park 到下个周期。
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { SpiritConfig, SpiritSleepReport, SpiritSleepStatus } from '../contract.js';
import { factBits } from '../experience/render.js';
import type { MinimalLogger } from '../persona/store.js';
import type { ExperienceStore } from '../store/experience.js';
import type { EdgeStore } from '../store/edges.js';
import type { InsightStore } from '../store/insights.js';
import type { TopicStore } from '../store/topics.js';
import { heuristicEdges } from '../store/edges.js';
import { NoDistillRouteError, resolveDistillRoute, type DistillRoute, type LlmChannel } from './llm.js';
import {
  COLLISION_PROMPT_SYSTEM,
  INDUCTION_PROMPT_SYSTEM,
  buildCollisionUser,
  buildInductionUser,
  parseJsonLoose,
  validateCollisions,
  validateInduction,
  type BatchEntry,
} from './prompts.js';

/** meta 单键：已蒸水位（ts_ms），防同一批反复重蒸。 */
export const SLEEP_WATERMARK_KEY = 'sleep.watermark';
/** meta 单键：上次长觉报告（面板读，禁进注入）。 */
export const SLEEP_REPORT_KEY = 'sleep.lastReport';

export const SLEEP_DEDUP_MS = 300_000;
export const SLEEP_BACKOFF_BASE_MS = 120_000;
export const SLEEP_BACKOFF_CAP_MS = 900_000;
export const SLEEP_FAIL_PARK_STREAK = 3;
export const SLEEP_BATCH_MAX = 24;

export type SleepRunResult =
  | { accepted: true }
  | { accepted: false; reason: 'disabled' | 'unsupported' | 'running' | 'dedup-window' | 'backoff' | 'below-batch' | 'degraded' };

export interface RuminateDeps {
  db: () => DatabaseSync | null;
  store: ExperienceStore;
  topics: TopicStore;
  insights: InsightStore;
  edges: EdgeStore;
  /** llm 通道 getter；undefined = 宿主 llm 服务缺席（长觉整条休眠，绿路径）。
   * 走 getter 而非值：llm 服务是域注入晚到的，Runner 构造时它可能还没就绪。 */
  channel: () => LlmChannel | undefined;
  /** 宿主默认模型（agentDefaultModel 宽容读结果）；distill.provider/model 留空时的唯一合法来源，拿不到 ⇒ fail-closed 拒蒸。 */
  defaultModel?: () => DistillRoute | undefined;
  cfg: () => SpiritConfig;
  logger: MinimalLogger;
}

function readMeta(db: DatabaseSync, key: string): string {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as Record<string, SQLOutputValue> | undefined;
    return typeof row?.['value'] === 'string' ? row['value'] : '';
  } catch {
    return '';
  }
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export class RuminateRunner {
  private running = false;
  private cancelRequested = false;
  private hydrated = false;
  private lastRunAt = 0;
  private failStreak = 0;
  private nextAllowedAt = 0;
  private state: SpiritSleepStatus;

  constructor(private readonly deps: RuminateDeps) {
    this.state = { supported: false, running: false, phase: 'idle', detail: '', cancelRequested: false, startedAt: 0, finishedAt: 0, error: '', lastReport: null };
  }

  status(): SpiritSleepStatus {
    // 懒 hydrate：内存报告不在（宿主刚重启）就从 meta 回读——上次长觉报告跨重启可读（对齐梦境报告面）
    if (!this.hydrated) {
      this.hydrated = true;
      const db = this.deps.db();
      if (db !== null && this.state.lastReport === null) {
        const raw = readMeta(db, SLEEP_REPORT_KEY);
        if (raw !== '') {
          try {
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed === 'object' && parsed !== null) this.state = { ...this.state, lastReport: parsed as SpiritSleepStatus['lastReport'] };
          } catch {
            /* 坏报告不连坐状态面 */
          }
        }
      }
    }
    const supported = this.deps.channel() !== undefined;
    return { ...this.state, supported, running: this.running, cancelRequested: this.cancelRequested };
  }

  /** 取消意图置位：不问是否在跑——runNow 直调路径（测试/桥工装）同样可被取消；
   * 未在运行时该旗标会在下次 runNow 开头被重置，无害。 */
  requestCancel(): void {
    this.cancelRequested = true;
  }

  /** 异步受理（sleep-run 端点用）：立即回 accepted，进度走 status。
   * 不在这里置 running——由 runNow 在 precheck 通过后才占位（round-29 拓的自拦 bug：
   * 先置位再异步跑，precheck 会把自家任务判成 'running' 拒掉）。 */
  run(): SleepRunResult {
    const quick = this.precheck();
    if (!quick.accepted) return quick;
    // 受理即预占去重窗：两次快速连点不会双跑（running 由任务体自己管）
    this.lastRunAt = Date.now();
    setTimeout(() => {
      void this.runAccepted();
    }, 0);
    return { accepted: true };
  }

  /** 受理后专用体：不再 precheck（窗刚被自己预占，重检必自拦——round-29 第二拓的变体）。 */
  private async runAccepted(): Promise<void> {
    const db = this.deps.db();
    if (db === null) return;
    if (this.running) return;
    this.running = true;
    try {
      await this.runInner(db);
    } catch (err) {
      this.deps.logger.warn(`[spirit] 长觉任务体异常（已收敛进状态）：${err instanceof Error ? err.message : String(err)}`);
      this.state = { ...this.state, phase: 'failed', error: err instanceof Error ? err.message.slice(0, 300) : String(err), running: false, finishedAt: Date.now() };
    } finally {
      this.running = false;
    }
  }

  private precheck(): SleepRunResult {
    const cfg = this.deps.cfg();
    if (!cfg.distill.enabled) return { accepted: false, reason: 'disabled' };
    if (this.deps.channel() === undefined) return { accepted: false, reason: 'unsupported' };
    if (this.deps.db() === null) return { accepted: false, reason: 'degraded' };
    if (this.running) return { accepted: false, reason: 'running' };
    const now = Date.now();
    if (now - this.lastRunAt < SLEEP_DEDUP_MS) return { accepted: false, reason: 'dedup-window' };
    if (now < this.nextAllowedAt) return { accepted: false, reason: 'backoff' };
    return { accepted: true };
  }

  /**
   * 全链同步跑完（测试/桥工装入口；生产路径走 run() 的异步受理）。
   * 返回最终 status；任何一步失败都不留半批（落库单事务）。
   */
  async runNow(): Promise<SpiritSleepStatus> {
    const pre = this.precheck();
    if (!pre.accepted) {
      this.state = { ...this.state, phase: 'failed', error: pre.reason, finishedAt: Date.now() };
      return this.status();
    }
    const db = this.deps.db();
    if (db === null) return this.status();
    // 占位从 precheck 通过后开始（round-29 拓的自拦 bug 的修法：受理不置位，任务体才置位）
    this.running = true;
    try {
      return await this.runInner(db);
    } finally {
      this.running = false;
    }
  }

  private async runInner(db: DatabaseSync): Promise<SpiritSleepStatus> {
    const cfg = this.deps.cfg();
    const now = Date.now();
    this.lastRunAt = now;
    this.cancelRequested = false;
    const runId = `sl-${now.toString(36)}`;
    this.state = { supported: true, running: true, phase: 'collecting', detail: '攒这次的记忆', cancelRequested: false, startedAt: now, finishedAt: 0, error: '', lastReport: this.state.lastReport };
    try {
      // ① 攒批：水位之后的在场条目（只读工作记忆——正交性的第一道形状）
      const watermark = Number(readMeta(db, SLEEP_WATERMARK_KEY) || '0');
      const batch = this.deps.store.listRecent(SLEEP_BATCH_MAX).filter((entry) => entry.tsMs > watermark);
      if (batch.length < cfg.distill.batchMin) {
        this.state = { ...this.state, phase: 'idle', detail: `还没攒够（${batch.length}/${cfg.distill.batchMin}）`, running: false, finishedAt: Date.now() };
        return this.status();
      }
      const batchEntries: BatchEntry[] = batch.map((entry) => ({
        id: entry.id,
        text: entry.text,
        gist: entry.gist ?? null,
        trigger: entry.trigger,
        notice: entry.notice,
        // factBits 只含 tool/路径 basename 等结构化摘要——用户话语引用字段不在其输出面里（G20 的构造保证）
        factBits: factBits(entry.fact).join('｜'),
      }));
      const batchIds = new Set(batchEntries.map((e) => e.id));

      // ② 归纳调用（fail-closed 路由在这里解析——配错根本走不到烧 token）
      this.state = { ...this.state, phase: 'distilling', detail: `梦里回看 ${batchEntries.length} 条` };
      const route: DistillRoute = resolveDistillRoute(cfg.distill, {
        llm: () => undefined,
        defaultModel: () => this.deps.defaultModel?.(),
        logger: this.deps.logger,
      });
      const channel = this.deps.channel();
      if (channel === undefined) throw new NoDistillRouteError('llm 通道缺席');
      const knownTopics = this.deps.topics.topicsWithCounts().map((t) => t.topic.name).slice(0, 32);
      const induction = await channel.complete({
        route,
        reasoningEffort: cfg.distill.reasoningEffort,
        system: INDUCTION_PROMPT_SYSTEM,
        user: buildInductionUser(batchEntries, knownTopics),
        maxTokens: cfg.distill.maxOutputTokens,
        timeoutMs: cfg.distill.timeoutMs,
      });
      const proposal = validateInduction(parseJsonLoose(induction.text), batchIds);

      // 取消检查（安全边界：调用#1 之后、调用#2 之前——已花的 token 不浪费在拒绝落库上，但未落任何东西）
      if (this.cancelRequested) return this.finishCancelled(db, runId, now);

      // ③ 碰撞判定（只在新洞察有同题旧账时发起；无对可判就省一次调用）
      this.state = { ...this.state, phase: 'deduping', detail: '对一对有没有打架' };
      const keptInsights: typeof proposal.insights = [];
      const verdictByProposal = new Map<number, 'store' | 'conflict' | 'duplicate'>();
      const collisionPairs: Array<{ a: { id: string; text: string }; b: { id: string; text: string } }> = [];
      proposal.insights.forEach((insight, index) => {
        const existing = this.deps.topics !== undefined ? this.existingFor(insight.topicName) : [];
        if (existing.length === 0) {
          keptInsights.push(insight);
          return;
        }
        const against = existing[0];
        if (against === undefined) {
          keptInsights.push(insight);
          return;
        }
        collisionPairs.push({ a: { id: `p${index}`, text: insight.text }, b: { id: against.id, text: against.text } });
        keptInsights.push(insight);
        verdictByProposal.set(index, 'store');
      });
      if (collisionPairs.length > 0) {
        const collision = await channel.complete({
          route,
          reasoningEffort: cfg.distill.reasoningEffort,
          system: COLLISION_PROMPT_SYSTEM,
          user: buildCollisionUser(collisionPairs),
          maxTokens: 800,
          timeoutMs: cfg.distill.timeoutMs,
        });
        const pairIds = new Set([...collisionPairs.map((p) => p.a.id), ...collisionPairs.map((p) => p.b.id)]);
        for (const verdict of validateCollisions(parseJsonLoose(collision.text), pairIds)) {
          const index = Number(verdict.a.slice(1));
          if (!Number.isInteger(index)) continue;
          verdictByProposal.set(index, verdict.action);
        }
      }

      if (this.cancelRequested) return this.finishCancelled(db, runId, now);

      // ④ 单事务落库（半批不可见；派生域内才动笔，工作记忆一行不写）
      this.state = { ...this.state, phase: 'persisting', detail: '把梦里的领悟记下来' };
      let topicsTouched = 0;
      let insightsCreated = 0;
      let edgesCreated = 0;
      let conflictsMarked = 0;
      let duplicatesDropped = 0;
      const maxTs = Math.max(...batch.map((e) => e.tsMs));
      db.exec('BEGIN');
      try {
        // 启发式因果打底（零模型部分顺手回填，幂等）
        edgesCreated += this.deps.edges.backfillHeuristic(heuristicEdges(batch), now);
        const topicIdByName = new Map<string, string>();
        for (const topic of proposal.topics) {
          const t = this.deps.topics.ensureTopic(topic.name, 'distilled', now);
          topicIdByName.set(topic.name, t.id);
          for (const entryId of topic.entryIds) {
            if (this.deps.topics.assign(entryId, t.id, 'distilled', now)) topicsTouched += 1;
          }
        }
        const inserted: Array<{ id: string; proposalIndex: number }> = [];
        for (const [index, insight] of proposal.insights.entries()) {
          const action = verdictByProposal.get(index) ?? 'store';
          if (action === 'duplicate') {
            duplicatesDropped += 1;
            continue; // 重复提案不落库：旧账永远在场，丢的只是这次的表述
          }
          const topic = topicIdByName.get(insight.topicName) ?? this.deps.topics.ensureTopic(insight.topicName, 'distilled', now).id;
          const rows = this.deps.insights.insertBatch(now, runId, [{ topicId: topic, text: insight.text, evidenceIds: insight.evidenceIds }]);
          const row = rows[0];
          if (row !== undefined) {
            insightsCreated += 1;
            inserted.push({ id: row.id, proposalIndex: index });
          }
        }
        for (const item of inserted) {
          if (verdictByProposal.get(item.proposalIndex) === 'conflict') {
            const pair = collisionPairs.find((p) => p.a.id === `p${item.proposalIndex}`);
            conflictsMarked += this.deps.insights.markConflict(pair !== undefined ? [item.id, pair.b.id] : [item.id], now);
          }
        }
        if (proposal.edges.length > 0) edgesCreated += this.deps.edges.insertLlm(runId, proposal.edges, now);
        writeMeta(db, SLEEP_WATERMARK_KEY, String(maxTs));
        const report: SpiritSleepReport = {
          finishedAt: Date.now(),
          model: `${route.provider}/${route.model}`,
          entriesScanned: batchEntries.length,
          topicsTouched,
          insightsCreated,
          edgesCreated,
          conflictsMarked,
          duplicatesDropped,
        };
        db.prepare(`INSERT INTO sleep_run (id, started_at, finished_at, phase, detail, error, model, stats_json) VALUES (?, ?, ?, 'done', '', '', ?, ?)`)
          .run(runId, now, report.finishedAt, report.model, JSON.stringify(report));
        writeMeta(db, SLEEP_REPORT_KEY, JSON.stringify(report));
        this.state = { ...this.state, lastReport: report };
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* 回滚失败不掩盖原错 */
        }
        throw err;
      }
      this.failStreak = 0;
      this.nextAllowedAt = 0;
      this.state = { ...this.state, phase: 'done', detail: '梦醒了，领悟记下了', running: false, finishedAt: Date.now(), error: '', cancelRequested: false };
      return this.status();
    } catch (err) {
      const isConfig = err instanceof NoDistillRouteError;
      if (!isConfig) {
        this.failStreak += 1;
        this.nextAllowedAt = Date.now() + Math.min(SLEEP_BACKOFF_BASE_MS * 2 ** (this.failStreak - 1), SLEEP_BACKOFF_CAP_MS);
        if (this.failStreak >= SLEEP_FAIL_PARK_STREAK) this.nextAllowedAt = Date.now() + cfg.distill.intervalMs;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`[spirit] 长觉失败（${isConfig ? '配置' : '瞬态'}类）：${message}`);
      try {
        db.prepare(`INSERT INTO sleep_run (id, started_at, finished_at, phase, detail, error, model, stats_json) VALUES (?, ?, ?, 'failed', '', ?, '', '{}')`).run(runId, now, Date.now(), message.slice(0, 300));
      } catch {
        /* 失败记录失败不再连坐 */
      }
      this.state = { ...this.state, phase: 'failed', detail: '', error: message.slice(0, 300), running: false, finishedAt: Date.now(), cancelRequested: false };
      return this.status();
    }
  }

  /** 同题既有洞察（碰撞判定的对手盘）：按主题名找 topic 再取 active 行。 */
  private existingFor(topicName: string): Array<{ id: string; text: string }> {
    const db = this.deps.db();
    if (db === null) return [];
    try {
      const topic = db.prepare(`SELECT id FROM topic WHERE name = ? AND status = 'active'`).get(topicName) as Record<string, SQLOutputValue> | undefined;
      const topicId = typeof topic?.['id'] === 'string' ? topic['id'] : '';
      if (topicId === '') return [];
      return this.deps.insights.byTopic(topicId).filter((row) => row.status === 'active').map((row) => ({ id: row.id, text: row.text }));
    } catch {
      return [];
    }
  }

  private finishCancelled(db: DatabaseSync, runId: string, now: number): SpiritSleepStatus {
    try {
      db.prepare(`INSERT INTO sleep_run (id, started_at, finished_at, phase, detail, error, model, stats_json) VALUES (?, ?, ?, 'cancelled', '', '', '', '{}')`).run(runId, now, Date.now());
    } catch {
      /* 记录失败不连坐取消 */
    }
    this.state = { ...this.state, phase: 'cancelled', detail: '中途被叫醒，什么都没记', running: false, finishedAt: Date.now(), cancelRequested: false };
    return this.status();
  }
}
