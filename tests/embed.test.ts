/**
 * 向量能力位（v0.3.5 缺省关）：四态仲裁 + 远程通道形状 + 维度锁。
 * 假 fetch/假 prime 客户端（照 prime-sync 打桩范式），不触真网络。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SPIRIT_DEFAULTS, type SpiritConfig } from '../src/contract.js';
import { openSpiritDb } from '../src/db/open.js';
import { EmbedArbitrator, EMBED_DIMS_KEY } from '../src/embed/probe.js';
import { RemoteEmbedding, backfillVectors, decodeVector, encodeVector, hashText, normalize, rankByCosine } from '../src/embed/remote.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
const openDbs: DatabaseSync[] = [];
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-embed-'));
});
afterEach(() => {
  for (const db of openDbs.splice(0, openDbs.length)) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function cfgWith(vector: Partial<SpiritConfig['distill']['vector']>): SpiritConfig {
  const cfg = structuredClone(SPIRIT_DEFAULTS);
  Object.assign(cfg.distill.vector, vector);
  return cfg;
}

function fakeFetch(payload: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
}

describe('RemoteEmbedding（纯 fetch 通道）', () => {
  it('缺省关 ⇒ enabled=false、embed 直接 null（零触网）', async () => {
    const e = new RemoteEmbedding({ cfg: () => cfgWith({}), logger, fetchImpl: fakeFetch({}) });
    expect(e.enabled).toBe(false);
    expect(await e.embed(['x'])).toBeNull();
  });

  it('三件套齐 ⇒ 请求形状对、响应按 index 还原、L2 归一', async () => {
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [3, 4] }, { index: 1, embedding: [0, 0] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const e = new RemoteEmbedding({
      cfg: () => cfgWith({ enabled: true, baseUrl: 'https://embed.invalid/v1/', apiKey: 'sk-test', model: 'm1' }),
      logger,
      fetchImpl,
    });
    expect(e.enabled).toBe(true);
    const out = await e.embed(['甲', '乙']);
    expect(seenUrl).toBe('https://embed.invalid/v1/embeddings');
    expect(seenBody.model).toBe('m1');
    expect(out).not.toBeNull();
    const first = out?.[0] ?? [];
    expect(Math.hypot(...first)).toBeCloseTo(1, 5); // [3,4] → [0.6,0.8]
    expect(out?.[1]).toEqual([0, 0]);
  });

  it('响应形状不符（缺 data）⇒ 抛错由调用方降级，不静默给半批', async () => {
    const e = new RemoteEmbedding({
      cfg: () => cfgWith({ enabled: true, baseUrl: 'https://embed.invalid', apiKey: 'k', model: 'm' }),
      logger,
      fetchImpl: fakeFetch({ nope: 1 }),
    });
    await expect(e.embed(['x'])).rejects.toThrow(/data/);
  });

  it('编解码往返 + source_hash 对账 + 两阶段精排', () => {
    const vec = normalize([1, 2, 3]);
    const blob = encodeVector(vec);
    const back = decodeVector(new Uint8Array(blob));
    expect(Array.from(back)).toHaveLength(3);
    expect(back[2] ?? 0).toBeCloseTo(vec[2] ?? 0, 6);
    expect(hashText('a')).toBe(hashText('a'));
    expect(hashText('a')).not.toBe(hashText('b'));
    const ranked = rankByCosine(vec, [{ id: 'x', vec: new Float32Array(vec) }, { id: 'y', vec: new Float32Array(normalize([-1, 0, 0])) }]);
    expect(ranked[0]?.id).toBe('x');
  });

  it('backfillVectors：同 hash 跳过、文本变更重嵌（source_hash 对账防陈旧）', async () => {
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('库应打开成功');
    openDbs.push(opened.db);
    const db = opened.db;
    let embedCalls = 0;
    const e = new RemoteEmbedding({
      cfg: () => cfgWith({ enabled: true, baseUrl: 'https://embed.invalid', apiKey: 'k', model: 'm' }),
      logger,
      fetchImpl: (async () => {
        embedCalls += 1;
        return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 1] }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const deps = { db: () => db, embedder: e, logger };
    expect(await backfillVectors(deps, [{ id: 'a', text: '原文' }])).toBe(1);
    expect(await backfillVectors(deps, [{ id: 'a', text: '原文' }])).toBe(0); // hash 未变 ⇒ 不重嵌
    expect(embedCalls).toBe(1);
    expect(await backfillVectors(deps, [{ id: 'a', text: '改过的原文' }])).toBe(1); // 文本变 ⇒ 重嵌
    // 降级：库不可用不抛
    const bare = new RemoteEmbedding({ cfg: () => cfgWith({}), logger, fetchImpl: fakeFetch({}) });
    expect(await backfillVectors({ db: () => null, embedder: bare, logger }, [{ id: 'a', text: 'x' }])).toBe(0);
  });
});

describe('EmbedArbitrator（四态仲裁 + 维度锁）', () => {
  function openedDb(): DatabaseSync {
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('库应打开成功');
    openDbs.push(opened.db);
    return opened.db;
  }

  it('缺省关 ⇒ off（关键词路照常）', async () => {
    const db = openedDb();
    const a = new EmbedArbitrator({ prime: undefined, cfg: () => cfgWith({}), db: () => db, logger });
    expect((await a.probe()).status).toBe('off');
  });

  it('prime 档位可得 ⇒ borrowed（对齐 baseURL/模型/维度，note 标来源）', async () => {
    const db = openedDb();
    const fakePrime = { embeddingState: async () => ({ source: 'remote', remote: { baseUrl: 'https://prime-side.invalid/v1', model: 'bge-m3', dimensions: 1024 } }) } as never;
    const a = new EmbedArbitrator({ prime: fakePrime, cfg: () => cfgWith({ enabled: true, apiKey: 'self-key' }), db: () => db, logger });
    const res = await a.probe();
    expect(res.status).toBe('borrowed');
    expect(res.model).toBe('bge-m3');
    expect(res.dimensions).toBe(1024);
    expect(res.note).toContain('prime');
  });

  it('prime 不可得但自家三件套齐 ⇒ self-remote；都不齐 ⇒ off', async () => {
    const db = openedDb();
    const a = new EmbedArbitrator({ prime: undefined, cfg: () => cfgWith({ enabled: true, baseUrl: 'https://mine.invalid', model: 'm', apiKey: 'k', dimensions: 64 }), db: () => db, logger });
    expect((await a.probe()).status).toBe('self-remote');
    const a2 = new EmbedArbitrator({ prime: undefined, cfg: () => cfgWith({ enabled: true }), db: () => db, logger });
    expect((await a2.probe()).status).toBe('off');
  });

  it('维度锁：首建记 meta，档位维度变了 ⇒ 显式冲突 note，不静默重建；reset 后可恢复', async () => {
    const db = openedDb();
    const cfgA = cfgWith({ enabled: true, baseUrl: 'https://mine.invalid', model: 'm', apiKey: 'k', dimensions: 64 });
    const a = new EmbedArbitrator({ prime: undefined, cfg: () => cfgA, db: () => db, logger });
    expect((await a.probe()).note).toContain('自家');
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(EMBED_DIMS_KEY) as { value: string };
    expect(row.value).toBe('64');
    // 换 128 维档位：冲突显式化
    const cfgB = cfgWith({ enabled: true, baseUrl: 'https://mine.invalid', model: 'm', apiKey: 'k', dimensions: 128 });
    const b = new EmbedArbitrator({ prime: undefined, cfg: () => cfgB, db: () => db, logger });
    const conflict = await b.probe();
    expect(conflict.note).toContain('维度冲突');
    b.resetDimsConflict();
    expect((await b.probe()).note).toContain('维度冲突'); // 未处置 meta 仍冲突（复位只清缓存，meta 是事实源）
  });

  it('prime 探测抛错不误报：落 self-remote/off 判定（缺席是绿路径）', async () => {
    const db = openedDb();
    const boomPrime = { embeddingState: async () => { throw new Error('不可达'); } } as never;
    const a = new EmbedArbitrator({ prime: boomPrime, cfg: () => cfgWith({ enabled: true, baseUrl: 'https://mine.invalid', model: 'm', apiKey: 'k', dimensions: 32 }), db: () => db, logger });
    const res = await a.probe();
    expect(res.status).toBe('self-remote');
    expect(res.note).toContain('prime 档位不可得');
  });
});
