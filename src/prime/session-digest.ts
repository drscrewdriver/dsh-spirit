/**
 * 会话级生涯流程档（v0.8.25）：**以会话为单位组织**，再对总结出的流程去重。
 *
 * 为什么要会话级：
 * - 上游 L1 是"记录流"，同一条进展会在一个会话里反复蒸馏出多行（同一件事写三五遍）；
 * - 一周档按时间窗压行时，这些重复会挤掉别的会话，看起来像"只做了一件事"。
 *
 * 两层去重（确定性，不调模型）：
 * 1. 会话内：归一化签名（去日期/时间戳/空白/标点）相同 ⇒ 只留第一行；
 * 2. 跨会话：同签名或前缀包含（长/短 ≥ 0.8）⇒ 并入首个会话的行，行尾标 `×N`（重复次数），
 *    并把重复来源记进 source_ids_json——流程只记一次，出处不丢。
 *
 * 归属边界不变：只收流程性（work_task / episodic）；知识性归上游 memory_search。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { DistillDigestRow } from '../contract.js';
import { loadAliasIndex, matchEntitiesWithIndex } from './entity-align.js';
import { classifyL1Type, toSummaryText, type ProceduralLine, type ProceduralSummary } from './distill-summary.js';
import { searchL1Records, type L1RecordRow } from './l1-source.js';

/** 无会话归属的兜底桶（上游偶发缺 session_id）。 */
export const UNSESSIONED_KEY = 'l1-unsessioned';

export interface SessionDigestStats {
  /** 写入的会话档数。 */
  sessions: number;
  /** 参与总结的流程性记录数。 */
  records: number;
  /** 去重后保留的流程行数。 */
  unique: number;
  /** 被合并掉的重复行数（会话内 + 跨会话）。 */
  merged: number;
  available: boolean;
}

const NOISE_PATTERNS: RegExp[] = [
  /截至\s*[\dT:.\-Z/]+/giu,
  /时间\s*[:：]\s*[\dT:.\-Z/]+/giu,
];

/** L1 记录里的固定套词（不参与相似度，否则不同任务会被“任务/当前状态”拉高）。 */
const BOILERPLATE_PATTERNS: RegExp[] = [
  /任务\s*[:：]/gu,
  /当前状态\s*[:：]/gu,
  /下一步\s*[:：]/gu,
  /处置口径\s*[:：]/gu,
  /负责人\s*[:：]/gu,
  /截止\s*[:：]?/gu,
  /结论\s*[:：]/gu,
  /目标\s*[:：]/gu,
  /步骤\s*[:：]/gu,
  /依据\s*[:：]/gu,
  /适用范围\s*[:：]/gu,
  /此前/gu,
];

/** 流程行签名：NFKC + 去时间戳噪声 + 去 L1 套词 + 去空白/标点/符号（只用于判重，不用于展示）。 */
export function normalizeFlowText(text: string): string {
  let out = text.normalize('NFKC').toLowerCase();
  for (const pattern of NOISE_PATTERNS) out = out.replace(pattern, '');
  for (const pattern of BOILERPLATE_PATTERNS) out = out.replace(pattern, '');
  out = out.replace(/[\s\p{P}\p{S}]+/gu, '');
  return out.slice(0, 400);
}

function bigramsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (let index = 0; index + 1 < text.length; index += 1) out.add(text.slice(index, index + 2));
  return out;
}

/** 字符二元组 Jaccard（同一任务的两种措辞≈0.9，不同任务共享套话时通常＜0.7）。 */
function similarity(a: string, b: string): number {
  if (a.length < 20 || b.length < 20) return 0;
  const setA = bigramsOf(a);
  const setB = bigramsOf(b);
  let shared = 0;
  for (const gram of setA) if (setB.has(gram)) shared += 1;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** 同一条流程：签名相等，或长短版本前缀包含（≥0.8），或去套话后相似度 ≥0.85。 */
function isSameFlow(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === '' || b === '') return false;
  const long = a.length >= b.length ? a : b;
  const short = a.length >= b.length ? b : a;
  if (long.startsWith(short) && short.length / long.length >= 0.8) return true;
  return similarity(a, b) >= 0.85;
}

