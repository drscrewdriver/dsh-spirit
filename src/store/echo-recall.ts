/**
 * 回响落档（v10）：`echo_step` + `echo_recall` 的读写层。
 *
 * 为什么要库：侧栏「回响」要回答的是「**本会话**被 spirit 召回过的段落」，重启不能归零；
 * 而进程内 `EchoLog` 天生是观测灯（重启归零不算丢数据）。两者语义不同，故并存不互相冒充：
 * - `EchoLog` → 星海「翻阅 → 回响」的实时快照（RPC `inject-echo`）；
 * - `echo_step` / `echo_recall` → 侧栏的持久面（服务端投影 `spiritEcho`）。
 *
 * 四条纪律：
 * 1. **写面只增不改**：`echo_step` 一轮一行（主键 `session_id + ts_ms`），`echo_recall`
 *    同一句只留一行、`times` 累加——重复召回不制造噪音，也不篡改首次时间。
 * 2. **不落全文卡**：`echo_step` 只存分段计数（`segments_json`，标签 + 行数），
 *    `echo_recall` 只存被召回的那一句（截断）。注入卡正文仍只在 `EchoLog` 里过一遍。
 * 3. **库不可用 ⇒ 整段休眠**：降级期间写入丢弃、读取返回空摘要，不抛穿 `agent/pre-step`
 *    （那条路串行，一次异常就是用户等不到回话）。
 * 4. **读侧有顶**：`ECHO_RECALL_MAX` 兜底，模型输入面永不因这张表变宽。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { MinimalLogger } from '../persona/store.js';

/** 一次读的条数上限（与其它 store 的 PAGE_MAX 同口径）。 */
export const ECHO_RECALL_MAX = 200;
/** 单句召回截断：侧栏只显示一行，不需要整段。 */
export const ECHO_EXCERPT_MAX = 240;

export interface EchoRecallSegment {
  /** 被召回的那一句（已截断）。 */
  excerpt: string;
  firstTs: number;
  lastTs: number;
  /** 被召回次数（同一会话内累加）。 */
  times: number;
}

export interface EchoStepRow {
  /** 展示/查询用的编号：`echo-<ts_ms>`（旧行由迁移按 ts 回填）。 */
  id: string;
  at: number;
  kind: 'injected' | 'skipped';
  reason: string;
  fingerprint: string;
  /** 卡首 200 字压平（侧栏一行摘要）；跳过行为空串。 */
  preview: string;
  /** 内容优先的标题（v14：如线程任务名）；老行为空串，读侧退到 preview。 */
  title: string;
  /** 这条回响指向的真源（memid）：把回响挂回具体记忆条目；老行为空数组。 */
  refs: EchoStepRef[];
  /** 是否勾起旧事（v16）：命中记录最早时间 > 7d ⇒ true。 */
  flashback: boolean;
}

/** 回响指向的真源引用（memid）：kind 定表，id 定行，label 是给人看的一句。 */
export interface EchoStepRef {
  kind: string;
  id: string;
  label: string;
}

export interface EchoRecallSummary {
  /** 判脏令牌：库派生（步骤数 × 1e6 + 召回次数和），重启后仍单调。 */
  token: number;
  total: number;
  segments: EchoRecallSegment[];
  /** 最近几轮回响条目（新→旧，含跳过），侧栏列表的真源。 */
  steps: EchoStepRow[];
  lastStep?: EchoStepRow;
}

/** 落档行的完整形状（回响页重启后回退读用：带分段计数与卡全文）。 */
export interface EchoStepFull extends EchoStepRow {
  sessionId: string;
  /** 分段行数（与进程内 EchoLog 同形）；旧行 segments_json 缺/坏 ⇒ []。 */
  segments: Array<{ name: string; lines: number }>;
  /** 注入卡全文（跳进行为空串）。 */
  text: string;
}

