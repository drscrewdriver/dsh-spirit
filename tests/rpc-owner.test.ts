/**
 * 主人档案四端点门禁（rpc 分发层）。
 *
 * 用注入 fetchImpl 的假 prime + 真 OwnerProfileStore（mkdtemp SQLite）：
 * 端点层要守的是参数校验、包络形状与"缺席不覆盖"，不是同步算法（那是 prime-sync 测试的事）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SPIRIT_DEFAULTS, SPIRIT_RPC_PREFIX } from '../src/contract.js';
import { openSpiritDb } from '../src/db/open.js';
import { OwnerProfileStore } from '../src/store/owner.js';
import { PrimeClient } from '../src/prime/client.js';
import { OwnerSyncService } from '../src/prime/sync.js';
import { handleEndpoint, type RpcDeps } from '../src/rpc.js';

const logger = { info: () => {}, warn: () => {} };

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-rpc-owner-'));
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('应打开库成功');
  db = opened.db;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// 同步链主路径实态（T2.2）：preview 轻量清单 → 逐 id node-get 全量
function primeFetch(): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes('graph-preview')) {
      return new Response(JSON.stringify({ ok: true, value: { full: { nodes: [{ id: 'p1', type: 'person', name: '小鱼', degree: 1 }] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, value: { node: { id: 'p1', type: 'person', name: '小鱼', aliases: [], currentState: '职业: 程序员', tags: [] } } }), { status: 200 });
  }) as typeof fetch;
}

function makeDeps(fetchImpl: typeof fetch): { deps: RpcDeps; store: OwnerProfileStore } {
  const store = new OwnerProfileStore({ dataDir: dir, logger, db });
  const client = new PrimeClient({ baseUrl: 'http://fake', fetchImpl, trustedHosts: () => [] });
  const sync = new OwnerSyncService({ client, store, cfg: () => SPIRIT_DEFAULTS, logger });
  const deps = {
    spirit: {},
    stats: { latest: () => null, snapshot: () => null, agentOfSession: () => undefined },
    store: null,
    modes: { isOff: () => false, isBypass: () => false },
    personas: null,
    dataDir: dir,
    cfg: () => SPIRIT_DEFAULTS,
    drscVerdict: () => 'skipped' as const,
    owner: { store, sync },
    logger,
  } as unknown as RpcDeps;
  return { deps, store };
}

type Call = { ok: boolean; value?: Record<string, unknown>; error?: { code: string; message: string } };

function call(deps: RpcDeps, op: string, payload: Record<string, unknown> = {}): Promise<Call> {
  return handleEndpoint(`${SPIRIT_RPC_PREFIX}${op}`, payload, deps) as Promise<Call>;
}

describe('owner-* 端点', () => {
  it('owner-get：初始空档案 + primeStatus 三态之一，不抛', async () => {
    const { deps } = makeDeps(primeFetch());
    const result = await call(deps, 'owner-get');
    expect(result.ok).toBe(true);
    const value = result.value as { syncText: string; selfText: string; revision: number; primeStatus: string };
    expect(value.syncText).toBe('');
    expect(value.revision).toBe(1);
    expect(['available', 'absent', 'graph-off']).toContain(value.primeStatus);
  });

  it('owner-set-self：乐观并发拒冲突（reason 进 error），成功回新档案', async () => {
    const { deps } = makeDeps(primeFetch());
    const bad = await call(deps, 'owner-set-self', { text: '我是程序员', expectedRevision: 99 });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('save-failed');
    const missing = await call(deps, 'owner-set-self', { text: 'x' });
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe('bad-request');
    const good = await call(deps, 'owner-set-self', { text: '我是程序员', expectedRevision: 1 });
    expect(good.ok).toBe(true);
    expect((good.value as { revision: number; selfText: string }).revision).toBe(2);
  });

  it('owner-sync-now：真同步落库；第二击去重窗 updated:false（不是错误）', async () => {
    const { deps, store } = makeDeps(primeFetch());
    const first = await call(deps, 'owner-sync-now');
    expect(first.ok).toBe(true);
    expect((first.value as { updated: boolean }).updated).toBe(true);
    expect(store.get().syncText).toContain('小鱼');
    const second = await call(deps, 'owner-sync-now');
    expect((second.value as { updated: boolean; reason?: string }).updated).toBe(false);
  });

  it('owner-sync-ping：空 body 受理、坏 body 不炸；ping 后 sync-now 被去重窗接住', async () => {
    const { deps } = makeDeps(primeFetch());
    const ping = await call(deps, 'owner-sync-ping', {});
    expect(ping.ok).toBe(true);
    expect((ping.value as { accepted: boolean }).accepted).toBe(true);
    const now = await call(deps, 'owner-sync-now');
    expect((now.value as { updated: boolean }).updated).toBe(false);
  });

  it('未装配 owner 的最小 deps：四端点报 unavailable 而不是崩', async () => {
    const bare = {
      spirit: {},
      stats: { latest: () => null, snapshot: () => null, agentOfSession: () => undefined },
      store: null,
      modes: { isOff: () => false, isBypass: () => false },
      personas: null,
      dataDir: dir,
      cfg: () => SPIRIT_DEFAULTS,
      drscVerdict: () => 'skipped' as const,
      logger,
    } as unknown as RpcDeps;
    for (const op of ['owner-get', 'owner-set-self', 'owner-sync-now', 'owner-sync-ping']) {
      const result = await call(bare, op, { text: 'x', expectedRevision: 1 });
      expect(result.ok, op).toBe(false);
      expect(result.error?.code, op).toBe('unavailable');
    }
  });
});
