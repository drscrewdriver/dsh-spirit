/**
 * 体验条目库（append-only 真源）。
 *
 * 四条硬纪律，都是"写错一次就毁掉整段经历"级别：
 * 1. **没有 DELETE**。更正 = 插新行 + 旧行置 `superseded_by`。旧行永远读得回来，
 *    所以"记错了"能纠正，"纠正本身错了"还能退回。
 * 2. **`id` 是身份，`turn_seq`/`seq` 不是**。宿主侧 replace 会重排序号，
 *    拿序号做键会在某次压缩之后静默指错行。
 * 3. **读默认只看未取代的行**，取代行只在手记显式要求时出现（否则面板里
 *    一条经历会显示两遍，用户无法判断哪条作数）。
 * 4. **任何库错误都不抛穿**。库打不开就退内存镜像：本轮"此刻状态"照样出卡，
 *    只是没有历史与跨会话——角色当下有没有情绪，不该取决于 SQLite 是否可用。
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { ExperienceDraft, ExperienceEntry, ExperienceFact } from '../types.js';
import type { MinimalLogger } from '../persona/store.js';
import { extractCues } from '../experience/cues.js';

/** 降级模式下的内存镜像上限（有顶是必须的：无顶就是无界增长）。 */
export const MEMORY_MIRROR_LIMIT = 200;

/** 分页上限：一次 RPC 不打算搬空整个库。 */
export const PAGE_MAX = 200;

