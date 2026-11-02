/**
 * v0.2 编排集成：淡出的 unchanged 稳定性、bias 两臂等形、未竟账首轮带出。
 */
import { describe, expect, it } from 'vitest';

import { Spirit, type PreStepInput } from '../src/spirit.js';
import { TurnWatcher } from '../src/experience/watcher.js';
import { ExperienceStore } from '../src/store/experience.js';
import { DEFAULT_PERSONA } from '../src/persona/types.js';
import { SPIRIT_DEFAULTS, type FadeStats, type SpiritConfig, type SpiritLiveSettings } from '../src/contract.js';
import { isOwnCardText } from '../src/slot/render.js';
import type { ExperienceEntry } from '../src/types.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };

function deepCfg(patch: { recall?: Partial<SpiritConfig['recall']>; ledger?: Partial<SpiritConfig['ledger']>; bias?: Partial<SpiritConfig['bias']> } = {}, live?: Partial<SpiritLiveSettings>): () => SpiritConfig {
  const base: SpiritConfig = structuredClone(SPIRIT_DEFAULTS);
  return () => ({
    ...base,
    recall: { ...base.recall, ...patch.recall },
    ledger: { ...base.ledger, ...patch.ledger },
    bias: { ...base.bias, ...patch.bias },
    live: { ...base.live, ...live },
  });
}

interface Harness {
  spirit: Spirit;
  store: ExperienceStore;
  watcher: TurnWatcher;
  fades: FadeStats[];
  seed(entries: ExperienceEntry[]): void;
  ledgerSettles: number;
  cfgProbe: () => SpiritConfig;
}

function harness(opts: { cfg?: () => SpiritConfig; seed?: ExperienceEntry[]; ledgerLine?: string; biasBand?: number } = {}): Harness {
  const store = new ExperienceStore({ db: null, logger });
  const watcher = new TurnWatcher({ gapThresholdMs: 180_000 });
  const fades: FadeStats[] = [];
  let seeded = opts.seed ?? [];
  const spirit = new Spirit(
    {
      cfg: opts.cfg ?? deepCfg(),
      live: () => (opts.cfg ?? deepCfg())().live,
      store,
      watcher,
      modes: { isOff: () => false, isBypass: () => false },
      history: { store },
      logger,
      recentEntries: (_sessionId, k) => seeded.slice(-k),
      previousEntries: () => [],
      ledgerLine: opts.ledgerLine === undefined ? undefined : () => opts.ledgerLine,
      biasBand: opts.biasBand === undefined ? undefined : () => opts.biasBand,
      onFadeStats: (_agentId, stats) => { fades.push(stats); },
      onLedgerSettle: () => { harnessRef.ledgerSettles += 1; },
    },
    DEFAULT_PERSONA,
  );
  const harnessRef: Harness = { spirit, store, watcher, fades, seed: (e) => { seeded = e; }, ledgerSettles: 0, cfgProbe: () => (opts.cfg ?? deepCfg())() };
  return harnessRef;
}

function entry(over: Partial<ExperienceEntry> & { id: string }): ExperienceEntry {
  return {
    sessionId: 's1', workspaceId: 'w1', turnSeq: 1, tsMs: 0,
    trigger: 'tool_failure', notice: 'self_mistake', reaction: 'mild',
    text: '手边的动作没成，我记着这一下', gist: '有一次没走通，我记着', salience: 2,
    fact: { tool: 'bash' }, lane: 'live', personaRevision: 1, updatedAt: 0, ...over,
  } as ExperienceEntry;
}

function input(over: Partial<PreStepInput> = {}): PreStepInput {
  return {
    agentId: 'a1', sessionId: 's1', workspaceId: 'w1', ownerId: 's1', isSubagent: false,
    newUserText: '继续', messageCount: 1, now: 1_000, ...over,
  };
}

/** 注意：`fadeHalfLifeMs` 属 volatile 接管键（面板六腿）——eff 里 live 值盖静态值，
 * 测试要同时给两节，否则静态的 1_000 会被缺省 5.4M 静默掉（本轮调这就是真实踩坑）。 */
const FADE_ON = { recall: { fadeEnabled: true, fadeHalfLifeMs: 1_000 }, live: { fadeEnabled: true, fadeHalfLifeMs: 1_000 } } as const;

