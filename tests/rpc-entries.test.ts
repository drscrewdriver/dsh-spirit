/**
 * 翻阅/做梦端点的参数校验与形状（G8）：handleEndpoint 直调，不经 HTTP。
 * 错误码形状纪律照既有面：业务拒收 = 200 + ok:false 信封（bad-request/not-found/unavailable），
 * 不是 4xx——面板要能把原因说出口，transport 错才是 reject。
 */
import { describe, expect, it } from 'vitest';

import { SPIRIT_DEFAULTS } from '../src/contract.js';
import { PersonaStore } from '../src/persona/store.js';
import { handleEndpoint, type RpcDeps } from '../src/rpc.js';
import { SpiritStats } from '../src/stats.js';
import { ExperienceStore } from '../src/store/experience.js';
import { TRIGGER_TOOL_FAILURE } from '../src/types.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };

function makeDeps(over: Partial<RpcDeps> = {}): RpcDeps {
  return {
    spirit: null as unknown as RpcDeps['spirit'],
    stats: new SpiritStats(),
    store: new ExperienceStore({ db: null, logger }),
    modes: { isOff: () => false, isBypass: () => false, set: () => true } as unknown as RpcDeps['modes'],
    personas: new PersonaStore({ dataDir: '', logger }),
    dataDir: '',
    cfg: () => SPIRIT_DEFAULTS,
    drscVerdict: () => 'skipped' as const,
    logger,
    ...over,
  } as unknown as RpcDeps;
}

function seededStore(): ExperienceStore {
  const store = new ExperienceStore({ db: null, logger });
  store.append(
    { id: 'e1', sessionId: 's1', workspaceId: 'w1', turnSeq: 1, tsMs: 1_000, personaRevision: 1 },
    { trigger: TRIGGER_TOOL_FAILURE, notice: 'environment', reaction: 'mild', text: '手边的动作没成。', fact: {}, lane: 'live' },
  );
  return store;
}

