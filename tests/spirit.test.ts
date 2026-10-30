import { describe, expect, it } from 'vitest';

import { Spirit, type PreStepInput } from '../src/spirit.js';
import { TurnWatcher } from '../src/experience/watcher.js';
import { ExperienceStore } from '../src/store/experience.js';
import { DEFAULT_PERSONA } from '../src/persona/types.js';
import { SPIRIT_DEFAULTS, type SpiritConfig, type SpiritLiveSettings } from '../src/contract.js';
import { isOwnCardText } from '../src/slot/render.js';
import type { ExperienceEntry } from '../src/types.js';
import { registerCardObserve } from '../src/hooks/card-observe.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };

function cfgWith(patch: Partial<SpiritConfig> = {}, live?: Partial<SpiritLiveSettings>): () => SpiritConfig {
  const base: SpiritConfig = structuredClone(SPIRIT_DEFAULTS);
  const merged: SpiritConfig = { ...base, ...patch, live: { ...base.live, ...live } };
  return () => merged;
}

interface Harness {
  spirit: Spirit;
  store: ExperienceStore;
  watcher: TurnWatcher;
  modes: { off: Set<string>; bypass: Set<string>; isOff(s: string): boolean; isBypass(s: string): boolean };
  recent: () => ExperienceEntry[];
}

/** 本套用例一律走内存降级路径（db=null）：门与指纹语义不依赖 SQLite。 */
function harness(opts: { cfg?: () => SpiritConfig; throwOnRecent?: boolean } = {}): Harness {
  const store = new ExperienceStore({ db: null, logger });
  const watcher = new TurnWatcher({ gapThresholdMs: 180_000 });
  const modes = {
    off: new Set<string>(),
    bypass: new Set<string>(),
    isOff(s: string) { return this.off.has(s); },
    isBypass(s: string) { return this.bypass.has(s); },
  };
  let lastEntries: ExperienceEntry[] = [];
  const spirit = new Spirit(
    {
      cfg: opts.cfg ?? cfgWith(),
      live: () => (opts.cfg ?? cfgWith())().live,
      store,
      watcher,
      modes,
      history: { store },
      logger,
      recentEntries: (sessionId, k) => {
        // 故意为真：验“注入链内部抛错不得抛穿主会话”（checklist 的全链 fail-open）
        if (opts.throwOnRecent) throw new Error('存储层抽风');
        lastEntries = store.recent(sessionId, k);
        return lastEntries;
      },
      previousEntries: () => [],
    },
    DEFAULT_PERSONA,
  );
  return { spirit, store, watcher, modes, recent: () => lastEntries };
}

function input(over: Partial<PreStepInput> = {}): PreStepInput {
  return {
    agentId: 'a1', sessionId: 's1', workspaceId: 'w1', ownerId: 's1', isSubagent: false,
    newUserText: '继续', messageCount: 1, now: 1_000, ...over,
  };
}

