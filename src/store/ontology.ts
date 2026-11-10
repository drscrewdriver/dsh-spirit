/**
 * 本体层读写层（v8 / Phase B）：先落 evaluation（tier1 反馈/互动，用户点名的最高优先）。
 * entity/task/relation 的读写在 Phase D 补（同一 store，避免多写者）。
 *
 * 三条纪律（沿用 store/transaction.ts 的口径）：
 * 1. **写面只有 INSERT + supersede 列的 UPDATE**（markSuperseded）：更正=插新行+旧行置标记，不原地改。
 * 2. **不造身份**：id 由调用方（anchor/extractor）给；缺 id 拒收。
 * 3. **库不可用 ⇒ 整段休眠**：读返回空、写返回拒收，不抛穿、不攒内存镜像。
 *
 * 红线：evaluation 行属工作记忆真源域，**禁入 store.recent()/deriveMood/注入指纹**（gates 泛扫守）；
 * 它只进翻阅/详情/查询面（evaluation-list）。user_line 是钳短、过脱敏的用户原句，非全文。
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { MinimalLogger } from '../persona/store.js';
import type { AnchorMode, EntityKind, EvalKind, SourceTrust } from '../types.js';
import { ANCHOR_MODES, ENTITY_KINDS, EVAL_KINDS, SOURCE_TRUST_VALUES } from '../types.js';
import { hitsInjection } from '../words.js';

/** 读侧上界（与 TXN_READ_MAX 同口径：一次读不搬空整库）。 */
export const ONT_READ_MAX = 200;

/** 实体 kind 五词单源见 types.ts ENTITY_KINDS。实体 id 由 kind+name 确定性派生（同 topicIdOf 先例）。 */
export function entityIdOf(kind: string, name: string): string {
  return `ent-${kind}:${name.trim().toLowerCase()}`;
}

export interface OntologyEntity {
  id: string;
  kind: EntityKind;
  name: string;
  aliases: string[];
  importance: number;
  firstSeenMs: number;
  lastSeenMs: number;
}

export interface OntologyTask {
  id: string;
  title: string;
  status: 'open' | 'progress' | 'stalled' | 'done';
  nextStep?: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
}

const TASK_STATUSES: readonly string[] = ['open', 'progress', 'stalled', 'done'];

export interface OntologyEvaluation {
  id: string;
  /** null = unresolved 悬置池（没锚到具体 delivery，等人工指认）。 */
  deliveryId: string | null;
  kind: EvalKind;
  anchorMode: AnchorMode;
  anchorConfidence: number;
  userLine?: string;
  sourceTrust: SourceTrust;
  sessionId: string;
  workspaceId: string;
  tsMs: number;
  createdAt: number;
}

export interface EvaluationInsertInput {
  id: string;
  deliveryId: string | null;
  kind: EvalKind;
  anchorMode: AnchorMode;
  anchorConfidence: number;
  userLine?: string | null;
  sourceTrust: SourceTrust;
  sessionId: string;
  workspaceId: string;
  tsMs: number;
}

export type EvalRejectReason =
  | '缺 id（身份由调用方给）'
  | '缺 sessionId / workspaceId'
  | '评价档不在单源词表'
  | '锚定方式不在单源词表'
  | '来源标记不在单源四档'
  | 'user_line 命中黑名单'
  | '时间/置信不是可判定数值'
  | '落库失败（降级面）';

export type EvalInsertResult = { ok: true; row: OntologyEvaluation } | { ok: false; reason: EvalRejectReason };