/** 分层检索结果：命中层级回给调用方（不跳级也不假装命中）。 */
export interface EchoSearchResult {
  rows: EchoStepFull[];
  /** time=只按时间段；keyword=关键词命中；none=两层都没命中。 */
  tier: 'time' | 'keyword' | 'none';
  /** 参检总条数（同一过滤条件下的计数，不受 limit 影）。 */
  scanned: number;
}

type StepKind = 'injected' | 'skipped';

function clampText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** refs_json 宽容解析：坏 JSON / 坏行 ⇒ 丢弃该条，不连坐整行（老行为空数组）。 */
function parseRefs(raw: unknown): EchoStepRef[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({ kind: String(item['kind'] ?? ''), id: String(item['id'] ?? ''), label: String(item['label'] ?? '') }))
      .filter((item) => item.kind !== '' && item.id !== '');
  } catch {
    return [];
  }
}

export class EchoRecallStore {
  private readonly db: () => DatabaseSync | undefined;
  private readonly logger: MinimalLogger | undefined;

  /**
   * @param deps - `db` 是惰性取库（降级期返回 undefined）；`logger` 只用于 `warn`。
   */
  constructor(deps: { db: () => DatabaseSync | undefined; logger?: MinimalLogger }) {
    this.db = deps.db;
    this.logger = deps.logger;
  }

  /** 取库；不可用时 undefined（所有公开方法据此休眠，不抛）。 */
  private handle(): DatabaseSync | undefined {
    try {
      return this.db();
    } catch {
      return undefined;
    }
  }

