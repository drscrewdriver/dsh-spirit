import { describe, expect, it } from 'vitest';

import { DrscClient, DrscClientError } from '../src/drsc/client.js';
import { DrscProbe } from '../src/drsc/probe.js';
import { decayWeight, hitToCandidate, rowToCandidate, roleOfKind, selectCandidates, type RecallCandidate } from '../src/drsc/segments.js';
import { VERDICT_OK, VERDICT_SKIPPED, VERDICT_WARN } from '../src/types.js';

function clientReturning(status: () => Promise<unknown>): DrscClient {
  const fetchImpl = (async () => ({ ok: true, json: async () => status() })) as unknown as typeof fetch;
  return new DrscClient({ fetchImpl });
}

function clientThrowing(err: Error): DrscClient {
  const fetchImpl = (async () => {
    throw err;
  }) as unknown as typeof fetch;
  return new DrscClient({ fetchImpl });
}

describe('DrscProbe 判定四值', () => {
  it('配置关了 ⇒ skipped（中性无据，不该出现在故障提示里）', async () => {
    let called = 0;
    const spy = new DrscClient({ fetchImpl: (async () => { called += 1; return { ok: true, json: async () => ({ ok: true }) }; }) as unknown as typeof fetch });
    const probe = new DrscProbe({ client: spy, enabled: () => false, ttlMs: () => 15_000 });
    const result = await probe.check();
    expect(result.verdict).toBe(VERDICT_SKIPPED);
    expect(called, '关了就不该打网络').toBe(0);
  });

  it('status 通 ⇒ ok；usable 与 verdict 一致', async () => {
    const probe = new DrscProbe({ client: clientReturning(async () => ({ ok: true, session_count: 3 })), enabled: () => true, ttlMs: () => 15_000 });
    expect((await probe.check()).verdict).toBe(VERDICT_OK);
    expect(await probe.usable()).toBe(true);
  });

  it('last_sync.ok=false ⇒ warn（collector 在但投影链坏了），未知不算失败', async () => {
    const failing = new DrscProbe({
      client: clientReturning(async () => ({ ok: true, sessions: 3, last_sync: { ok: false, busy: false } })),
      enabled: () => true,
      ttlMs: () => 15_000,
    });
    const result = await failing.check();
    expect(result.verdict).toBe(VERDICT_WARN);
    expect(result.reason).toContain('同步失败');
    expect(await failing.usable()).toBe(false);
    // 没带 last_sync 的旧版/异形响应：未知 ⇒ 仍然是 ok（把未知当异常就是一屏假故障）
    const unknown = new DrscProbe({ client: clientReturning(async () => ({ ok: true, sessions: 1 })), enabled: () => true, ttlMs: () => 15_000 });
    expect((await unknown.check()).verdict).toBe(VERDICT_OK);
  });

  it('探测路径永不产出 fail：不可达 ⇒ warn（有据可疑），不抛穿', async () => {
    const probe = new DrscProbe({ client: clientThrowing(new DrscClientError('collector 不可达')), enabled: () => true, ttlMs: () => 15_000 });
    const result = await probe.check();
    expect(result.verdict).toBe(VERDICT_WARN);
    expect(result.reason).toContain('不可达');
    expect(await probe.usable()).toBe(false);
  });

  it('TTL 内不重复打网络；invalidate 后重探', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return { ok: true, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;
    let clock = 1_000;
    const probe = new DrscProbe({ client: new DrscClient({ fetchImpl }), enabled: () => true, ttlMs: () => 15_000, now: () => clock });
    await probe.check();
    await probe.check();
    expect(calls).toBe(1);
    clock = 20_000;
    await probe.check();
    expect(calls, '过了 TTL 该重探').toBe(2);
    probe.invalidate();
    await probe.check();
    expect(calls).toBe(3);
  });

  it('enabled 每次现读（热更开关立刻生效，不缓存旧结论）', async () => {
    let on = true;
    const probe = new DrscProbe({ client: clientReturning(async () => ({ ok: true })), enabled: () => on, ttlMs: () => 0 });
    expect((await probe.check()).verdict).toBe(VERDICT_OK);
    on = false;
    expect((await probe.check()).verdict).toBe(VERDICT_SKIPPED);
  });
});

