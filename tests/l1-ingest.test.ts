/**
 * L1 → 本体重建（v0.8.24）：历史重建换源后的行为闸。
 * 断言：work_task→task、work_artifact→交付、实体/引用只存 id；重跑幂等（不重复计数）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { L1BackfillRunner } from '../src/prime/l1-backfill.js';
import { ingestL1 } from '../src/prime/l1-ingest.js';
import { OntologyStore } from '../src/store/ontology.js';
import { TxnStore } from '../src/store/transaction.js';

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

const logger = { warn: () => undefined, info: () => undefined };

function freshL1(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-ingest-l1-'));
  dirs.push(dir);
  const file = join(dir, 'memory.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE l1_records (
    record_id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT DEFAULT '', family TEXT NOT NULL DEFAULT 'work',
    timestamp_start TEXT DEFAULT '', created_time TEXT DEFAULT '', workspace_id TEXT NOT NULL DEFAULT 'E:/p',
    repo_key_name TEXT NOT NULL DEFAULT 'dsh-spirit', repo_key_owner TEXT NOT NULL DEFAULT ''
  )`);
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO l1_records (record_id, content, type, family, timestamp_start, created_time, workspace_id, repo_key_name) VALUES (?, ?, ?, 'work', ?, ?, 'E:/p', 'dsh-spirit')`);
  insert.run('mem_task_done', '完成 9 语收口并推送 18/18', 'work_task', now, now);
  insert.run('mem_task_open', '排查回响列表摘要是否干净', 'work_task', now, now);
  insert.run('mem_artifact', '交付：L1 生涯档三档落地', 'work_artifact', now, now);
  insert.run('mem_fact', 'dsh-spirit 的 schema 到 v18 了', 'work_fact', now, now);
  db.close();
  return file;
}

function freshSpirit(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-ingest-db-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  dbs.push(opened.db);
  return opened.db;
}

describe('ingestL1（历史重建换源）', () => {
  it('task/交付/实体/引用；二次运行幂等（计数不翻倍）', () => {
    const db = freshSpirit();
    const l1Path = freshL1();
    const ontology = new OntologyStore({ db: () => db, logger });
    const txn = new TxnStore({ db: () => db, logger });
    const deps = { db: () => db, ontology, txn, logger, dbPath: l1Path };

    const first = ingestL1(deps, { days: 0 });
    expect(first.total).toBe(4);
    expect(first.tasks).toBe(2);
    expect(first.deliveries).toBe(1);
    expect(first.entities).toBeGreaterThanOrEqual(1);
    expect(first.knowledge).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) c FROM task`).get() as { c?: number }).c).toBe(2);
    expect((db.prepare(`SELECT COUNT(*) c FROM txn_entry`).get() as { c?: number }).c).toBe(1);
    // 知识性只存引用：work_fact 正文不得落进 spirit 任何表
    expect((db.prepare(`SELECT COUNT(*) c FROM txn_entry WHERE card_line LIKE '%schema 到 v18%'`).get() as { c?: number }).c).toBe(0);
    // done 语义：完成/推送 ⇒ done，排查 ⇒ progress
    const statuses = db.prepare(`SELECT status FROM task ORDER BY title`).all() as Array<{ status: string }>;
    expect(statuses.some((row) => row.status === 'done')).toBe(true);
    expect(statuses.some((row) => row.status === 'progress')).toBe(true);

    const second = ingestL1(deps, { days: 0 });
    expect(second.deliveries).toBe(0); // 主键冲突 ⇒ 计 0（幂等）
    expect((db.prepare(`SELECT COUNT(*) c FROM txn_entry`).get() as { c?: number }).c).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) c FROM task`).get() as { c?: number }).c).toBe(2);
  });

  it('L1 缺失 ⇒ 空结果（不抛）', () => {
    const db = freshSpirit();
    const ontology = new OntologyStore({ db: () => db, logger });
    const txn = new TxnStore({ db: () => db, logger });
    const result = ingestL1({ db: () => db, ontology, txn, logger, dbPath: join(tmpdir(), 'no-such', 'x.db') }, { days: 0 });
    expect(result.total).toBe(0);
  });
});

describe('L1BackfillRunner（面板重建接口不变）', () => {
  it('start 受理后进入 done；连点第二次返回 running（防双跑）', async () => {
    const runner = new L1BackfillRunner({
      run: () => ({ total: 4, tasks: 2, deliveries: 1, entities: 1, links: 1, refs: 1, knowledge: 1 }),
      logger,
    });
    expect(runner.start(false)).toEqual({ accepted: true });
    expect(runner.start(false)).toEqual({ accepted: false, reason: 'running' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runner.status().phase).toBe('done');
    expect(runner.status().totalSessions).toBe(4);
    expect(runner.status().running).toBe(false);
  });
});
