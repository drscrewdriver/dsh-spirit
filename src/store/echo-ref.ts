/**
 * 回响记录聚合（v0.8.11 / schema v16）：**一行 = 一条被想起的记录（progress/done 卡片本身）**。
 *
 * 编号口径（与 `src/echo/identity.ts` 分工）：
 * - `echo-<uuid>` = **记录的号**，由 echo_identity 注册表保证一记录一号；本模块只**存**与**读**，不发号；
 * - `recall-<uuid>` = **回响事件的号**（一轮注入一个），存在 `last_echo_step_id` 列里（wire 名 `lastRecallId`）；
 * - `times/first_ts/last_ts` = 被想起的次数与首末，跨轮合并。
 *
 * 边界：
 * 1. 只收**记忆类且有真源**的条目（状态/开场这种语气行不进这张表）；
 * 2. 降级面（db 不可用）写 false、读空，不抛穿；
 * 3. 排序口径可选：`recall`（默认，按最近想起）/ `record`（按记录自身时间，翻阅面用）。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { MinimalLogger } from '../persona/store.js';

/** 一次读的上限。 */
export const ECHO_REF_MAX = 200;

/** 一条记录的聚合行（读面/投影/侧栏共用）。 */
export interface EchoRefRow {
  /** 记录的号：`echo-<uuid>`。 */
  echoId: string;
  sessionId: string;
  kind: string;
  /** 真源主键（task/experience/txn/memory/goal 的 id）。 */
  memId: string;
  title: string;
  /** 被想起次数。 */
  times: number;
  /** 记录自身时间（星图/翻阅展示"记录时间"用）。 */
  recordTs: number;
  /** 首次被想起。 */
  firstTs: number;
  /** 最近被想起。 */
  lastTs: number;
  /** 最近一次召回的事件号：`recall-<uuid>`（供 echo-detail 取注入卡）。 */
  lastRecallId: string;
}

/** 语气/状态行（特殊格式，不属于记录）。 */
export interface EchoToneRow {
  at: number;
  state?: string;
  opening?: string;
}

