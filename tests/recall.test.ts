import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TurnWatcher, type RawEvent } from '../src/experience/watcher.js';
import { compileTurn } from '../src/experience/compile.js';
import { previousTone } from '../src/experience/cross-session.js';
import { recentLines } from '../src/recall/recent.js';
import { queryWorthRecall, recallHistory } from '../src/recall/history.js';
import { DrscClient } from '../src/drsc/client.js';
import { DrscProbe } from '../src/drsc/probe.js';
import { ExperienceStore } from '../src/store/experience.js';
import { SessionModeStore } from '../src/store/session-modes.js';
import { openSpiritDb } from '../src/db/open.js';
import { DEFAULT_PERSONA } from '../src/persona/types.js';
import { isOwnCardText, SPIRIT_CARD_SIGNATURE } from '../src/slot/render.js';
import type { ExperienceEntry } from '../src/types.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
const CFG = { gapThresholdMs: 180_000 };

function entry(over: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return {
    id: 'e1', sessionId: 's1', workspaceId: 'w1', turnSeq: 1, tsMs: 1_000,
    trigger: 'tool_failure', notice: 'environment', reaction: 'mild',
    text: '手边的动作没成。', fact: {}, lane: 'live', personaRevision: 1, updatedAt: 1_000, ...over,
  };
}