  /**
   * 记录一轮注入结果（含本轮被召回的段落）。
   *
   * 写两次：`echo_step` 一行（决策面）+ `echo_recall` 逐句 upsert（展示面）。
   * 任何异常只 warn，绝不让 pre-step 失败。
   */
  record(input: {
    sessionId: string;
    agentId: string;
    at: number;
    kind: StepKind;
    reason?: string;
    fingerprint?: string;
    segments?: ReadonlyArray<{ name: string; lines: number }>;
    excerpts?: readonly string[];
    /** 卡首 200 字压平（侧栏列表用）；不存整张卡。 */
    preview?: string;
    /** 当时注入的卡全文（查看原文用）；旧行/跳过行为空串。 */
    text?: string;
    /** 条目编号（缺省 = `echo-<at>`）；落档前即指定可让消费方提前拿到。 */
    id?: string;
    /** 内容优先的标题（v14：线程任务名、交付句等）；侧栏直接用这个当行文字。 */
    title?: string;
    /** 指向的真源（memid）：每条回响挂回具体记忆条目，供侧栏/星图定位。 */
    refs?: readonly EchoStepRef[];
    /** 勾起旧事标记（v16）：由调用方按“命中记录最早时间 > 7d”判定。 */
    flashback?: boolean;
    /**
     * 召回负样本（v19 / P0）：被挡在卡外的条目及原因（superseded/held/limit/…）。
     * 纯观测列，不进卡、不进指纹。
     */
    rejected?: ReadonlyArray<{ kind: string; id: string; reason: string }>;
  }): void {
    const sessionId = input.sessionId.trim();
    if (sessionId === '') return;
    const db = this.handle();
    if (db === undefined) return;
    try {
      db.prepare(
        `INSERT INTO echo_step (session_id, ts_ms, agent_id, kind, reason, fingerprint, segments_json, preview, id, text, title, refs_json, flashback, rejected_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, ts_ms) DO UPDATE SET
           kind = excluded.kind,
           reason = excluded.reason,
           fingerprint = excluded.fingerprint,
           segments_json = excluded.segments_json,
           preview = excluded.preview,
           id = excluded.id,
           text = excluded.text,
           title = excluded.title,
           refs_json = excluded.refs_json,
           flashback = excluded.flashback,
           rejected_json = excluded.rejected_json`,
      ).run(
        sessionId,
        Math.floor(input.at),
        input.agentId,
        input.kind,
        input.reason ?? '',
        input.fingerprint ?? '',
        JSON.stringify(input.segments ?? []),
        clampText(input.preview ?? '', 200),
        input.id ?? `recall-${Math.floor(input.at)}`,
        input.text ?? '',
        clampText(input.title ?? '', 120),
        JSON.stringify(input.refs ?? []),
        input.flashback === true ? 1 : 0,
        JSON.stringify((input.rejected ?? []).slice(0, 20)),
      );
      const upsert = db.prepare(
        `INSERT INTO echo_recall (session_id, excerpt, first_ts, last_ts, times, agent_id)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(session_id, excerpt) DO UPDATE SET
           last_ts = excluded.last_ts,
           times = echo_recall.times + 1`,
      );
      const seen = new Set<string>();
      for (const raw of input.excerpts ?? []) {
        const excerpt = clampText(String(raw), ECHO_EXCERPT_MAX);
        if (excerpt === '' || seen.has(excerpt)) continue;
        seen.add(excerpt);
        upsert.run(sessionId, excerpt, Math.floor(input.at), Math.floor(input.at), input.agentId);
      }
    } catch (err) {
      this.logger?.warn(`回响落档失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 读一个会话的回响摘要：被召回段落（新→旧≤limit）+ 总段数 + 最近一轮决策。
   *
   * @param sessionId - 会话 id；空串返回空摘要（不跨会话兜底，避免张冠李戴）。
   * @param limit - 返回条数，钳到 `[1, ECHO_RECALL_MAX]`。
   */
  summary(sessionId: string, limit = 20, stepLimit = 5): EchoRecallSummary {
    const empty: EchoRecallSummary = { token: 0, total: 0, segments: [], steps: [] };
    const sid = sessionId.trim();
    if (sid === '') return empty;
    const db = this.handle();
    if (db === undefined) return empty;
    const cap = Math.max(1, Math.min(ECHO_RECALL_MAX, Math.floor(Number.isFinite(limit) ? limit : 20)));
    try {
      const rows = db.prepare(
        `SELECT excerpt, first_ts, last_ts, times FROM echo_recall
         WHERE session_id = ?
         ORDER BY last_ts DESC, excerpt ASC
         LIMIT ?`,
      ).all(sid, cap) as Array<{ excerpt?: string; first_ts?: number; last_ts?: number; times?: number }>;
      const segments: EchoRecallSegment[] = rows.map((row) => ({
        excerpt: String(row.excerpt ?? ''),
        firstTs: Number(row.first_ts ?? 0),
        lastTs: Number(row.last_ts ?? 0),
        times: Number(row.times ?? 1),
      }));
      const totals = db.prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(times), 0) AS times FROM echo_recall WHERE session_id = ?`,
      ).get(sid) as { n?: number; times?: number } | undefined;
      const stepRows = db.prepare(
        `SELECT id, ts_ms, kind, reason, fingerprint, preview, title, flashback FROM echo_step
         WHERE session_id = ? ORDER BY ts_ms DESC LIMIT ?`,
      ).all(sid, Math.max(1, Math.min(20, Math.floor(stepLimit)))) as Array<{
        id?: string; ts_ms?: number; kind?: string; reason?: string; fingerprint?: string; preview?: string; title?: string; flashback?: number;
      }>;
      const steps: EchoStepRow[] = stepRows.map((row) => ({
        id: String(row.id ?? '') || `recall-${Number(row.ts_ms ?? 0)}`,
        at: Number(row.ts_ms ?? 0),
        kind: (row.kind === 'skipped' ? 'skipped' : 'injected') as StepKind,
        reason: String(row.reason ?? ''),
        fingerprint: String(row.fingerprint ?? ''),
        preview: String(row.preview ?? ''),
        title: String(row.title ?? ''),
        refs: [],
        flashback: Number(row.flashback ?? 0) === 1,
      }));
      const stepTotals = db.prepare(
        `SELECT COUNT(*) AS n FROM echo_step WHERE session_id = ?`,
      ).get(sid) as { n?: number } | undefined;
      const timesSum = Number(totals?.times ?? 0);
      const stepCount = Number(stepTotals?.n ?? 0);
      return {
        token: stepCount * 1_000_000 + timesSum,
        total: Number(totals?.n ?? 0),
        segments,
        steps,
        ...(steps[0] === undefined ? {} : { lastStep: steps[0] }),
      };
    } catch (err) {
      this.logger?.warn(`回响摘要读取失败（按空处理）：${err instanceof Error ? err.message : String(err)}`);
      return empty;
    }
  }

