/**
 * 回响引用读面规模闸（checklist Should Pass）：echo_ref 只增可合并，读侧缺索引会随使用时长变慢。
 *
 * 钉三个读面，一档预算（50ms/次，1 万行）：
 * 1. `list({sessionId, limit})`：回响页主列表（热）；
 * 2. `list({sessionId, q})`：引用搜索（关键词）；
 * 3. `list({limit})`：跨会话翻阅（星海全局视角）。
 *
 * 三条都该走 `echo_ref_session_last` / `echo_ref_mem`，掉到全表扫就会破 50ms。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { EchoRefStore } from '../src/store/echo-ref.js';

const ROWS = 10_000;
const SESSIONS = 50;
const BASE_TS = 1_700_000_000_000;
const BUDGET_MS = 50;

const dir = mkdtempSync(join(tmpdir(), 'spirit-perf-echo-ref-'));
let handle: DatabaseSync | undefined;
let store: EchoRefStore | undefined;

beforeAll(() => {
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应可打开');
  const db = opened.db;
  handle = db;
  store = new EchoRefStore({ db: () => db });
  const insert = db.prepare(
    `INSERT INTO echo_ref (session_id, ref_id, kind, mem_id, title, times, first_ts, last_ts, last_echo_step_id, record_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const kinds = ['task', 'delivery', 'experience', 'memory', 'goal'];
  db.exec('BEGIN');
  for (let i = 1; i <= ROWS; i += 1) {
    const kind = kinds[i % kinds.length]!;
    insert.run(
      `s${i % SESSIONS}`,
      `echo-00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      kind,
      `mem-${i}`,
      `条目 ${i} · 端口漂移排查与网关回退`,
      (i % 5) + 1,
      BASE_TS + i,
      BASE_TS + i + 1000,
      `recall-00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      BASE_TS + i,
    );
  }
  db.exec('COMMIT');
});

afterAll(() => {
  try {
    handle?.close();
  } catch {
    /* 已关 */
  }
  rmSync(dir, { recursive: true, force: true });
});

function perRun(run: () => void, times = 20): number {
  run();
  const started = performance.now();
  for (let i = 0; i < times; i += 1) run();
  return (performance.now() - started) / times;
}

describe(`echo_ref 规模闸（${ROWS} 行）`, () => {
  it(`会话列表 limit20 < ${BUDGET_MS}ms`, () => {
    const ms = perRun(() => { store!.list({ sessionId: 's1', limit: 20 }); });
    expect(ms, `实测 ${ms.toFixed(2)}ms`).toBeLessThan(BUDGET_MS);
  });

  it(`关键词搜索 < ${BUDGET_MS}ms`, () => {
    const ms = perRun(() => { store!.list({ sessionId: 's1', q: '端口', limit: 20 }); });
    expect(ms, `实测 ${ms.toFixed(2)}ms`).toBeLessThan(BUDGET_MS);
  });

  it(`跨会话翻阅 limit50 < ${BUDGET_MS}ms`, () => {
    const ms = perRun(() => { store!.list({ limit: 50 }); });
    expect(ms, `实测 ${ms.toFixed(2)}ms`).toBeLessThan(BUDGET_MS);
  });
});
