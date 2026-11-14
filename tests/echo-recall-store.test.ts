/**
 * 回响落档（v10 两表）：写入去重 / 读侧有顶 / 令牌单调 / 库不可用休眠。
 *
 * 这一层是侧栏「本会话回响段」的真源，所以每个用例都从真实打开的库走，
 * 不用内存桩——SQL 主键与 UPSERT 语义正是被测对象。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { ECHO_EXCERPT_MAX, EchoRecallStore } from '../src/store/echo-recall.js';

let dir = '';
let db: DatabaseSync | undefined;
let store: EchoRecallStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-echo-'));
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error(`库应打开成功：${String(opened.err)}`);
  db = opened.db;
  store = new EchoRecallStore({ db: () => db });
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* 已关闭 */
  }
  db = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('EchoRecallStore', () => {
  it('同句重复召回只留一行、times 累加、first_ts 不变', () => {
    store.record({ sessionId: 's1', agentId: 'a1', at: 1000, kind: 'injected', excerpts: ['想起一件事'] });
    store.record({ sessionId: 's1', agentId: 'a1', at: 2000, kind: 'injected', excerpts: ['想起一件事', '又想起一件'] });
    const summary = store.summary('s1');
    expect(summary.total).toBe(2);
    expect(summary.token).toBe(2 * 1_000_000 + 3);
    const first = summary.segments.find((seg) => seg.excerpt === '想起一件事');
    expect(first).toMatchObject({ times: 2, firstTs: 1000, lastTs: 2000 });
  });

  it('最新在前，单次读取有顶（limit 钳到 [1, 200]）', () => {
    for (let i = 0; i < 30; i += 1) {
      store.record({ sessionId: 's1', agentId: 'a1', at: 1000 + i, kind: 'injected', excerpts: [`第${i}段`] });
    }
    const top = store.summary('s1', 5);
    expect(top.segments).toHaveLength(5);
    expect(top.segments[0]?.excerpt).toBe('第29段');
    expect(top.total).toBe(30);
    expect(store.summary('s1', 0).segments).toHaveLength(1);
  });

  it('按会话隔离：别人的回响不会出现在本会话摘要里', () => {
    store.record({ sessionId: 's1', agentId: 'a1', at: 1000, kind: 'injected', excerpts: ['A 的回忆'] });
    store.record({ sessionId: 's2', agentId: 'a1', at: 1000, kind: 'injected', excerpts: ['B 的回忆'] });
    expect(store.summary('s1').segments.map((seg) => seg.excerpt)).toEqual(['A 的回忆']);
    expect(store.summary('').total).toBe(0);
  });

  it('跳过轮也落 step（回答「这轮为什么没卡」），但不产生召回段', () => {
    store.record({ sessionId: 's1', agentId: 'a1', at: 1234, kind: 'skipped', reason: 'unchanged' });
    const summary = store.summary('s1');
    expect(summary.total).toBe(0);
    expect(summary.lastStep).toEqual({ id: 'recall-1234', at: 1234, kind: 'skipped', reason: 'unchanged', fingerprint: '', preview: '', title: '', refs: [], flashback: false });
    expect(summary.token).toBe(1_000_000);
  });

  it('令牌由库派生：重新构造 store 仍读到大令牌（重启不归零）', () => {
    store.record({ sessionId: 's1', agentId: 'a1', at: 1000, kind: 'injected', excerpts: ['记得我'] });
    const reopened = new EchoRecallStore({ db: () => db });
    const summary = reopened.summary('s1');
    expect(summary.token).toBe(1_000_000 + 1);
    expect(summary.segments).toHaveLength(1);
  });

  it('超长句子按 ECHO_EXCERPT_MAX 截断并带省略号', () => {
    const long = '很'.repeat(ECHO_EXCERPT_MAX * 2);
    store.record({ sessionId: 's1', agentId: 'a1', at: 1000, kind: 'injected', excerpts: [long] });
    const excerpt = store.summary('s1').segments[0]?.excerpt ?? '';
    expect(excerpt.length).toBe(ECHO_EXCERPT_MAX);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('按编号取原文：只在同一会话内命中，缺条目就 undefined', () => {
    store.record({ sessionId: 's1', agentId: 'a1', at: 1000, kind: 'injected', preview: '状态：平常', text: '整张卡正文\n状态：平常' });
    store.record({ sessionId: 's2', agentId: 'a1', at: 1000, kind: 'injected', preview: '别人', text: '别人的卡' });
    const hit = store.detail('s1', 'recall-1000');
    expect(hit?.text).toContain('整张卡正文');
    expect(hit?.preview).toBe('状态：平常');
    expect(store.detail('s2', 'recall-1000')?.text).toBe('别人的卡');
    expect(store.detail('s1', 'recall-404')).toBeUndefined();
    expect(store.detail('', 'recall-1000')).toBeUndefined();
  });

  it('库不可用时整段休眠：写入丢弃、摘要为空、不抛', () => {
    const dead = new EchoRecallStore({ db: () => undefined });
    expect(() => dead.record({ sessionId: 's1', agentId: 'a1', at: 1, kind: 'injected', excerpts: ['x'] })).not.toThrow();
    expect(dead.summary('s1')).toEqual({ token: 0, total: 0, segments: [], steps: [] });
    expect(() => dead.clearSession('s1')).not.toThrow();
  });

  it('clearSession 只清本会话', () => {
    store.record({ sessionId: 's1', agentId: 'a1', at: 1, kind: 'injected', excerpts: ['留一'] });
    store.record({ sessionId: 's2', agentId: 'a1', at: 1, kind: 'injected', excerpts: ['留二'] });
    store.clearSession('s1');
    expect(store.summary('s1').total).toBe(0);
    expect(store.summary('s2').total).toBe(1);
  });
});
