/**
 * 本体抽取器（Phase B / TB.1）：异步批调 LLM，把一轮内容抽成 delivery + entities + relations + task 落库。
 *
 * 与 TxnCollector 同为异步批 + 退避三件套（照抄其节律），差别只在**读正文**且**写多张本体表**：
 * - 严禁每轮同步 LLM：enqueue 无 await，攒够批才 schedule 异步跑；
 * - 关时（ontology.enabled=false）连队列都不攒 ⇒ 零落库（与 countEvaluations/countAll 恒 0 的灰度承诺成对）；
 * - 落库前每段过 isSemanticAllowed（delivery 的 gist/summary 走同一黑名单），实体 kind 已在 validate 收口。
 *
 * 幂等：delivery id=`dlv-<key>`、task id 由 title 派生、entity id 由 kind+name 派生——重跑同批主键冲突即 no-op。
 */
import type { DatabaseSync } from 'node:sqlite';

import { SLEEP_BACKOFF_BASE_MS, SLEEP_BACKOFF_CAP_MS, SLEEP_FAIL_PARK_STREAK } from '../distill/ruminate.js';
import { NoDistillRouteError, resolveDistillRoute, type DistillRoute, type LlmChannel } from '../distill/llm.js';
import type { MinimalLogger } from '../persona/store.js';
import type { SpiritConfig } from '../contract.js';
import { TRUST_BACKFILL, TRUST_DERIVED_SUMMARY } from '../types.js';
import { isSemanticAllowed } from '../transaction/gate.js';
import { entityIdOf, type OntologyStore } from '../store/ontology.js';
import type { TxnStore } from '../store/transaction.js';
import { buildOntologyUser, parseOntologyOutput, validateOntologyOutput, ONTOLOGY_SUMMARY_SYSTEM, type OntologyLimits } from './prompts.js';
import type { OntologySignals } from './watcher.js';

/**
 * 实体名归一：`resource` 类的 URL 收敛到 host（同站点不同路径 → 一个资源实体）；
 * 非 resource 或非 URL 原样返回。归一在写入前做，让 entityIdOf 的主键自然合并（importance 累加）。
 */
export function canonicalEntityName(kind: string, raw: string): string {
  const name = raw.trim();
  if (kind !== 'resource' || name === '') return name;
  try {
    const url = new URL(name);
    return url.host !== '' ? url.host : name;
  } catch {
    return name;
  }
}

const DEDUP_MS = 300_000;
const BATCH_MIN = 8;
const QUEUE_MAX = 24;
/**
 * 单行输出 token 预算：gist(40 字)+summary(240 字)+entities/relations/task ≈ 300~400 token，给 700 富余。
 * 此前固定 1600 管整批：8 行必被 max_tokens 截断 ⇒ JSON 残缺解析 0 行 ⇒ 旧版当"成功零产出"标 done
 * ——真机 132 会话 done 却一条记录没有的根因。批越大预算越大，封顶防跑飞。
 */
const OUTPUT_TOKENS_PER_ROW = 700;
const OUTPUT_TOKENS_CAP = 8_000;
/**
 * 本体抽取是**冷路径**（回填/长觉同级别），不是每轮热路：一批要读十几轮正文、吐十几行 JSON。
 * 沿用 txn.collectorTimeoutMs（30s）在真机大模型上会稳定超时（abort ⇒ "This operation was aborted"），
 * 故单批预算取 max(蒸馏超时, 180s)。热路径不受影响：本体从不进 pre-step / 注入链路。
 */
const ONTOLOGY_MIN_TIMEOUT_MS = 180_000;
/** 拆批重试深度上限（8→4→2→1，最多 4 层）：深度用完仍失败就如实报，不再无限切。 */
const SPLIT_MAX_DEPTH = 4;
/** 这几类错误不是"这批太重"，拆小了也白拆（配置/资源问题，直接上报）。 */
const NON_RETRYABLE = ['宿主 llm 服务不可用', 'llm 通道缺席', '抽取器忙', '全数被拒'];
const LIMITS: OntologyLimits = { maxGistChars: 40, maxSummaryChars: 240, maxEntities: 8, maxRelations: 6 };

export type OntoRejectPath = 'disabled' | 'unsupported' | 'degraded' | 'running' | 'dedup-window' | 'backoff' | 'below-batch' | 'queue-full';
export type OntoEnqueueResult = { accepted: true; key: string; scheduled: boolean } | { accepted: false; reason: OntoRejectPath };

