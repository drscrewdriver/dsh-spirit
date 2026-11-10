/**
 * 模型可写记忆（v0.8）：**两本账 + 日记**，与目的层（goal）同库不同表。
 *
 * 三条纪律（照本体层的先例）：
 * 1. **范围必须显式**：life（生涯/人格面：心里话、约定）/ work（长期工作：事实/决定/偏好、约定）
 *    / diary（日记：追加、**不自动注入**，靠工具 recall 或面板按需取）。kind 越界拒写。
 * 2. **写前脱敏**：dropIfSecret 含密整条拒（不整段落库）；文本钳 200 字；同 scope 同文幂等（撞 id 只刷 updated_at）。
 * 3. **删不是物理删**：forget 置 forgotten_at，读面永远排除非法行；降级面（db=null）写 false / 读空，不抛穿。
 *
 * goal：惦记的事（open/done/dropped），workspace_id 空 = 跨工作区；done 记 done_at。
 */
import type { DatabaseSync } from 'node:sqlite';

import { SPIRIT_MEMORY_KINDS, SPIRIT_MEMORY_SCOPES, type SpiritGoalRow, type SpiritMemoryRow, type SpiritMemoryScope } from '../contract.js';
import { dropIfSecret } from '../ontology/scrub.js';

const TEXT_MAX = 200;
const TITLE_MAX = 80;
const WHY_MAX = 200;
const READ_MAX = 100;
export const GOAL_STATUSES = ['open', 'done', 'dropped'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

function capLimit(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 20;
  return Math.min(Math.max(1, n), READ_MAX);
}

/** 稳定 id：同 scope 同文（小写）⇒ 同 id（幂等靠主键，不靠查重再插）。 */
function hashOf(seed: string): string {
  let hash = 5381;
  for (let i = 0; i < seed.length; i += 1) hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class ModelMemoryStore {
  constructor(private readonly deps: { db: () => DatabaseSync | null; logger: { warn(message: string): void }; clock?: () => number }) {}

  private get now(): number {
    return (this.deps.clock ?? Date.now)();
  }

  write(input: {
    scope: string;
    kind: string;
    text: string;
    workspaceId?: string;
    sessionId?: string;
  }): { ok: true; row: SpiritMemoryRow } | { ok: false; reason: string } {
    const db = this.deps.db();
    if (db === null) return { ok: false, reason: '库不可用（降级面）' };
    const scope = input.scope.trim();
    if (!(SPIRIT_MEMORY_SCOPES as readonly string[]).includes(scope)) {
      return { ok: false, reason: `scope 必须是 ${SPIRIT_MEMORY_SCOPES.join('/')}` };
    }
    const kind = input.kind.trim();
    if (!SPIRIT_MEMORY_KINDS[scope as SpiritMemoryScope].includes(kind)) {
      return { ok: false, reason: `${scope} 的 kind 必须是 ${SPIRIT_MEMORY_KINDS[scope as SpiritMemoryScope].join('/')}` };
    }
    const raw = Array.from(input.text.trim()).slice(0, TEXT_MAX).join('');
    if (raw === '') return { ok: false, reason: 'text 不能为空' };
    const clean = dropIfSecret(raw);
    if (clean === null) return { ok: false, reason: '含密钥/隐私，拒绝写入（记忆不存敏感串）' };
    const id = `mm-${scope}-${hashOf(`${scope}\u0000${clean.toLowerCase()}`)}`;
    const ts = this.now;
    try {
      db.prepare(
        `INSERT INTO model_memory (id, scope, kind, text, workspace_id, session_id, pinned, created_at, updated_at, forgotten_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, updated_at = excluded.updated_at, forgotten_at = NULL`,
      ).run(id, scope, kind, clean, (input.workspaceId ?? '').trim(), (input.sessionId ?? '').trim(), ts, ts);
      const row = this.recent({ scope: scope as SpiritMemoryScope, limit: READ_MAX }).find((r) => r.id === id);
      if (row === undefined) return { ok: false, reason: '写入后读取失败' };
      return { ok: true, row };
    } catch (err) {
      return { ok: false, reason: `写入失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  pin(id: string, pinned: boolean): boolean {
    const db = this.deps.db();
    if (db === null || id === '') return false;
    try {
      const info = db.prepare(`UPDATE model_memory SET pinned = ?, updated_at = ? WHERE id = ? AND forgotten_at IS NULL`)
        .run(pinned ? 1 : 0, this.now, id);
      return Number(info.changes) > 0;
    } catch {
      return false;
    }
  }

  forget(id: string): boolean {
    const db = this.deps.db();
    if (db === null || id === '') return false;
    try {
      const info = db.prepare(`UPDATE model_memory SET forgotten_at = ?, updated_at = ? WHERE id = ? AND forgotten_at IS NULL`)
        .run(this.now, this.now, id);
      return Number(info.changes) > 0;
    } catch {
      return false;
    }
  }

  /** 读面：不含遗忘行；workspaceId 空 = 全部；非空 = 本区 + 全局行（跨工作区写的那部分）。 */
  recent(opts: { scope: SpiritMemoryScope; workspaceId?: string; limit?: number }): SpiritMemoryRow[] {
    const db = this.deps.db();
    if (db === null) return [];
    const limit = capLimit(opts.limit);
    const ws = (opts.workspaceId ?? '').trim();
    try {
      const conds = ['scope = ?', 'forgotten_at IS NULL'];
      const params: unknown[] = [opts.scope];
      if (ws !== '') {
        conds.push(`(workspace_id = ? OR workspace_id = '')`);
        params.push(ws);
      }
      params.push(limit);
      const rows = db.prepare(`SELECT * FROM model_memory WHERE ${conds.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`)
        .all(...(params as never[])) as Array<Record<string, unknown>>;
      return rows.map(toMemoryRow);
    } catch {
      return [];
    }
  }

  /** 注入面：生涯 pinned（全局，不含工作区语义）。 */
  pinnedLife(limit = 3): SpiritMemoryRow[] {
    return this.recent({ scope: 'life', limit: READ_MAX }).filter((row) => row.pinned).slice(0, capLimit(limit));
  }

  /** 注入面：工作 pinned（本区 + 全局）。 */
  pinnedWork(workspaceId: string, limit = 2): SpiritMemoryRow[] {
    return this.recent({ scope: 'work', workspaceId, limit: READ_MAX }).filter((row) => row.pinned).slice(0, capLimit(limit));
  }

  /** 日记：不自动注入，按需取（工具 recall / 面板）。 */
  diary(limit = 20): SpiritMemoryRow[] {
    return this.recent({ scope: 'diary', limit });
  }

  /** 文本包含检索（日记/生涯/工作都可查；供工具 recall 用）。 */
  search(q: string, opts: { scope?: SpiritMemoryScope; workspaceId?: string; limit?: number } = {}): SpiritMemoryRow[] {
    const keyword = q.trim().toLowerCase();
    if (keyword === '') return [];
    const scope = opts.scope ?? 'life';
    return this.recent({ scope, ...(opts.workspaceId === undefined ? {} : { workspaceId: opts.workspaceId }), limit: capLimit(opts.limit) })
      .filter((row) => row.text.toLowerCase().includes(keyword));
  }
}

function toMemoryRow(raw: Record<string, unknown>): SpiritMemoryRow {
  return {
    id: asText(raw['id']),
    scope: asText(raw['scope']) as SpiritMemoryScope,
    kind: asText(raw['kind']),
    text: asText(raw['text']),
    workspaceId: asText(raw['workspace_id']),
    pinned: Number(raw['pinned']) === 1,
    createdAt: Number(raw['created_at']) || 0,
    updatedAt: Number(raw['updated_at']) || 0,
  };
}

export class GoalStore {
  constructor(private readonly deps: { db: () => DatabaseSync | null; logger: { warn(message: string): void }; clock?: () => number }) {}

  private get now(): number {
    return (this.deps.clock ?? Date.now)();
  }

  add(input: { title: string; why?: string; workspaceId?: string }): { ok: true; row: SpiritGoalRow } | { ok: false; reason: string } {
    const db = this.deps.db();
    if (db === null) return { ok: false, reason: '库不可用（降级面）' };
    const title = Array.from(input.title.trim()).slice(0, TITLE_MAX).join('');
    if (title === '') return { ok: false, reason: 'title 不能为空' };
    const why = Array.from((input.why ?? '').trim()).slice(0, WHY_MAX).join('');
    const id = `goal-${hashOf(`${title.toLowerCase()}\u0000${(input.workspaceId ?? '').trim()}`)}`;
    const ts = this.now;
    try {
      // 同标的重开：撞 id 就把状态拨回 open（不新增重复目标）
      db.prepare(
        `INSERT INTO goal (id, title, status, why, workspace_id, created_at, updated_at, done_at)
         VALUES (?, ?, 'open', ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET status = 'open', why = excluded.why, updated_at = excluded.updated_at, done_at = NULL`,
      ).run(id, title, why, (input.workspaceId ?? '').trim(), ts, ts);
      const row = this.list({ limit: READ_MAX }).find((r) => r.id === id);
      if (row === undefined) return { ok: false, reason: '写入后读取失败' };
      return { ok: true, row };
    } catch (err) {
      return { ok: false, reason: `写入失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  setStatus(id: string, status: GoalStatus): boolean {
    const db = this.deps.db();
    if (db === null || id === '' || !(GOAL_STATUSES as readonly string[]).includes(status)) return false;
    try {
      const ts = this.now;
      const info = db.prepare(`UPDATE goal SET status = ?, updated_at = ?, done_at = ? WHERE id = ?`)
        .run(status, ts, status === 'done' ? ts : null, id);
      return Number(info.changes) > 0;
    } catch {
      return false;
    }
  }

  list(opts: { status?: GoalStatus; workspaceId?: string; limit?: number } = {}): SpiritGoalRow[] {
    const db = this.deps.db();
    if (db === null) return [];
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.status !== undefined && (GOAL_STATUSES as readonly string[]).includes(opts.status)) {
      conds.push('status = ?');
      params.push(opts.status);
    }
    const ws = (opts.workspaceId ?? '').trim();
    if (ws !== '') {
      conds.push(`(workspace_id = ? OR workspace_id = '')`);
      params.push(ws);
    }
    params.push(capLimit(opts.limit));
    const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
    try {
      const rows = db.prepare(`SELECT * FROM goal${where} ORDER BY updated_at DESC LIMIT ?`).all(...(params as never[])) as Array<Record<string, unknown>>;
      return rows.map(toGoalRow);
    } catch {
      return [];
    }
  }

  /** 注入面：惦记的事（open，最多 3 条；本区 + 全局）。 */
  openFor(workspaceId: string, limit = 3): SpiritGoalRow[] {
    return this.list({ status: 'open', workspaceId, limit });
  }
}

function toGoalRow(raw: Record<string, unknown>): SpiritGoalRow {
  return {
    id: asText(raw['id']),
    title: asText(raw['title']),
    status: asText(raw['status']) as GoalStatus,
    why: asText(raw['why']),
    workspaceId: asText(raw['workspace_id']),
    createdAt: Number(raw['created_at']) || 0,
    updatedAt: Number(raw['updated_at']) || 0,
  };
}
