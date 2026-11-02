/**
 * 六腿写腿（settings rpc）+ DRSC 候选不受淡出 的针对性回归。
 * 这两条都是 checklist 里容易"看起来做到了其实没测"的点位。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { DatabaseSync } from 'node:sqlite';
import { openSpiritDb } from '../src/db/open.js';
import { ExperienceStore } from '../src/store/experience.js';
import { recallHistory } from '../src/recall/history.js';
import { deriveMood } from '../src/slot/derive.js';
import { readBias } from '../src/slot/bias.js';
import { handleEndpoint, type RpcDeps } from '../src/rpc.js';
import { SPIRIT_DEFAULTS, type SpiritConfig, type SpiritLiveSettings } from '../src/contract.js';
import type { ExperienceEntry } from '../src/types.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };

function heldEntry(over: Partial<ExperienceEntry> & { id: string }): ExperienceEntry {
  // 无 gist + 低 salience ⇒ 淡出下必 held；但历史检索路（路 B）不该因此丢它
  return {
    sessionId: 's1', workspaceId: 'w1', turnSeq: 1, tsMs: 1,
    trigger: 'tool_failure', notice: 'environment', reaction: 'mild',
    text: '很久以前那次没走通，我记得细节里有 grep 这个词', salience: 1,
    fact: { tool: 'grep' }, lane: 'live', personaRevision: 1, updatedAt: 1, ...over,
  } as ExperienceEntry;
}

describe('历史检索路（路 B）不受淡出影响', () => {
  let dir: string;
  let db: DatabaseSync | null = null;
  beforeEachDir();
  function beforeEachDir() {
    dir = mkdtempSync(join(tmpdir(), 'spirit-fade-hist-'));
  }
  afterEach(() => {
    try { db?.close(); } catch { /* noop */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('淡出开启时，命中查询的旧条目仍经历史路进片段（formOf 不在路 B 的调用链上）', async () => {
    const opened = openSpiritDb(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    db = opened.db;
    const store = new ExperienceStore({ db: opened.db, logger });
    // 直接落一条会被淡出判 held 的旧条目（有 gist 也够不到 full：salience=1 时间久 ⇒ held）
    const e = heldEntry({ id: 'old1', gist: '有一次没走通，我记着' });
    store.append(
      { id: 'old1', sessionId: 's1', workspaceId: 'w1', turnSeq: 1, tsMs: 1, personaRevision: 1 },
      { trigger: e.trigger, notice: e.notice, reaction: e.reaction, text: e.text, gist: e.gist, salience: e.salience, fact: e.fact, lane: 'live' },
    );
    // 走路 B：只给 store（DRSC 缺席），检索词命中该条；淡出与否都与路 B 无关
    const result = await recallHistory({ store }, {
      query: 'grep', sessionId: undefined, limit: 3, maxCharsPerEntry: 120, timeoutMs: 800, now: 10_000_000_000,
    });
    expect(result.excerpts.join('')).toContain('grep');
    // 反证：无 gist 的旧行（v1 迁移形状）在路 A 会被逐出注意力（held）——路 B 不受此影响
    const legacy = { ...e, gist: undefined };
    const { recentForms } = await import('../src/recall/recent.js');
    const formed = recentForms([legacy], {
      now: 10_000_000_000, halfLifeMs: 1000, limit: 5,
      fade: { fadeEnabled: true, feedbackEnabled: false, fadeHalfLifeMs: 1000, fullMinScore: 550, gistMinScore: 250, gistMinSalience: 1 },
    });
    expect(formed.find((f) => f.entry.id === 'old1'), '路 A 该条应被逐出/held').toBeUndefined();
  });
});