const INSERT_SQL = `INSERT INTO experience (
    id, session_id, workspace_id, turn_seq, ts_ms, trigger, notice, reaction,
    text, fact_json, lane, source_ref, persona_revision, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_CUE_SQL = `INSERT INTO experience_cues (entry_id, cue) VALUES (?, ?)`;

/** 行形状（DB 列名 → TS 形状的单一映射点，别处不再抄列名）。 */
interface Row {
  id: string;
  session_id: string;
  workspace_id: string;
  turn_seq: number;
  ts_ms: number;
  trigger: string;
  notice: string;
  reaction: string;
  text: string;
  fact_json: string;
  lane: string;
  source_ref: string | null;
  persona_revision: number;
  superseded_by: string | null;
  updated_at: number;
}

export interface AppendContext {
  id: string;
  sessionId: string;
  workspaceId: string;
  turnSeq: number;
  tsMs: number;
  personaRevision: number;
}

/** 列名集合（`toEntry` 逐列取，不用位置索引，避免 SELECT 顺序变化时静默错位）。 */
const REQUIRED_COLUMNS = [
  'id',
  'session_id',
  'workspace_id',
  'turn_seq',
  'ts_ms',
  'trigger',
  'notice',
  'reaction',
  'text',
  'fact_json',
  'lane',
  'persona_revision',
  'updated_at',
] as const;

function toEntry(row: Row): ExperienceEntry {
  let fact: ExperienceFact = {};
  try {
    const parsed: unknown = JSON.parse(row.fact_json);
    if (typeof parsed === 'object' && parsed !== null) fact = parsed as ExperienceFact;
  } catch {
    fact = {}; // fact_json 坏了不影响这条经历本身：丢细节、留句子
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    turnSeq: row.turn_seq,
    tsMs: row.ts_ms,
    trigger: row.trigger as ExperienceEntry['trigger'],
    notice: row.notice as ExperienceEntry['notice'],
    reaction: row.reaction as ExperienceEntry['reaction'],
    text: row.text,
    fact,
    lane: row.lane as ExperienceEntry['lane'],
    sourceRef: row.source_ref ?? undefined,
    personaRevision: row.persona_revision,
    supersededBy: row.superseded_by ?? undefined,
    updatedAt: row.updated_at,
  };
}

export class ExperienceStore {
  private readonly mirror: ExperienceEntry[] = [];

  constructor(private readonly deps: { db: DatabaseSync | null; logger: MinimalLogger }) {}

  /** 库是否可用（不可用时统计面要如实报 degraded）。 */
  get persistent(): boolean {
    return this.deps.db !== null;
  }

  // ───────────────────────────────────────────── 统一 DB 出口（node:sqlite 的写口是 prepare().run()）

  private run(sql: string, params: readonly unknown[]): number {
    const db = this.deps.db;
    if (db === null) return 0;
    const args = params as never[];
    const result = db.prepare(sql).run(...args);
    return typeof result.changes === 'number' ? result.changes : 0;
  }

  private all(sql: string, params: readonly unknown[]): Row[] {
    const db = this.deps.db;
    if (db === null) return [];
    const args = params as never[];
    const rows = db.prepare(sql).all(...args) as Record<string, SQLOutputValue>[];
    return rows.filter((raw) => REQUIRED_COLUMNS.every((column) => raw[column] !== undefined)).map((raw) => raw as unknown as Row);
  }

  private countOf(sql: string, params: readonly unknown[]): number {
    const db = this.deps.db;
    if (db === null) return 0;
    const args = params as never[];
    const row = db.prepare(sql).get(...args) as Record<string, SQLOutputValue> | undefined;
    const n = row?.['n'];
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  }

  private scalar(sql: string, params: readonly unknown[], key: string): string | undefined {
    const db = this.deps.db;
    if (db === null) return undefined;
    const args = params as never[];
    const row = db.prepare(sql).get(...args) as Record<string, SQLOutputValue> | undefined;
    const value = row?.[key];
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * 单事务写入：条目行 + 它的 cues。
   *
   * 两件分开写会坏在很安静的位置：崩在中间就得到"有 cue 无条目"的孤儿行（检索能命中
   * 一个不存在的经历）。实测还顺带发现成本：逐条自提交时 2 万条要 92 秒。
   */
  private runInTransaction(write: () => void): void {
    const db = this.deps.db;
    if (db === null) return;
    db.exec('BEGIN');
    try {
      write();
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败不掩盖原错 */
      }
      throw err;
    }
  }

  /** 内存镜像写入（有顶：无顶就是无界增长）。 */
  private pushMirror(entry: ExperienceEntry): void {
    this.mirror.push(entry);
    if (this.mirror.length > MEMORY_MIRROR_LIMIT) this.mirror.shift();
  }

  // ───────────────────────────────────────────── 写

  /**
   * 追加一条。写库失败 ⇒ 落内存镜像并告警，**不抛**。
   *
   * @param cuesOverride 显式指定 cues（DRSC 来源带 segment 关键词）；缺省从 fact 提取
   */
  append(ctx: AppendContext, draft: ExperienceDraft, cuesOverride?: string[]): ExperienceEntry {
    const entry: ExperienceEntry = {
      ...draft,
      id: ctx.id,
      sessionId: ctx.sessionId,
      workspaceId: ctx.workspaceId,
      turnSeq: ctx.turnSeq,
      tsMs: ctx.tsMs,
      personaRevision: ctx.personaRevision,
      updatedAt: ctx.tsMs,
    };
    const cues = cuesOverride ?? extractCues(entry.fact);
    if (this.deps.db === null) {
      this.pushMirror(entry);
      return entry;
    }
    try {
      this.runInTransaction(() => {
        this.run(INSERT_SQL, [
          entry.id,
          entry.sessionId,
          entry.workspaceId,
          entry.turnSeq,
          entry.tsMs,
          entry.trigger,
          entry.notice,
          entry.reaction,
          entry.text,
          JSON.stringify(entry.fact),
          entry.lane,
          entry.sourceRef ?? null,
          entry.personaRevision,
          entry.updatedAt,
        ]);
        for (const cue of cues) this.run(INSERT_CUE_SQL, [entry.id, cue]);
      });
    } catch (err) {
      // 抛穿就等于让一次记录失败变成一轮对话失败
      this.deps.logger.warn(`[spirit] 条目写入失败，本次退内存镜像：${err instanceof Error ? err.message : String(err)}`);
      this.pushMirror(entry);
    }
    return entry;
  }

  /**
   * 更正：只置旧行的 `superseded_by`，不删不改旧行内容。
   *
   * @returns 旧行是否被成功标记（不存在或已被取代 ⇒ false）
   */
  supersede(oldId: string, newId: string): boolean {
    if (this.deps.db === null) {
      const old = this.mirror.find((e) => e.id === oldId && e.supersededBy === undefined);
      if (old === undefined) return false;
      old.supersededBy = newId;
      return true;
    }
    try {
      return (
        this.run(
          `UPDATE experience SET superseded_by = ?, updated_at = ? WHERE id = ? AND superseded_by IS NULL`,
          [newId, Date.now(), oldId],
        ) > 0
      );
    } catch (err) {
      this.deps.logger.warn(`[spirit] 取代标记失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ───────────────────────────────────────────── 读

  /** 近因路：本会话最近 K 条未取代条目（返回升序，卡片按时间读）。 */
  recent(sessionId: string, k: number): ExperienceEntry[] {
    if (k <= 0) return [];
    const fromMirror = (): ExperienceEntry[] =>
      this.mirror.filter((e) => e.sessionId === sessionId && e.supersededBy === undefined).slice(-k);
    if (this.deps.db === null) return fromMirror();
    try {
      const rows = this.all(
        `SELECT * FROM experience
         WHERE session_id = ? AND superseded_by IS NULL
         ORDER BY ts_ms DESC, id DESC LIMIT ?`,
        [sessionId, Math.floor(k)],
      );
      return rows.reverse().map(toEntry);
    } catch (err) {
      this.deps.logger.warn(`[spirit] 近因读失败，本轮只走内存镜像：${err instanceof Error ? err.message : String(err)}`);
      return fromMirror();
    }
  }

  /** 跨会话基调：本工作区最近一个其它会话的末尾几条。 */
  previousSessionEntries(workspaceId: string, excludeSessionId: string, limit: number): ExperienceEntry[] {
    if (limit <= 0) return [];
    if (this.deps.db === null) {
      return this.mirror
        .filter((e) => e.workspaceId === workspaceId && e.sessionId !== excludeSessionId && e.supersededBy === undefined)
        .slice(-limit);
    }
    try {
      const sessionId = this.scalar(
        `SELECT session_id FROM experience
         WHERE workspace_id = ? AND session_id <> ? AND superseded_by IS NULL
         GROUP BY session_id ORDER BY MAX(ts_ms) DESC LIMIT 1`,
        [workspaceId, excludeSessionId],
        'session_id',
      );
      if (sessionId === undefined) return [];
      const rows = this.all(
        `SELECT * FROM experience WHERE session_id = ? AND superseded_by IS NULL ORDER BY ts_ms DESC LIMIT ?`,
        [sessionId, Math.floor(limit)],
      );
      return rows.reverse().map(toEntry);
    } catch {
      return [];
    }
  }

  /** 条目数（stats 用；失败退 0 而不是抛）。 */
  count(sessionId: string): number {
    if (this.deps.db === null) {
      return this.mirror.filter((e) => e.sessionId === sessionId && e.supersededBy === undefined).length;
    }
    try {
      return this.countOf(`SELECT COUNT(*) AS n FROM experience WHERE session_id = ? AND superseded_by IS NULL`, [sessionId]);
    } catch {
      return 0;
    }
  }

  /** 手记分页（倒序）：读侧投影，不是真源。 */
  page(
    sessionId: string,
    offset: number,
    limit: number,
    includeSuperseded = false,
  ): { total: number; rows: ExperienceEntry[] } {
    const from = Math.max(0, Math.floor(offset));
    const size = Math.max(1, Math.min(PAGE_MAX, Math.floor(limit)));
    const where = includeSuperseded ? `session_id = ?` : `session_id = ? AND superseded_by IS NULL`;
    if (this.deps.db === null) {
      const pool = this.mirror.filter(
        (e) => e.sessionId === sessionId && (includeSuperseded || e.supersededBy === undefined),
      );
      return { total: pool.length, rows: pool.slice().reverse().slice(from, from + size) };
    }
    try {
      const total = this.countOf(`SELECT COUNT(*) AS n FROM experience WHERE ${where}`, [sessionId]);
      const rows = this.all(`SELECT * FROM experience WHERE ${where} ORDER BY ts_ms DESC, id DESC LIMIT ? OFFSET ?`, [
        sessionId,
        size,
        from,
      ]);
      return { total, rows: rows.map(toEntry) };
    } catch {
      return { total: 0, rows: [] };
    }
  }

  /**
   * 检索路的小表打分：cues 命中或正文包含（二元串兼容中文）。
   *
   * 这里**故意不做 FTS**：条目规模是事件数量级，扫表够用；实测不达标再补索引，
   * 不预先付维护成本（计划 task_4.2 的 p95 实测就是这条的验收口）。
   */
  searchLocal(query: string, opts: { sessionId?: string; limit: number }): ExperienceEntry[] {
    const parts = query
      .trim()
      .toLowerCase()
      .split(/\s+/u)
      .filter((part) => part.length >= 2);
    if (parts.length === 0 || this.deps.db === null) return [];
    try {
      const clauses = parts.map(() => `(c.cue LIKE ? OR e.text LIKE ?)`).join(' OR ');
      const params: unknown[] = [];
      for (const part of parts) params.push(`%${part}%`, `%${part}%`);
      const scope = opts.sessionId === undefined ? '' : `AND e.session_id = ?`;
      if (opts.sessionId !== undefined) params.push(opts.sessionId);
      params.push(Math.max(1, Math.floor(opts.limit)));
      const rows = this.all(
        `SELECT e.* FROM experience e
         LEFT JOIN experience_cues c ON c.entry_id = e.id
         WHERE e.superseded_by IS NULL AND (${clauses}) ${scope}
         GROUP BY e.id
         ORDER BY MAX(e.ts_ms) DESC
         LIMIT ?`,
        params,
      );
      return rows.map(toEntry);
    } catch {
      return [];
    }
  }
}
