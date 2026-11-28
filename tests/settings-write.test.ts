/**
 * settingsWrite 写路径门禁（task_9）：ns 对齐 / entryId 回退链 / 逐键 volatile 回退 /
 * 读回校验 / 错误信息带上下文。全部走 src/settings-write.ts 纯模块，不依赖真机。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { entryIdOf, writeLiveSettings, type SettingsRow, type SettingsServiceLike } from '../src/settings-write.js';

function makeSvc(rows: SettingsRow[], opts: {
  mutate?: (ns: string, ops: Array<{ op: string; path: string[]; value: unknown }>) => Promise<unknown>;
} = {}): SettingsServiceLike {
  return {
    describe: () => rows,
    mutate: opts.mutate ?? (async () => undefined),
  };
}

describe('entryIdOf 回退链', () => {
  it('fiber entry id 优先', () => {
    expect(entryIdOf('include:custom', 'dsh-spirit', 'dsh-spirit-plugin')).toBe('include:custom');
  });
  it('fiber 缺席退编译期 entry id', () => {
    expect(entryIdOf(undefined, 'dsh-spirit', 'dsh-spirit-plugin')).toBe('dsh-spirit');
  });
  it('entry id 空串再退 cordis 插件名', () => {
    expect(entryIdOf('', '', 'dsh-spirit-plugin')).toBe('dsh-spirit-plugin');
  });
});

describe('writeLiveSettings', () => {
  it('ns 精确命中 entryId：整对象写 path=["live"] 并读回成功', async () => {
    const live = { enabled: true, fadeEnabled: false } as Record<string, unknown>;
    const calls: Array<{ ns: string; path: string[]; value: unknown }> = [];
    const svc = makeSvc(
      [{ ns: 'dsh-spirit', value: { live } }],
      { mutate: async (ns, ops) => {
        calls.push({ ns, path: ops[0]!.path, value: ops[0]!.value });
        Object.assign(live, (ops[0]!.value as Record<string, unknown>));
      } },
    );
    const r = await writeLiveSettings({ svc, entryId: 'dsh-spirit', patch: { fadeEnabled: true } });
    expect(r.ok).toBe(true);
    expect(calls[0]!.ns).toBe('dsh-spirit');
    expect(calls[0]!.path).toEqual(['live']);
    expect(live.fadeEnabled).toBe(true);
  });

  it('ns 错配时按 value 的 live 节回退命中，错误串带 entryId 与已知 ns', async () => {
    const r = await writeLiveSettings({
      svc: makeSvc([{ ns: 'other-plugin', value: { other: 1 } }]),
      entryId: 'dsh-spirit',
      patch: { fadeEnabled: true },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('entryId=dsh-spirit');
    expect(r.error).toContain('other-plugin');
  });

  it('整对象写抛 not volatile → 逐键 path=["live",key] 回退成功', async () => {
    const live = { enabled: true, fadeEnabled: false } as Record<string, unknown>;
    const paths: string[][] = [];
    const svc = makeSvc(
      [{ ns: 'dsh-spirit', value: { live } }],
      { mutate: async (_ns, ops) => {
        paths.push(ops[0]!.path);
        if (ops[0]!.path.length === 1) throw new Error('Config field "live" is not volatile');
        live[ops[0]!.path[1]!] = ops[0]!.value;
      } },
    );
    const r = await writeLiveSettings({
      svc,
      entryId: 'dsh-spirit',
      patch: { fadeEnabled: true, enabled: false },
    });
    expect(r.ok).toBe(true);
    expect(paths[0]).toEqual(['live']);
    expect(paths.slice(1)).toEqual([['live', 'fadeEnabled'], ['live', 'enabled']]);
    expect(live.fadeEnabled).toBe(true);
    expect(live.enabled).toBe(false);
  });

  it('非 not-volatile 错误如实冒泡，不吞成成功', async () => {
    const svc = makeSvc(
      [{ ns: 'dsh-spirit', value: { live: {} } }],
      { mutate: async () => { throw new Error('disk full'); } },
    );
    const r = await writeLiveSettings({ svc, entryId: 'dsh-spirit', patch: { fadeEnabled: true } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('disk full');
  });

  it('读回不一致返回 read-back-mismatch，不谎报成功', async () => {
    const svc = makeSvc(
      [{ ns: 'dsh-spirit', value: { live: { fadeEnabled: false } } }],
      { mutate: async () => undefined }, // 不真写
    );
    const r = await writeLiveSettings({ svc, entryId: 'dsh-spirit', patch: { fadeEnabled: true } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('read-back-mismatch');
  });

  it('settings 服务缺席返回明确错误', async () => {
    const r = await writeLiveSettings({ svc: undefined, entryId: 'dsh-spirit', patch: { fadeEnabled: true } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('settings 服务不可用');
  });
});

describe('假成功消除的源码门禁（pin 住 rpc/panel 两处 regressions）', () => {
  // ESM 侧统一用静态 import：require() 在 type:module 里既不合规也没必要（lint 会红）
  const readSrc = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');

  it('rpc.ts 的 settings-set 成功面不得再硬编码 hotUpdatable: true', () => {
    const src = readSrc('src/rpc.ts');
    const start = src.indexOf("case 'settings-set'");
    const end = src.indexOf("case 'sea-graph'", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).not.toContain('hotUpdatable: true');
    expect(block).toContain('hotUpdatable: typeof deps.liveRaw?.()?.update');
  });

  it('panel.ts 的 saveSettings 失败分支必须回滚旧 settings', () => {
    const src = readSrc('client/src/panel.ts');
    const start = src.indexOf('const saveSettings');
    const end = src.indexOf('const ladderInput', start);
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, end);
    expect(block).toContain('const prev = settings');
    expect(block).toContain('if (prev !== null) setSettings(prev)');
  });
});
