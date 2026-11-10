/**
 * 长觉模型选择 RPC（distill-models / -list / -set，Phase 面板）。
 *
 * 用可控假 distillRoute 面直调 handleEndpoint——测分发与优先级/写语义，不牵真宿主 llm。
 * 必钉：优先级 pin>覆盖>默认、pinned 拒写、半配拒写、降级写 false、未装配 unavailable、
 * 以及 -list 的 provider 校验与枚举抛错降级。
 */
import { describe, expect, it } from 'vitest';

import { SPIRIT_RPC_PREFIX } from '../src/contract.js';
import type { SpiritDistillRouteView, SpiritDistillModelSetResult, SpiritDistillModelListResult } from '../src/contract.js';
import { handleEndpoint, type RpcDeps } from '../src/rpc.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
const ep = (op: string): string => `${SPIRIT_RPC_PREFIX}${op}`;

interface FakeState {
  pin: { provider: string; model: string } | null;
  override: { provider: string; model: string } | null;
  host: { provider: string; model: string } | null;
  providers: Array<{ id: string; name: string }>;
  modelsByProvider: Record<string, Array<{ id: string; name: string }>>;
  supported: boolean;
  writeOk: boolean;
  writeCalls: Array<{ provider: string; model: string } | null>;
}

function fakeDeps(over: Partial<FakeState> = {}): { deps: RpcDeps; state: FakeState } {
  const state: FakeState = {
    pin: null,
    override: null,
    host: { provider: 'host', model: 'default-m' },
    providers: [{ id: 'p1', name: 'Provider One' }, { id: 'p2', name: 'p2' }],
    modelsByProvider: { p1: [{ id: 'm-a', name: 'M A' }, { id: 'm-b', name: 'm-b' }] },
    supported: true,
    writeOk: true,
    writeCalls: [],
    ...over,
  };
  const distillRoute: NonNullable<RpcDeps['distillRoute']> = {
    deployPin: () => state.pin,
    runtimeOverride: () => state.override,
    hostDefault: () => state.host,
    setRuntimeOverride: (route) => {
      state.writeCalls.push(route);
      if (state.writeOk) state.override = route;
      return state.writeOk;
    },
    providers: () => state.providers,
    models: async (provider) => state.modelsByProvider[provider] ?? [],
    enumerationSupported: () => state.supported,
  };
  const deps = { logger, distillRoute } as unknown as RpcDeps;
  return { deps, state };
}

describe('distill-models（读视图）', () => {
  it('优先级：pin 压过覆盖与默认', async () => {
    const { deps } = fakeDeps({ pin: { provider: 'pinp', model: 'pinm' }, override: { provider: 'ovr', model: 'o' } });
    const res = await handleEndpoint(ep('distill-models'), {}, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const view = res.value as SpiritDistillRouteView;
    expect(view.pinned).toBe(true);
    expect(view.effective).toEqual({ provider: 'pinp', model: 'pinm', source: 'deployPinned' });
  });

  it('无 pin 时：覆盖压过宿主默认', async () => {
    const { deps } = fakeDeps({ override: { provider: 'ovr', model: 'ovm' } });
    const res = await handleEndpoint(ep('distill-models'), {}, deps);
    if (!res.ok) return expect(false).toBe(true);
    const view = res.value as SpiritDistillRouteView;
    expect(view.pinned).toBe(false);
    expect(view.effective).toEqual({ provider: 'ovr', model: 'ovm', source: 'runtimeOverride' });
  });

  it('三者全空 ⇒ effective=null（fail-closed，长觉会拒蒸）', async () => {
    const { deps } = fakeDeps({ host: null });
    const res = await handleEndpoint(ep('distill-models'), {}, deps);
    if (!res.ok) return expect(false).toBe(true);
    expect((res.value as SpiritDistillRouteView).effective).toBeNull();
  });

  it('未装配 distillRoute ⇒ unavailable', async () => {
    const res = await handleEndpoint(ep('distill-models'), {}, { logger } as unknown as RpcDeps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('unavailable');
  });
});

describe('distill-model-list', () => {
  it('给定 provider 返回其模型', async () => {
    const { deps } = fakeDeps();
    const res = await handleEndpoint(ep('distill-model-list'), { provider: 'p1' }, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.value as SpiritDistillModelListResult).models.map((m) => m.id)).toEqual(['m-a', 'm-b']);
  });

  it('provider 空 ⇒ bad-request；未知 provider ⇒ 空模型不报错', async () => {
    const { deps } = fakeDeps();
    const bad = await handleEndpoint(ep('distill-model-list'), { provider: '' }, deps);
    expect(bad.ok).toBe(false);
    const unknown = await handleEndpoint(ep('distill-model-list'), { provider: 'nope' }, deps);
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect((unknown.value as SpiritDistillModelListResult).models).toEqual([]);
  });
});

describe('distill-model-set（写运行时覆盖）', () => {
  it('成对写 ⇒ 落覆盖、route 反映 runtimeOverride', async () => {
    const { deps, state } = fakeDeps();
    const res = await handleEndpoint(ep('distill-model-set'), { provider: 'p1', model: 'm-a' }, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const result = res.value as SpiritDistillModelSetResult;
    expect(result.ok).toBe(true);
    expect(result.route.effective).toEqual({ provider: 'p1', model: 'm-a', source: 'runtimeOverride' });
    expect(state.writeCalls).toEqual([{ provider: 'p1', model: 'm-a' }]);
  });

  it('pin 在场 ⇒ 拒写 reason=pinned（不写盘）', async () => {
    const { deps, state } = fakeDeps({ pin: { provider: 'pinp', model: 'pinm' } });
    const res = await handleEndpoint(ep('distill-model-set'), { provider: 'p1', model: 'm-a' }, deps);
    if (!res.ok) return expect(false).toBe(true);
    expect((res.value as SpiritDistillModelSetResult).reason).toBe('pinned');
    expect(state.writeCalls, 'pin 时根本不写').toEqual([]);
  });

  it('半配（只 provider）⇒ reason=half-config，不写盘', async () => {
    const { deps, state } = fakeDeps();
    const res = await handleEndpoint(ep('distill-model-set'), { provider: 'p1' }, deps);
    if (!res.ok) return expect(false).toBe(true);
    expect((res.value as SpiritDistillModelSetResult).reason).toBe('half-config');
    expect(state.writeCalls).toEqual([]);
  });

  it('clear=true ⇒ 写 null 清除；降级写 false ⇒ reason=degraded', async () => {
    const { deps, state } = fakeDeps({ override: { provider: 'ovr', model: 'o' } });
    const cleared = await handleEndpoint(ep('distill-model-set'), { clear: true }, deps);
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect((cleared.value as SpiritDistillModelSetResult).route.effective?.source).toBe('hostDefault');
    expect(state.writeCalls).toContain(null);

    const degraded = fakeDeps({ writeOk: false });
    const res = await handleEndpoint(ep('distill-model-set'), { provider: 'p1', model: 'm-a' }, degraded.deps);
    if (!res.ok) return expect(false).toBe(true);
    expect((res.value as SpiritDistillModelSetResult).reason).toBe('degraded');
  });
});