describe('8 道判定门（逐条）', () => {
  it('门 1 部署上限 cfg.enabled=false ⇒ 零副作用', async () => {
    const h = harness({ cfg: cfgWith({ enabled: false }) });
    const outcome = await h.spirit.onPreStep(input());
    expect(outcome).toEqual({ kind: 'passthrough', reason: 'cfg-off' });
  });

  it('门 2 主闸 live.enabled=false ⇒ 零副作用', async () => {
    const h = harness({ cfg: cfgWith({}, { enabled: false }) });
    expect((await h.spirit.onPreStep(input())).reason).toBe('live-off');
  });

  it('门 3 子代理 ⇒ 不注入（人格不传染）', async () => {
    const h = harness();
    expect((await h.spirit.onPreStep(input({ isSubagent: true }))).reason).toBe('subagent');
  });

  it('门 4 会话 off 档按**所有者**判：父会话 off 时子会话也不注入', async () => {
    const h = harness();
    h.modes.off.add('parent-s');
    const outcome = await h.spirit.onPreStep(input({ ownerId: 'parent-s' }));
    expect(outcome.reason).toBe('session-off');
    // 自己的会话没关 ⇒ 照常
    expect((await h.spirit.onPreStep(input({ ownerId: 's1' }))).kind).not.toBe('passthrough');
  });

  it('门 5a 全局旁路（live.bypass）：条目照常入库，只是不出卡', async () => {
    const h = harness({ cfg: cfgWith({}, { bypass: true }) });
    h.watcher.observe('s1', { type: 'tool/call', data: { callId: 'c1', name: 'bash' } }, 900);
    h.watcher.observe('s1', { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: true } } }, 950);
    const outcome = await h.spirit.onPreStep(input({ now: 1_000, messageCount: 1 }));
    expect(outcome).toEqual({ kind: 'recorded', reason: 'bypass' });
    expect(h.store.count('s1'), '旁路必须留数据，否则归因实验没有对照组').toBe(1);
  });

  it('门 5b 会话级旁路同样生效（与全局开关两入口都要读）', async () => {
    const h = harness();
    h.modes.bypass.add('s1');
    h.watcher.observe('s1', { type: 'tool/call', data: { callId: 'c1', name: 'bash' } }, 900);
    h.watcher.observe('s1', { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: true } } }, 950);
    expect(await h.spirit.onPreStep(input())).toEqual({ kind: 'recorded', reason: 'bypass' });
    expect(h.store.count('s1')).toBe(1);
  });

  it('门 5c 卡总闸关掉：照常记录，但 reason 与旁路区分开', async () => {
    const h = harness({ cfg: cfgWith({}, { cardEnabled: false }) });
    h.watcher.observe('s1', { type: 'tool/call', data: { callId: 'c9', name: 'bash' } }, 900);
    h.watcher.observe('s1', { type: 'tool/result', data: { message: { toolCallId: 'c9', isError: true } } }, 950);
    expect(await h.spirit.onPreStep(input())).toEqual({ kind: 'recorded', reason: 'card-off' });
    expect(h.store.count('s1')).toBe(1);
  });

  it('门 6 纯工具步（无新消息）⇒ 完全不打扰，也不记录', async () => {
    const h = harness();
    const outcome = await h.spirit.onPreStep(input({ messageCount: 0 }));
    expect(outcome.reason).toBe('no-new-user');
    expect(h.store.count('s1')).toBe(0);
  });

  it('注入链内部抛错 ⇒ passthrough(error)，不抛穿主会话（fail-open）', async () => {
    // 实现里 spirit.ts 的 catch 返 `{kind:'passthrough', reason:'error'}`，但此前**没有用例**：
    // 异常路径没验就等于“情绪功能够了就会把会话弄挂”这个风险没人守。
    const h = harness({ throwOnRecent: true });
    await expect(h.spirit.onPreStep(input())).resolves.toEqual({ kind: 'passthrough', reason: 'error' });
  });

  it('门 8 默认人格下中性轮不记，但会发一张"平常"档的卡（首轮无指纹可比）', async () => {
    const h = harness();
    const outcome = await h.spirit.onPreStep(input());
    expect(outcome.kind).toBe('injected');
    if (outcome.kind !== 'injected') return;
    expect(isOwnCardText(outcome.text)).toBe(true);
    expect(outcome.text).toContain('平常');
    expect(h.store.count('s1'), '中性轮默认 salience=0 ⇒ 不记').toBe(0);
  });

  it('有摩擦的一轮：记一条并出卡（状态词由派生档决定）', async () => {
    const h = harness({ cfg: cfgWith({}, { cardMaxBytes: 700 }) });
    h.watcher.observe('s1', { type: 'tool/call', data: { callId: 'c1', name: 'bash' } }, 900);
    h.watcher.observe('s1', { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: true } } }, 950);
    const outcome = await h.spirit.onPreStep(input({ newUserText: 'bash 那边怎么回事' }));
    expect(outcome.kind).toBe('injected');
    expect(h.store.count('s1')).toBe(1);
    if (outcome.kind !== 'injected') return;
    expect(outcome.text).toContain('刚刚：');
    // 默认人格的 focus 里先命中 self_mistake ⇒ 工具失败被归因成“我出了错”，而不是“工具不顺”
    expect(outcome.text).toContain('我出了错');
    expect(outcome.text).not.toContain('手边的工具不顺');
  });

  it('capture.userSnippet 默认关 ⇒ 条目里不存用户原文', async () => {
    const h = harness();
    h.watcher.observe('s1', { type: 'tool/call', data: { callId: 'c1', name: 'bash' } }, 900);
    h.watcher.observe('s1', { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: true } } }, 950);
    await h.spirit.onPreStep(input({ newUserText: 'bash 那边怎么回事，先把投递放一放' }));
    const rows = h.store.recent('s1', 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fact.quote).toBeUndefined();
    expect(JSON.stringify(rows[0])).not.toContain('投递');
  });

  it('开启后存截断 quote，但它不进卡文本、不进 cues', async () => {
    // checklist 的“体验≠事实”红线在采集面的落地：原文只能作为**人读的细节**存着，
    // 不能变成模型引用的“历史原话”。两个回灌入口（卡文本 / 检索键）各自断言。
    const base = structuredClone(SPIRIT_DEFAULTS);
    const h = harness({ cfg: cfgWith({ capture: { ...base.capture, userSnippet: true, maxQuoteChars: 8 } }) });
    h.watcher.observe('s1', { type: 'tool/call', data: { callId: 'c1', name: 'bash' } }, 900);
    h.watcher.observe('s1', { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: true } } }, 950);
    const outcome = await h.spirit.onPreStep(input({ newUserText: '帮我把投递脚本再跑一次看看' }));
    expect(outcome.kind).toBe('injected');
    const rows = h.store.recent('s1', 5);
    // 按码点截到 8：不拆散代理对，也不整段进库
    expect(Array.from(rows[0]?.fact.quote ?? '')).toHaveLength(8);
    if (outcome.kind === 'injected') expect(outcome.text).not.toContain('投递');
    expect(h.store.searchLocal('投递', { sessionId: 's1', limit: 3 })).toEqual([]);
  });

  it('预算装不下状态段 ⇒ passthrough(budget)，不发空壳', async () => {
    const h = harness({ cfg: cfgWith({}, { cardMaxBytes: 40 }) });
    const outcome = await h.spirit.onPreStep(input());
    expect(outcome).toEqual({ kind: 'passthrough', reason: 'budget' });
  });
});