export interface OntologyExtractReport {
  runId: string;
  batchSize: number;
  deliveries: number;
  entities: number;
  relations: number;
  tasks: number;
  model: string;
  runMs: number;
}

export interface OntologyExtractStatus {
  supported: boolean;
  running: boolean;
  phase: 'idle' | 'running' | 'done' | 'failed';
  detail: string;
  error: string;
  consecutiveFailures: number;
  lastReport?: OntologyExtractReport;
}

export interface OntologyExtractorDeps {
  db: () => DatabaseSync | null;
  txnStore: TxnStore;
  store: OntologyStore;
  channel: () => LlmChannel | undefined;
  defaultModel?: () => DistillRoute | undefined;
  cfg: () => SpiritConfig;
  logger: MinimalLogger;
  clock?: () => number;
  schedule?: (task: () => unknown) => void;
}

export class OntologyExtractor {
  private readonly deps: OntologyExtractorDeps;
  private readonly clock: () => number;
  private readonly schedule: (task: () => unknown) => void;
  private queue: OntologySignals[] = [];
  private running = false;
  private failStreak = 0;
  private nextAllowedAt = 0;
  private lastRunAt = 0;
  private statusValue: OntologyExtractStatus = {
    supported: true, running: false, phase: 'idle', detail: '', error: '', consecutiveFailures: 0,
  };

  constructor(deps: OntologyExtractorDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? Date.now;
    this.schedule = deps.schedule ?? ((task) => {
      setTimeout(task, 0);
    });
  }

  /** 攒一条信号；无 await。关时不攒（零落库半边靠这条）。 */
  enqueue(signals: OntologySignals): OntoEnqueueResult {
    const gates = this.gates();
    if (!gates.accepted) return { accepted: false, reason: gates.reason };
    if (this.queue.length >= QUEUE_MAX) return { accepted: false, reason: 'queue-full' };
    if (this.queue.some((item) => item.key === signals.key)) return { accepted: true, key: signals.key, scheduled: false };
    this.queue.push(signals);
    if (this.queue.length < BATCH_MIN) return { accepted: true, key: signals.key, scheduled: false };
    this.lastRunAt = this.clock();
    this.schedule(() => this.runInner().catch((err: unknown) => {
      this.deps.logger.warn(`[spirit] 本体抽取任务体异常（已收敛进状态）：${err instanceof Error ? err.message : String(err)}`);
    }));
    return { accepted: true, key: signals.key, scheduled: true };
  }

  /** 测试/工装入口：同步跑完一批。 */
  async flush(): Promise<OntologyExtractStatus> {
    const gates = this.gates();
    if (!gates.accepted) {
      this.statusValue = { ...this.statusValue, phase: 'failed', error: gates.reason };
      return this.statusValue;
    }
    if (this.queue.length < BATCH_MIN) {
      this.statusValue = { ...this.statusValue, phase: 'failed', error: 'below-batch' };
      return this.statusValue;
    }
    return this.runInner();
  }

  status(): OntologyExtractStatus {
    return this.statusValue;
  }