  /**
   * 最近几轮回响（新→旧）：**进程内缓冲重启归零后的回退读面**。
   *
   * sessionId 空 ⇒ 跨会话全局最近（星海「回响」页不带会话时用）；非空 ⇒ 只取本会话。
   * 与 summary 的区别：这里带 `segments` 与 `text`（回响页要展示分段与全文），
   * 且允许跨会话（全局翻阅场景）——summary 不跨会话是防张冠李戴，这里展示面另有会话标记。
   */
  recent(opts: { sessionId?: string; limit?: number } = {}): EchoStepFull[] {
    const db = this.handle();
    if (db === undefined) return [];
    const sid = (opts.sessionId ?? '').trim();
    const cap = Math.max(1, Math.min(ECHO_RECALL_MAX, Math.floor(Number.isFinite(opts.limit) ? (opts.limit as number) : 20)));
    try {
      const rows = (sid === ''
        ? db.prepare(
          `SELECT session_id, id, ts_ms, kind, reason, fingerprint, segments_json, preview, text, title, refs_json, flashback FROM echo_step
           ORDER BY ts_ms DESC LIMIT ?`,
        ).all(cap)
        : db.prepare(
          `SELECT session_id, id, ts_ms, kind, reason, fingerprint, segments_json, preview, text, title, refs_json, flashback FROM echo_step
           WHERE session_id = ? ORDER BY ts_ms DESC LIMIT ?`,
        ).all(sid, cap)) as Array<Record<string, unknown>>;
      return rows.map((row) => this.mapStepRow(row));
    } catch (err) {
      this.logger?.warn(`回响落档读取失败（按空处理）：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 分层检索（v0.8.6）：时间段 → 关键词（→ 语义向量，本层未接嵌入，调用方如实回 unavailable）。
   *
   * 不跳级也不假装命中：时间段最便宜也最准（回响问的就是“这段时间注入了什么”）；
   * 关键词是第二刀（LIKE 字面量，用户输入的 % _ 不当通配符）；两层都没命中就回 none。
   */
  search(opts: { sessionId?: string; sinceMs?: number; untilMs?: number; q?: string; limit?: number } = {}): EchoSearchResult {
    const db = this.handle();
    if (db === undefined) return { rows: [], tier: 'none', scanned: 0 };
    const sid = (opts.sessionId ?? '').trim();
    const keyword = (opts.q ?? '').trim();
    const cap = Math.max(1, Math.min(ECHO_RECALL_MAX, Math.floor(Number.isFinite(opts.limit) ? (opts.limit as number) : 20)));
    const conds: string[] = [];
    const params: unknown[] = [];
    if (sid !== '') {
      conds.push('session_id = ?');
      params.push(sid);
    }
    if (Number.isFinite(opts.sinceMs)) {
      conds.push('ts_ms >= ?');
      params.push(Math.floor(opts.sinceMs as number));
    }
    if (Number.isFinite(opts.untilMs)) {
      conds.push('ts_ms <= ?');
      params.push(Math.floor(opts.untilMs as number));
    }
    if (keyword !== '') {
      const like = `%${keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      conds.push(`(preview LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')`);
      params.push(like, like);
    }
    const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
    try {
      const rows = db.prepare(
        `SELECT session_id, id, ts_ms, kind, reason, fingerprint, segments_json, preview, text, title, refs_json, flashback FROM echo_step${where}
         ORDER BY ts_ms DESC LIMIT ?`,
      ).all(...([...params, cap] as never[])) as Array<Record<string, unknown>>;
      const counted = db.prepare(`SELECT COUNT(*) AS n FROM echo_step${where}`).get(...(params as never[])) as { n?: number } | undefined;
      const mapped = rows.map((row) => this.mapStepRow(row));
      const tier: EchoSearchResult['tier'] = mapped.length === 0 ? 'none' : keyword !== '' ? 'keyword' : 'time';
      return { rows: mapped, tier, scanned: Number(counted?.n ?? 0) };
    } catch (err) {
      this.logger?.warn(`回响检索失败（按空处理）：${err instanceof Error ? err.message : String(err)}`);
      return { rows: [], tier: 'none', scanned: 0 };
    }
  }

  /** 行 → 完整形状（recent/search 共用，不开第二套解析口径）。 */
  private mapStepRow(row: Record<string, unknown>): EchoStepFull {
    let segments: EchoStepFull['segments'] = [];
    try {
      const parsed: unknown = JSON.parse(String(row['segments_json'] ?? '[]'));
      if (Array.isArray(parsed)) {
        segments = parsed
          .filter((item): item is { name: string; lines: number } => typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string')
          .map((item) => ({ name: item.name, lines: Number((item as { lines?: unknown }).lines) || 0 }));
      }
    } catch {
      /* 坏 JSON ⇒ 无分段，不连坐整行 */
    }
    return {
      sessionId: String(row['session_id'] ?? ''),
      id: String(row['id'] ?? '') || `echo-${Number(row['ts_ms'] ?? 0)}`,
      at: Number(row['ts_ms'] ?? 0),
      kind: (row['kind'] === 'skipped' ? 'skipped' : 'injected') as StepKind,
      reason: String(row['reason'] ?? ''),
      fingerprint: String(row['fingerprint'] ?? ''),
      preview: String(row['preview'] ?? ''),
      segments,
      text: String(row['text'] ?? ''),
      title: String(row['title'] ?? ''),
      refs: parseRefs(row['refs_json']),
      flashback: Number(row['flashback'] ?? 0) === 1,
    };
  }

  /** 落档行总数（sessionId 空 = 全库）。 */
  count(sessionId = ''): number {
    const db = this.handle();
    if (db === undefined) return 0;
    const sid = sessionId.trim();
    try {
      const row = (sid === ''
        ? db.prepare(`SELECT COUNT(*) AS n FROM echo_step`).get()
        : db.prepare(`SELECT COUNT(*) AS n FROM echo_step WHERE session_id = ?`).get(sid)) as { n?: number } | undefined;
      return Number(row?.n ?? 0);
    } catch {
      return 0;
    }
  }

  /**
   * 取一条回响的详情（含当时注入的卡全文）。
   *
   * 按 `(session_id, id)` 精确定位，不跨会话兜底：编号在不同会话里可能撞车，
   * 拿另一会话的原文当成这条会把“看原文”变成张冠李戴。
   *
   * @param sessionId - 会话 id。
   * @param id - 列表里显示的 `echo-<ts>`。
   */
  detail(sessionId: string, id: string): (EchoStepRow & { text: string }) | undefined {
    const sid = sessionId.trim();
    const handle = id.trim();
    if (sid === '' || handle === '') return undefined;
    const db = this.handle();
    if (db === undefined) return undefined;
    try {
      const row = db.prepare(
        `SELECT id, ts_ms, kind, reason, fingerprint, preview, text, title, refs_json, flashback FROM echo_step
         WHERE session_id = ? AND id = ? LIMIT 1`,
      ).get(sid, handle) as {
        id?: string; ts_ms?: number; kind?: string; reason?: string; fingerprint?: string; preview?: string; text?: string; title?: string; refs_json?: string; flashback?: number;
      } | undefined;
      if (row === undefined) return undefined;
      return {
        id: String(row.id ?? handle),
        at: Number(row.ts_ms ?? 0),
        kind: (row.kind === 'skipped' ? 'skipped' : 'injected') as StepKind,
        reason: String(row.reason ?? ''),
        fingerprint: String(row.fingerprint ?? ''),
        preview: String(row.preview ?? ''),
        text: String(row.text ?? ''),
        title: String(row.title ?? ''),
        refs: parseRefs(row.refs_json),
        flashback: Number(row.flashback ?? 0) === 1,
      };
    } catch (err) {
      this.logger?.warn(`回响详情读取失败（按未找到处理）：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * 列出「缺原文或缺摘要」的条目（回填用）：只取 `sinceMs` 之后的行。
   *
   * 两个缺口分开看：
   * - v11 落档只有摘要、v12 才开始存原文 ⇒ `text=''`；
   * - 更早的 v10 行连摘要都没存 ⇒ `preview=''`；但侧栏列表只列「有摘要的注入行」，
   *   所以这类行即使后来补到原文也不会出现——回填时两个字段一起补。
   *
   * @param sinceMs - 只看这个时间点之后的条目（调用方按时效给窗口，避免扫全库）。
   * @param limit - 单次上限。
   */
  pendingText(sinceMs: number, limit = 500): Array<{ sessionId: string; id: string; at: number; preview: string; hasText: boolean }> {
    const db = this.handle();
    if (db === undefined) return [];
    try {
      const rows = db.prepare(
        `SELECT session_id, id, ts_ms, preview, text FROM echo_step
         WHERE kind = 'injected' AND ts_ms >= ? AND (text = '' OR preview = '')
         ORDER BY ts_ms DESC LIMIT ?`,
      ).all(Math.floor(sinceMs), Math.max(1, Math.min(2000, Math.floor(limit)))) as Array<{
        session_id?: string; id?: string; ts_ms?: number; preview?: string; text?: string;
      }>;
      return rows.map((row) => ({
        sessionId: String(row.session_id ?? ''),
        id: String(row.id ?? `echo-${Number(row.ts_ms ?? 0)}`),
        at: Number(row.ts_ms ?? 0),
        preview: String(row.preview ?? ''),
        hasText: String(row.text ?? '') !== '',
      }));
    } catch (err) {
      this.logger?.warn(`回响待回填列表读取失败（按空处理）：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** 只补摘要（原文已经在库、但 v10 时代没存 preview 的行）。 */
  setPreview(sessionId: string, id: string, preview: string): boolean {
    const sid = sessionId.trim();
    if (sid === '' || id.trim() === '' || preview === '') return false;
    const db = this.handle();
    if (db === undefined) return false;
    try {
      const result = db.prepare(
        `UPDATE echo_step SET preview = ? WHERE session_id = ? AND id = ? AND preview = ''`,
      ).run(preview, sid, id.trim());
      return Number((result as { changes?: number }).changes ?? 0) > 0;
    } catch (err) {
      this.logger?.warn(`回响摘要回填失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * 回填一条条目的原文（只补空值，不覆盖已有原文）。
   *
   * `preview` 也给：v10 行连摘要都没存（preview=''），侧栏列表会把它当「无摘要」
   * 筛掉——原文都到手了，摘要顺手补上，那条旧回响才能重新出现在列表里。
   */
  setText(sessionId: string, id: string, text: string, preview = ''): boolean {
    const sid = sessionId.trim();
    if (sid === '' || id.trim() === '' || text === '') return false;
    const db = this.handle();
    if (db === undefined) return false;
    try {
      const result = db.prepare(
        `UPDATE echo_step
            SET text = ?,
                preview = CASE WHEN preview = '' THEN ? ELSE preview END
          WHERE session_id = ? AND id = ? AND text = ''`,
      ).run(text, preview, sid, id.trim());
      return Number((result as { changes?: number }).changes ?? 0) > 0;
    } catch (err) {
      this.logger?.warn(`回响原文回填失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** 清空一个会话的回响档（清空会话时由调用方触发；失败只 warn）。 */
  clearSession(sessionId: string): void {
    const sid = sessionId.trim();
    if (sid === '') return;
    const db = this.handle();
    if (db === undefined) return;
    try {
      db.prepare(`DELETE FROM echo_recall WHERE session_id = ?`).run(sid);
      db.prepare(`DELETE FROM echo_step WHERE session_id = ?`).run(sid);
    } catch (err) {
      this.logger?.warn(`回响档清理失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
