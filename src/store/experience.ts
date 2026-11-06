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
 *    ⚠️ 镜像**只在内存**（上限 `MEMORY_MIRROR_LIMIT`，且没有回灌库的路径）：降级期间
 *    记下的条目在进程重启后**不可恢复**。对外文案不许把这写成"只是少了历史"。
 *
 * 5. **读侧也要有上界**。写侧的批有上界不等于读侧安全：`LIKE '%…%'` 不走索引，而本库
 *    append-only 且只归档不删行 ⇒ 没有扫描窗的检索会随使用时长线性变慢，而它在
 *    `agent/pre-step` 上每轮同步跑一次。
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { ExperienceDraft, ExperienceEntry, ExperienceFact } from '../types.js';
import type { MinimalLogger } from '../persona/store.js';
import { extractCues } from '../experience/cues.js';

/** 降级模式下的内存镜像上限（有顶是必须的：无顶就是无界增长）。 */
export const MEMORY_MIRROR_LIMIT = 200;

/** 分页上限：一次 RPC 不打算搬空整个库。 */
export const PAGE_MAX = 200;

/**
 * 检索候选池上限（行数）：`LIKE '%…%'` 用不上索引，`LIMIT` 只截输出不截扫描 ——
 * 没有这个窗，单次检索的成本就与库的总行数成正比，而本库永不删行。
 *
 * 量级依据：每轮最多一条 ⇒ 5000 行 ≈ 数千轮的使用量；再往前的经历本就该由近因段
 * 与淡出档位覆盖，不该在历史路里把"刚发生"挤掉。行数小于窗时行为与全表逐行等价。
 */
export const LOCAL_SCAN_LIMIT = 5000;

