/**
 * 事务轨读写层（v7 / T2.4）：`txn_entry` + `txn_cues`。
 *
 * 表定性沿用 `db/schema.ts` 头注（工作记忆真源域），这里只写"这一层怎么守"：
 *
 * 四条纪律：
 * 1. **写面只有 INSERT + 一个 supersede 列的 UPDATE**。除 `markSuperseded` 置 `superseded_by`（更正=插新行+旧行置标记）外，
 *    没有任何 UPDATE/DELETE：真源域的更正靠插新行，原地覆写内容会把"发生了什么"改成"此刻认为它是什么"。
 *    （gates 的 UPDATE 列白名单只放行 `superseded_by`，其余列被改即红。）
 * 2. **不造身份**。`id` 由调用方（collector）给——来源标记说"从哪来"，身份说"哪一条"；
 *    store 自己生成 id 等于把这两个可对账的东西都换了手。缺 id ⇒ 拒收，不猜。
 * 3. **库不可用 ⇒ 整段休眠，不攒内存镜像**。这与 experience 的 mirror 不同不是疏漏：
 *    事务条目是 LLM 衍生物或结构信号，内存镜像会给出"看起来落过库"的假信号，而本层
 *    没有回灌路径。降级期间读写全部返回空/0，不抛穿。
 * 4. **读侧有顶**：每个读方法都有 LIMIT，且 `resourceLookup` 用 cue **等值**（走
 *    txn_cue_value 索引）——LIKE 不走索引，成本与表行数成正比，而这张表只增不删。
 *
 * 口径缺口（交回人手，不在本批补）：`txn_entry` 没有 `superseded_by` 列 ⇒ 真源域的
 * "更正 = 插新行 + 旧行置标记"这条纪律在这张表落不成。要么加列（走迁移），要么更正
 * 语义改判。见 plan findings。
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { MinimalLogger } from '../persona/store.js';
import type { SourceTrust } from '../types.js';
import { SOURCE_TRUST_VALUES, TRUST_BACKFILL } from '../types.js';
import { baseName, CUE_LIMITS, normalizeCue } from '../experience/cues.js';
import { hitsInjection } from '../words.js';

/** cue 的 kind 是开放词表（只钳长度不白名单）；单源在此，别处不再抄第二份。 */
export const TXN_CUE_KINDS = ['file', 'person', 'tool', 'topic'] as const;
export type TxnCueKind = (typeof TXN_CUE_KINDS)[number];

/** 一次读不打算搬空整库（与 store/experience.ts 的 PAGE_MAX 同口径）。 */
export const TXN_READ_MAX = 200;

export interface TxnCueRef {
  txnId: string;
  cue: string;
  kind: TxnCueKind;
}

/** `semantic_json` 的形状（LLM 产物，坏了不连坐条目：丢细节留 card_line）。 */
export interface TxnSemantic {
  what?: string;
  who?: string;
  when?: string;
  next?: string;
  topics?: string[];
  entities?: string[];
}

export interface TxnEntry {
  id: string;
  sessionId: string;
  workspaceId: string;
  tsMs: number;
  turnSeq: number;
  /** 进注入卡的那一行（≤60 字）——唯一允许进注入面的字段。 */
  cardLine: string;
  /** LLM 衍生物：只进翻阅/详情/长觉原料，禁入 deriveMood 与指纹（G15 同族）。 */
  summary?: string;
  gistKey?: string;
  semantic?: TxnSemantic;
  sourceTrust: SourceTrust;
  topicId?: string;
  /** 检索键（读侧 join 补；写入侧同一份归一口径）。 */
  cues: TxnCueRef[];
  createdAt: number;
  /** salience 分层：1反馈/2轮次总结/3步骤/4被掩埋思考（v8 本体层，缺省 2）。 */
  salienceTier: number;
  turnStartMs?: number;
  turnEndMs?: number;
}

