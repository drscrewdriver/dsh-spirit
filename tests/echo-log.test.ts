/**
 * 注入回响面（v0.7 / 对表 prime-memory 的 memory 激活槽位）。
 * 正反成对：分段只认行首标签、跳过轮也留档（带门名）、缓冲有顶。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SPIRIT_RPC_PREFIX } from '../src/contract.js';
import { openSpiritDb } from '../src/db/open.js';
import { EchoLog, parseEchoSegments, previewOfEcho, splitEchoEntries } from '../src/echo-log.js';
import { resolveEntryTimes } from '../src/echo-times.js';
import { EchoRecallStore } from '../src/store/echo-recall.js';
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

describe('previewOfEcho', () => {
  it('剔除 <system-reminder> 壳子，只连分段行', () => {
    const card = [
      '<system-reminder>',
      '（角色体验快照 · 取代先前快照）',
      '以下是角色自己的体验记录：不是客观事实，不是用户原话。',
      '状态：平常',
      '刚刚：调端口',
      '想起：网关挡住',
      '</system-reminder>',
    ].join('\n');
    const preview = previewOfEcho(card);
    expect(preview).toBe('状态：平常 · 刚刚：调端口 · 想起：网关挡住');
    expect(preview).not.toContain('system-reminder');
  });

  it('一行分段都没有时退回压平正文，并截到上限', () => {
    const preview = previewOfEcho('很'.repeat(80), 20);
    expect(preview).toHaveLength(20);
    expect(preview.endsWith('…')).toBe(true);
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

  it('内存缓冲空（刚重启）⇒ 回退读落档：origin=persisted、带全文与会话标记', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spirit-echo-fallback-'));
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('库应打开');
    try {
      const recall = new EchoRecallStore({ db: () => opened.db, logger });
      recall.record({
        sessionId: 's9', agentId: 'a', at: 5_000, kind: 'injected', reason: '',
        fingerprint: 'fp9', segments: [{ name: '状态', lines: 1 }, { name: '刚刚', lines: 2 }],
        excerpts: [], preview: '状态：平稳·继续', text: CARD,
      });
      const deps = { logger, echo: new EchoLog(), echoRecall: recall } as unknown as RpcDeps;
      const result = await handleEndpoint(`${SPIRIT_RPC_PREFIX}inject-echo`, { limit: 10 }, deps);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const view = result.value as { items: Array<{ origin?: string; sessionId: string; text: string; segments: unknown[]; recallId?: string }>; total: number };
      expect(view.total).toBe(1);
      expect(view.items[0]?.origin, '回退行必须标 persisted，不冒充实时').toBe('persisted');
      expect(view.items[0]?.sessionId).toBe('s9');
      expect(view.items[0]?.text).toBe(CARD);
      expect(view.items[0]?.segments).toHaveLength(2);
      expect(view.items[0]?.recallId, '带编号供 echo-detail 取全文').toMatch(/^recall-/);

      // 内存有数据时不混排落档行（同一条不能两处各出现一次）
      const live = new EchoLog();
      live.record({ at: 9_000, agentId: 'a', sessionId: 's1', workspaceId: 'w', kind: 'skipped', reason: 'no-new-user' });
      const mixed = await handleEndpoint(`${SPIRIT_RPC_PREFIX}inject-echo`, { limit: 10 }, { logger, echo: live, echoRecall: recall } as unknown as RpcDeps);
      expect(mixed.ok).toBe(true);
      if (!mixed.ok) return;
      const mixedItems = (mixed.value as { items: Array<{ origin?: string }> }).items;
      expect(mixedItems).toHaveLength(1);
      expect(mixedItems[0]?.origin).toBe('live');
    } finally {
      try {
        opened.db.close();
      } catch {
        /* 已关 */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inject-echo 带条目化与时间（装配了 echoEntries 才填，不编）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spirit-echo-entries-rpc-'));
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('库应打开');
    try {
      const log = new EchoLog();
      log.record({ at: 3_000, agentId: 'a', sessionId: 's1', workspaceId: 'w', kind: 'injected', fingerprint: 'fp', text: CARD });
      const deps = {
        logger,
        echo: log,
        echoEntries: ({ sessionId, text, at }: { sessionId: string; text: string; at: number }) =>
          resolveEntryTimes(opened.db, sessionId, splitEchoEntries(text), at),
      } as unknown as RpcDeps;
      const result = await handleEndpoint(`${SPIRIT_RPC_PREFIX}inject-echo`, {}, deps);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const item = (result.value as { items: Array<{ entries?: Array<{ name: string; tsSource?: string }> }> }).items[0]!;
      expect(item.entries?.map((e) => e.name)).toEqual(['状态', '反馈', '刚刚', '想起']);
      expect(item.entries?.[0]?.tsSource).toBe('turn');
      // 没装解析器 ⇒ entries 仍在（采集时就切好了）但不带时间（不编）
      const plain = await handleEndpoint(`${SPIRIT_RPC_PREFIX}inject-echo`, {}, { logger, echo: log } as unknown as RpcDeps);
      expect(plain.ok).toBe(true);
      if (!plain.ok) return;
      const plainEntries = (plain.value as { items: Array<{ entries?: Array<{ ts?: string; tsSource?: string }> }> }).items[0]!.entries!;
      expect(plainEntries).toHaveLength(4);
      expect(plainEntries.every((entry) => entry.ts === undefined && entry.tsSource === undefined), '没解析器就不编时间').toBe(true);
    } finally {
      try {
        opened.db.close();
      } catch {
        /* 已关 */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('echo-search 分层检索（v0.8.6）', () => {
  it('时间段→关键词→未命中；向量层如实 unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spirit-echo-search-'));
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('库应打开');
    try {
      const recall = new EchoRecallStore({ db: () => opened.db, logger });
      recall.record({ sessionId: 's1', agentId: 'a', at: 1_000, kind: 'injected', reason: '', fingerprint: 'f1', segments: [], excerpts: [], preview: '状态：平稳', text: '状态：平稳' });
      recall.record({ sessionId: 's1', agentId: 'a', at: 9_000, kind: 'injected', reason: '', fingerprint: 'f2', segments: [], excerpts: [], preview: '端口固定', text: '刚刚：把端口固定住了' });
      const deps = { logger, echoRecall: recall } as unknown as RpcDeps;

      // 第一刀：只给时间窗
      const byTime = await handleEndpoint(`${SPIRIT_RPC_PREFIX}echo-search`, { sinceMs: 5_000 }, deps);
      expect(byTime.ok).toBe(true);
      if (!byTime.ok) return;
      const timeView = byTime.value as { tier: string; items: unknown[]; vector: string; scanned: number };
      expect(timeView.tier).toBe('time');
      expect(timeView.items).toHaveLength(1);
      expect(timeView.scanned).toBe(1);
      expect(timeView.vector, '回响未接嵌入 ⇒ 如实不可用').toBe('unavailable');

      // 第二刀：关键词
      const byWord = await handleEndpoint(`${SPIRIT_RPC_PREFIX}echo-search`, { q: '端口' }, deps);
      expect(byWord.ok).toBe(true);
      if (!byWord.ok) return;
      const wordView = byWord.value as { tier: string; items: Array<{ recallId?: string }> };
      expect(wordView.tier).toBe('keyword');
      expect(wordView.items).toHaveLength(1);

      // 两层都没命中 ⇒ none（不假装兜底）
      const miss = await handleEndpoint(`${SPIRIT_RPC_PREFIX}echo-search`, { q: '不存在' }, deps);
      expect(miss.ok).toBe(true);
      if (!miss.ok) return;
      expect((miss.value as { tier: string }).tier).toBe('none');

      // 关键词里的 % 按字面量（不当通配符把全库捕走）
      recall.record({ sessionId: 's1', agentId: 'a', at: 12_000, kind: 'injected', reason: '', fingerprint: 'f3', segments: [], excerpts: [], preview: '100% 命中', text: '100% 命中' });
      const literal = await handleEndpoint(`${SPIRIT_RPC_PREFIX}echo-search`, { q: '%' }, deps);
      expect(literal.ok).toBe(true);
      if (!literal.ok) return;
      expect((literal.value as { items: unknown[] }).items).toHaveLength(1);
    } finally {
      try {
        opened.db.close();
      } catch {
        /* 已关 */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