/** 两段式生效：note → confirm 都要模拟（只注 messageId 不登记指纹 = 永远不确认，每轮重发是既定语义）。 */
async function step(h: Harness, over: Partial<PreStepInput>) {
  const out = await h.spirit.onPreStep(input(over));
  if (out.kind === 'injected') {
    const mid = `m-${over['now'] ?? 0}`;
    h.spirit.noteInjected(over.agentId ?? 'a1', mid, out.fingerprint);
    h.spirit.confirmInjected(mid, 1);
  }
  return out;
}

describe('刀1 集成：淡出档内不重发（量化纪律的编排面回归）', () => {
  it('fadeEnabled=true：同档跨多个半衰期 ⇒ 确认后的档内轮 unchanged（now 漂移不破门）', async () => {
    const h = harness({ cfg: deepCfg({ recall: { fadeEnabled: true, fadeHalfLifeMs: 1_000 } }, { fadeEnabled: true, fadeHalfLifeMs: 1_000 }) });
    h.seed([entry({ id: 'x1', tsMs: 0, salience: 2 })]);
    const first = await step(h, { now: 500 });
    expect(first.kind).toBe('injected');
    const second = await step(h, { now: 1_500 });
    expect(second.kind).toBe('injected');
    const third = await step(h, { now: 2_500 });
    expect(third.kind + ':' + third.reason).toBe('passthrough:unchanged');
    void second;
    expect(h.fades.length).toBeGreaterThanOrEqual(1);
    expect(h.fades[0]?.pool).toBe(1);
  });

  it('fadeEnabled=false：与 v0.1 同路径（形态恒 full，指纹不带档名）', async () => {
    const off = harness({ cfg: deepCfg() });
    off.seed([entry({ id: 'x1', tsMs: 0 })]);
    const one = await step(off, { now: 500 });
    const two = await step(off, { now: 501 });
    expect(one.kind).toBe('injected');
    expect(two.kind).toBe('passthrough');
    expect(two.reason).toBe('unchanged');
    expect(off.fades.length, '关闸时不该有淡出计数上报').toBe(0);
  });

  it('gist 降级后卡文本仍可被 isOwnCardText 识别（签名行不受形态影响）', async () => {
    const h = harness({ cfg: deepCfg({ recall: { fadeEnabled: true, fadeHalfLifeMs: 1_000, fadeFullMinScore: 999 } }, { fadeEnabled: true, fadeHalfLifeMs: 1_000 }) });
    h.seed([entry({ id: 'x1', tsMs: 0, salience: 2 })]);
    const one = await step(h, { now: 1_500 });
    expect(one.kind).toBe('injected');
    if (one.kind === 'injected') {
      expect(isOwnCardText(one.text)).toBe(true);
      expect(one.text).toContain('有一次没走通，我记着'); // gist 行而非原文（fadeFullMinScore=999 让 full 不可达）
    }
  });
});

describe('刀4 集成：bias 只经卡文本通道', () => {
  it('bias 开/关两臂 ⇒ PreStepOutcome 除 text 外全等（两臂都开淡出，隔离变量）', async () => {
    const seed = [entry({ id: 'x1', tsMs: 0 })];
    const on = harness({ cfg: deepCfg({ ...FADE_ON, bias: { enabled: true } }, FADE_ON.live), biasBand: 2 });
    on.seed(seed);
    const off = harness({ cfg: deepCfg({ ...FADE_ON }, FADE_ON.live), biasBand: 2 });
    off.seed(seed);
    const a = await on.spirit.onPreStep(input({ now: 500 }));
    const b = await off.spirit.onPreStep(input({ now: 500 }));
    expect(a.kind).toBe('injected');
    expect(b.kind).toBe('injected');
    if (a.kind === 'injected' && b.kind === 'injected') {
      expect(a.fingerprint).toBe(b.fingerprint); // 指纹不掺倾向短语外的语义
      expect(a.text).not.toBe(b.text);
      expect(a.text).toContain('绕开');
      expect(b.text).not.toContain('绕开');
    }
  });

  it('turn/end 冷写：tool_failure 带工具名 ⇒ 结算里 upsert；未走 pre-step 不写', async () => {
    const upserts: Array<{ key: string; band: number }> = [];
    const store = new ExperienceStore({ db: null, logger });
    const watcher = new TurnWatcher({ gapThresholdMs: 180_000 });
    const spirit = new Spirit(
      {
        cfg: deepCfg({ ...FADE_ON, bias: { enabled: true } }, FADE_ON.live),
        live: () => deepCfg({ ...FADE_ON, bias: { enabled: true } }, FADE_ON.live)().live,
        store, watcher,
        modes: { isOff: () => false, isBypass: () => false },
        history: { store }, logger,
        recentEntries: () => [], previousEntries: () => [],
        onBiasUpsert: (_w, actionKey, band) => { upserts.push({ key: actionKey, band }); },
      },
      DEFAULT_PERSONA,
    );
    spirit.observeEvent('s1', { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '跑一下' }] } }, 100);
    spirit.observeEvent('s1', { type: 'turn/start', data: { turn: 2 } }, 105);
    spirit.observeEvent('s1', { type: 'tool/call', data: { callId: 'c1', name: 'bash' } }, 110);
    spirit.observeEvent('s1', { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: true } } }, 120);
    // 记账上下文只有 pre-step 能给（turnCtx 在 runPreStep 里登记）：先走一轮再结算
    await spirit.onPreStep(input({ now: 130, newUserText: '', messageCount: 1 }));
    spirit.observeEvent('s1', { type: 'turn/end', data: {} }, 200);
    expect(upserts).toEqual([{ key: 'bash', band: 1 }]); // mild ⇒ 1 档（DEFAULT_PERSONA 对 tool_failure 的 salience=1）
  });
});

