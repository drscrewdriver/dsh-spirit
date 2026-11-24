/**
 * 三态启动挡位（live.bootMode: on/off/last）的行为闸。
 *
 * 与 prime-memory 同构：挡位**不在读侧折叠**（否则本会话的手动开关永远失效），
 * 启动期由 `applyBootMode` 把初值写回 `enabled` 一次；写不进去就不动。
 */
import { describe, expect, it } from 'vitest';

import { applyBootMode, resolveLive } from '../src/config.js';
import { SPIRIT_DEFAULTS } from '../src/contract.js';

describe('resolveLive 归一启动挡位', () => {
  it('缺键 / 非法值一律归 off（出厂默认关闭）', () => {
    expect(resolveLive({}).bootMode).toBe('off');
    expect(resolveLive({ bootMode: 'ON' }).bootMode).toBe('off');
    expect(resolveLive({ bootMode: null }).bootMode).toBe('off');
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

  it('SPIRIT_DEFAULTS.live.bootMode 默认 off', () => {
    expect(SPIRIT_DEFAULTS.live.bootMode).toBe('off');
  });
});

describe('applyBootMode 启动期写回', () => {
  function fakeRef(value: Record<string, unknown>) {
    const writes: Array<Record<string, unknown>> = [];
    return {
      writes,
      ref: {
        get: () => value,
        update: (patch: Record<string, unknown>) => {
          writes.push(patch);
        },
      },
    };
  }

  it('off + enabled=true → 写一次 { enabled: false }', async () => {
    const { ref, writes } = fakeRef({ bootMode: 'off', enabled: true });
    await applyBootMode(ref);
    expect(writes).toEqual([{ enabled: false }]);
  });

  it('on + enabled=false → 写一次 { enabled: true }', async () => {
    const { ref, writes } = fakeRef({ bootMode: 'on', enabled: false });
    await applyBootMode(ref);
    expect(writes).toEqual([{ enabled: true }]);
  });

  it('last → 一次都不写', async () => {
    const { ref, writes } = fakeRef({ bootMode: 'last', enabled: false });
    await applyBootMode(ref);
    expect(writes).toEqual([]);
  });

  it('已经一致 → 不重复写', async () => {
    const { ref, writes } = fakeRef({ bootMode: 'on', enabled: true });
    await applyBootMode(ref);
    expect(writes).toEqual([]);
  });

  it('老线冻结值（无 .get()）→ 静默返回，不抛', async () => {
    await expect(applyBootMode({ bootMode: 'off', enabled: true })).resolves.toBeUndefined();
  });

  it('写面抛错 → 吞掉，不阻断启动', async () => {
    await expect(
      applyBootMode({
        get: () => ({ bootMode: 'off', enabled: true }),
        update: () => {
          throw new Error('volatile 写面不可用');
        },
      }),
    ).resolves.toBeUndefined();
  });
});