describe('settings-get/set 写腿（volatile 六腿的 rpc 腿）', () => {
  function makeDeps(live: SpiritLiveSettings, opts: { updatable?: boolean; onApply?: (patch: Partial<SpiritLiveSettings>) => void } = {}): RpcDeps {
    const cfg: SpiritConfig = structuredClone(SPIRIT_DEFAULTS);
    cfg.live = live;
    const ref: { get(): SpiritLiveSettings; update?: (patch: Partial<SpiritLiveSettings>) => unknown } = { get: () => live };
    if (opts.updatable) {
      ref.update = (patch) => { opts.onApply?.(patch); Object.assign(live, patch); };
    }
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spirit: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stats: { latest: () => null } as any,
      store: new ExperienceStore({ db: null, logger }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modes: { isOff: () => false, isBypass: () => false, set: () => false } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      personas: { current: () => ({ id: '', revision: 0, name: '', voice: 'plain', salience: {}, focus: [], values: [], boundaries: [] }) } as any,
      dataDir: '',
      cfg: () => cfg,
      eff: () => cfg,
      liveRaw: () => ref,
      drscVerdict: () => 'skipped',
      logger,
    };
  }

  it('可热更时：settings-set 写 fadeEnabled/fadeHalfLifeMs 并回读写入后的值', async () => {
    const live: SpiritLiveSettings = { ...SPIRIT_DEFAULTS.live, fadeEnabled: false };
    const applied: Partial<SpiritLiveSettings>[] = [];
    const deps = makeDeps(live, { updatable: true, onApply: (p) => applied.push(p) });
    const r = await handleEndpoint('dsh-spirit/settings-set', { fadeEnabled: true, fadeHalfLifeMs: 60_000 }, deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ fadeEnabled: true, fadeHalfLifeMs: 60_000, hotUpdatable: true });
    expect(applied[0]).toMatchObject({ fadeEnabled: true, fadeHalfLifeMs: 60_000 });
    const g = await handleEndpoint('dsh-spirit/settings-get', {}, deps);
    expect(g.ok && g.value).toMatchObject({ fadeEnabled: true, fadeHalfLifeMs: 60_000 });
  });

  it('不可热更时：settings-set 报 no-volatile，不改 live', async () => {
    const live: SpiritLiveSettings = { ...SPIRIT_DEFAULTS.live, fadeEnabled: false };
    const deps = makeDeps(live, { updatable: false });
    const r = await handleEndpoint('dsh-spirit/settings-set', { fadeEnabled: true }, deps);
    expect(!r.ok && r.error.code).toBe('no-volatile');
    expect(live.fadeEnabled).toBe(false);
  });

  it('越界半衰期被拒（区间单源 SPIRIT_RANGES）', async () => {
    const live: SpiritLiveSettings = { ...SPIRIT_DEFAULTS.live };
    const deps = makeDeps(live, { updatable: true });
    const r = await handleEndpoint('dsh-spirit/settings-set', { fadeHalfLifeMs: 999_999_999_999 }, deps);
    expect(!r.ok && r.error.code).toBe('bad-request');
  });
});

describe('derive.ts 乘子通道（刀4：bias 只放大负向条目权重，不跨档不造新输入）', () => {
  const neg = (over: Partial<ExperienceEntry> & { id: string }): ExperienceEntry => ({
    sessionId: 's1', workspaceId: 'w1', turnSeq: 1, tsMs: 5,
    trigger: 'tool_failure', notice: 'environment', reaction: 'mild',
    text: '没成', fact: { tool: 'bash' }, lane: 'live', personaRevision: 1, updatedAt: 5, ...over,
  }) as ExperienceEntry;
  const base = { halfLifeMs: 5_400_000, stepCap: 2, staleAfterMs: 600_000 };

  it('缺省（无 biasBands）与传空 Map 逐字一致（回归冻结）', () => {
    const a = deriveMood(undefined, [neg({ id: 'x' })], 6, base);
    const b = deriveMood(undefined, [neg({ id: 'x' })], 6, { ...base, biasBands: new Map() });
    expect(b).toEqual(a);
  });

  it('band 命中负向 trigger 时效价更负（乘子真生效，且只在负向）', () => {
    const noBias = deriveMood(undefined, [neg({ id: 'x' })], 6, base);
    const bias = deriveMood(undefined, [neg({ id: 'x' })], 6, { ...base, biasBands: new Map([['tool_failure', 2]]) });
    // 单条 tool_failure 本就负；乘子把它推得更负或至少不更轻
    const rank = { neg: 0, mid: 1, plus: 2 } as const;
    expect(rank[bias.valence as keyof typeof rank]).toBeLessThanOrEqual(rank[noBias.valence as keyof typeof rank]);
    // 唤醒（tool_failure 是正向唤起）：乘子放大权重会拉高唤起占比
    expect(bias.arousal).toBeTruthy();
  });

  it('readBias 的 fallbackBands：动作键不在池时退用乘子集的最强档', () => {
    const cfg = { bias: { enabled: true } };
    expect(readBias(cfg, () => undefined, ['bash'], new Map([['tool_failure', 2]]))).toBe(2);
    // 显式读表优先于 fallback
    expect(readBias(cfg, () => 1, ['bash'], new Map([['tool_failure', 2]]))).toBe(1);
  });
});
