/**
 * 注入回响面（v0.7 / 对表 prime-memory 的 memory 激活槽位）。
 * 正反成对：分段只认行首标签、跳过轮也留档（带门名）、缓冲有顶。
 */
import { describe, expect, it } from 'vitest';

import { SPIRIT_RPC_PREFIX } from '../src/contract.js';
import { EchoLog, parseEchoSegments } from '../src/echo-log.js';
import { handleEndpoint, type RpcDeps } from '../src/rpc.js';

const logger = { info: () => {}, warn: () => {} };

const CARD = ['状态：平稳·继续', '反馈：上次交付被认可', '刚刚：我修好了端口漂移', '想起：三个月前的架构评审'].join('\n');

describe('parseEchoSegments', () => {
  it('只认行首标签：正文里出现同词不计', () => {
    const segs = parseEchoSegments(`${CARD}\n这句里提到刚刚发生的事，但不在行首，不该计`);
    expect(segs).toEqual([
      { name: '状态', lines: 1 },
      { name: '反馈', lines: 1 },
      { name: '刚刚', lines: 1 },
      { name: '想起', lines: 1 },
    ]);
  });
});

describe('EchoLog', () => {
  it('注入快照：bytes/指纹/分段齐；最新在前', () => {
    const log = new EchoLog();
    log.record({ at: 1, agentId: 'a', sessionId: 's1', workspaceId: 'w', kind: 'injected', fingerprint: 'fp1', text: CARD });
    log.record({ at: 2, agentId: 'a', sessionId: 's2', workspaceId: 'w', kind: 'skipped', reason: 'no-new-user' });
    const items = log.list({});
    expect(items.map((i) => i.at)).toEqual([2, 1]);
    const injected = items[1]!;
    expect(injected.bytes).toBeGreaterThan(0);
    expect(injected.fingerprint).toBe('fp1');
    expect(injected.segments.length).toBe(4);
    // 跳过轮：text 空、分段空、reason 是门名
    expect(items[0]!.text).toBe('');
    expect(items[0]!.segments).toEqual([]);
    expect(items[0]!.reason).toBe('no-new-user');
  });

  it('会话过滤 + 缓冲有顶（200 条，丢最老）', () => {
    const log = new EchoLog();
    for (let i = 0; i < 210; i += 1) {
      log.record({ at: i, agentId: 'a', sessionId: i % 2 === 0 ? 'even' : 'odd', workspaceId: 'w', kind: 'skipped', reason: 'no-new-user' });
    }
    expect(log.size()).toBe(200);
    const even = log.list({ sessionId: 'even', limit: 500 });
    expect(even.every((i) => i.sessionId === 'even')).toBe(true);
    // 最早的 10 条（i=0..9）已被挤掉：even 从 10 开始
    expect(Math.min(...even.map((i) => i.at))).toBe(10);
  });

  it('limit 生效（取最近 N 条，最新在前）', () => {
    const log = new EchoLog();
    for (let i = 0; i < 5; i += 1) log.record({ at: i, agentId: 'a', sessionId: 's', workspaceId: 'w', kind: 'skipped', reason: 'x' });
    expect(log.list({ limit: 2 }).map((i) => i.at)).toEqual([4, 3]);
  });
});

describe('inject-echo RPC', () => {
  it('未装配回响面 ⇒ unavailable；装配后返回 items+total', async () => {
    const bare = { logger } as unknown as RpcDeps;
    const missing = await handleEndpoint(`${SPIRIT_RPC_PREFIX}inject-echo`, {}, bare);
    expect(missing.ok).toBe(false);

    const log = new EchoLog();
    log.record({ at: 10, agentId: 'a', sessionId: 's1', workspaceId: 'w', kind: 'injected', fingerprint: 'fp', text: CARD });
    log.record({ at: 11, agentId: 'a', sessionId: 's1', workspaceId: 'w', kind: 'skipped', reason: 'no-new-user' });
    const deps = { logger, echo: log } as unknown as RpcDeps;
    const result = await handleEndpoint(`${SPIRIT_RPC_PREFIX}inject-echo`, { limit: 10 }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.value as { items: Array<{ kind: string }>; total: number };
    expect(view.total).toBe(2);
    expect(view.items).toHaveLength(2);
    expect(view.items[0]!.kind).toBe('skipped');
  });
});
