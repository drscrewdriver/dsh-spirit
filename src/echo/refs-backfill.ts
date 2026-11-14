/**
 * 回响记录回填（v0.8.11 / v2）：把历史 echo_step 里**有原文**的轮次解析成"记录被想起"。
 *
 * 纪律（沿用 v1，编号换成 v2 口径）：
 * 1. **只回填有 text 的行**：只有摘要的旧行拿摘要反推条目就是猜测；
 * 2. **echo 号走注册表**：`resolveEchoId` 保证同一记录永远同号，重跑不重生；
 * 3. **水位幂等**：meta 键 `echo.records.v2`；重跑时按新号合并（times 会累加，观测面可接受）；
 * 4. **异常不抛穿**：观测面回填失败只 warn，绝不影响插件启动。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { MinimalLogger } from '../persona/store.js';
import type { SpiritEchoEntry } from '../contract.js';
import { titleOfEntries } from '../echo-times.js';
import { resolveEchoId } from './identity.js';

/** 水位键（与正文回填分键，互不覆盖）。 */
export const ECHO_RECORDS_WATERMARK = 'echo.records.v2';

export interface RefsBackfillResult {
  sessions: number;
  steps: number;
  records: number;
  skipped: boolean;
}

function readWatermark(db: DatabaseSync): string | undefined {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(ECHO_RECORDS_WATERMARK) as { value?: unknown } | undefined;
    return typeof row?.value === 'string' && row.value !== '' ? row.value : undefined;
  } catch {
    return undefined;
  }
}

function writeWatermark(db: DatabaseSync, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(ECHO_RECORDS_WATERMARK, value);
}

/**
 * 回填记录行。
 *
 * @param deps.db - 权威库；unavailable ⇒ 全 0（不抛）
 * @param deps.refs - 记录写入层（upsert 合并）
 * @param deps.resolve - 行→条目解析（调用方注入 resolveEntryTimes，保持按轨拆分的读面）
 * @param deps.sinceDays - 回填窗口（默认 7 天；0 = 全史）
 * @param deps.force - 忽略水位
 */
export function backfillEchoRefs(deps: {
  db: () => DatabaseSync | undefined;
  refs: {
    upsert(input: {
      sessionId: string;
      echoId: string;
      kind: string;
      memId: string;
      title?: string;
      at: number;
      recordTs?: number;
      lastRecallId?: string;
    }): boolean;
  };
  resolve: (sessionId: string, text: string, at: number) => SpiritEchoEntry[];
  sinceDays?: number;
  force?: boolean;
  logger?: MinimalLogger;
}): RefsBackfillResult {
  const empty: RefsBackfillResult = { sessions: 0, steps: 0, records: 0, skipped: false };
  let db: DatabaseSync | undefined;
  try {
    db = deps.db();
  } catch {
    db = undefined;
  }
  if (db === undefined) return empty;
  if (deps.force !== true && readWatermark(db) !== undefined) return { ...empty, skipped: true };

  const days = deps.sinceDays ?? 7;
  const since = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
  let rows: Array<{ session_id?: string; id?: string; ts_ms?: number; text?: string }>;
  try {
    rows = db.prepare(
      `SELECT session_id, id, ts_ms, text FROM echo_step
       WHERE text <> '' AND ts_ms >= ?
       ORDER BY ts_ms ASC`,
    ).all(since) as Array<{ session_id?: string; id?: string; ts_ms?: number; text?: string }>;
  } catch (err) {
    deps.logger?.warn(`回响记录回填读取失败：${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }

  const sessions = new Set<string>();
  let steps = 0;
  let written = 0;
  for (const row of rows) {
    const sessionId = typeof row.session_id === 'string' ? row.session_id : '';
    const text = typeof row.text === 'string' ? row.text : '';
    if (sessionId === '' || text === '') continue;
    sessions.add(sessionId);
    steps += 1;
    const at = Number(row.ts_ms) || 0;
    const recallId = typeof row.id === 'string' ? row.id : '';
    const entries = deps.resolve(sessionId, text, at);
    for (const entry of entries) {
      if (entry.ref === undefined) continue;
      const echoId = resolveEchoId(db, entry.ref.kind, entry.ref.id);
      if (echoId === undefined) continue;
      const ok = deps.refs.upsert({
        sessionId,
        echoId,
        kind: entry.ref.kind,
        memId: entry.ref.id,
        title: titleOfEntries([entry]),
        at,
        recordTs: entry.ts ?? at,
        lastRecallId: recallId,
      });
      if (ok) written += 1;
    }
  }

  try {
    writeWatermark(db, String(Date.now()));
  } catch (err) {
    deps.logger?.warn(`回响记录回填水位写入失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return { sessions: sessions.size, steps, records: written, skipped: false };
}