const INSERT_SQL = `INSERT INTO experience (
    id, session_id, workspace_id, turn_seq, ts_ms, trigger, notice, reaction,
    text, fact_json, lane, source_ref, persona_revision, updated_at,
    gist, salience
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_CUE_SQL = `INSERT INTO experience_cues (entry_id, cue) VALUES (?, ?)`;

/**
 * 更正式编辑专用插入（v5）：比 INSERT_SQL 多一列 feedback_score——
 * ★ 继承必须**落库**而不是只在返回对象里（round-28 真浏览器抓到的假绿：
 * 内存里带着★、库里新行是 NULL，刷新后面板上的★就蒸发了）。
 */
const REVISE_INSERT_SQL = `INSERT INTO experience (
    id, session_id, workspace_id, turn_seq, ts_ms, trigger, notice, reaction,
    text, fact_json, lane, source_ref, persona_revision, updated_at,
    gist, salience, feedback_score
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
  // v2 列（对 v1 旧库不存在，读侧一律可缺省；写侧由 append/淡出派生供给）
  gist?: string | null;
  salience?: number;
  feedback_score?: number | null;
  // v5 列（藏起标记）：老库迁移补齐，读侧缺省即在场
  hidden_at?: number | null;
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
  const salience = typeof row.salience === 'number' && Number.isFinite(row.salience) ? row.salience : undefined;
  const feedback = typeof row.feedback_score === 'number' && Number.isFinite(row.feedback_score) ? row.feedback_score : undefined;
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
    gist: typeof row.gist === 'string' && row.gist !== '' ? row.gist : undefined,
    fact,
    lane: row.lane as ExperienceEntry['lane'],
    sourceRef: row.source_ref ?? undefined,
    personaRevision: row.persona_revision,
    supersededBy: row.superseded_by ?? undefined,
    hiddenAt: typeof row.hidden_at === 'number' && Number.isFinite(row.hidden_at) ? row.hidden_at : undefined,
    ...(salience === undefined ? {} : { salience }),
    ...(feedback === undefined ? {} : { feedbackScore: feedback }),
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
          entry.gist ?? null,
          entry.salience ?? 0,
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

  /**
   * 人工反馈落库（刀1 反馈腿）：feedback_score 列可覆写（v2 豁免定性见 db/schema.ts 头注）。
   *
   * 两轴分离的执行点：这里只写反馈列，条目本体（text/salience/gist）不动；
   * 读侧（recentForms）拿它做**重排**，永不拿它参与 m/衰减/情绪派生。
   * @returns 是否命中一条未取代的条目
   */
  setFeedback(entryId: string, score: number): boolean {
    const clamped = Math.max(-1, Math.min(5, Math.round(score)));
    const mirrorHit = (): boolean => {
      const hit = this.mirror.find((e) => e.id === entryId && e.supersededBy === undefined);
      if (hit === undefined) return false;
      hit.feedbackScore = clamped;
      return true;
    };
    if (this.deps.db === null) return mirrorHit();
    try {
      return (
        this.run(`UPDATE experience SET feedback_score = ? WHERE id = ? AND superseded_by IS NULL`, [clamped, entryId]) > 0
      );
    } catch (err) {
      this.deps.logger.warn(`[spirit] 反馈写入失败（退内存镜像）：${err instanceof Error ? err.message : String(err)}`);
      return mirrorHit();
    }
  }

  /**
   * 藏起来 / 再想起（v5 翻阅 tab 的管理动作）：只置 `hidden_at` 标记列，行永不物理删。
   * 非空 ⇒ 退出星海图/注入/手记缺省视图；可随时清空恢复。幂等：重复藏同一行不重复计数。
   * @returns 实际被改动的行数（批量上界 PAGE_MAX，超出截断不报错——照 prime 退场腿口径）
   */
  setHidden(ids: readonly string[], hidden: boolean): number {
    const list = ids.slice(0, PAGE_MAX);
    if (list.length === 0) return 0;
    const now = Date.now();
    if (this.deps.db === null) {
      let n = 0;
      for (const id of list) {
        const e = this.mirror.find((x) => x.id === id);
        if (e === undefined) continue;
        if (hidden ? e.hiddenAt === undefined : e.hiddenAt !== undefined) {
          e.hiddenAt = hidden ? now : undefined;
          n += 1;
        }
      }
      return n;
    }
    try {
      let n = 0;
      this.runInTransaction(() => {
        for (const id of list) {
          n += hidden
            ? this.run(`UPDATE experience SET hidden_at = ?, updated_at = ? WHERE id = ? AND hidden_at IS NULL`, [now, now, id])
            : this.run(`UPDATE experience SET hidden_at = NULL, updated_at = ? WHERE id = ? AND hidden_at IS NOT NULL`, [now, id]);
        }
      });
      return n;
    } catch (err) {
      this.deps.logger.warn(`[spirit] 藏起标记失败：${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /**
   * 更正式编辑（v5 翻阅 tab）：插新行 + 旧行置 `superseded_by`，绝不 UPDATE 正文。
   *
   * 与仓内根纪律同构（可回滚优先）：旧行永远读得回来，编辑史以取代链形态在星海自然可见。
   * ★ feedback_score 复制进新行（否则「标过在意」会随编辑蒸发，G4）；cues 原样拷贝；
   * `source_ref` 记 `rev:<旧 id>` 锚点。仅未取代且未藏的行可改（幽灵/藏行拒改，不拿编辑当恢复后门）。
   * @returns 新行；旧行不存在/不可改 ⇒ null
   */
  reviseEntry(id: string, patch: { text?: string; gist?: string; salience?: number }): ExperienceEntry | null {
    const old = this.byId(id);
    if (old === null || old.supersededBy !== undefined || old.hiddenAt !== undefined) return null;
    const now = Date.now();
    const newId = `rev-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const nextText = patch.text?.trim();
    const nextGist = patch.gist?.trim();
    const revised: ExperienceEntry = {
      ...old,
      id: newId,
      text: nextText !== undefined && nextText !== '' ? nextText : old.text,
      gist: nextGist !== undefined ? (nextGist === '' ? undefined : nextGist) : old.gist,
      salience: typeof patch.salience === 'number' && Number.isFinite(patch.salience)
        ? Math.max(0, Math.min(2, Math.round(patch.salience)))
        : old.salience,
      sourceRef: `rev:${old.id}`,
      supersededBy: undefined,
      hiddenAt: undefined,
      updatedAt: now,
    };
    if (this.deps.db === null) {
      const mirrorOld = this.mirror.find((e) => e.id === id);
      if (mirrorOld !== undefined) mirrorOld.supersededBy = newId;
      this.pushMirror(revised);
      return revised;
    }
    try {
      const oldCues = this.cuesFor([old.id]).get(old.id) ?? [];
      this.runInTransaction(() => {
        this.run(REVISE_INSERT_SQL, [
          revised.id,
          revised.sessionId,
          revised.workspaceId,
          revised.turnSeq,
          revised.tsMs,
          revised.trigger,
          revised.notice,
          revised.reaction,
          revised.text,
          JSON.stringify(revised.fact),
          revised.lane,
          revised.sourceRef,
          revised.personaRevision,
          revised.updatedAt,
          revised.gist ?? null,
          revised.salience ?? 0,
          revised.feedbackScore ?? null,
        ]);
        for (const cue of oldCues) this.run(INSERT_CUE_SQL, [revised.id, cue]);
        if (!this.supersede(old.id, revised.id)) throw new Error('旧行已被并发取代，编辑未落');
      });
      return revised;
    } catch (err) {
      this.deps.logger.warn(`[spirit] 条目编辑失败（事务已回滚，旧行原样在场）：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ───────────────────────────────────────────── 读

  /** 近因路：本会话最近 K 条未取代条目（返回升序，卡片按时间读）。 */
  recent(sessionId: string, k: number): ExperienceEntry[] {
    if (k <= 0) return [];
    const fromMirror = (): ExperienceEntry[] =>
      this.mirror.filter((e) => e.sessionId === sessionId && e.supersededBy === undefined && e.hiddenAt === undefined).slice(-k);
    if (this.deps.db === null) return fromMirror();
    try {
      const rows = this.all(
        `SELECT * FROM experience
         WHERE session_id = ? AND superseded_by IS NULL AND hidden_at IS NULL
         ORDER BY ts_ms DESC, id DESC LIMIT ?`,
        [sessionId, Math.floor(k)],
      );
      return rows.reverse().map(toEntry);
    } catch (err) {
      this.deps.logger.warn(`[spirit] 近因读失败，本轮只走内存镜像：${err instanceof Error ? err.message : String(err)}`);
      return fromMirror();
    }
  }

  /**
   * 跨会话基调：本工作区最近一个其它会话的末尾几条。
   *
   * 内层子查询同样是**扫描窗**：`GROUP BY session_id` 在全表上跑就是一次全量扫，
   * 而这条路在新会话首轮必走一次。先取最近 `LOCAL_SCAN_LIMIT` 条再分组，语义上
   * 等于「最近的经历里，上一次会话长什么样」。
   */
  previousSessionEntries(workspaceId: string, excludeSessionId: string, limit: number): ExperienceEntry[] {
    if (limit <= 0) return [];
    if (this.deps.db === null) {
      return this.mirror
        .filter((e) => e.workspaceId === workspaceId && e.sessionId !== excludeSessionId && e.supersededBy === undefined && e.hiddenAt === undefined)
        .slice(-limit);
    }
    try {
      const sessionId = this.scalar(
        `SELECT session_id FROM (
           SELECT session_id, ts_ms FROM experience
           WHERE workspace_id = ? AND session_id <> ? AND superseded_by IS NULL AND hidden_at IS NULL
           ORDER BY ts_ms DESC, id DESC LIMIT ?
         )
         GROUP BY session_id ORDER BY MAX(ts_ms) DESC LIMIT 1`,
        [workspaceId, excludeSessionId, LOCAL_SCAN_LIMIT],
        'session_id',
      );
      if (sessionId === undefined) return [];
      const rows = this.all(
        `SELECT * FROM experience WHERE session_id = ? AND superseded_by IS NULL AND hidden_at IS NULL ORDER BY ts_ms DESC LIMIT ?`,
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
      return this.mirror.filter((e) => e.sessionId === sessionId && e.supersededBy === undefined && e.hiddenAt === undefined).length;
    }
    try {
      return this.countOf(`SELECT COUNT(*) AS n FROM experience WHERE session_id = ? AND superseded_by IS NULL AND hidden_at IS NULL`, [sessionId]);
    } catch {
      return 0;
    }
  }

  /**
   * 库里最近有体验条目的会话（手记默认视图用）。
   *
   * 为什么不能由内存注册表回答：注册表随宿主重启清空，而手记是**库**——
   * “看看这个角色最近经历了什么”在重启后仍须可读，否则观测面最常用的一眼会变空白。
   * 无条目 ⇒ 空串（调用方自己决定是空态还是错态，不猜）。
   */
  latestSessionId(): string {
    if (this.deps.db === null) {
      for (let i = this.mirror.length - 1; i >= 0; i -= 1) {
        const entry = this.mirror[i];
        if (entry !== undefined && entry.supersededBy === undefined && entry.hiddenAt === undefined) return entry.sessionId;
      }
      return '';
    }
    try {
      return this.scalar(
        `SELECT session_id AS sid FROM experience WHERE superseded_by IS NULL AND hidden_at IS NULL ORDER BY ts_ms DESC, id DESC LIMIT 1`,
        [],
        'sid',
      ) ?? '';
    } catch {
      return '';
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
    const where = includeSuperseded
      ? `session_id = ? AND hidden_at IS NULL`
      : `session_id = ? AND superseded_by IS NULL AND hidden_at IS NULL`;
    if (this.deps.db === null) {
      const pool = this.mirror.filter(
        (e) => e.sessionId === sessionId && e.hiddenAt === undefined && (includeSuperseded || e.supersededBy === undefined),
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
   * 记忆星海窗口：全库最近 `limit` 条未取代条目（**升序**返回，便于前端按时间排布）。
   *
   * 为什么不能复用 `page()`：它是**会话级**且带 OFFSET 分页，拿它凑全库要么 N 次查询、
   * 要么把 3000 条拆成 15 页；而星海只要"最近的一段"。所以这里只做一件事：
   * 按 `ts_ms` 倒序取一屏，不提供 offset（星海不是翻页器）。
   *
   * ⚠️ 必须有 `LIMIT`：本库 append-only、只归档不删行，无顶就是随使用时长线性变慢。
   */
  listRecent(limit: number, opts: { sessionId?: string; includeSuperseded?: boolean } = {}): ExperienceEntry[] {
    const size = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
    const scope = opts.sessionId;
    const withGhosts = opts.includeSuperseded === true;
    if (this.deps.db === null) {
      const pool = this.mirror.filter(
        (entry) => entry.hiddenAt === undefined && (withGhosts || entry.supersededBy === undefined) && (scope === undefined || entry.sessionId === scope),
      );
      return pool.slice(-size);
    }
    try {
      // 条件动态拼（但只拼**固定子句**，参数一律走占位符）：星海要能看到取代链，
      // 就得让被更正的旧版本同窗；手记列表仍走 `page()`，那里只列作数的那条。
      const conditions: string[] = ['hidden_at IS NULL'];
      const params: Array<string | number> = [];
      if (!withGhosts) conditions.push('superseded_by IS NULL');
      if (scope !== undefined) {
        conditions.push('session_id = ?');
        params.push(scope);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(size);
      const rows = this.all(`SELECT * FROM experience ${where} ORDER BY ts_ms DESC, id DESC LIMIT ?`, params);
      return rows.reverse().map(toEntry);
    } catch (err) {
      this.deps.logger.warn(`[spirit] 星海窗口读取失败：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** 全库未取代条目总数（星海顶部「已加载 X / 总量 Y」用）。 */
  countAll(): number {
    if (this.deps.db === null) return this.mirror.filter((entry) => entry.supersededBy === undefined && entry.hiddenAt === undefined).length;
    try {
      return this.countOf(`SELECT COUNT(*) AS n FROM experience WHERE superseded_by IS NULL AND hidden_at IS NULL`, []);
    } catch {
      return 0;
    }
  }

  /**
   * 批量取 cue（星海连线用）：`entry_id → cue[]`。
   *
   * 分批执行（每批 400）而不是一条 `IN (...)` 到底：SQLite 的绑定变量数有上限，
   * 3000 个 id 一次性拼进去在部分构建上会直接报错。库不可用 ⇒ 返回空表（只连时间边）。
   */
  cuesFor(ids: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const db = this.deps.db;
    if (db === null || ids.length === 0) return out;
    const batch = 400;
    try {
      for (let start = 0; start < ids.length; start += batch) {
        const slice = ids.slice(start, start + batch);
        const placeholders = slice.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT entry_id, cue FROM experience_cues WHERE entry_id IN (${placeholders}) ORDER BY entry_id, cue`)
          .all(...(slice as never[])) as Record<string, SQLOutputValue>[];
        for (const row of rows) {
          const id = typeof row['entry_id'] === 'string' ? row['entry_id'] : '';
          const cue = typeof row['cue'] === 'string' ? row['cue'] : '';
          if (id === '' || cue === '') continue;
          const list = out.get(id) ?? [];
          list.push(cue);
          out.set(id, list);
        }
      }
      return out;
    } catch (err) {
      this.deps.logger.warn(`[spirit] cue 读取失败，本次只连时间边：${err instanceof Error ? err.message : String(err)}`);
      return out;
    }
  }

  /**
   * 检索路的小表打分：cues 命中或正文包含（二元串兼容中文）。
   *
   * 这里**故意不做 FTS**：条目规模是事件数量级，扫表够用；实测不达标再补索引，
   * 不预先付维护成本（计划 task_4.2 的 p95 实测就是这条的验收口）。
   *
   * **扫描窗（必须有）**：`LIKE '%…%'` 走不了索引、`LIMIT` 只截输出不截扫描，而本库
   * append-only 且只归档不删行 ⇒ 行数单调增长。更关键的是本方法**同步**执行，位于
   * `agent/pre-step` 串行路径上——`recall.timeoutMs` 那个超时只包 DRSC 的异步检索，
   * **管不到这里**。所以先按时间取最近 `scanLimit` 条做候选池，再在其上过滤：
   * 代价有界；语义上等于"只在最近的经历里被勾起"。
   *
   * @param opts.scanLimit 候选池行数（缺省 `LOCAL_SCAN_LIMIT`；测试注入小值用）
   */
  searchLocal(
    query: string,
    opts: { sessionId?: string; limit: number; scanLimit?: number },
  ): ExperienceEntry[] {
    const parts = query
      .trim()
      .toLowerCase()
      .split(/\s+/u)
      .filter((part) => part.length >= 2);
    if (parts.length === 0 || this.deps.db === null) return [];
    const scan = Math.max(1, Math.floor(opts.scanLimit ?? LOCAL_SCAN_LIMIT));
    try {
      const clauses = parts.map(() => `(c.cue LIKE ? OR e.text LIKE ?)`).join(' OR ');
      const params: unknown[] = [];
      const scopeInner = opts.sessionId === undefined ? '' : `AND session_id = ?`;
      if (opts.sessionId !== undefined) params.push(opts.sessionId);
      params.push(scan);
      for (const part of parts) params.push(`%${part}%`, `%${part}%`);
      params.push(Math.max(1, Math.floor(opts.limit)));
      const rows = this.all(
        `SELECT e.* FROM (
           SELECT * FROM experience
           WHERE superseded_by IS NULL AND hidden_at IS NULL ${scopeInner}
           ORDER BY ts_ms DESC, id DESC LIMIT ?
         ) e
         LEFT JOIN experience_cues c ON c.entry_id = e.id
         WHERE (${clauses})
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

  /** 按 id 单取（编辑预检/详情展开用）：含幽灵与藏行——调用方自己判状态。 */
  byId(id: string): ExperienceEntry | null {
    if (id === '') return null;
    if (this.deps.db === null) return this.mirror.find((e) => e.id === id) ?? null;
    try {
      const rows = this.all(`SELECT * FROM experience WHERE id = ?`, [id]);
      return rows[0] === undefined ? null : toEntry(rows[0]);
    } catch {
      return null;
    }
  }

  /**
   * 归档取会话全量行（做梦/备份腿）：**含幽灵与藏行**——备份是备份，投影筛选不许渗进来。
   * 上界 500 条/会话（与 journal-export 同口径）；镜像路即本会话全部。
   */
  allForSession(sessionId: string): ExperienceEntry[] {
    if (this.deps.db === null) {
      return this.mirror.filter((e) => e.sessionId === sessionId).slice(0, 500);
    }
    try {
      return this.all(`SELECT * FROM experience WHERE session_id = ? ORDER BY ts_ms ASC, id ASC LIMIT ?`, [sessionId, 500]).map(toEntry);
    } catch {
      return [];
    }
  }

  /**
   * 做梦的查重扫描（v5）：同会话同 trigger 同正文的等值重复组（未藏未取代）。
   * 每组按时间倒序（首条=保留者）；组数上界 50、单次扫描窗 LOCAL_SCAN_LIMIT——
   * 判据故意保守（等值而非近重复）：宁漏不误合并，语义判重留后。db=null ⇒ 空（降级不做梦）。
   */
  dreamDuplicateGroups(): ExperienceEntry[][] {
    const db = this.deps.db;
    if (db === null) return [];
    try {
      // 分组键行不是完整条目，不能走 `this.all()`（它的 REQUIRED_COLUMNS 闸会把缺列行全丢）；
      // 直查 prepare 取 (session_id, trigger, text) 三元组，取行在下面逐组做。
      const keys = db
        .prepare(
          `SELECT session_id, trigger, text FROM experience
           WHERE superseded_by IS NULL AND hidden_at IS NULL
           GROUP BY session_id, trigger, text HAVING COUNT(*) > 1
           ORDER BY MAX(ts_ms) DESC LIMIT 50`,
        )
        .all() as Array<{ session_id?: SQLOutputValue; trigger?: SQLOutputValue; text?: SQLOutputValue }>;
      const groups: ExperienceEntry[][] = [];
      for (const key of keys) {
        if (typeof key.session_id !== 'string' || typeof key.trigger !== 'string' || typeof key.text !== 'string') continue;
        const rows = this.all(
          `SELECT * FROM experience
           WHERE session_id = ? AND trigger = ? AND text = ? AND superseded_by IS NULL AND hidden_at IS NULL
           ORDER BY ts_ms DESC, id DESC`,
          [key.session_id, key.trigger, key.text],
        );
        if (rows.length > 1) groups.push(rows.map(toEntry));
      }
      return groups;
    } catch {
      return [];
    }
  }

  /**
   * 翻阅 tab 的管理查询（v5）：全库跨会话筛选 + 服务端分页，搜索与浏览回**同一投影**。
   *
   * 形状纪律（照 prime list-records 的成熟面，只取其适合本库规模的部分）：
   * - 不做全表 COUNT：`hasMore` 用 wanted=limit+1 多取一条探界；总数诚实表达为 null 口径由调用方定；
   * - 搜索路带扫描窗（`LIKE` 不走索引，LIMIT 只截输出不截扫描），窗吃满 ⇒ `truncated:true` 告知截断；
   * - 筛选条件全部是**固定子句**，参数走占位符；筛选维度都有索引（exp_trigger_ts/exp_lane_ts/exp_ts）；
   * - 缺省只看未藏未取代；`hiddenOnly` 切到「藏起来的」视图；`includeGhosts` 才带幽灵。
   */
  listAdmin(opts: {
    query?: string;
    trigger?: string;
    lane?: string;
    marked?: boolean;
    includeGhosts?: boolean;
    hiddenOnly?: boolean;
    sessionId?: string;
    offset: number;
    limit: number;
    scanLimit?: number;
  }): { rows: ExperienceEntry[]; hasMore: boolean; truncated: boolean } {
    const from = Math.max(0, Math.floor(opts.offset));
    const size = Math.max(1, Math.min(PAGE_MAX, Math.floor(opts.limit)));
    const wanted = size + 1;
    const q = opts.query?.trim().toLowerCase();
    const hasQuery = q !== undefined && q !== '';

    // 镜像过滤（db=null 降级面）：条件与 SQL 路逐条对齐，不拿降级当第二套语义
    const mirrorMatch = (e: ExperienceEntry): boolean => {
      if (opts.hiddenOnly === true ? e.hiddenAt === undefined : e.hiddenAt !== undefined) return false;
      if (opts.includeGhosts !== true && e.supersededBy !== undefined) return false;
      if (opts.sessionId !== undefined && e.sessionId !== opts.sessionId) return false;
      if (opts.trigger !== undefined && opts.trigger !== '' && e.trigger !== opts.trigger) return false;
      if (opts.lane !== undefined && opts.lane !== '' && e.lane !== opts.lane) return false;
      if (opts.marked === true && !(typeof e.feedbackScore === 'number' && e.feedbackScore >= 0)) return false;
      if (hasQuery && q !== undefined) {
        const hay = `${e.text} ${e.gist ?? ''}`.toLowerCase();
        if (!q.split(/\s+/u).filter((p) => p.length >= 2).some((p) => hay.includes(p))) return false;
      }
      return true;
    };
    if (this.deps.db === null) {
      const pool = this.mirror.filter(mirrorMatch).slice().reverse(); // 倒序：新在前
      return { rows: pool.slice(from, from + size), hasMore: from + size < pool.length, truncated: false };
    }

    try {
      // 固定子句拼装（参数一律占位符）：搜索路下进子查询，保证「筛完还有得排」
      const conditions: string[] = [];
      const params: Array<string | number> = [];
      conditions.push(opts.hiddenOnly === true ? 'hidden_at IS NOT NULL' : 'hidden_at IS NULL');
      if (opts.includeGhosts !== true) conditions.push('superseded_by IS NULL');
      if (opts.sessionId !== undefined) {
        conditions.push('session_id = ?');
        params.push(opts.sessionId);
      }
      if (opts.trigger !== undefined && opts.trigger !== '') {
        conditions.push('trigger = ?');
        params.push(opts.trigger);
      }
      if (opts.lane !== undefined && opts.lane !== '') {
        conditions.push('lane = ?');
        params.push(opts.lane);
      }
      if (opts.marked === true) conditions.push('feedback_score >= 0');
      const where = conditions.join(' AND ');

      if (!hasQuery) {
        const rows = this.all(
          `SELECT * FROM experience WHERE ${where} ORDER BY ts_ms DESC, id DESC LIMIT ? OFFSET ?`,
          [...params, wanted, from],
        );
        return { rows: rows.slice(0, size).map(toEntry), hasMore: rows.length > size, truncated: false };
      }

      // 搜索路：候选池（带结构化筛选）→ cues/正文匹配 → 同一投影回
      const scan = Math.max(1, Math.floor(opts.scanLimit ?? LOCAL_SCAN_LIMIT));
      const parts = q!.split(/\s+/u).filter((p) => p.length >= 2);
      if (parts.length === 0) {
        const rows = this.all(
          `SELECT * FROM experience WHERE ${where} ORDER BY ts_ms DESC, id DESC LIMIT ? OFFSET ?`,
          [...params, wanted, from],
        );
        return { rows: rows.slice(0, size).map(toEntry), hasMore: rows.length > size, truncated: false };
      }
      const clauses = parts.map(() => `(c.cue LIKE ? OR e.text LIKE ?)`).join(' OR ');
      const innerParams: Array<string | number> = [...params, scan];
      const searchParams: Array<string | number> = [];
      for (const part of parts) searchParams.push(`%${part}%`, `%${part}%`);
      const rows = this.all(
        `SELECT e.* FROM (
           SELECT * FROM experience
           WHERE ${where}
           ORDER BY ts_ms DESC, id DESC LIMIT ?
         ) e
         LEFT JOIN experience_cues c ON c.entry_id = e.id
         WHERE (${clauses})
         GROUP BY e.id
         ORDER BY MAX(e.ts_ms) DESC
         LIMIT ? OFFSET ?`,
        [...innerParams, ...searchParams, wanted, from],
      );
      // 截断告知：候选池被扫描窗吃满 ⇒ 更早的经历可能没被勾起（诚实面，不外漏 scanLimit）
      const poolN = this.countOf(`SELECT COUNT(*) AS n FROM (SELECT id FROM experience WHERE ${where} ORDER BY ts_ms DESC LIMIT ?)`, [...params, scan]);
      return { rows: rows.slice(0, size).map(toEntry), hasMore: rows.length > size, truncated: poolN >= scan };
    } catch (err) {
      this.deps.logger.warn(`[spirit] 管理查询失败：${err instanceof Error ? err.message : String(err)}`);
      return { rows: [], hasMore: false, truncated: false };
    }
  }
}
