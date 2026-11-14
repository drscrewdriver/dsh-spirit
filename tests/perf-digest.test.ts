/**
 * 生涯档性能闸（v0.8.18）：生成 ≤300ms / 读取 ≤20ms（实测值进 checklist 证据）。
 * 目标值（非断言）：生成 ≤80ms、读取 ≤5ms。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { summarizeProcedural } from '../src/prime/distill-summary.js';
import { buildDigests, readDigests } from '../src/prime/distill-digest.js';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterAll(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function freshL1(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-perf-l1-'));
  dirs.push(dir);
  const file = join(dir, 'memory.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE l1_records (
    record_id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT DEFAULT '', family TEXT NOT NULL DEFAULT 'work',
    timestamp_start TEXT DEFAULT '', created_time TEXT DEFAULT '', workspace_id TEXT NOT NULL DEFAULT '',
    repo_key_name TEXT NOT NULL DEFAULT '', repo_key_owner TEXT NOT NULL DEFAULT ''
  )`);
  const insert = db.prepare(`INSERT INTO l1_records (record_id, content, type, family, timestamp_start, created_time) VALUES (?, ?, ?, 'work', ?, ?)`);
  const now = Date.now();
  for (let index = 0; index < count; index += 1) {
    const stamp = new Date(now - index * 60_000).toISOString();
    insert.run(`mem_${index}`, `完成第 ${index} 项：修改 src/prime 模块并交付`, 'work_task', stamp, stamp);
  }
  db.close();
  return file;
}

function freshSpirit(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-perf-digest-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  dbs.push(opened.db);
  return opened.db;
}

describe('perf：生涯档', () => {
  it('200 条 L1：生成 ≤300ms、读取 ≤20ms；实测值打印到 checklist 证据', () => {
    const spirit = freshSpirit();
    const file = freshL1(200);
    const summarize = (opts: { days: number; perBucket: number }) => summarizeProcedural({ ...opts, dbPath: file });

    const t0 = performance.now();
    const build = buildDigests(spirit, summarize, { now: Date.now(), dbPath: file });
    const buildMs = performance.now() - t0;
    expect(build.available).toBe(true);
    expect(build.week?.tier).toBe('week');
    expect(buildMs).toBeLessThan(300);

    const t1 = performance.now();
    const rows = readDigests(spirit, { milestoneLimit: 5 });
    const readMs = performance.now() - t1;
    expect(rows.length).toBeGreaterThan(0);
    expect(readMs).toBeLessThan(20);

    // 实测值写入测试输出（验收证据）
    // eslint-disable-next-line no-console
    console.log(`perf-digest build=${buildMs.toFixed(1)}ms read=${readMs.toFixed(1)}ms milestones=${build.milestones}`);
  });
});