describe('TurnWatcher：只折结构字段', () => {
  it('同名工具先败后成才算 recovery；换工具成功不算', () => {
    const w = new TurnWatcher(CFG);
    w.observe('a1', { type: 'turn/start', data: { turn: 1 } }, 10);
    w.observe('a1', { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash' } }, 11);
    w.observe('a1', { type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', isError: true } } }, 12);
    const failed = w.takeSignals('a1', 13);
    expect(failed.toolFailures).toBe(1);
    expect(failed.recovered).toBe(false);

    w.observe('a1', { type: 'tool/call', data: { turn: 2, step: 1, callId: 'c2', name: 'bash' } }, 20);
    w.observe('a1', { type: 'tool/result', data: { turn: 2, step: 1, message: { toolCallId: 'c2' } } }, 21);
    expect(w.takeSignals('a1', 22).recovered).toBe(true);

    // 另一件事：换个工具成功不算"那次缓过来了"
    const w2 = new TurnWatcher(CFG);
    w2.observe('a', { type: 'tool/call', data: { callId: 'x', name: 'bash' } }, 1);
    w2.observe('a', { type: 'tool/result', data: { message: { toolCallId: 'x', isError: true } } }, 2);
    w2.takeSignals('a', 3);
    w2.observe('a', { type: 'tool/call', data: { callId: 'y', name: 'read' } }, 4);
    w2.observe('a', { type: 'tool/result', data: { message: { toolCallId: 'y' } } }, 5);
    expect(w2.takeSignals('a', 6).recovered).toBe(false);
  });

  it('本轮未闭合就再来一条用户消息 = 插话；闭合后就是新轮', () => {
    const w = new TurnWatcher(CFG);
    w.observe('a', { type: 'turn/start', data: { turn: 1 } }, 1);
    w.observe('a', { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先停一下' }] } }, 2);
    const interrupted = w.takeSignals('a', 3);
    expect(interrupted.userInterruption).toBe(true);
    expect(interrupted.hasNewUserMessage).toBe(false);

    const w2 = new TurnWatcher(CFG);
    w2.observe('a', { type: 'turn/end', data: { turn: 1, reason: { kind: 'done' } } }, 1);
    w2.observe('a', { type: 'user/message', data: { source: { kind: 'user' }, content: 'abcde' } }, 2);
    const next = w2.takeSignals('a', 3);
    expect(next.userInterruption).toBe(false);
    expect(next.hasNewUserMessage).toBe(true);
    expect(next.userChars).toBe(5);
  });

  it('非 user 来源的行不产生"用户发言"（自家卡、别的插件注入都在这里被挡）', () => {
    const w = new TurnWatcher(CFG);
    const rows: RawEvent[] = [
      { type: 'user/message', data: { source: { kind: 'plugin:spirit', form: 'snapshot' }, content: [{ type: 'text', text: SPIRIT_CARD_SIGNATURE }] } },
      { type: 'user/message', data: { source: { kind: 'plugin:memory', form: 'recall' }, content: [{ type: 'text', text: '召回注入' }] } },
      { type: 'user/message', data: { content: [{ type: 'text', text: '没有 source Shape' }] } },
    ];
    for (const row of rows) w.observe('a', row, 5);
    const signals = w.takeSignals('a', 6);
    expect(signals.hasNewUserMessage).toBe(false);
    expect(signals.userChars).toBe(0);
    expect(w.hasActivity('a')).toBe(false);
  });

  it('todo/write 快照非空且全完成才算收尾；未知状态词不算完成', () => {
    const w = new TurnWatcher(CFG);
    w.observe('a', { type: 'todo/write', data: { todos: [{ content: 'a', status: 'completed' }] } }, 1);
    expect(w.takeSignals('a', 2).taskClosed).toBe(true);
    const w2 = new TurnWatcher(CFG);
    w2.observe('b', { type: 'todo/write', data: { todos: [{ content: 'a', status: 'pending' }] } }, 1);
    expect(w2.takeSignals('b', 2).taskClosed).toBe(false);
    const w3 = new TurnWatcher(CFG);
    w3.observe('c', { type: 'todo/write', data: { todos: [] } }, 1);
    expect(w3.takeSignals('c', 2).taskClosed).toBe(false);
  });

  it('长间隔用"距上次活动"，不是"距上次用户消息"（长工具轮不被误判成被晾）', () => {
    const w = new TurnWatcher(CFG);
    w.observe('a', { type: 'user/message', data: { source: { kind: 'user' }, content: 'x' } }, 0);
    w.takeSignals('a', 1);
    w.observe('a', { type: 'tool/call', data: { callId: 'c', name: 'build' } }, 100_000);
    const signals = w.takeSignals('a', 150_000);
    expect(signals.gapMs).toBeLessThan(180_000); // 有活动 ⇒ 不算长间隔
    expect(signals.facts.tool).toBe('build');
  });

  it('未知事件/未知形状一律忽略，不猜字段', () => {
    const w = new TurnWatcher(CFG);
    for (const event of [{ type: 'weird/event' }, { type: 'tool/call' }, { type: 'tool/result', data: {} }, { type: 'user/message', data: null }] as RawEvent[]) {
      w.observe('a', event, 1);
    }
    expect(w.takeSignals('a', 2).toolCalls).toBe(1);
    expect(() => w.release('a')).not.toThrow();
  });
});

describe('每轮编译接到 watcher 之后', () => {
  it('插话轮在默认人格下会记一条（salience=2 ⇒ 带 strong 反应）', () => {
    const w = new TurnWatcher(CFG);
    w.observe('a', { type: 'turn/start', data: { turn: 3 } }, 1);
    w.observe('a', { type: 'user/message', data: { source: { kind: 'user' }, content: '等等' } }, 2);
    const compiled = compileTurn(w.takeSignals('a', 3), DEFAULT_PERSONA, CFG);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok || compiled.draft === undefined) throw new Error('应有草稿');
    expect(compiled.draft.trigger).toBe('user_interruption');
    expect(compiled.draft.reaction).toBe('strong');
    expect(compiled.draft.lane).toBe('live');
  });

  it('空档轮（无任何活动）编译出中性且默认不记', () => {
    const w = new TurnWatcher(CFG);
    const compiled = compileTurn(w.takeSignals('nobody', 5), DEFAULT_PERSONA, CFG);
    expect(compiled.ok && compiled.draft).toBeUndefined();
  });
});

describe('近因路与打分', () => {
  it('按新→旧取前 N，被取代与空句不进', () => {
    const lines = recentLines(
      [entry({ id: 'a', tsMs: 100 }), entry({ id: 'b', tsMs: 200, text: '第二条' }), entry({ id: 'c', tsMs: 300, supersededBy: 'b' }), entry({ id: 'd', tsMs: 50, text: '  ' })],
      { now: 300, halfLifeMs: 1000, limit: 2 },
    );
    expect(lines).toEqual(['第二条', '手边的动作没成。']);
  });

  it('同分按 id 稳定序（打乱输入顺序结果不变）', () => {
    const opts = { now: 100, halfLifeMs: 0, limit: 3 };
    const a = entry({ id: 'x', tsMs: 5 });
    const b = entry({ id: 'y', tsMs: 5 });
    expect(recentLines([a, b], opts)).toEqual(recentLines([b, a], opts));
  });

  it('空查询不值得走历史路', () => {
    expect(queryWorthRecall('   ')).toBe(false);
    expect(queryWorthRecall('投递脚本')).toBe(true);
    expect(queryWorthRecall('a，。')).toBe(false);
  });
});

describe('跨会话基调', () => {
  it('少于两条不给；足够时只引用确实写过的最后一句', () => {
    expect(previousTone([entry()], { maxChars: 120 })).toBe('');
    const tone = previousTone([entry({ id: 'p', text: '第一句。' }), entry({ id: 'q', tsMs: 2, text: '最后一句。' })], { maxChars: 120 });
    expect(tone).toContain('最后一句。');
    expect(tone).toContain('收尾在');
    expect(previousTone([entry({ id: 'r', text: '' })], { maxChars: 120 })).toBe('');
  });
});

describe('SessionModeStore', () => {
  let dir = '';
  let handle: DatabaseSync | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spirit-modes-'));
  });
  afterEach(() => {
    handle?.close();
    handle = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('off 与 bypass 正交：off 时 bypass 失效（关功能优先）', () => {
    const modes = new SessionModeStore({ dataDir: dir, logger });
    expect(modes.isBypass('s1')).toBe(false);
    modes.set('s1', { bypass: true });
    expect(modes.isBypass('s1')).toBe(true);
    modes.set('s1', { off: true, bypass: true });
    expect(modes.isOff('s1')).toBe(true);
    expect(modes.isBypass('s1'), 'off 才是完全不参与').toBe(false);
  });

  it('全清 ⇒ 删条目（跟随全局），文件只增不减的形状被挡住', () => {
    const modes = new SessionModeStore({ dataDir: dir, logger });
    modes.set('s2', { bypass: true });
    expect(modes.size()).toBe(1);
    modes.set('s2', {});
    expect(modes.size()).toBe(0);
    expect(modes.get('s2')).toEqual({});
  });

  it('持久化后重载一致；损坏文件退回空表不抛', () => {
    const modes = new SessionModeStore({ dataDir: dir, logger });
    modes.set('s3', { off: true });
    const reloaded = new SessionModeStore({ dataDir: dir, logger });
    expect(reloaded.isOff('s3')).toBe(true);
    const store4 = new SessionModeStore({ dataDir: dir, logger });
    store4.invalidate();
    expect(store4.size()).toBe(1);
  });
});

describe('历史路（真实库 + 假 DRSC）', () => {
  let dir = '';
  let handle: DatabaseSync | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spirit-hist-'));
  });
  afterEach(() => {
    handle?.close();
    handle = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function store(): ExperienceStore {
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('库应可打开');
    handle = opened.db;
    return new ExperienceStore({ db: opened.db, logger });
  }

  it('无 DRSC 时只用自家条目；命中不到就整段空', async () => {
    const s = store();
    s.append({ id: 'k1', sessionId: 's1', workspaceId: 'w1', turnSeq: 1, tsMs: 5, personaRevision: 1 }, {
      trigger: 'tool_failure', notice: 'environment', reaction: 'mild', text: 'pnpm-build 那下没成。', lane: 'live', fact: { tool: 'pnpm-build' },
    });
    const result = await recallHistory({ store: s }, { query: 'pnpm-build', sessionId: 's1', limit: 3, maxCharsPerEntry: 120, timeoutMs: 500, now: 10 });
    expect(result.excerpts).toEqual(['pnpm-build 那下没成。']);
    expect(result.laneUsed).toBe('local');
    expect(result.sourceRefs[0]).toBe('spirit:k1');
    const miss = await recallHistory({ store: s }, { query: '不存在的词', sessionId: 's1', limit: 3, maxCharsPerEntry: 120, timeoutMs: 500, now: 10 });
    expect(miss.excerpts).toEqual([]);
    expect(miss.laneUsed).toBe('none');
  });

  it('DRSC 可用时补历史原文；不可用/超时都不编造', async () => {
    const s = store();
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ ok: true, hits: [
      { session_id: 's0', seq: 9, kind: 'user/message', rank: 0, snippet: '先把投递的事放一放', time: 1, on_surface: 1, turn: 2 },
      { session_id: 's0', seq: 10, kind: 'user/message', rank: 1, snippet: `${SPIRIT_CARD_SIGNATURE} 混进来的自家卡`, time: 2, on_surface: 1, turn: 2 },
    ] }) })) as unknown as typeof fetch;
    const client = new DrscClient({ fetchImpl });
    const probe = new DrscProbe({ client, enabled: () => true, ttlMs: () => 15_000 });
    const result = await recallHistory({ store: s, client, probe }, { query: '投递', limit: 3, maxCharsPerEntry: 120, timeoutMs: 500, now: 10 ** 12 });
    expect(result.excerpts).toEqual(['先把投递的事放一放']);
    expect(result.excerpts.some((text) => isOwnCardText(text))).toBe(false);
    expect(result.sourceRefs[0]).toBe('drsc:s0:9');
    expect(result.laneUsed).toBe('drsc');

    const deadProbe = new DrscProbe({ client: new DrscClient({ fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch }), enabled: () => true, ttlMs: () => 0 });
    const off = await recallHistory({ store: s, client, probe: deadProbe }, { query: '投递', limit: 3, maxCharsPerEntry: 120, timeoutMs: 500, now: 10 });
    expect(off.excerpts).toEqual([]);
    expect(off.laneUsed).toBe('none');
  });

  it('exclude 让同句不重复出现在两段', async () => {
    const s = store();
    s.append({ id: 'z1', sessionId: 's1', workspaceId: 'w1', turnSeq: 1, tsMs: 5, personaRevision: 1 }, {
      trigger: 'recovery', notice: 'task_progress', reaction: 'mild', text: '那次过了。', lane: 'live', fact: {},
    });
    const result = await recallHistory({ store: s }, { query: '那次过了', limit: 3, maxCharsPerEntry: 120, timeoutMs: 500, now: 10, exclude: new Set(['那次过了。']) });
    expect(result.excerpts).toEqual([]);
  });
});