const INSERT_SQL = `INSERT INTO evaluation (
    id, delivery_id, kind, anchor_mode, anchor_confidence, user_line, source_trust,
    session_id, workspace_id, ts_ms, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function asFinite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function toEvaluation(raw: Record<string, SQLOutputValue>): OntologyEvaluation {
  const row: OntologyEvaluation = {
    id: asText(raw['id']),
    deliveryId: typeof raw['delivery_id'] === 'string' ? raw['delivery_id'] : null,
    kind: asText(raw['kind']) as EvalKind,
    anchorMode: asText(raw['anchor_mode']) as AnchorMode,
    anchorConfidence: asFinite(raw['anchor_confidence']),
    sourceTrust: asText(raw['source_trust']) as SourceTrust,
    sessionId: asText(raw['session_id']),
    workspaceId: asText(raw['workspace_id']),
    tsMs: asFinite(raw['ts_ms']),
    createdAt: asFinite(raw['created_at']),
  };
  const userLine = optionalText(raw['user_line']);
  if (userLine !== undefined) row.userLine = userLine;
  return row;
}

function toTask(raw: Record<string, SQLOutputValue>): OntologyTask {
  const task: OntologyTask = {
    id: asText(raw['id']),
    title: asText(raw['title']),
    status: asText(raw['status']) as OntologyTask['status'],
    workspaceId: asText(raw['workspace_id']),
    createdAt: asFinite(raw['created_at']),
    updatedAt: asFinite(raw['updated_at']),
  };
  const nextStep = optionalText(raw['next_step']);
  if (nextStep !== undefined) task.nextStep = nextStep;
  return task;
}

function capRead(limit: number): number {
  const n = Number.isFinite(limit) ? Math.floor(limit) : 1;
  return Math.min(Math.max(1, n), ONT_READ_MAX);
}

/** LIKE 字面量转义：用户输入的 % _ \ 不当通配符（配合 ESCAPE '\\' 用）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class OntologyStore {
  constructor(private readonly deps: { db: () => DatabaseSync | null; logger: MinimalLogger }) {}

  get persistent(): boolean {
    return this.deps.db() !== null;
  }

  // ───────────────────────────────────────────── 写

  insertEvaluation(input: EvaluationInsertInput): EvalInsertResult {
    const reject = (reason: EvalRejectReason): EvalInsertResult => ({ ok: false, reason });
    if (input.id === '') return reject('缺 id（身份由调用方给）');
    if (input.sessionId === '' || input.workspaceId === '') return reject('缺 sessionId / workspaceId');
    if (!(EVAL_KINDS as readonly string[]).includes(input.kind)) return reject('评价档不在单源词表');
    if (!(ANCHOR_MODES as readonly string[]).includes(input.anchorMode)) return reject('锚定方式不在单源词表');
    if (!(SOURCE_TRUST_VALUES as readonly string[]).includes(input.sourceTrust)) return reject('来源标记不在单源四档');
    const userLine = typeof input.userLine === 'string' ? input.userLine.trim() : '';
    if (userLine !== '' && hitsInjection(userLine)) return reject('user_line 命中黑名单');
    if (!Number.isFinite(input.tsMs) || !Number.isFinite(input.anchorConfidence)) return reject('时间/置信不是可判定数值');

    const db = this.deps.db();
    if (db === null) return reject('落库失败（降级面）');

    const confidence = Math.max(0, Math.min(1000, Math.round(input.anchorConfidence)));
    const row: OntologyEvaluation = {
      id: input.id,
      deliveryId: input.deliveryId !== null && input.deliveryId !== '' ? input.deliveryId : null,
      kind: input.kind,
      anchorMode: input.anchorMode,
      anchorConfidence: confidence,
      sourceTrust: input.sourceTrust,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      tsMs: input.tsMs,
      createdAt: input.tsMs,
    };
    if (userLine !== '') row.userLine = userLine;

    try {
      db.prepare(INSERT_SQL).run(
        row.id,
        row.deliveryId,
        row.kind,
        row.anchorMode,
        row.anchorConfidence,
        row.userLine ?? null,
        row.sourceTrust,
        row.sessionId,
        row.workspaceId,
        row.tsMs,
        row.createdAt,
      );
    } catch (err) {
      this.deps.logger.warn(`[spirit] 评价落库失败：${err instanceof Error ? err.message : String(err)}`);
      return reject('落库失败（降级面）');
    }
    return { ok: true, row };
  }

  /** 更正：旧评价行置 superseded_by=新行 id（唯一允许的 UPDATE，只动 superseded_by 列）。 */
  markSuperseded(oldId: string, byId: string): boolean {
    const db = this.deps.db();
    if (db === null || oldId === '' || byId === '' || oldId === byId) return false;
    try {
      const info = db.prepare(`UPDATE evaluation SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL`).run(byId, oldId);
      return Number(info.changes ?? 0) > 0;
    } catch {
      return false;
    }
  }

  // ───────────────────────────────────────────── 读

  /** 最近评价（翻阅/注入读用）：默认只取未取代；可排除 unresolved 悬置池。 */
  listRecentEvaluations(limit: number, opts: { workspaceId?: string; sessionId?: string; excludeUnresolved?: boolean } = {}): OntologyEvaluation[] {
    const db = this.deps.db();
    if (db === null) return [];
    const window = capRead(limit);
    try {
      const conds: string[] = ['superseded_by IS NULL'];
      const params: unknown[] = [];
      if (opts.workspaceId !== undefined) {
        conds.push('workspace_id = ?');
        params.push(opts.workspaceId);
      }
      if (opts.sessionId !== undefined) {
        conds.push('session_id = ?');
        params.push(opts.sessionId);
      }
      if (opts.excludeUnresolved === true) {
        conds.push('delivery_id IS NOT NULL');
      }
      params.push(window);
      const rows = db
        .prepare(`SELECT * FROM evaluation WHERE ${conds.join(' AND ')} ORDER BY ts_ms DESC, id DESC LIMIT ?`)
        .all(...(params as never[])) as Record<string, SQLOutputValue>[];
      return rows.map(toEvaluation);
    } catch {
      return [];
    }
  }

  /** 某 delivery 上的评价（评价锚定的反查：这条交付被怎么评价过）。 */
  listEvaluationsByDelivery(deliveryId: string, limit = ONT_READ_MAX): OntologyEvaluation[] {
    const db = this.deps.db();
    if (db === null || deliveryId === '') return [];
    const window = capRead(limit);
    try {
      const rows = db
        .prepare(`SELECT * FROM evaluation WHERE delivery_id = ? AND superseded_by IS NULL ORDER BY ts_ms DESC LIMIT ?`)
        .all(deliveryId, window) as Record<string, SQLOutputValue>[];
      return rows.map(toEvaluation);
    } catch {
      return [];
    }
  }

  /** unresolved 悬置池（面板人工指认队列）。 */
  listUnresolved(limit = ONT_READ_MAX): OntologyEvaluation[] {
    const db = this.deps.db();
    if (db === null) return [];
    const window = capRead(limit);
    try {
      const rows = db
        .prepare(`SELECT * FROM evaluation WHERE delivery_id IS NULL AND superseded_by IS NULL ORDER BY ts_ms DESC LIMIT ?`)
        .all(window) as Record<string, SQLOutputValue>[];
      return rows.map(toEvaluation);
    } catch {
      return [];
    }
  }

  /** 整表行数（关路径零落库对账：ontology.enabled=false 时这里必须为 0）。 */
  countEvaluations(): number {
    const db = this.deps.db();
    if (db === null) return 0;
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM evaluation`).get() as Record<string, SQLOutputValue> | undefined;
      const n = row?.['n'];
      return typeof n === 'number' && Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  // ───────────────────────────────────────────── 实体（派生缓存，可 upsert/重算）

  /** 实体 upsert：同 id 再现 ⇒ importance+1、last_seen 取大、first_seen 取小、别名并。 */
  upsertEntity(input: { kind: EntityKind; name: string; alias?: string; tsMs: number }): { id: string } | null {
    const db = this.deps.db();
    if (db === null) return null;
    const name = input.name.trim();
    if (name === '' || !(ENTITY_KINDS as readonly string[]).includes(input.kind) || !Number.isFinite(input.tsMs)) return null;
    const id = entityIdOf(input.kind, name);
    try {
      const existing = db.prepare(`SELECT aliases_json, importance, first_seen_ms, last_seen_ms FROM entity WHERE id = ?`).get(id) as Record<string, SQLOutputValue> | undefined;
      const aliases = new Set<string>();
      if (existing !== undefined) {
        try {
          const arr: unknown = JSON.parse(asText(existing['aliases_json']));
          if (Array.isArray(arr)) for (const a of arr) if (typeof a === 'string') aliases.add(a);
        } catch { /* 坏别名不连坐 */ }
      }
      const alias = typeof input.alias === 'string' ? input.alias.trim() : '';
      if (alias !== '' && alias.toLowerCase() !== name.toLowerCase()) aliases.add(alias);
      const importance = existing !== undefined ? Math.min(1000, asFinite(existing['importance']) + 1) : 1;
      const firstSeen = existing !== undefined ? Math.min(asFinite(existing['first_seen_ms']), input.tsMs) : input.tsMs;
      const lastSeen = existing !== undefined ? Math.max(asFinite(existing['last_seen_ms']), input.tsMs) : input.tsMs;
      db.prepare(`INSERT INTO entity (id, kind, name, aliases_json, importance, first_seen_ms, last_seen_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET importance = excluded.importance, aliases_json = excluded.aliases_json, first_seen_ms = excluded.first_seen_ms, last_seen_ms = excluded.last_seen_ms`)
        .run(id, input.kind, name, JSON.stringify([...aliases]), importance, firstSeen, lastSeen);
      return { id };
    } catch {
      return null;
    }
  }

  listEntities(limit = ONT_READ_MAX, opts: { kind?: EntityKind; q?: string } = {}): OntologyEntity[] {
    const db = this.deps.db();
    if (db === null) return [];
    const window = capRead(limit);
    try {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (opts.kind !== undefined) {
        conds.push('kind = ?');
        params.push(opts.kind);
      }
      // 搜索（v0.6.1）：名字或别名 LIKE；用户输入的 %/_ 按字面量处理（ESCAPE），不当通配符
      const q = (opts.q ?? '').trim();
      if (q !== '') {
        conds.push(`(name LIKE ? ESCAPE '\\' OR aliases_json LIKE ? ESCAPE '\\')`);
        const like = `%${escapeLike(q)}%`;
        params.push(like, like);
      }
      const scope = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
      params.push(window);
      const rows = db.prepare(`SELECT * FROM entity ${scope} ORDER BY importance DESC, last_seen_ms DESC LIMIT ?`).all(...(params as never[])) as Record<string, SQLOutputValue>[];
      return rows.map((raw) => this.toEntity(raw));
    } catch {
      return [];
    }
  }

  /** 某 delivery 关联的实体（正排：这条交付牵涉谁/什么）。 */
  listEntitiesByDelivery(deliveryId: string, limit = ONT_READ_MAX): OntologyEntity[] {
    const db = this.deps.db();
    if (db === null || deliveryId === '') return [];
    const window = capRead(limit);
    try {
      const rows = db.prepare(`SELECT e.* FROM entity e JOIN delivery_entity de ON de.entity_id = e.id
         WHERE de.delivery_id = ? ORDER BY de.ts_ms DESC LIMIT ?`).all(deliveryId, window) as Record<string, SQLOutputValue>[];
      return rows.map((raw) => this.toEntity(raw));
    } catch {
      return [];
    }
  }

  /** 按实体反查关联的 delivery id（“这件事还牵涉哪些交付”）。 */
  listDeliveriesByEntity(entityId: string, limit = ONT_READ_MAX): string[] {
    const db = this.deps.db();
    if (db === null || entityId === '') return [];
    const window = capRead(limit);
    try {
      const rows = db.prepare(`SELECT delivery_id FROM delivery_entity WHERE entity_id = ? ORDER BY ts_ms DESC LIMIT ?`).all(entityId, window) as Record<string, SQLOutputValue>[];
      return rows.map((raw) => asText(raw['delivery_id'])).filter((id) => id !== '');
    } catch {
      return [];
    }
  }

  linkDeliveryEntity(input: { deliveryId: string; entityId: string; role: string; tsMs: number }): boolean {
    const db = this.deps.db();
    if (db === null) return false;
    if (input.deliveryId === '' || input.entityId === '' || input.role === '' || !Number.isFinite(input.tsMs)) return false;
    try {
      const dup = db.prepare(`SELECT 1 FROM delivery_entity WHERE delivery_id = ? AND entity_id = ? AND role = ?`).get(input.deliveryId, input.entityId, input.role);
      if (dup !== undefined) return true;
      db.prepare(`INSERT INTO delivery_entity (delivery_id, entity_id, role, ts_ms) VALUES (?, ?, ?, ?)`).run(input.deliveryId, input.entityId, input.role, input.tsMs);
      return true;
    } catch {
      return false;
    }
  }

  // ───────────────────────────────────────────── 任务线程（派生缓存，可 upsert）

  upsertTask(input: { id: string; title: string; status?: string; nextStep?: string | null; workspaceId: string; tsMs: number }): boolean {
    const db = this.deps.db();
    if (db === null) return false;
    const title = input.title.trim();
    const status = input.status ?? 'open';
    if (input.id === '' || title === '' || input.workspaceId === '' || !Number.isFinite(input.tsMs)) return false;
    if (!TASK_STATUSES.includes(status)) return false;
    try {
      const existing = db.prepare(`SELECT created_at FROM task WHERE id = ?`).get(input.id) as Record<string, SQLOutputValue> | undefined;
      const createdAt = existing !== undefined ? asFinite(existing['created_at']) : input.tsMs;
      const nextStep = typeof input.nextStep === 'string' && input.nextStep.trim() !== '' ? input.nextStep.trim() : null;
      db.prepare(`INSERT INTO task (id, title, status, next_step, workspace_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, next_step = excluded.next_step, updated_at = excluded.updated_at`)
        .run(input.id, title, status, nextStep, input.workspaceId, createdAt, input.tsMs);
      return true;
    } catch {
      return false;
    }
  }

  listTasks(workspaceId: string, opts: { status?: string; limit?: number; q?: string } = {}): OntologyTask[] {
    const db = this.deps.db();
    if (db === null || workspaceId === '') return [];
    const window = capRead(opts.limit ?? ONT_READ_MAX);
    try {
      const conds = ['workspace_id = ?'];
      const params: unknown[] = [workspaceId];
      if (opts.status !== undefined && TASK_STATUSES.includes(opts.status)) {
        conds.push('status = ?');
        params.push(opts.status);
      }
      const q = (opts.q ?? '').trim();
      if (q !== '') {
        conds.push(`title LIKE ? ESCAPE '\\'`);
        params.push(`%${escapeLike(q)}%`);
      }
      params.push(window);
      const rows = db.prepare(`SELECT * FROM task WHERE ${conds.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...(params as never[])) as Record<string, SQLOutputValue>[];
      return rows.map(toTask);
    } catch {
      return [];
    }
  }

  /** 跨工作区任务线（面板「本体」翻阅用：不指定工作区时按 updated_at 倒序取全局最近）。 */
  listAllTasks(opts: { status?: string; limit?: number; q?: string } = {}): OntologyTask[] {
    const db = this.deps.db();
    if (db === null) return [];
    const window = capRead(opts.limit ?? ONT_READ_MAX);
    try {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (opts.status !== undefined && TASK_STATUSES.includes(opts.status)) {
        conds.push('status = ?');
        params.push(opts.status);
      }
      const q = (opts.q ?? '').trim();
      if (q !== '') {
        conds.push(`title LIKE ? ESCAPE '\\'`);
        params.push(`%${escapeLike(q)}%`);
      }
      const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
      params.push(window);
      const rows = db.prepare(`SELECT * FROM task${where} ORDER BY updated_at DESC LIMIT ?`).all(...(params as never[])) as Record<string, SQLOutputValue>[];
      return rows.map(toTask);
    } catch {
      return [];
    }
  }

  getTask(id: string): OntologyTask | null {
    const db = this.deps.db();
    if (db === null || id === '') return null;
    try {
      const raw = db.prepare(`SELECT * FROM task WHERE id = ?`).get(id) as Record<string, SQLOutputValue> | undefined;
      return raw === undefined ? null : toTask(raw);
    } catch {
      return null;
    }
  }

  /** 一 delivery 归一任务：同 delivery 的旧活跃归属先置 superseded（一交付只活在一个任务下）。 */
  assignTaskDelivery(input: { taskId: string; deliveryId: string; origin: string; tsMs: number }): boolean {
    const db = this.deps.db();
    if (db === null) return false;
    if (input.taskId === '' || input.deliveryId === '' || !Number.isFinite(input.tsMs)) return false;
    try {
      db.prepare(`UPDATE task_delivery SET superseded_at = ? WHERE delivery_id = ? AND superseded_at IS NULL AND task_id <> ?`).run(input.tsMs, input.deliveryId, input.taskId);
      const dup = db.prepare(`SELECT 1 FROM task_delivery WHERE task_id = ? AND delivery_id = ? AND superseded_at IS NULL`).get(input.taskId, input.deliveryId);
      if (dup !== undefined) return true;
      db.prepare(`INSERT INTO task_delivery (task_id, delivery_id, origin, superseded_at, created_at) VALUES (?, ?, ?, NULL, ?)`).run(input.taskId, input.deliveryId, input.origin, input.tsMs);
      return true;
    } catch {
      return false;
    }
  }

  listDeliveriesByTask(taskId: string, limit = ONT_READ_MAX): string[] {
    const db = this.deps.db();
    if (db === null || taskId === '') return [];
    const window = capRead(limit);
    try {
      const rows = db.prepare(`SELECT delivery_id FROM task_delivery WHERE task_id = ? AND superseded_at IS NULL ORDER BY created_at ASC LIMIT ?`).all(taskId, window) as Record<string, SQLOutputValue>[];
      return rows.map((raw) => asText(raw['delivery_id'])).filter((id) => id !== '');
    } catch {
      return [];
    }
  }

  // ───────────────────────────────────────────── 实体关系（派生缓存）

  upsertEntityEdge(input: { id: string; from: string; to: string; relation: string; origin: string; confidence: number; evidence: string[]; tsMs: number }): boolean {
    const db = this.deps.db();
    if (db === null) return false;
    if (input.id === '' || input.from === '' || input.to === '' || input.from === input.to || input.relation.trim() === '') return false;
    const confidence = Math.max(0, Math.min(1000, Math.round(Number.isFinite(input.confidence) ? input.confidence : 500)));
    try {
      db.prepare(`INSERT INTO entity_edge (id, from_entity, to_entity, relation, origin, evidence_json, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET confidence = excluded.confidence, evidence_json = excluded.evidence_json`)
        .run(input.id, input.from, input.to, input.relation.trim().slice(0, 40), input.origin, JSON.stringify(input.evidence.slice(0, 24)), confidence, input.tsMs);
      return true;
    } catch {
      return false;
    }
  }

  listEdgesByEntity(entityId: string, limit = ONT_READ_MAX): Array<{ id: string; from: string; to: string; relation: string; confidence: number }> {
    const db = this.deps.db();
    if (db === null || entityId === '') return [];
    const window = capRead(limit);
    try {
      const rows = db.prepare(`SELECT id, from_entity, to_entity, relation, confidence FROM entity_edge WHERE from_entity = ? OR to_entity = ? ORDER BY confidence DESC LIMIT ?`).all(entityId, entityId, window) as Record<string, SQLOutputValue>[];
      return rows.map((raw) => ({ id: asText(raw['id']), from: asText(raw['from_entity']), to: asText(raw['to_entity']), relation: asText(raw['relation']), confidence: asFinite(raw['confidence']) }));
    } catch {
      return [];
    }
  }

  private toEntity(raw: Record<string, SQLOutputValue>): OntologyEntity {
    let aliases: string[] = [];
    try {
      const arr: unknown = JSON.parse(asText(raw['aliases_json']));
      if (Array.isArray(arr)) aliases = arr.filter((x): x is string => typeof x === 'string');
    } catch { /* 坏 json 当无别名 */ }
    return {
      id: asText(raw['id']),
      kind: asText(raw['kind']) as EntityKind,
      name: asText(raw['name']),
      aliases,
      importance: asFinite(raw['importance']),
      firstSeenMs: asFinite(raw['first_seen_ms']),
      lastSeenMs: asFinite(raw['last_seen_ms']),
    };
  }
}
