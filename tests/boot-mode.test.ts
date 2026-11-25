/**
 * 三态启动挡位（live.bootMode: on/off/last）的行为闸。
 *
 * 新语义（与 prime-memory 同构）：滑块控制**新会话默认档位**（modes.defaultOff），
 * 而非系统级 enabled。无 modes 时降级为写 enabled（向后兼容老宿主）。
 */
import { describe, expect, it } from 'vitest';

import { applyBootMode, resolveLive } from '../src/config.js';
import { SPIRIT_DEFAULTS } from '../src/contract.js';

describe('resolveLive 归一启动挡位', () => {
  it('缺键 / 非法值一律归 last（出厂默认跟随上次，新安装即开）', () => {
    expect(resolveLive({}).bootMode).toBe('last');
    expect(resolveLive({ bootMode: 'ON' }).bootMode).toBe('last');
    expect(resolveLive({ bootMode: null }).bootMode).toBe('last');
  });

  it('合法三态原样保留', () => {
    expect(resolveLive({ bootMode: 'on' }).bootMode).toBe('on');
    expect(resolveLive({ bootMode: 'off' }).bootMode).toBe('off');
    expect(resolveLive({ bootMode: 'last' }).bootMode).toBe('last');
  });

  it('读侧不折叠：enabled 只认自己的键', () => {
    expect(resolveLive({ bootMode: 'off', enabled: true }).enabled).toBe(true);
    expect(resolveLive({ bootMode: 'on', enabled: false }).enabled).toBe(false);
  });

  it('SPIRIT_DEFAULTS.live.bootMode 默认 last', () => {
    expect(SPIRIT_DEFAULTS.live.bootMode).toBe('last');
  });
});

describe('applyBootMode 新语义：写会话默认档', () => {
  function fakeRef(value: Record<string, unknown>) {
    const writes: Array<Record<string, unknown>> = [];
    return {
      writes,
      ref: {
        get: () => value,
        update: (patch: Record<string, unknown>) => { writes.push(patch); },
      },
    };
  }

  it('off + modes → setDefaultOff(true)，不写 enabled', async () => {
    const { ref, writes } = fakeRef({ bootMode: 'off', enabled: true });
    const calls: Array<boolean | undefined> = [];
    const modes = { setDefaultOff: (v: boolean | undefined) => calls.push(v) };
    await applyBootMode(ref, modes);
    expect(calls).toEqual([true]);
    expect(writes).toEqual([]); // 不写系统级
  });

  it('on + modes → setDefaultOff(false)', async () => {
    const { ref } = fakeRef({ bootMode: 'on', enabled: false });
    const calls: Array<boolean | undefined> = [];
    const modes = { setDefaultOff: (v: boolean | undefined) => calls.push(v) };
    await applyBootMode(ref, modes);
    expect(calls).toEqual([false]);
  });

  it('last + modes → 不改 modes', async () => {
    const { ref } = fakeRef({ bootMode: 'last', enabled: true });
    let called = false;
    const modes = { setDefaultOff: () => { called = true; } };
    await applyBootMode(ref, modes);
    expect(called).toBe(false);
  });

  it('无 modes（老宿主降级）→ 仍写 enabled（向后兼容）', async () => {
    const { ref, writes } = fakeRef({ bootMode: 'off', enabled: true });
    await applyBootMode(ref); // no modes param
    expect(writes).toEqual([{ enabled: false }]);
  });

  it('老线冻结值（无 .get()）→ 静默返回', async () => {
    await expect(applyBootMode({ bootMode: 'off', enabled: true })).resolves.toBeUndefined();
  });
});
