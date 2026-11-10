/**
 * 事务轨规模闸（Phase 6 / T6.2）：txn_entry 只增不删，读侧若缺索引会随使用时长单调变慢。
 *
 * 为什么单独一条（不并进 perf.test.ts 的 experience 闸）：
 * - 本次升级新增的是**事务表**的读路径，experience 闸不覆盖它；
 * - 摘要形状（~500B summary）正落在 txn_entry.summary——plan T6.2 说的"摘要形状语料"实际存这里。
 *
 * 钉三个读面，两档预算：
 * 1. `listRecent(limit, {sessionId})`：注入热路径（开轨后每轮 pre-step 都走）——个位数毫秒；
 * 2. `timelineQuery(from,to)`：面板冷路径（本周视图），走 txn_ts 索引；
 * 3. `resourceLookup(cue)`：面板冷路径（资源反查），走 txn_cue_value 索引。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { TxnStore } from '../src/store/transaction.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
const ROWS = 60_000;
const SESSIONS = 5;
const DAY = 86_400_000;
const BASE_TS = 1_700_000_000_000;
// ~500B 的摘要形状（plan 口径：summary 是长文本，才是体积压力来源）。
const SUMMARY = '本轮事务摘要：'.padEnd(180, '细节');

const dir = mkdtempSync(join(tmpdir(), 'spirit-perf-txn-'));
let handle: DatabaseSync | undefined;
let store: TxnStore | undefined;

beforeAll(() => {
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应可打开');
  const db = opened.db;
  handle = db;
  store = new TxnStore({ db: () => db, logger });
  // 直插铺量（单事务）：读性能闸测的是读侧，写侧成本交给 txn-store 用例，不在此重复计时。
  const insertEntry = db.prepare(`INSERT INTO txn_entry (
      id, session_id, workspace_id, ts_ms, turn_seq, card_line, summary, gist_key, semantic_json, source_trust, topic_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertCue = db.prepare(`INSERT INTO txn_cues (txn_id, cue, kind) VALUES (?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (let i = 0; i < ROWS; i += 1) {
      const sessionId = `s${i % SESSIONS}`;
      const id = `txn-${i}`;
      const ts = BASE_TS + i * 1_000; // 铺到 ~60k 秒 ≈ 16 小时跨度 + 早期基线
      insertEntry.run(
        id,
        sessionId,
        `w${i % 3}`,
        ts,
        i,
        `第 ${i} 条：帮用户推进了一件事`,
        SUMMARY,
        `g:${i % 500}`,
        JSON.stringify({ what: `做事 ${i}`, topics: [`主题${i % 40}`] }),
        'derived_summary',
        `tp${i % 60}`,
        ts,
      );
      insertCue.run(id, `file-${i % 997}.ts`, 'file');
      insertCue.run(id, `tool-${i % 20}`, 'tool');
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}, 120_000);

afterAll(() => {
  handle?.close();
  rmSync(dir, { recursive: true, force: true });
});

function p95(samples: readonly number[]): number {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] ?? Math.max(...samples);
}

describe(`T6.2 事务轨规模闸（${ROWS} 行 · 只增不删）`, () => {
  it('总量读得出（说明真铺到了量，不是空表自证）', () => {
    expect(store!.countAll()).toBe(ROWS);
  });

  it('listRecent(sessionId) 注入热路径在个位数毫秒（缺 session 索引会单调劣化）', () => {
    // 先跑一次让缓存到位，再测
    store!.listRecent(1, { sessionId: 's1' });
    const durations: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const t0 = performance.now();
      store!.listRecent(1, { sessionId: `s${i % SESSIONS}` });
      durations.push(performance.now() - t0);
    }
    const p = p95(durations);
    expect(p, `listRecent(sessionId) p95=${p.toFixed(2)}ms`).toBeLessThan(20);
  });

  it('timelineQuery 近 7 天窗口在冷路径预算内（走 txn_ts 索引）', () => {
    const durations: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const to = BASE_TS + ROWS * 1_000 - i * 60_000;
      const from = to - 7 * DAY;
      const t0 = performance.now();
      store!.timelineQuery(from, to, undefined, 200);
      durations.push(performance.now() - t0);
    }
    const p = p95(durations);
    expect(p, `timelineQuery p95=${p.toFixed(1)}ms`).toBeLessThan(300);
  });

  it('resourceLookup 按 cue 等值命中在冷路径预算内（走 txn_cue_value 索引）', () => {
    const durations: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const t0 = performance.now();
      const hits = store!.resourceLookup(`file-${(i * 37) % 997}.ts`, 100);
      durations.push(performance.now() - t0);
      if (i === 0) expect(hits.length).toBeGreaterThan(0); // 正向对敲：确有命中，不是空查假快
    }
    const p = p95(durations);
    expect(p, `resourceLookup p95=${p.toFixed(1)}ms`).toBeLessThan(300);
  });
});
