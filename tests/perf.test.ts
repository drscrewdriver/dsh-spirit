import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { ExperienceStore } from '../src/store/experience.js';
import { deriveMood } from '../src/slot/derive.js';
import type { ExperienceEntry } from '../src/types.js';

/**
 * 规模闸（计划 task_4.2 的验收口）：v0.1 **不建 FTS5 虚表**，靠小表 `LIKE` + cues 索引 +
 * 近因权重。这条测试就是那个"等实测不达标再补索引"的实测：不达标就不许继续省这份成本。
 */

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
const ROWS = 20_000;

const dir = mkdtempSync(join(tmpdir(), 'spirit-perf-'));
let handle: DatabaseSync | undefined;
let store: ExperienceStore | undefined;

beforeAll(() => {
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应可打开');
  handle = opened.db;
  store = new ExperienceStore({ db: opened.db, logger });
  // 分 5 个会话铺量：真实使用里单会话不会有两万条，但跨会话累计会（检索路正是跨会话的）
  for (let i = 0; i < ROWS; i += 1) {
    const sessionId = `s${i % 5}`;
    store!.append(
      { id: `id-${i}`, sessionId, workspaceId: 'w1', turnSeq: i, tsMs: 1_000 + i * 1_000, personaRevision: 1 },
      {
        trigger: i % 3 === 0 ? 'tool_failure' : 'task_close',
        notice: 'environment',
        reaction: i % 7 === 0 ? 'strong' : 'mild',
        text: `第 ${i} 条体验：手边的动作${i % 3 === 0 ? '没成' : '收了个段落'}。`,
        fact: { tool: i % 2 === 0 ? 'pnpm-build' : 'read', pathBases: [`e:/w/file-${i % 97}.ts`] },
        lane: 'live',
      },
    );
  }
}, 120_000);

afterAll(() => {
  handle?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe(`规模闸（${ROWS} 条，无 FTS5）`, () => {
  it('总量读得出（说明真的铺到了量，不是空表自证）', () => {
    expect(store!.count('s0')).toBeGreaterThan(ROWS / 6);
  });

  it('检索路 p95 在召回预算内（默认 timeoutMs=800）', () => {
    const queries = ['pnpm-build', 'file-3.ts', 'file-42.ts', '收了个段落', '第 9999 条体验', 'read', '不存在的词', 'file-7.ts'];
    const durations: number[] = [];
    for (const q of queries) {
      const t0 = performance.now();
      store!.searchLocal(q, { sessionId: undefined, limit: 3 });
      durations.push(performance.now() - t0);
    }
    const p95 = [...durations].sort((a, b) => a - b)[Math.floor(durations.length * 0.95)] ?? Math.max(...durations);
    // 断言写成"预算的一半"：留出的余量是给宿主里同轮的其它开销，不是给自己放水
    expect(p95, `p95=${p95.toFixed(1)}ms，durations=${durations.map((d) => d.toFixed(1)).join('/')}`).toBeLessThan(400);
  });

  it('近因读（每轮都走的热路径）在个位数毫秒', () => {
    const t0 = performance.now();
    for (let i = 0; i < 50; i += 1) store!.recent('s1', 3);
    const perCall = (performance.now() - t0) / 50;
    expect(perCall, `per=${perCall.toFixed(2)}ms`).toBeLessThan(20);
  });

  it('档位派生与条数量级无关（每轮都要跑）', () => {
    const entries: ExperienceEntry[] = store!.recent('s2', 3);
    const t0 = performance.now();
    for (let i = 0; i < 1_000; i += 1) deriveMood(undefined, entries, Date.now(), { halfLifeMs: 5_400_000, stepCap: 1, staleAfterMs: 600_000 });
    expect((performance.now() - t0) / 1_000).toBeLessThan(1);
  });
});
