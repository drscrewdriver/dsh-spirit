/**
 * 本体层规模闸（TZ.2）：entity / evaluation / task 只增不删，读侧必须有索引支撑，不随库增长劣化。
 * 冷路径预算：面板动作触发，不在每轮热路上；只守"缺索引就全表扫"这类单调劣化（秒级 → 单次 ms 级）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { OntologyStore } from '../src/store/ontology.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
const ENTITIES = 5_000;
const EVALS = 8_000;
const TASKS = 800;
const BASE = 1_700_000_000_000;

const dir = mkdtempSync(join(tmpdir(), 'spirit-perf-onto-'));
let db: DatabaseSync | undefined;
let store: OntologyStore | undefined;

beforeAll(() => {
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应可打开');
  db = opened.db;
  store = new OntologyStore({ db: () => opened.db, logger });
  const insE = opened.db.prepare(`INSERT INTO entity (id, kind, name, aliases_json, importance, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, '[]', ?, ?, ?)`);
  const insV = opened.db.prepare(`INSERT INTO evaluation (id, delivery_id, kind, anchor_mode, anchor_confidence, user_line, source_trust, session_id, workspace_id, ts_ms, created_at) VALUES (?, ?, 'positive', 'recency', 700, NULL, 'user_explicit', 's1', 'w1', ?, ?)`);
  const insT = opened.db.prepare(`INSERT INTO task (id, title, status, next_step, workspace_id, created_at, updated_at) VALUES (?, ?, 'progress', NULL, 'w1', ?, ?)`);
  opened.db.exec('BEGIN');
  try {
    for (let i = 0; i < ENTITIES; i += 1) insE.run(`ent-${i}`, 'project', `项目 ${i}`, i % 100, BASE + i, BASE + i);
    for (let i = 0; i < EVALS; i += 1) insV.run(`ev-${i}`, `dlv-${i % 1000}`, BASE + i, BASE + i);
    for (let i = 0; i < TASKS; i += 1) insT.run(`task-${i}`, `任务 ${i}`, BASE + i, BASE + i);
    opened.db.exec('COMMIT');
  } catch (err) {
    opened.db.exec('ROLLBACK');
    throw err;
  }
}, 120_000);

afterAll(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function p95(samples: readonly number[]): number {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] ?? Math.max(...samples);
}

describe(`本体层规模闸（entity ${ENTITIES} / eval ${EVALS} / task ${TASKS}）`, () => {
  it('铺到量（不是空表自证）', () => {
    expect(store!.listEntities(1).length).toBe(1);
    expect(store!.countEvaluations()).toBe(EVALS);
    expect(store!.listTasks('w1', { limit: 1 }).length).toBe(1);
  });

  it('listAllTasks 跨工作区；listTasks 只限本区（面板「本体」全局翻阅依据）', () => {
    // updated_at 置为最新 ⇒ 在全局窗口（ONT_READ_MAX 上限）里必排第一，可稳定断言"跨区可见"
    db!
      .prepare(`INSERT INTO task (id, title, status, next_step, workspace_id, created_at, updated_at) VALUES ('task-w2', '另一个工作区', 'open', NULL, 'w2', ?, ?)`)
      .run(BASE, BASE + TASKS + 10);
    expect(store!.listAllTasks({ limit: 200 }).some((t) => t.id === 'task-w2')).toBe(true);
    const w1 = store!.listTasks('w1', { limit: 200 });
    expect(w1.length).toBe(200);
    expect(w1.some((t) => t.id === 'task-w2')).toBe(false);
  });

  it('listEntities（按 importance DESC）冷路径在预算内', () => {
    const d: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const t0 = performance.now();
      store!.listEntities(60);
      d.push(performance.now() - t0);
    }
    expect(p95(d), `listEntities p95=${p95(d).toFixed(1)}ms`).toBeLessThan(200);
  });

  it('listRecentEvaluations 冷路径在预算内（走 eval_ts 索引）', () => {
    const d: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const t0 = performance.now();
      store!.listRecentEvaluations(100, { excludeUnresolved: true });
      d.push(performance.now() - t0);
    }
    expect(p95(d), `listRecentEvaluations p95=${p95(d).toFixed(1)}ms`).toBeLessThan(200);
  });

  it('listTasks 冷路径在预算内（走 task_workspace_status 索引）', () => {
    const d: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const t0 = performance.now();
      store!.listTasks('w1', { limit: 50 });
      d.push(performance.now() - t0);
    }
    expect(p95(d), `listTasks p95=${p95(d).toFixed(1)}ms`).toBeLessThan(200);
  });
});