export interface TxnInsertInput {
  id: string;
  sessionId: string;
  workspaceId: string;
  tsMs: number;
  turnSeq: number;
  cardLine: string;
  summary?: string | null;
  gistKey?: string | null;
  semantic?: TxnSemantic | null;
  sourceTrust: SourceTrust;
  topicId?: string | null;
  cues?: readonly { cue: string; kind: TxnCueKind }[];
  /** v8 本体层：交付的 salience 档（缺省 2=轮次总结）与跨轮区间。 */
  salienceTier?: number;
  turnStartMs?: number | null;
  turnEndMs?: number | null;
}

/** 拒收原因（闸看形状不看内容；测试与 collector 都要能报出"为什么被拒"）。 */
export type TxnRejectReason =
  | '缺 id（身份由调用方给，store 不造身份）'
  | '缺 sessionId / workspaceId'
  | 'card_line 为空（宁缺毋造）'
  | 'card_line 命中黑名单'
  | 'summary 命中黑名单'
  | '来源标记不在单源三档'
  | '时间/序号不是可判定数值'
  | 'cue kind 不在单源词表'
  | '条目落库失败（降级面）';

export type TxnInsertResult = { ok: true; entry: TxnEntry } | { ok: false; reason: TxnRejectReason };

/** 反查命中：条目本体 + 被命中的那条 cue（kind 是这次反查的判据，不能只说"它是个 cue"）。 */
export interface TxnLookupHit {
  entry: TxnEntry;
  matchedCue: string;
  matchedKind: TxnCueKind;
}