describe('entries 端点参数校验（G8）', () => {
  it('entries-list：非法 trigger/lane ⇒ bad-request；缺省 ⇒ 行 + 首屏 catalogs', async () => {
    const deps = makeDeps({ store: seededStore() });
    const badTrigger = await handleEndpoint('dsh-spirit/entries-list', { trigger: 'no_such_trigger' }, deps);
    expect(badTrigger.ok).toBe(false);
    if (!badTrigger.ok) expect(badTrigger.error.code).toBe('bad-request');
    const badLane = await handleEndpoint('dsh-spirit/entries-list', { lane: 'sqlite' }, deps);
    expect(badLane.ok).toBe(false);
    const listed = await handleEndpoint('dsh-spirit/entries-list', { offset: 0, limit: 50 }, deps);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const value = listed.value as { rows: Array<{ id: string; sessionId?: string; supersededBy?: string | null; hiddenAt?: number | null }>; hasMore: boolean; truncated: boolean; catalogs?: unknown };
      expect(value.rows.map((row) => row.id)).toEqual(['e1']);
      // 与 journal-tail 同一投影：行必须带得出会话/取代/藏起三个解释字段
      expect(value.rows[0]?.sessionId).toBe('s1');
      expect(value.rows[0]?.supersededBy).toBeNull();
      expect(value.rows[0]?.hiddenAt).toBeNull();
      expect(value.hasMore).toBe(false);
      expect(value.truncated).toBe(false);
      expect(value.catalogs).toBeDefined();
    }
    // 非首屏不带 catalogs（词表只在第一页说话）
    const second = await handleEndpoint('dsh-spirit/entries-list', { offset: 50, limit: 50 }, deps);
    expect(second.ok && (second.value as { catalogs?: unknown }).catalogs).toBeUndefined();
  });

  it('entries-hide/unhide：ids 空或非字符串 ⇒ bad-request；正常 ⇒ changed 计数', async () => {
    const deps = makeDeps({ store: seededStore() });
    const empty = await handleEndpoint('dsh-spirit/entries-hide', { ids: [] }, deps);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('bad-request');
    const junk = await handleEndpoint('dsh-spirit/entries-hide', { ids: [1, 2] }, deps);
    expect(junk.ok).toBe(false);
    const hidden = await handleEndpoint('dsh-spirit/entries-hide', { ids: ['e1'] }, deps);
    expect(hidden.ok).toBe(true);
    if (hidden.ok) expect((hidden.value as { changed: number }).changed).toBe(1);
    const unhidden = await handleEndpoint('dsh-spirit/entries-unhide', { ids: ['e1'] }, deps);
    expect(unhidden.ok).toBe(true);
    if (unhidden.ok) expect((unhidden.value as { changed: number }).changed).toBe(1);
  });

  it('entries-update：缺 entryId / 无字段 / salience 越界 ⇒ bad-request；不存在 ⇒ not-found；正常 ⇒ 新行带 ★', async () => {
    const store = seededStore();
    store.setFeedback('e1', 5);
    const deps = makeDeps({ store });
    const noId = await handleEndpoint('dsh-spirit/entries-update', {}, deps);
    expect(noId.ok).toBe(false);
    const noPatch = await handleEndpoint('dsh-spirit/entries-update', { entryId: 'e1' }, deps);
    expect(noPatch.ok).toBe(false);
    const badSalience = await handleEndpoint('dsh-spirit/entries-update', { entryId: 'e1', salience: 7 }, deps);
    expect(badSalience.ok).toBe(false);
    const missing = await handleEndpoint('dsh-spirit/entries-update', { entryId: 'nope', text: 'x' }, deps);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('not-found');
    const updated = await handleEndpoint('dsh-spirit/entries-update', { entryId: 'e1', text: '其实那一下我记岔了。' }, deps);
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      const row = updated.value as { id: string; text: string; feedbackScore: number | null; sourceRef: string | null };
      expect(row.text).toBe('其实那一下我记岔了。');
      expect(row.feedbackScore).toBe(5); // G4 在 rpc 面的回显：★ 跟到新行
      expect(row.sourceRef).toBe('rev:e1');
    }
    // 旧行已成幽灵：再改 ⇒ not-found（编辑不是恢复后门）
    const againGhost = await handleEndpoint('dsh-spirit/entries-update', { entryId: 'e1', text: '再改' }, deps);
    expect(againGhost.ok).toBe(false);
    if (!againGhost.ok) expect(againGhost.error.code).toBe('not-found');
  });

  it('dream-run/dream-report：未装配 ⇒ unavailable 不炸（每端点可分发纪律）', async () => {
    const deps = makeDeps();
    const run = await handleEndpoint('dsh-spirit/dream-run', {}, deps);
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error.code).toBe('unavailable');
    const report = await handleEndpoint('dsh-spirit/dream-report', {}, deps);
    expect(report.ok).toBe(false);
  });

  it('dream-run 双闸拒（v0.3.4）：live.dreamEnabled=false ⇒ updated:false reason disabled，不真跑', async () => {
    const store = seededStore();
    const { DreamRunner } = await import('../src/dream/dream.js');
    const { effectiveCfg } = await import('../src/config.js');
    const raw = structuredClone(SPIRIT_DEFAULTS);
    raw.live.dreamEnabled = false;
    // 拿真 effectiveCfg 出视图：双闸取与是合并层的语义，测试不手拼第二份（手拼就是假绿）
    const effView = effectiveCfg(raw, raw.live);
    const dream = new DreamRunner({ store, db: () => null, dataDir: '', cfg: () => effView, logger });
    const deps = makeDeps({ store, dream, eff: () => effView });
    const run = await handleEndpoint('dsh-spirit/dream-run', {}, deps);
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.value).toMatchObject({ updated: false, reason: 'disabled' });
  });

  it('sea-graph 响应带 drscVerdict（顶栏短提示的单源数据面）', async () => {
    const deps = makeDeps({ store: seededStore() });
    const graph = await handleEndpoint('dsh-spirit/sea-graph', { scope: 'all' }, deps);
    expect(graph.ok).toBe(true);
    if (graph.ok) expect((graph.value as { drscVerdict?: string }).drscVerdict).toBe('skipped');
  });
});