describe('刀3 集成：未竟账首轮带出与闸链', () => {
  it('ledgerLine 有值 ⇒ 开场段带出；无值 ⇒ 卡内不出现空"开场："行', async () => {
    const withLedger = harness({ cfg: deepCfg({ ...FADE_ON, ledger: { enabled: true } }, FADE_ON.live), ledgerLine: '上次有一条线停在没收口的地方，我没放下' });
    withLedger.seed([entry({ id: 'x1', tsMs: 0 })]);
    const a = await withLedger.spirit.onPreStep(input({ now: 500 }));
    expect(a.kind).toBe('injected');
    if (a.kind === 'injected') expect(a.text).toContain('开场：上次有一条线停在没收口的地方');
    const noLedger = harness({ cfg: deepCfg({ ...FADE_ON, ledger: { enabled: true } }, FADE_ON.live) });
    noLedger.seed([entry({ id: 'x1', tsMs: 0 })]);
    const b = await noLedger.spirit.onPreStep(input({ now: 500 }));
    if (b.kind === 'injected') expect(b.text).not.toContain('开场：');
  });

  it('总闸未开（live.fadeEnabled=false）⇒ 即便静态开了 ledger 也不结算入账', async () => {
    const h = harness({ cfg: deepCfg({ ledger: { enabled: true } }, { fadeEnabled: false }), ledgerLine: '不该出现' });
    h.seed([entry({ id: 'x1', tsMs: 0 })]);
    h.watcher.observe('s1', { type: 'todo/write', data: { todos: [{ status: 'pending' }] } }, 100);
    h.spirit.settleLedger('s1', 'w1', 2, 200);
    h.spirit.settleOnDispose('a1', 300);
    expect(h.ledgerSettles).toBe(0);
  });

  it('灰度全开且有快照 ⇒ dispose 前结算一行；无快照 ⇒ 一行不落', async () => {
    const h = harness({ cfg: deepCfg({ ...FADE_ON, ledger: { enabled: true } }, FADE_ON.live) });
    await step(h, { now: 500 }); // 建 sessionToAgent/ledgerCtx
    expect(h.watcher.openLoops('s1'), '前置：此时还没见过快照').toBeUndefined();
    // 先无快照：不入账
    h.spirit.settleOnDispose('a1', 501);
    expect(h.ledgerSettles).toBe(0);
    // 后有快照：入账一行（todo/write 也要走 spirit.observeEvent 才进采集器）
    h.spirit.observeEvent('s1', { type: 'todo/write', data: { todos: [{ status: 'in_progress' }] } }, 502);
    expect(h.watcher.openLoops('s1'), '前置：快照已进采集器').toEqual({ open: 1, inProgress: 1 });
    h.spirit.settleOnDispose('a1', 504);
    expect(h.ledgerSettles).toBe(1);
    // takeSignals 不再被结算路使用：快照不会被中间读吃掉
    h.spirit.settleOnDispose('a1', 505);
    expect(h.ledgerSettles, '重复结算仍可入账（幂等由 id 在存储层收敛）').toBe(2);
  });
});
