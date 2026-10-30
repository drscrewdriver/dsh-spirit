/**
 * 条目保留与归档（v0.1：**只归档导出，不删行**）。
 *
 * 这里有一个必须写下来的冲突与裁决。计划要求"清理默认干跑 + 归档改名"，同时有条红线
 * 是"全仓不存在删除体验行的路径"（可回滚优先）。两者在 v0.1 不能同时满足——
 * 真删行需要一个配套的东西还没做：删除前的全量快照 + 快照校验 + 回灌入口
 * （姊妹包为此专门做了 `cleanup-retired` + 内容哈希校验 + `snapshot-restore`）。
 *
 * 所以 v0.1 的口径：**过期数据只做归档导出（写 JSONL），库里一行不删**。
 * 代价很小：条目是"每轮最多一条"的量级，90 天重度使用也就数万行，SQLite 无压力。
 * 真删留到 v0.2，且必须带快照与显式授权才能开。
 */

import { join } from 'node:path';

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import { appendLine } from './json-file.js';
import type { ExperienceEntry } from '../types.js';

/** 一天毫秒数（保留期换算单源）。 */
export const DAY_MS = 86_400_000;

export const ARCHIVE_DIR_NAME = 'archive';

export interface SessionBucket {
  sessionId: string;
  entries: number;
  oldestMs: number;
  newestMs: number;
}

export interface RetentionPlan {
  /** 早于此时间的会话整体算过期（按会话末条时间判定，不按条目逐条切）。 */
  cutoffMs: number;
  retentionDays: number;
  buckets: SessionBucket[];
  /** 会被归档的会话数。 */
  staleSessions: number;
  staleEntries: number;
  /** 本版本恒为 0：不删任何行（见文件头注释）。 */
  deletedRows: 0;
  dryRun: boolean;
}

function toBuckets(db: DatabaseSync): SessionBucket[] {
  const rows = db
    .prepare(
      `SELECT session_id, COUNT(*) AS entries, MIN(ts_ms) AS oldest, MAX(ts_ms) AS newest
       FROM experience GROUP BY session_id`,
    )
    .all() as Record<string, SQLOutputValue>[];
  return rows
    .filter((row) => typeof row['session_id'] === 'string')
    .map((row) => ({
      sessionId: row['session_id'] as string,
      entries: Number(row['entries'] ?? 0),
      oldestMs: Number(row['oldest'] ?? 0),
      newestMs: Number(row['newest'] ?? 0),
    }));
}

/**
 * 计算保留计划（**纯读**，不写任何东西）。
 *
 * @param retentionDays 过期天数；0 = 永久保留（返回空计划）
 */
export function planRetention(deps: {
  db: DatabaseSync | null;
  retentionDays: number;
  now: number;
  dryRun: boolean;
}): RetentionPlan {
  const cutoffMs = deps.now - Math.max(0, Math.floor(deps.retentionDays)) * DAY_MS;
  if (deps.db === null || deps.retentionDays <= 0) {
    return { cutoffMs, retentionDays: deps.retentionDays, buckets: [], staleSessions: 0, staleEntries: 0, deletedRows: 0, dryRun: deps.dryRun };
  }
  let buckets: SessionBucket[];
  try {
    buckets = toBuckets(deps.db);
  } catch {
    return { cutoffMs, retentionDays: deps.retentionDays, buckets: [], staleSessions: 0, staleEntries: 0, deletedRows: 0, dryRun: deps.dryRun };
  }
  const stale = buckets.filter((bucket) => bucket.newestMs < cutoffMs);
  return {
    cutoffMs,
    retentionDays: deps.retentionDays,
    buckets: stale,
    staleSessions: stale.length,
    staleEntries: stale.reduce((sum, bucket) => sum + bucket.entries, 0),
    deletedRows: 0,
    dryRun: deps.dryRun,
  };
}

/** 归档结果。 */
export interface ArchiveResult {
  dryRun: boolean;
  files: string[];
  written: number;
  /** 本版本恒 0（不删行）。 */
  deletedRows: 0;
  reason?: string;
}

/**
 * 把过期会话导出成 JSONL 归档。
 *
 * @param dryRun 默认 true：只报数不写文件。写文件时是**新增**归档文件，不动原库，
 *               所以干跑与实跑的唯一差别就是有没有落盘，没有不可逆动作。
 */
export function archiveSessions(deps: {
  db: DatabaseSync | null;
  logger: { warn(message: string): void };
  dataDir: string;
  plan: RetentionPlan;
  /** 取某会话全部行（含被取代的）：由调用方注入，避免这里再抄一份 SQL。 */
  loadSession: (sessionId: string) => ExperienceEntry[];
}): ArchiveResult {
  if (deps.db === null) return { dryRun: deps.plan.dryRun, files: [], written: 0, deletedRows: 0, reason: '库不可用' };
  if (deps.plan.staleSessions === 0) return { dryRun: deps.plan.dryRun, files: [], written: 0, deletedRows: 0 };
  if (deps.plan.dryRun) {
    return { dryRun: true, files: deps.plan.buckets.map((b) => b.sessionId), written: 0, deletedRows: 0, reason: '干跑：未写任何文件' };
  }
  const files: string[] = [];
  let written = 0;
  for (const bucket of deps.plan.buckets) {
    try {
      const entries = deps.loadSession(bucket.sessionId);
      const stamp = new Date(bucket.newestMs).toISOString().slice(0, 10).replace(/-/gu, '');
      // 文件名不带路径分隔符与会话 id 原文（sessionId 可能含特殊字符，路径注入面在这里关掉）
      const path = join(deps.dataDir, ARCHIVE_DIR_NAME, `${stamp}-${files.length + 1}.jsonl`);
      for (const entry of entries) appendLine(path, JSON.stringify(entry));
      files.push(path);
      written += entries.length;
    } catch (err) {
      deps.logger.warn(`[spirit] 会话归档失败（${bucket.sessionId}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { dryRun: false, files, written, deletedRows: 0 };
}