describe('重发判据与两段式生效', () => {
  it('档位与近因都没变 ⇒ unchanged，不重复发卡', async () => {
    const h = harness();
    expect((await h.spirit.onPreStep(input())).kind).toBe('injected');
    // 未确认生效 ⇒ 指纹还没提交，第二次仍会发（这正是两段式的意义）
    expect((await h.spirit.onPreStep(input({ now: 1_001 }))).kind).toBe('injected');
  });

  it('确认生效后再进同一轮状态 ⇒ unchanged（不刷同档卡）', async () => {
    const h = harness();
    const first = await h.spirit.onPreStep(input());
    expect(first.kind).toBe('injected');
    if (first.kind !== 'injected') return;
    h.spirit.noteInjected('a1', 'msg-1', first.fingerprint);
    expect(h.spirit.confirmInjected('msg-1')).toBe(true);
    expect(h.spirit.confirmInjected('msg-1')).toBe(false);
    expect((await h.spirit.onPreStep(input({ now: 1_002 }))).reason).toBe('unchanged');
  });

  it('未确认的注入不压制重发（宿主取消/覆盖时不能"以为发过了"）', async () => {
    const h = harness();
    const first = await h.spirit.onPreStep(input());
    if (first.kind !== 'injected') throw new Error('首轮应发卡');
    h.spirit.noteInjected('a1', 'msg-lost', first.fingerprint);
    // 没有任何 user/message 事件确认它
    expect((await h.spirit.onPreStep(input({ now: 1_003 }))).kind).toBe('injected');
  });

  it('压缩/清空后重置发卡凭据 ⇒ 下轮重新出卡（不重置就是"角色再也没情绪"且无声）', async () => {
    const h = harness();
    const handlers: Record<string, (a: unknown, b?: unknown) => void> = {};
    const ctx = {
      on: (name: string, handler: (a: unknown, b?: unknown) => void) => {
        handlers[name] = handler;
      },
    } as unknown as Parameters<typeof registerCardObserve>[0];
    registerCardObserve(ctx, { spirit: h.spirit, logger });

    const first = await h.spirit.onPreStep(input());
    if (first.kind !== 'injected') throw new Error('首轮应发卡');
    h.spirit.noteInjected('a1', 'c1', first.fingerprint);
    handlers['session/event']?.({ id: 's1' }, { type: 'user/message', data: { id: 'c1', source: { kind: 'plugin:spirit' } } });
    // 已确认生效 ⇒ 同一状态不该重发
    expect((await h.spirit.onPreStep(input({ now: 2_000 }))).reason).toBe('unchanged');
    // 压缩把卡行从表面抽走 ⇒ 凭据作废
    handlers['session/event']?.({ id: 's1' }, { type: 'compaction/end', data: {} });
    expect((await h.spirit.onPreStep(input({ now: 3_000 }))).kind).toBe('injected');
    // 用户清空同样重置
    handlers['agent/created']?.({ source: 'clear', agent: { id: 'a1', session: { id: 's1' } } });
    h.spirit.noteInjected('a1', 'c2', 'fp-2');
    handlers['session/event']?.({ id: 's1' }, { type: 'user/message', data: { id: 'c2', source: { kind: 'plugin:spirit' } } });
    expect((await h.spirit.onPreStep(input({ now: 4_000 }))).kind).toBe('injected');
  });

  it('卡行被从模型表面上抽走 ⇒ 凭据作废、下轮重发（事件会漏，表面才是事实）', async () => {
    const h = harness();
    const first = await h.spirit.onPreStep(input());
    if (first.kind !== 'injected') throw new Error('首轮应发卡');
    h.spirit.noteInjected('a1', 'c1', first.fingerprint);
    expect(h.spirit.confirmInjected('c1', 42)).toBe(true);

    // 还在表面上：同一状态不该重发
    expect((await h.spirit.onPreStep(input({ now: 1_010, surfaceNodes: new Set([42, 43]) }))).reason).toBe('unchanged');
    // 不在表面上（被摘要掉了）：必须重发，不报错的静默就是"角色再也没情绪"
    expect((await h.spirit.onPreStep(input({ now: 1_020, surfaceNodes: new Set([43]) }))).kind).toBe('injected');
    // 拿不到表面 ⇒ 未知处理：不得因此反复重发
    const second = await h.spirit.onPreStep(input({ now: 1_030 }));
    expect(second.kind).toBe('injected');
    if (second.kind !== 'injected') return;
    h.spirit.noteInjected('a1', 'c2', second.fingerprint);
    h.spirit.confirmInjected('c2', 44);
    expect((await h.spirit.onPreStep(input({ now: 1_040 }))).reason).toBe('unchanged');
  });

  it('agent/disposed 释放运行态；关闭后不再喂采集器', () => {
    const h = harness({ cfg: cfgWith({ enabled: false }) });
    expect(h.spirit.shouldObserve()).toBe(false);
    h.spirit.noteInjected('a1', 'x', 'y');
    h.spirit.release('a1');
    expect(h.spirit.confirmInjected('x')).toBe(false);
    expect(h.spirit.moodOf('a1')).toBeUndefined();
  });
});