interface OwnerLine {
  sig: string;
  date: string;
  type: string;
  text: string;
  sourceIds: string[];
  sessions: Set<string>;
  repeats: number;
}

function dateOf(tsMs: number): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return '—';
  const date = new Date(tsMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function summaryTextOf(lines: OwnerLine[]): string {
  return lines
    .slice()
    .sort((left, right) => (left.date === right.date ? 0 : left.date < right.date ? 1 : -1))
    .map((line) => `${line.date} · ${line.type} · ${line.text}${line.repeats > 1 ? ` ×${line.repeats}` : ''}`)
    .join('\n');
}

/**
 * 重建会话档：先清空 `tier='session'` 再按当前 L1 全量写回（幂等，跨会话合并需要重算归属）。
 *
 * @param opts.days - 参与范围（默认 0 = 全史）
 * @param opts.limit - 读取上限（默认 2000，封顶 2000）
 */
export function buildSessionDigests(
  db: DatabaseSync | null | undefined,
  opts: { days?: number; limit?: number; dbPath?: string; now?: number } = {},
): SessionDigestStats {
  const empty: SessionDigestStats = { sessions: 0, records: 0, unique: 0, merged: 0, available: false };
  if (db === null || db === undefined) return empty;
  const days = Number.isFinite(opts.days) ? Math.max(0, Math.floor(opts.days as number)) : 0;
  const limit = Math.max(1, Math.min(2000, Math.floor(Number.isFinite(opts.limit) ? (opts.limit as number) : 2000)));
  const now = opts.now ?? Date.now();
  const rows = searchL1Records({
    days,
    limit,
    ...(opts.dbPath === undefined ? {} : { dbPath: opts.dbPath }),
  }).filter((row) => classifyL1Type(row.type) === 'procedural');
  if (rows.length === 0) {
    try {
      db.prepare(`DELETE FROM distill_digest WHERE category = 'procedural' AND tier = 'session'`).run();
    } catch {
      /* 表不在：保持空 */
    }
    return empty;
  }

  const bySession = new Map<string, L1RecordRow[]>();
  for (const row of rows) {
    const key = row.sessionId.trim() === '' ? UNSESSIONED_KEY : row.sessionId;
    const bucket = bySession.get(key);
    if (bucket === undefined) bySession.set(key, [row]);
    else bucket.push(row);
  }

  const owners: OwnerLine[] = [];
  const perSession = new Map<string, OwnerLine[]>();
  for (const [session, bucket] of bySession) {
    const lines: OwnerLine[] = [];
    for (const row of bucket) {
      const text = toSummaryText(row.content);
      const sig = normalizeFlowText(text);
      if (sig === '') continue;
      // 会话内重复：并入本会话已有行（不另起一行），并计数
      const local = lines.find((line) => isSameFlow(line.sig, sig));
      if (local !== undefined) {
        local.repeats += 1;
        local.sourceIds.push(row.id);
        continue;
      }
      // 跨会话重复：并入首个会话的行（× N）
      const existing = owners.find((owner) => isSameFlow(owner.sig, sig));
      if (existing !== undefined) {
        existing.repeats += 1;
        existing.sourceIds.push(row.id);
        existing.sessions.add(session);
        continue;
      }
      const owner: OwnerLine = { sig, date: dateOf(row.tsMs), type: row.type, text, sourceIds: [row.id], sessions: new Set([session]), repeats: 1 };
      owners.push(owner);
      lines.push(owner);
    }
    if (lines.length > 0) perSession.set(session, lines);
  }

  const aliasIndex = loadAliasIndex(db);
  let sessions = 0;
  try {
    db.prepare(`DELETE FROM distill_digest WHERE category = 'procedural' AND tier = 'session'`).run();
    const insert = db.prepare(
      `INSERT OR REPLACE INTO distill_digest
         (category, tier, period_key, window_days, generated_at, period_start, period_end, count, summary, source_ids_json, entities_json)
       VALUES ('procedural', 'session', ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [session, lines] of perSession) {
      const stampOf = (line: OwnerLine): number => {
        const parsed = Date.parse(`${line.date}T00:00:00Z`);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const stamps = lines.map(stampOf).filter((value) => value > 0);
      const start = stamps.length === 0 ? '' : new Date(Math.min(...stamps)).toISOString().slice(0, 10);
      const end = stamps.length === 0 ? '' : new Date(Math.max(...stamps)).toISOString().slice(0, 10);
      const text = summaryTextOf(lines);
      if (text === '') continue;
      const entities = matchEntitiesWithIndex(aliasIndex, lines.map((line) => `${line.type} ${line.text}`).join('\n'), 8);
      const sourceIds = [...new Set(lines.flatMap((line) => line.sourceIds))];
      insert.run(session, now, start, end, lines.length, text, JSON.stringify(sourceIds), JSON.stringify(entities));
      sessions += 1;
    }
  } catch {
    return empty;
  }

  return { sessions, records: rows.length, unique: owners.length, merged: rows.length - owners.length, available: true };
}

/** 会话档行 → 窗口内按会话去重后的流程行（week/month 的输入）。 */
export function summarizeSessionDigests(
  db: DatabaseSync | null | undefined,
  opts: { days?: number; perBucket?: number; now?: number } = {},
): ProceduralSummary {
  const days = Number.isFinite(opts.days) ? Math.max(1, Math.floor(opts.days as number)) : 7;
  const cap = Math.max(1, Math.min(20, Math.floor(Number.isFinite(opts.perBucket) ? (opts.perBucket as number) : 8)));
  const now = opts.now ?? Date.now();
  const empty: ProceduralSummary = { count: 0, lines: [], knowledgeCount: 0, days, available: false };
  if (db === null || db === undefined) return empty;
  const since = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  const rows: Array<Record<string, unknown>> = (() => {
    try {
      return db
        .prepare(
          `SELECT period_key, period_end, summary FROM distill_digest
           WHERE category = 'procedural' AND tier = 'session' AND period_end >= ?
           ORDER BY period_end DESC`,
        )
        .all(since) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  })();
  const lines: ProceduralLine[] = [];
  const sigs: string[] = [];
  for (const row of rows) {
    const session = String(row['period_key'] ?? '');
    for (const raw of String(row['summary'] ?? '').split('\n')) {
      const match = /^(\d{4}-\d{2}-\d{2}) · ([^·]+) · (.*)$/u.exec(raw.trim());
      if (match === null) continue;
      const text = (match[3] ?? '').trim();
      const sig = normalizeFlowText(text);
      if (sig === '' || sigs.some((known) => isSameFlow(known, sig))) continue;
      sigs.push(sig);
      lines.push({ date: match[1] ?? '—', type: (match[2] ?? '').trim(), text, sourceId: session });
    }
  }
  lines.sort((left, right) => (left.date === right.date ? 0 : left.date < right.date ? 1 : -1));
  return { count: lines.length, lines: lines.slice(0, cap), knowledgeCount: 0, days, available: rows.length > 0 };
}

/** 读会话档（按会话末条日期倒序）。 */
export function readSessionDigests(db: DatabaseSync | null | undefined, limit = 10): DistillDigestRow[] {
  if (db === null || db === undefined) return [];
  const cap = Math.max(0, Math.min(50, Math.floor(limit)));
  if (cap === 0) return [];
  try {
    const rows = db
      .prepare(
        `SELECT category, tier, period_key, window_days, generated_at, period_start, period_end, count, summary, entities_json
         FROM distill_digest WHERE category = 'procedural' AND tier = 'session'
         ORDER BY period_end DESC, generated_at DESC LIMIT ?`,
      )
      .all(cap) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      let entities: string[] = [];
      try {
        const parsed: unknown = JSON.parse(String(row['entities_json'] ?? '[]'));
        if (Array.isArray(parsed)) entities = parsed.map((item) => String(item));
      } catch {
        /* 坏 JSON ⇒ 无实体 */
      }
      return {
        category: 'procedural' as const,
        tier: 'session' as const,
        periodKey: String(row['period_key'] ?? ''),
        windowDays: Number(row['window_days'] ?? 0),
        generatedAt: Number(row['generated_at'] ?? 0),
        periodStart: String(row['period_start'] ?? ''),
        count: Number(row['count'] ?? 0),
        summary: String(row['summary'] ?? ''),
        entities,
      };
    });
  } catch {
    return [];
  }
}