function clampLimit(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 20;
  return Math.min(Math.max(1, n), ECHO_REF_MAX);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toRow(raw: Record<string, unknown>): EchoRefRow {
  return {
    echoId: asText(raw['ref_id']),
    sessionId: asText(raw['session_id']),
    kind: asText(raw['kind']),
    memId: asText(raw['mem_id']),
    title: asText(raw['title']),
    times: Number(raw['times']) || 1,
    recordTs: Number(raw['record_ts']) || Number(raw['first_ts']) || 0,
    firstTs: Number(raw['first_ts']) || 0,
    lastTs: Number(raw['last_ts']) || 0,
    lastRecallId: asText(raw['last_echo_step_id']),
  };
}

export class EchoRefStore {
  constructor(private readonly deps: { db: () => DatabaseSync | undefined; logger?: MinimalLogger }) {}

  private handle(): DatabaseSync | undefined {
    try {
      return this.deps.db();
    } catch {
      return undefined;
    }
  }

  /**
   * 记一条记录被想起（幂等合并）。
   * @param input.echoId - 记录的号（由 identity 层领；空串拒写，不编造）
   * @param input.at - 本轮注入时刻
   * @param input.recordTs - 记录自身时间（条目真源时间；缺省退 at）
   * @param input.lastRecallId - 本轮回响事件号 `recall-<uuid>`
   */
  upsert(input: {
    sessionId: string;
    echoId: string;
    kind: string;
    memId: string;
    title?: string;
    at: number;
    recordTs?: number;
    lastRecallId?: string;
  }): boolean {
    const sessionId = input.sessionId.trim();
    const echoId = input.echoId.trim();
    const kind = input.kind.trim();
    const memId = input.memId.trim();
    if (sessionId === '' || echoId === '' || kind === '' || memId === '') return false;
    const db = this.handle();
    if (db === undefined) return false;
    const at = Math.floor(input.at);
    if (!Number.isFinite(at)) return false;
    const recordTs = Math.floor(input.recordTs ?? at) || at;
    try {
      db.prepare(
        `INSERT INTO echo_ref (session_id, ref_id, kind, mem_id, title, times, first_ts, last_ts, last_echo_step_id, record_ts)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(session_id, ref_id) DO UPDATE SET
           times = echo_ref.times + 1,
           first_ts = MIN(echo_ref.first_ts, excluded.first_ts),
           last_ts = MAX(echo_ref.last_ts, excluded.last_ts),
           title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE echo_ref.title END,
           last_echo_step_id = excluded.last_echo_step_id,
           record_ts = CASE WHEN echo_ref.record_ts > 0 THEN echo_ref.record_ts ELSE excluded.record_ts END`,
      ).run(
        sessionId,
        echoId,
        kind,
        memId,
        (input.title ?? '').trim().slice(0, 120),
        at,
        at,
        (input.lastRecallId ?? '').trim(),
        recordTs,
      );
      return true;
    } catch (err) {
      this.deps.logger?.warn(`回响记录写入失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** 记录列表（sessionId 空 = 跨会话；q 匹配 title/mem_id；时间窗默认按最近想起）。 */
  list(opts: {
    sessionId?: string;
    kind?: string;
    q?: string;
    sinceMs?: number;
    untilMs?: number;
    limit?: number;
    order?: 'recall' | 'record';
  } = {}): { rows: EchoRefRow[]; total: number } {
    const db = this.handle();
    if (db === undefined) return { rows: [], total: 0 };
    const conds: string[] = [];
    const params: unknown[] = [];
    const sid = (opts.sessionId ?? '').trim();
    if (sid !== '') {
      conds.push('session_id = ?');
      params.push(sid);
    }
    const kind = (opts.kind ?? '').trim();
    if (kind !== '') {
      conds.push('kind = ?');
      params.push(kind);
    }
    const keyword = (opts.q ?? '').trim();
    if (keyword !== '') {
      const like = `%${escapeLike(keyword)}%`;
      conds.push(`(title LIKE ? ESCAPE '\\' OR mem_id LIKE ? ESCAPE '\\')`);
      params.push(like, like);
    }
    if (Number.isFinite(opts.sinceMs)) {
      conds.push('last_ts >= ?');
      params.push(Math.floor(opts.sinceMs as number));
    }
    if (Number.isFinite(opts.untilMs)) {
      conds.push('last_ts <= ?');
      params.push(Math.floor(opts.untilMs as number));
    }
    const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
    const orderBy = opts.order === 'record' ? 'record_ts DESC, last_ts DESC' : 'last_ts DESC';
    try {
      const rows = db.prepare(
        `SELECT session_id, ref_id, kind, mem_id, title, times, first_ts, last_ts, last_echo_step_id, record_ts
         FROM echo_ref${where} ORDER BY ${orderBy} LIMIT ?`,
      ).all(...([...params, clampLimit(opts.limit)] as never[])) as Array<Record<string, unknown>>;
      const counted = db.prepare(`SELECT COUNT(*) AS n FROM echo_ref${where}`).get(...(params as never[])) as { n?: number } | undefined;
      return { rows: rows.map(toRow), total: Number(counted?.n ?? 0) };
    } catch (err) {
      this.deps.logger?.warn(`回响记录读取失败：${err instanceof Error ? err.message : String(err)}`);
      return { rows: [], total: 0 };
    }
  }

  /**
   * 语气/状态（特殊格式，非记录）：最近一条含 `状态：`/`开场：` 的注入轮。
   * sessionId 空 = 跨会话最近一条（星海回响页是全局视角）。
   */
  toneOf(sessionId: string): EchoToneRow | undefined {
    const sid = sessionId.trim();
    const db = this.handle();
    if (db === undefined) return undefined;
    try {
      const rows = (sid === ''
        ? db.prepare(
          `SELECT ts_ms, text FROM echo_step
           WHERE kind = 'injected' AND text <> ''
           ORDER BY ts_ms DESC LIMIT 5`,
        ).all()
        : db.prepare(
          `SELECT ts_ms, text FROM echo_step
           WHERE session_id = ? AND kind = 'injected' AND text <> ''
           ORDER BY ts_ms DESC LIMIT 5`,
        ).all(sid)) as Array<{ ts_ms?: number; text?: string }>;
      for (const row of rows) {
        const text = asText(row.text);
        const lines = text.split('\n').map((line) => line.trim());
        const state = lines.find((line) => line.startsWith('状态：'));
        const opening = lines.find((line) => line.startsWith('开场：'));
        if (state === undefined && opening === undefined) continue;
        return {
          at: Number(row.ts_ms) || 0,
          ...(state === undefined ? {} : { state: state.slice('状态：'.length) }),
          ...(opening === undefined ? {} : { opening: opening.slice('开场：'.length) }),
        };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}