describe('card-observe：确认必须排在业务过滤之前', () => {
  /** 只收集处理器的 cordis 桩：不需要真宿主就能测这段顺序语义。 */
  function stubCtx(): { ctx: Parameters<typeof registerCardObserve>[0]; handlers: Record<string, (a: unknown, b?: unknown) => void> } {
    const handlers: Record<string, (a: unknown, b?: unknown) => void> = {};
    const ctx = {
      on: (name: string, handler: (a: unknown, b?: unknown) => void) => {
        handlers[name] = handler;
      },
    } as unknown as Parameters<typeof registerCardObserve>[0];
    return { ctx, handlers };
  }

  it('自家行（kind 不是 user）能被确认；先过滤就会永不生效', () => {
    const h = harness();
    const { ctx, handlers } = stubCtx();
    registerCardObserve(ctx, { spirit: h.spirit, logger });
    h.spirit.noteInjected('a1', 'card-9', 'fp-9');
    handlers['session/event']?.({ id: 's1' }, { type: 'user/message', data: { id: 'card-9', source: { kind: 'plugin:spirit' }, content: [] } });
    // 已被处理器确认 ⇒ 再调一次就是 miss
    expect(h.spirit.confirmInjected('card-9'), '指纹应已提交，不该还挂在飞').toBe(false);
  });

  it('非自家行不确认；采集照常跑', () => {
    const h = harness();
    const { ctx, handlers } = stubCtx();
    registerCardObserve(ctx, { spirit: h.spirit, logger });
    h.spirit.noteInjected('a1', 'card-10', 'fp-10');
    handlers['session/event']?.({ id: 's1' }, { type: 'user/message', data: { id: 'card-10', source: { kind: 'user' }, content: [] } });
    // 没被确认 ⇒ 仍在飞，确认它才为 true
    expect(h.spirit.confirmInjected('card-10')).toBe(true);
    handlers['session/event']?.({ id: 's1' }, { type: 'tool/call', data: { callId: 'z', name: 'bash' } });
    handlers['session/event']?.({ id: 's1' }, { type: 'tool/result', data: { message: { toolCallId: 'z', isError: true } } });
    expect(h.watcher.takeSignals('s1', 5).toolFailures).toBe(1);
  });

  it('agent/disposed 走 release；形状不对不抛', () => {
    const h = harness();
    const { ctx, handlers } = stubCtx();
    registerCardObserve(ctx, { spirit: h.spirit, logger });
    expect(() => handlers['agent/disposed']?.({ agent: { id: 'a1' } })).not.toThrow();
    expect(() => handlers['session/event']?.(null, null)).not.toThrow();
    expect(() => handlers['session/event']?.({ id: 's1' }, { type: '' })).not.toThrow();
    expect(h.spirit.moodOf('a1')).toBeUndefined();
  });
});