describe('近因权重', () => {
  it('有地板：再久也只降到 0.5，相关但久远的回忆不该彻底沉底', () => {
    expect(decayWeight(0, 1_000_000_000, 5_400_000)).toBe(0.5);
  });

  it('一个半衰期 ⇒ 0.5；半程 ⇒ 约 0.707', () => {
    expect(decayWeight(0, 1_000, 1_000)).toBeCloseTo(0.5, 6);
    expect(decayWeight(0, 500, 1_000)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('halfLifeMs<=0 关闭衰减且返回 1（不改名次）', () => {
    expect(decayWeight(0, 10 ** 12, 0)).toBe(1);
    expect(decayWeight(0, 10 ** 12, -1)).toBe(1);
  });

  it('未来时间戳（时钟回拨/机器不同步）不倒挂成超大权重', () => {
    expect(decayWeight(2_000, 1_000, 1_000)).toBe(1);
  });
});

describe('行 → 候选', () => {
  const base = { now: 1_000_000, halfLifeMs: 5_400_000, maxChars: 40, isOwnCard: (t: string) => t.includes('角色体验快照') };

  it('只留对话行，其它 kind 直接丢（工具调用行有正文但没叙事价值）', () => {
    expect(roleOfKind('tool/call')).toBeUndefined();
    expect(rowToCandidate('s1', { seq: 1, turn: 1, step: 0, kind: 'tool/call', role: '', time: 0, text: '{}' }, base)).toBeUndefined();
    expect(rowToCandidate('s1', { seq: 1, turn: 1, step: 0, kind: 'user/message', role: 'user', time: 0, text: '你好' }, base)?.role).toBe('user');
  });

  it('锚点用调用方传的 sessionId + 行 seq，不是 turn（拼错就回溯不到原行）', () => {
    const c = rowToCandidate('会话A', { seq: 7, turn: 3, step: 1, kind: 'assistant/message', role: 'assistant', time: 0, text: '好' }, base);
    expect(c?.sourceRef).toBe('drsc:会话A:7');
  });

  it('回声过滤：自家卡行不被当历史原文记回来', () => {
    const own = { seq: 9, turn: 4, step: 0, kind: 'user/message', role: 'user', time: 0, text: '（角色体验快照 · 取代先前快照）\n状态：微倦' };
    expect(rowToCandidate('s1', own, base)).toBeUndefined();
  });

  it('excerpt 去首尾空白并按 maxChars 截断', () => {
    const long = `  ${'啊'.repeat(60)}  `;
    const c = rowToCandidate('s1', { seq: 1, turn: 1, step: 0, kind: 'user/message', role: 'user', time: 0, text: long }, base);
    expect(c?.excerpt).toBe('啊'.repeat(40));
  });

  it('检索命中的名次先验随 rank 单调下降', () => {
    const first = hitToCandidate({ sessionId: 's', seq: 1, kind: 'user/message', rank: 0, snippet: 'a', timeMs: 0, onSurface: 1, turn: 1 }, base);
    const third = hitToCandidate({ sessionId: 's', seq: 2, kind: 'user/message', rank: 2, snippet: 'b', timeMs: 0, onSurface: 1, turn: 1 }, base);
    expect(first?.rankPrior).toBe(1);
    expect(third?.rankPrior).toBeCloseTo(1 / 3, 6);
  });
});

describe('selectCandidates', () => {
  const cand = (sourceRef: string, timeMs: number, rankPrior = 1): RecallCandidate => ({
    sourceRef,
    lane: 'drsc',
    timeMs,
    excerpt: 'x',
    rankPrior,
  });

  it('新鲜者优先（同先验下时间新的排前）', () => {
    const picked = selectCandidates([cand('a', 0), cand('b', 900_000)], { now: 1_000_000, halfLifeMs: 5_400_000 }, 2);
    expect(picked.map((c) => c.sourceRef)).toEqual(['b', 'a']);
  });

  it('maxResults 生效且负数/0 不返回任何候选', () => {
    const list = [cand('a', 0), cand('b', 1), cand('c', 2)];
    expect(selectCandidates(list, { now: 10, halfLifeMs: 1_000 }, 2)).toHaveLength(2);
    expect(selectCandidates(list, { now: 10, halfLifeMs: 1_000 }, 0)).toEqual([]);
  });

  it('同分按 sourceRef 稳定排序（不稳定会直接破"同召回两次卡文本字节全等"）', () => {
    const a = cand('z-old', 500, 0.5);
    const b = cand('a-old', 500, 0.5);
    const first = selectCandidates([a, b], { now: 1_000, halfLifeMs: 5_400_000 }, 2);
    const second = selectCandidates([b, a], { now: 1_000, halfLifeMs: 5_400_000 }, 2);
    expect(first.map((c) => c.sourceRef)).toEqual(second.map((c) => c.sourceRef));
  });
});
