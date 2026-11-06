/**
 * 同步引擎门禁：缺席不覆盖、去重窗、渲染格式、探测缓存。
 *
 * `fetchImpl` 注入假 prime 响应——"prime 没装"是这个功能最常见的运行形态，
 * 它必须是绿路径而不是异常路径。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SPIRIT_DEFAULTS } from '../src/contract.js';
import { openSpiritDb } from '../src/db/open.js';
import { OwnerProfileStore } from '../src/store/owner.js';
import { PrimeClient, type PrimePersonNode } from '../src/prime/client.js';
import { OWNER_SYNC_LINE_MAX, OwnerSyncService, renderOwnerSyncText } from '../src/prime/sync.js';

const logger = { info: () => {}, warn: () => {} };

function nodeOf(over: Partial<PrimePersonNode> & { name: string }): PrimePersonNode {
  return { aliases: [], currentState: '', tags: [], ...over };
}

function failFetch(): typeof fetch {
  return (async () => {
    throw new Error('connection refused');
  }) as unknown as typeof fetch;
}

describe('renderOwnerSyncText（纯函数）', () => {
  it('person 列表 → 名称（别名）：facts 前 3 行的清单；空列表 ⇒ null', () => {
    const text = renderOwnerSyncText([
      nodeOf({ name: '小鱼', aliases: ['阿鱼'], currentState: '职业: 程序员\n城市: 杭州' }),
      nodeOf({ name: '字节', currentState: '类型: 公司' }),
    ]);
    expect(text).toBe('小鱼（阿鱼）：职业: 程序员；城市: 杭州\n字节：类型: 公司');
    expect(renderOwnerSyncText([])).toBeNull();
  });

  it('单条超 OWNER_SYNC_LINE_MAX 截断加省略号；条数顶 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => nodeOf({ name: `n${i}` }));
    const lines = (renderOwnerSyncText(many) ?? '').split('\n');
    expect(lines).toHaveLength(8);
    const long = renderOwnerSyncText([nodeOf({ name: '长', currentState: `k: ${'值'.repeat(200)}` })]) ?? '';
    expect(long.length).toBeLessThanOrEqual(OWNER_SYNC_LINE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('两次调用字节全等（无时间戳、无 id）', () => {
    const nodes = [nodeOf({ name: '小鱼', currentState: 'a: 1' })];
    expect(renderOwnerSyncText(nodes)).toBe(renderOwnerSyncText(nodes));
  });
});

describe('OwnerSyncService（注入 fetchImpl）', () => {
  let dir = '';
  let db: DatabaseSync;
  let store: OwnerProfileStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spirit-prime-'));
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('应打开库成功');
    db = opened.db;
    store = new OwnerProfileStore({ dataDir: dir, logger, db });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function serviceWith(fetchImpl: typeof fetch, nowStart = 1_000_000): { svc: OwnerSyncService; clock: { now: number } } {
    const clock = { now: nowStart };
    const client = new PrimeClient({ baseUrl: 'http://fake', fetchImpl, trustedHosts: () => [] });
    const svc = new OwnerSyncService({ client, store, cfg: () => SPIRIT_DEFAULTS, logger, now: () => clock.now });
    return { svc, clock };
  }

  // 同步链主路径实态（T2.2）：preview 轻量清单（id/name/type）→ 逐 id graph-node-get 全量
  const nodeDetails: Record<string, unknown> = {
    p1: { id: 'p1', type: 'person', name: '小鱼', aliases: ['阿鱼'], currentState: '职业: 程序员', tags: [] },
    p2: { id: 'p2', type: 'person', name: '同事甲', aliases: [], currentState: '公司: 字节', tags: [] },
  };
  function primeFetch(empty = false): typeof fetch {
    return (async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes('graph-preview')) {
        const nodes = empty ? [] : [{ id: 'p1', type: 'person', name: '小鱼', degree: 3 }, { id: 'p2', type: 'person', name: '同事甲', degree: 1 }, { id: 'x1', type: 'project', name: '不该出现的工程', degree: 2 }];
        return new Response(JSON.stringify({ ok: true, value: { full: { nodes } } }), { status: 200 });
      }
      const id = String(JSON.parse(init?.body ?? '{}')['id'] ?? '');
      return new Response(JSON.stringify({ ok: true, value: { node: nodeDetails[id] ?? null } }), { status: 200 });
    }) as typeof fetch;
  }

  it('preview 种子榜 + node-get 详情 ⇒ 同步段落库、meta 计数、自述段原样', async () => {
    store.setSelf('我是程序员', 1);
    const { svc } = serviceWith(primeFetch());
    const outcome = await svc.sync();
    expect(outcome).toEqual({ ok: true, updated: true });
    const row = store.get();
    expect(row.syncText).toBe('小鱼（阿鱼）：职业: 程序员\n同事甲：公司: 字节');
    expect(row.selfText).toBe('我是程序员');
    expect(row.syncMeta.sourceNodes).toBe(2);
    expect(row.syncMeta.syncedAt).toBe(1_000_000);
  });

  it('60s 去重窗：第二击 updated:false，跨过窗口才放行', async () => {
    const { svc, clock } = serviceWith(primeFetch());
    expect((await svc.sync()).updated).toBe(true);
    clock.now += 30_000;
    const second = await svc.sync();
    expect(second.updated).toBe(false);
    expect(second.reason).toBe('dedup-window');
    clock.now += 40_000;
    expect((await svc.sync()).updated).toBe(true);
  });

  it('prime 缺席（preview 请求也挂）⇒ updated:false 且**旧同步段不被清空**、probe 报 absent', async () => {
    const seeded = serviceWith(primeFetch());
    await seeded.svc.sync();
    const before = store.get().syncText;
    const absent = serviceWith(failFetch(), 2_000_000);
    const outcome = await absent.svc.sync();
    expect(outcome.updated).toBe(false);
    expect(outcome.reason).toBe('prime-absent');
    expect(store.get().syncText).toBe(before);
    expect(await absent.svc.probe()).toBe('absent');
  });

  it('空图（preview 空 nodes）⇒ graph-off、不写库、不抛', async () => {
    const { svc } = serviceWith(primeFetch(true));
    const outcome = await svc.sync();
    expect(outcome.updated).toBe(false);
    expect(outcome.reason).toBe('graph-empty');
    expect(store.get().syncText).toBe('');
  });

  it('node-get 单点失败退轻量形状（只有名字），不整段丢', async () => {
    const broken = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('graph-preview')) return new Response(JSON.stringify({ ok: true, value: { full: { nodes: [{ id: 'p1', type: 'person', name: '种子鱼', degree: 1 }] } } }), { status: 200 });
      return new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 500 });
    }) as typeof fetch;
    const { svc } = serviceWith(broken);
    expect((await svc.sync()).updated).toBe(true);
    expect(store.get().syncText).toBe('种子鱼');
  });

  it('同步链不再对 graph-search 白发注定空转的请求（T2.2 回归钉）', async () => {
    const seen: string[] = [];
    const spy = (async (input: unknown) => {
      seen.push(String(input));
      const url = String(input);
      if (url.includes('graph-preview')) return new Response(JSON.stringify({ ok: true, value: { full: { nodes: [{ id: 'p9', type: 'person', name: '种子鱼', degree: 1 }] } } }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, value: { node: { id: 'p9', type: 'person', name: '种子鱼', aliases: [], currentState: '', tags: [] } } }), { status: 200 });
    }) as typeof fetch;
    const { svc } = serviceWith(spy);
    expect((await svc.sync()).updated).toBe(true);
    expect(seen.some((u) => u.includes('graph-search'))).toBe(false);
    expect(seen.every((u) => u.includes('graph-preview') || u.includes('graph-node-get'))).toBe(true);
  });

  it('probe 缓存 TTL 内第二次调用不再发请求', async () => {
    let hits = 0;
    const counting = (async (input: unknown) => {
      hits += 1;
      const url = String(input);
      if (url.includes('graph-preview')) return new Response(JSON.stringify({ ok: true, value: { full: { nodes: [{ id: 'p1', type: 'person', name: '小鱼', degree: 1 }] } } }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, value: { node: nodeDetails['p1'] } }), { status: 200 });
    }) as typeof fetch;
    const { svc } = serviceWith(counting);
    expect(await svc.probe()).toBe('available');
    const afterFirst = hits;
    expect(afterFirst).toBeGreaterThan(0);
    expect(await svc.probe()).toBe('available');
    expect(hits).toBe(afterFirst);
    expect(await svc.probe(true)).toBe('available');
    expect(hits).toBeGreaterThan(afterFirst);
  });
});