describe('turn/end 即时结算（会话最后一轮不许丢）', () => {
  /** 走真接线：事件进 observeEvent，结算由 turn/end 触发。 */
  function feedFailure(h: Harness): void {
    h.spirit.observeEvent('s1', { type: 'tool/call', data: { callId: 'c1', name: 'read' } }, 900);
    h.spirit.observeEvent('s1', { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: true } } }, 950);
  }

  it('单轮会话：turn/end 一到就落库（不再靠“还有下一轮”）', async () => {
    const h = harness();
    await h.spirit.onPreStep(input({ messageCount: 1, now: 1_000 }));
    feedFailure(h);
    // 关键断言：这里**没有**第二次 pre-step，也没有任何“下一轮”
    h.spirit.observeEvent('s1', { type: 'turn/end', data: { turn: 1 } }, 1_200);
    expect(h.store.count('s1')).toBe(1);
  });

  it('结算后下一轮 pre-step 不重复记（兜底路取到空信号）', async () => {
    const h = harness();
    await h.spirit.onPreStep(input({ now: 1_000 }));
    feedFailure(h);
    h.spirit.observeEvent('s1', { type: 'turn/end', data: { turn: 1 } }, 1_200);
    expect(h.store.count('s1')).toBe(1);
    await h.spirit.onPreStep(input({ now: 2_000, newUserText: '然呢' }));
    expect(h.store.count('s1'), 'turn/end 已结算的轮不得被兜底路再记一次').toBe(1);
  });

  it('纯工具轮（本轮无新用户消息）⇒ turn/end 也不记', () => {
    // 门 6 的采集侧镜像：没认养过这一轮就没有记账上下文，结算直接 no-op。
    const h = harness();
    feedFailure(h);
    h.spirit.observeEvent('s1', { type: 'turn/end', data: { turn: 1 } }, 1_200);
    expect(h.store.count('s1')).toBe(0);
  });

  it('旁路下 turn/end 照常落库（对照组靠的就是这堆条目）', async () => {
    const h = harness({ cfg: cfgWith({}, { bypass: true }) });
    await h.spirit.onPreStep(input({ now: 1_000 }));
    feedFailure(h);
    h.spirit.observeEvent('s1', { type: 'turn/end', data: { turn: 1 } }, 1_200);
    expect(h.store.count('s1')).toBe(1);
  });

  it('中性轮（无可记信号）⇒ turn/end 不产出条目', async () => {
    const h = harness();
    await h.spirit.onPreStep(input({ now: 1_000 }));
    h.spirit.observeEvent('s1', { type: 'turn/end', data: { turn: 1 } }, 1_200);
    expect(h.store.count('s1')).toBe(0);
  });

  it('重复的 turn/end 只结算一次（上下文已消费）', async () => {
    const h = harness();
    await h.spirit.onPreStep(input({ now: 1_000 }));
    feedFailure(h);
    h.spirit.observeEvent('s1', { type: 'turn/end', data: { turn: 1 } }, 1_200);
    h.spirit.observeEvent('s1', { type: 'turn/end', data: { turn: 1 } }, 1_300);
    expect(h.store.count('s1')).toBe(1);
  });
});
