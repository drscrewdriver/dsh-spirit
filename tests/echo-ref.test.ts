/**
 * 回响记录聚合（v0.8.11 / schema v16）：一行 = 一条被想起的记录。
 * 正反成对：跨轮合并次数、record_ts 排序、关键词/时间窗过滤、tone 不混记录、降级面不抛。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { resolveEchoId } from '../src/echo/identity.js';
import { EchoRecallStore } from '../src/store/echo-recall.js';
import { EchoRefStore } from '../src/store/echo-ref.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
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

function fresh(): { db: DatabaseSync; refs: EchoRefStore; echo: EchoRecallStore } {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-echo-ref-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  dbs.push(opened.db);
  return {
    db: opened.db,
    refs: new EchoRefStore({ db: () => opened.db, logger }),
    echo: new EchoRecallStore({ db: () => opened.db, logger }),
  };
}

describe('EchoRefStore.upsert 合并（记录持 echo 号）', () => {
  it('同一记录跨两轮 ⇒ 一行、times=2、first/last 包络、lastRecallId 指较晚那轮、recordTs 保留记录时间', () => {
    const { db, refs } = fresh();
    const echoId = resolveEchoId(db, 'task', 'task-a')!;
    expect(refs.upsert({ sessionId: 's1', echoId, kind: 'task', memId: 'task-a', title: 'plugin-9lang-five-dim', at: 1_000, recordTs: 900, lastRecallId: 'recall-1' })).toBe(true);
    expect(refs.upsert({ sessionId: 's1', echoId, kind: 'task', memId: 'task-a', title: 'plugin-9lang-five-dim', at: 9_000, recordTs: 950, lastRecallId: 'recall-2' })).toBe(true);
    const listed = refs.list({ sessionId: 's1' });
    expect(listed.total).toBe(1);
    expect(listed.rows[0]).toEqual({
      echoId,
      sessionId: 's1',
      kind: 'task',
      memId: 'task-a',
      title: 'plugin-9lang-five-dim',
      times: 2,
      recordTs: 900,
      firstTs: 1_000,
      lastTs: 9_000,
      lastRecallId: 'recall-2',
    });
  });

  it('echoId 空 ⇒ 拒写（不编造编号）', () => {
    const { refs } = fresh();
    expect(refs.upsert({ sessionId: 's1', echoId: '', kind: 'task', memId: 'x', at: 1 })).toBe(false);
    expect(refs.upsert({ sessionId: '', echoId: 'echo-x', kind: 'task', memId: 'x', at: 1 })).toBe(false);
  });
});

describe('EchoRefStore.list 过滤与排序', () => {
  it('kind / 关键词 / 时间窗 / order=record 按记录时间排', () => {
    const { db, refs } = fresh();
    const a = resolveEchoId(db, 'task', 'task-a')!;
    const e = resolveEchoId(db, 'experience', 'e-9')!;
    refs.upsert({ sessionId: 's1', echoId: a, kind: 'task', memId: 'task-a', title: 'plugin-9lang-five-dim', at: 9_000, recordTs: 5_000 });
    refs.upsert({ sessionId: 's1', echoId: e, kind: 'experience', memId: 'e-9', title: '端口固定住了', at: 1_000, recordTs: 9_000 });

    expect(refs.list({ sessionId: 's1' }).rows.map((r) => r.memId), '默认按最近想起').toEqual(['task-a', 'e-9']);
    expect(refs.list({ sessionId: 's1', order: 'record' }).rows.map((r) => r.memId), 'order=record 按记录时间').toEqual(['e-9', 'task-a']);
    expect(refs.list({ sessionId: 's1', kind: 'task' }).rows.map((r) => r.memId)).toEqual(['task-a']);
    expect(refs.list({ sessionId: 's1', q: '端口' }).rows.map((r) => r.memId)).toEqual(['e-9']);
    expect(refs.list({ sessionId: 's1', q: 'task-a' }).rows.map((r) => r.memId), '关键词也匹配 mem_id').toEqual(['task-a']);
    expect(refs.list({ sessionId: 's1', sinceMs: 2_000 }).rows.map((r) => r.memId)).toEqual(['task-a']);
  });
});

describe('EchoRefStore.toneOf（语气分栏）', () => {
  it('从最近注入卡解析状态/开场；不产生记录行', () => {
    const { refs, echo } = fresh();
    echo.record({ sessionId: 's1', agentId: 'a', at: 1_000, kind: 'injected', segments: [], excerpts: [], preview: '无语气', text: '线程：只有线程' });
    echo.record({ sessionId: 's1', agentId: 'a', at: 2_000, kind: 'injected', segments: [], excerpts: [], preview: '状态/开场', text: '状态：平常·按平时那样说\n开场：我们又见面了' });
    expect(refs.toneOf('s1')).toEqual({ at: 2_000, state: '平常·按平时那样说', opening: '我们又见面了' });
    expect(refs.list({ sessionId: 's1' }).total).toBe(0);
    // 跨会话最近一条（星海回响页全局视角）
    expect(refs.toneOf('')?.at).toBe(2_000);
  });
});

describe('降级面', () => {
  it('db 不可用 ⇒ 写 false、读空、tone undefined，不抛', () => {
    const refs = new EchoRefStore({ db: () => undefined, logger });
    expect(refs.upsert({ sessionId: 's1', echoId: 'echo-x', kind: 'task', memId: 't', at: 1 })).toBe(false);
    expect(refs.list({ sessionId: 's1' })).toEqual({ rows: [], total: 0 });
    expect(refs.toneOf('s1')).toBeUndefined();
  });
});