  /**
   * 同步整批处理（回填「全记忆重建」用）：**绕过** enqueue 的队列上限 / 去重窗 / 批下限，
   * 把整批塞进队列后直接跑 runInner 并 await 落库。
   * 不绕的话：queue-full 会把大批静默丢掉、dedup-window 会把 5 分钟内的后续批全拒——回填永远只能一拖一。
   * 调用方须保证 batch.length ≤ QUEUE_MAX（回填按 QUEUE_CHUNK 切）。
   */
  async processBatch(batch: readonly OntologySignals[]): Promise<OntologyExtractStatus> {
    if (batch.length === 0) return this.statusValue;
    // 若直播抽取正跑着：等它结束再上批（不打断、不静默丢批）；超时如实报 busy，不伪装成业务失败
    const deadline = this.clock() + 60_000;
    while (this.running && this.clock() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    if (this.running) {
      this.statusValue = { ...this.statusValue, phase: 'failed', error: '抽取器忙：上一次批还在跑，稍后重试' };
      return this.statusValue;
    }
    this.queue = batch.slice(0, QUEUE_MAX);
    return this.runChunk(batch.slice(0, QUEUE_MAX));
  }

  /**
   * 实批执行 + **失败对半拆重试**：一批 8 轮里只要有 1 轮让模型跑飞/超时，整批就废，
   * 进而整会话（甚至整次重建）都被判死。拆一半重试能把坏的隔离到最小批（最终只丢单独那轮）。
   * 配置类错误（无路由/忙）不拆——拆小也不能好。
   */
  private async runChunk(chunk: readonly OntologySignals[], depth = 0): Promise<OntologyExtractStatus> {
    this.queue = chunk.slice();
    const status = await this.runInner();
    if (status.phase === 'done') return status;
    const err = status.error;
    const retryable = !NON_RETRYABLE.some((s) => err.includes(s));
    if (chunk.length <= 1 || depth >= SPLIT_MAX_DEPTH || !retryable) {
      if (chunk.length <= 1) {
        // 单独那轮仍失败：点名上报（可定位、可跳过），不再静默连坐整批
        this.deps.logger.warn(`[spirit] 本体抽取：单轮 ${chunk[0]?.key ?? '?'} 失败（${err}）`);
      }
      return status;
    }
    const mid = Math.ceil(chunk.length / 2);
    this.deps.logger.warn(`[spirit] 本体抽取失败，对半拆批重试（${chunk.length}→${mid}+${chunk.length - mid}）：${err}`);
    const head = await this.runChunk(chunk.slice(0, mid), depth + 1);
    const tail = await this.runChunk(chunk.slice(mid), depth + 1);
    // 只要有一半仍失败就如实上报失败（另一半已落库，不丢）
    return head.phase === 'done' ? tail : head;
  }

  pending(): number {
    return this.queue.length;
  }

  private gates(): { accepted: true } | { accepted: false; reason: OntoRejectPath } {
    if (!this.deps.cfg().ontology.enabled) return { accepted: false, reason: 'disabled' };
    if (this.deps.channel() === undefined) return { accepted: false, reason: 'unsupported' };
    if (this.deps.db() === null || !this.deps.store.persistent) return { accepted: false, reason: 'degraded' };
    if (this.running) return { accepted: false, reason: 'running' };
    const now = this.clock();
    if (now - this.lastRunAt < DEDUP_MS) return { accepted: false, reason: 'dedup-window' };
    if (now < this.nextAllowedAt) return { accepted: false, reason: 'backoff' };
    return { accepted: true };
  }

  private async runInner(): Promise<OntologyExtractStatus> {
    if (this.running) return this.statusValue;
    const cfg = this.deps.cfg();
    const batch = this.queue.splice(0, QUEUE_MAX);
    const batchKeys = new Set(batch.map((s) => s.key));
    const signalByKey = new Map(batch.map((s) => [s.key, s]));
    const started = this.clock();
    this.running = true;
    this.lastRunAt = started;
    this.statusValue = { ...this.statusValue, running: true, phase: 'running', detail: `抽取 ${batch.length} 轮`, error: '' };
    try {
      const route = resolveDistillRoute(cfg.distill, { llm: () => undefined, defaultModel: () => this.deps.defaultModel?.(), logger: this.deps.logger });
      const channel = this.deps.channel();
      if (channel === undefined) throw new NoDistillRouteError('llm 通道缺席');
      const raw = await channel.complete({
        route,
        system: ONTOLOGY_SUMMARY_SYSTEM,
        user: buildOntologyUser(batch),
        maxTokens: Math.min(OUTPUT_TOKENS_PER_ROW * Math.max(batch.length, 1), OUTPUT_TOKENS_CAP),
        timeoutMs: Math.max(cfg.distill.timeoutMs, ONTOLOGY_MIN_TIMEOUT_MS),
      });
      const rows = validateOntologyOutput(parseOntologyOutput(raw.text), batchKeys, LIMITS);

      let deliveries = 0;
      let entities = 0;
      let relations = 0;
      let tasks = 0;
      for (const row of rows) {
        const signal = signalByKey.get(row.key);
        if (signal === undefined) continue;
        // 回填行打 TRUST_BACKFILL（注入读面排除），在线行打 derived_summary。
        const trust = signal.backfill === true ? TRUST_BACKFILL : TRUST_DERIVED_SUMMARY;
        // 1. delivery：gist/summary 走同一黑名单闸（summary 空 ⇒ 传 null，与落库同值，不被空串误拒）。
        const summaryForGate = row.summary !== '' ? row.summary : null;
        if (!isSemanticAllowed({ source_trust: trust, card_line: row.gist, summary: summaryForGate })) continue;
        const deliveryId = `dlv-${row.key}`;
        const inserted = this.deps.txnStore.insert({
          id: deliveryId,
          sessionId: signal.sessionId,
          workspaceId: signal.workspaceId,
          tsMs: signal.tsMs,
          turnSeq: signal.turnSeq,
          cardLine: row.gist,
          summary: summaryForGate,
          sourceTrust: trust,
          salienceTier: 2,
          turnStartMs: signal.tsMs,
          turnEndMs: signal.tsMs,
        });
        if (!inserted.ok) {
          // 主键冲突 = 早先跑已落库（续跑/重扫场景）：算已记录，不当零产出误报
          if (this.deps.txnStore.getByIds([deliveryId]).length > 0) deliveries += 1;
          continue;
        }
        deliveries += 1;

        // 2. entities + delivery↔entity 关联；name→id 供关系解析。
        const nameToId = new Map<string, string>();
        for (const e of row.entities) {
          // resource 归一：URL → host（同站点收敛）；关系端点仍用 LLM 原名，故双键都登记
          const canonical = canonicalEntityName(e.kind, e.name);
          const ent = this.deps.store.upsertEntity({ kind: e.kind, name: canonical, tsMs: signal.tsMs });
          if (ent === null) continue;
          nameToId.set(e.name.toLowerCase(), ent.id);
          if (canonical.toLowerCase() !== e.name.toLowerCase()) nameToId.set(canonical.toLowerCase(), ent.id);
          this.deps.store.linkDeliveryEntity({ deliveryId, entityId: ent.id, role: e.role, tsMs: signal.tsMs });
          entities += 1;
        }

        // 3. relations：端点已在本行实体集内（validate 保证），映射到 id。
        for (const r of row.relations) {
          const from = nameToId.get(r.from.toLowerCase());
          const to = nameToId.get(r.to.toLowerCase());
          if (from === undefined || to === undefined) continue;
          const edgeId = `ee-${from}->${to}:${r.relation}`;
          if (this.deps.store.upsertEntityEdge({ id: edgeId, from, to, relation: r.relation, origin: 'llm', confidence: 600, evidence: [deliveryId], tsMs: signal.tsMs })) relations += 1;
        }

        // 4. task：title→id 确定性；assign 当前 delivery。
        if (row.task !== null) {
          const taskId = `task-${entityIdOf('project', row.task.title)}`;
          this.deps.store.upsertTask({ id: taskId, title: row.task.title, status: row.task.status, nextStep: row.task.nextStep, workspaceId: signal.workspaceId, tsMs: signal.tsMs });
          if (this.deps.store.assignTaskDelivery({ taskId, deliveryId, origin: 'llm', tsMs: signal.tsMs })) tasks += 1;
        }
      }

      // 非空批却一条都没落 ⇒ 是失败不是"确实没内容"：必须如实报，否则回填把零产出会话误标 done，
      // 历史永久丢失（真机事故：回包截断解析 0 行 / workspaceId 缺失被 store 闸全拒，都曾静默当 done）。
      if (batch.length > 0 && deliveries === 0) {
        throw new Error(rows.length === 0
          ? `抽取零产出（模型回包 ${raw.text.length} 字，无一可解析行：多半 JSON 被截断或 key 未原样回指）`
          : `抽取全数被拒（解析 ${rows.length} 行落库 0：闸拒或缺 workspaceId 类 insert 拒绝，拆小也没用）`);
      }

      this.failStreak = 0;
      this.nextAllowedAt = 0;
      this.statusValue = {
        ...this.statusValue,
        running: false,
        phase: 'done',
        detail: `交付 ${deliveries} / 实体 ${entities} / 关系 ${relations} / 任务 ${tasks}`,
        consecutiveFailures: 0,
        lastReport: { runId: `ox-${this.lastRunAt.toString(36)}`, batchSize: batch.length, deliveries, entities, relations, tasks, model: `${route.provider}/${route.model}`, runMs: this.clock() - started },
      };
      return this.statusValue;
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 300) : String(err);
      this.deps.logger.warn(`[spirit] 本体抽取失败：${message}`);
      const configError = err instanceof NoDistillRouteError;
      if (!configError) {
        this.failStreak += 1;
        this.nextAllowedAt = this.clock() + Math.min(SLEEP_BACKOFF_BASE_MS * 2 ** (this.failStreak - 1), SLEEP_BACKOFF_CAP_MS);
        if (this.failStreak >= SLEEP_FAIL_PARK_STREAK) {
          const interval = this.deps.cfg().distill.intervalMs;
          this.nextAllowedAt = this.clock() + (interval > 0 ? interval : SLEEP_BACKOFF_CAP_MS);
        }
      }
      this.statusValue = { ...this.statusValue, running: false, phase: 'failed', error: message, consecutiveFailures: this.failStreak };
      return this.statusValue;
    } finally {
      this.running = false;
    }
  }
}