const INSERT_SQL = `INSERT INTO txn_entry (
    id, session_id, workspace_id, ts_ms, turn_seq, card_line, summary, gist_key,
    semantic_json, source_trust, topic_id, created_at, salience_tier, turn_start_ms, turn_end_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_CUE_SQL = `INSERT INTO txn_cues (txn_id, cue, kind) VALUES (?, ?, ?)`;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asFinite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

/** 可选数值列：老行缺列即 undefined（灰度口径：缺列合法不报错）。 */
function optionalFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 可选文本列：老行缺列即 undefined（灰度口径：已有数据不回填，缺列合法不报错）。 */
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 读库里的 json 列：坏了不连坐条目（丢细节留 card_line，照 insight 的 fact_json 同法）。 */
function readJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseSemantic(raw: unknown): TxnSemantic | undefined {
  const pack = typeof raw === 'string' ? readJson(raw) : raw;
  if (typeof pack !== 'object' || pack === null) return undefined;
  const shape = pack as Record<string, unknown>;
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '').slice(0, 20) : undefined;
  const out: TxnSemantic = {};
  for (const key of ['what', 'who', 'when', 'next'] as const) {
    const value = shape[key];
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  const topics = strings(shape['topics']);
  if (topics !== undefined) out.topics = topics;
  const entities = strings(shape['entities']);
  if (entities !== undefined) out.entities = entities;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 列名 → TS 形状的单一映射点（别处不再抄列名）。 */
function toEntry(raw: Record<string, SQLOutputValue>, cues: TxnCueRef[]): TxnEntry {
  const entry: TxnEntry = {
    id: asText(raw['id']),
    sessionId: asText(raw['session_id']),
    workspaceId: asText(raw['workspace_id']),
    tsMs: asFinite(raw['ts_ms']),
    turnSeq: asFinite(raw['turn_seq']),
    cardLine: asText(raw['card_line']),
    sourceTrust: asText(raw['source_trust']) as SourceTrust,
    cues,
    createdAt: asFinite(raw['created_at']),
    salienceTier: 2,
  };
  const summary = optionalText(raw['summary']);
  if (summary !== undefined) entry.summary = summary;
  const gistKey = optionalText(raw['gist_key']);
  if (gistKey !== undefined) entry.gistKey = gistKey;
  const topicId = optionalText(raw['topic_id']);
  if (topicId !== undefined) entry.topicId = topicId;
  const semantic = parseSemantic(raw['semantic_json']);
  if (semantic !== undefined) entry.semantic = semantic;
  const tier = raw['salience_tier'];
  entry.salienceTier = typeof tier === 'number' && Number.isFinite(tier) ? tier : 2;
  const turnStart = optionalFinite(raw['turn_start_ms']);
  if (turnStart !== undefined) entry.turnStartMs = turnStart;
  const turnEnd = optionalFinite(raw['turn_end_ms']);
  if (turnEnd !== undefined) entry.turnEndMs = turnEnd;
  return entry;
}

export class TxnStore {
  constructor(private readonly deps: { db: () => DatabaseSync | null; logger: MinimalLogger }) {}

  /** 库是否可用（不可用时整段休眠——不攒镜像，见文件头纪律 3）。 */
  get persistent(): boolean {
    return this.deps.db() !== null;
  }

  // ───────────────────────────────────────────── 写

  /**
   * 落一条事务条目（条目行 + 它的 cues 在单事务里：分开写会坏在安静处——崩在中间得到
   * "有 cue 无条目"的孤儿行，反查能命中一个不存在的事务）。
   *
   * 两道闸在这里是重叠而不是重复：collector 侧的 `isSemanticAllowed` 是采集边界，
   * 这里的判据是**落库边界**。库错误不抛穿（一次记录失败不该变成一轮对话失败）。
   */
  insert(input: TxnInsertInput): TxnInsertResult {
    const reject = (reason: TxnRejectReason): TxnInsertResult => ({ ok: false, reason });

    if (input.id === '') return reject('缺 id（身份由调用方给，store 不造身份）');
    if (input.sessionId === '' || input.workspaceId === '') return reject('缺 sessionId / workspaceId');

    const cardLine = input.cardLine.trim();
    if (cardLine === '') return reject('card_line 为空（宁缺毋造）');
    if (hitsInjection(cardLine)) return reject('card_line 命中黑名单');

    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (summary !== '' && hitsInjection(summary)) return reject('summary 命中黑名单');

    if (!(SOURCE_TRUST_VALUES as readonly string[]).includes(input.sourceTrust)) return reject('来源标记不在单源三档');

    const tsMs = input.tsMs;
    const turnSeq = input.turnSeq;
    if (!Number.isFinite(tsMs) || !Number.isFinite(turnSeq)) return reject('时间/序号不是可判定数值');

    const cues: TxnCueRef[] = [];
    for (const item of input.cues ?? []) {
      if (!(TXN_CUE_KINDS as readonly string[]).includes(item.kind)) return reject('cue kind 不在单源词表');
      // 写入侧归一：路径只留 basename（会泄露工作区结构的是目录，不是文件名）。
      const clean = normalizeCue(baseName(item.cue));
      if (clean === '') continue;
      if (!cues.some((existing) => existing.cue === clean && existing.kind === item.kind)) {
        cues.push({ txnId: input.id, cue: clean, kind: item.kind });
      }
      if (cues.length >= CUE_LIMITS.maxPerEntry) break;
    }

    const db = this.deps.db();
    if (db === null) return reject('条目落库失败（降级面）');

    const semantic = parseSemantic(input.semantic ?? null);
    const entry: TxnEntry = {
      id: input.id,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      tsMs,
      turnSeq,
      cardLine,
      sourceTrust: input.sourceTrust,
      cues,
      createdAt: tsMs,
      salienceTier: typeof input.salienceTier === 'number' && Number.isFinite(input.salienceTier) ? input.salienceTier : 2,
    };
    if (summary !== '') entry.summary = summary;
    if (typeof input.gistKey === 'string' && input.gistKey !== '') entry.gistKey = input.gistKey;
    if (typeof input.topicId === 'string' && input.topicId !== '') entry.topicId = input.topicId;
    if (semantic !== undefined) entry.semantic = semantic;
    const turnStart = optionalFinite(input.turnStartMs);
    if (turnStart !== undefined) entry.turnStartMs = turnStart;
    const turnEnd = optionalFinite(input.turnEndMs);
    if (turnEnd !== undefined) entry.turnEndMs = turnEnd;

    try {
      runInTransaction(db, () => {
        db.prepare(INSERT_SQL).run(
          entry.id,
          entry.sessionId,
          entry.workspaceId,
          entry.tsMs,
          entry.turnSeq,
          entry.cardLine,
          entry.summary ?? null,
          entry.gistKey ?? null,
          JSON.stringify(entry.semantic ?? null),
          entry.sourceTrust,
          entry.topicId ?? null,
          entry.createdAt,
          entry.salienceTier,
          entry.turnStartMs ?? null,
          entry.turnEndMs ?? null,
        );
        for (const cue of cues) db.prepare(INSERT_CUE_SQL).run(cue.txnId, cue.cue, cue.kind);
      });
    } catch (err) {
      this.deps.logger.warn(`[spirit] 事务条目落库失败：${err instanceof Error ? err.message : String(err)}`);
      return reject('条目落库失败（降级面）');
    }
    return { ok: true, entry };
  }

  /**
   * 更正通道（v8 / TA.5）：把旧 delivery 行置 superseded_by=新行 id（更正=插新行+旧行标记，不原地改）。
   * 这是本表**唯一**允许的 UPDATE，且只动 superseded_by 列（gates 白名单实闸）。旧行永不物理删。
   * @returns 是否命中一行（已取代过/不存在/降级面 ⇒ false）。
   */
  markSuperseded(oldId: string, byId: string): boolean {
    const db = this.deps.db();
    if (db === null || oldId === '' || byId === '' || oldId === byId) return false;
    try {
      const info = db.prepare(`UPDATE txn_entry SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL`).run(byId, oldId);
      return Number(info.changes ?? 0) > 0;
    } catch (err) {
      this.deps.logger.warn(`[spirit] delivery 更正置标记失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ───────────────────────────────────────────── 读

  /**
   * 最近事务（注入卡取 card_line、长觉混喂的原料入口）。
   *
   * ⚠️ 这里**不做来源档位过滤**：`derived_summary` 的行本来就要进卡（进卡的是
   * `card_line`，不是 `summary`）。闸守的是 experience 的 `recent()` 不得出现
   * derived_summary（gates 口径），不是这张表不可读。判档归调用方——把过滤写进读侧
   * 等于把闸藏进查询条件，测试就看不到闸了。
   */
  listRecent(limit: number, opts: { sessionId?: string; excludeBackfill?: boolean } = {}): TxnEntry[] {
    const db = this.deps.db();
    if (db === null) return [];
    const window = capReadLimit(limit);
    try {
      // 读侧默认只取未取代行（更正=插新行+旧行置 superseded_by）；注入读面另传 excludeBackfill。
      const conds: string[] = ['superseded_by IS NULL'];
      const params: unknown[] = [];
      if (opts.sessionId !== undefined) {
        conds.push('session_id = ?');
        params.push(opts.sessionId);
      }
      if (opts.excludeBackfill === true) {
        conds.push('source_trust <> ?');
        params.push(TRUST_BACKFILL);
      }
      params.push(window);
      const rows = db
        .prepare(`SELECT * FROM txn_entry WHERE ${conds.join(' AND ')} ORDER BY ts_ms DESC, id DESC LIMIT ?`)
        .all(...(params as never[])) as Record<string, SQLOutputValue>[];
      return rows.map((raw) => toEntry(raw, this.cuesFor(db, asText(raw['id']))));
    } catch {
      return [];
    }
  }

  /** 时间线查询（"上周做了什么"）：区间闭合两端、按时间倒序；索引走 txn_ts / txn_workspace_ts。 */
  timelineQuery(from: number, to: number, workspaceId?: string, limit = TXN_READ_MAX): TxnEntry[] {
    const db = this.deps.db();
    if (db === null) return [];
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return [];
    const window = capReadLimit(limit);
    try {
      const params: unknown[] = [from, to];
      const scope = workspaceId === undefined ? '' : 'AND workspace_id = ?';
      if (workspaceId !== undefined) params.push(workspaceId);
      params.push(window);
      const rows = db
        .prepare(`SELECT * FROM txn_entry WHERE ts_ms BETWEEN ? AND ? AND superseded_by IS NULL ${scope} ORDER BY ts_ms DESC, id DESC LIMIT ?`)
        .all(...(params as never[])) as Record<string, SQLOutputValue>[];
      return rows.map((raw) => toEntry(raw, this.cuesFor(db, asText(raw['id']))));
    } catch {
      return [];
    }
  }

  /** 按 id 集取 delivery 行（task-detail 用）：保持传入顺序、跳过缺失/已取代。 */
  getByIds(ids: readonly string[]): TxnEntry[] {
    const db = this.deps.db();
    if (db === null) return [];
    const unique = [...new Set(ids.filter((id) => id !== ''))].slice(0, TXN_READ_MAX);
    if (unique.length === 0) return [];
    try {
      const placeholders = unique.map(() => '?').join(',');
      const rows = db.prepare(`SELECT * FROM txn_entry WHERE id IN (${placeholders}) AND superseded_by IS NULL`).all(...(unique as never[])) as Record<string, SQLOutputValue>[];
      const byId = new Map(rows.map((raw) => [asText(raw['id']), toEntry(raw, this.cuesFor(db, asText(raw['id'])))]));
      return unique.map((id) => byId.get(id)).filter((e): e is TxnEntry => e !== undefined);
    } catch {
      return [];
    }
  }

  /**
   * 按 cue 反查关联事务条目（面板"这件事还牵涉到什么"）。
   *
   * 用**等值**不用 `LIKE`：cue 是写入侧归一过的检索键，等值走 txn_cue_value 索引；
   * LIKE 不走索引 ⇒ 成本与表行数成正比，而这张表只增不删。查全路径查不到自己写进去的
   * 东西——库里存的正是 basename（同一归一口径，见 experience/cues.ts）。
   */
  resourceLookup(cue: string, limit = TXN_READ_MAX): TxnLookupHit[] {
    const db = this.deps.db();
    if (db === null) return [];
    const needle = normalizeCue(baseName(cue));
    if (needle === '') return [];
    const window = capReadLimit(limit);
    try {
      const rows = db
        .prepare(`SELECT txn_id, cue, kind FROM txn_cues WHERE cue = ? ORDER BY rowid ASC LIMIT ?`)
        .all(needle, window) as Record<string, SQLOutputValue>[];
      const hits: TxnLookupHit[] = [];
      for (const raw of rows) {
        const txnId = asText(raw['txn_id']);
        if (txnId === '') continue;
        const entryRow = db.prepare(`SELECT * FROM txn_entry WHERE id = ? AND superseded_by IS NULL`).get(txnId) as Record<string, SQLOutputValue> | undefined;
        if (entryRow === undefined) continue; // 孤儿 cue 行：反查不能报出一个不存在的事务
        hits.push({
          entry: toEntry(entryRow, this.cuesFor(db, txnId)),
          matchedCue: asText(raw['cue']),
          matchedKind: asText(raw['kind']) as TxnCueKind,
        });
      }
      return hits;
    } catch {
      return [];
    }
  }

  /** 整表行数（灰度期"关路径零建表行"的对账口：关路径时这里必须是 0）。 */
  countAll(): number {
    const db = this.deps.db();
    if (db === null) return 0;
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM txn_entry`).get() as Record<string, SQLOutputValue> | undefined;
      const n = row?.['n'];
      return typeof n === 'number' && Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  // ───────────────────────────────────────────── 内部

  private cuesFor(db: DatabaseSync, txnId: string): TxnCueRef[] {
    try {
      const rows = db
        .prepare(`SELECT txn_id, cue, kind FROM txn_cues WHERE txn_id = ? ORDER BY rowid ASC`)
        .all(txnId) as Record<string, SQLOutputValue>[];
      return rows.map((raw) => ({ txnId: asText(raw['txn_id']), cue: asText(raw['cue']), kind: asText(raw['kind']) as TxnCueKind }));
    } catch {
      return [];
    }
  }
}

/** 读上界：一次读不搬空整库（负数/零/非数一律当 1，不静默变成"无 LIMIT"）。 */
function capReadLimit(limit: number): number {
  const n = Number.isFinite(limit) ? Math.floor(limit) : 1;
  return Math.min(Math.max(1, n), TXN_READ_MAX);
}

function runInTransaction(db: DatabaseSync, write: () => void): void {
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
