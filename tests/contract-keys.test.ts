/**
 * 契约对齐门禁（Phase 0 腿）。
 *
 * 计划里这条测试是"五方对齐"（defaults ⇄ schema ⇄ settings 面 ⇄ runner ⇄ stats ⇄ client）。
 * 实现采取**逐相交齐**：每条腿落地时就加进本文件并立刻断言，而不是先写一条常红的空壳
 * （常红的门禁等于没有门禁，且会污染"全量绿"这一交付判据）。
 * 已交腿：defaults ⇄ schema（本文件）；后续腿在 Phase 5/6 的对应 task 里追加。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SPIRIT_DEFAULTS, SPIRIT_RANGES, SPIRIT_VERSION } from '../src/contract.js';
import { RANGE_KEYS, SCHEMA_FIELD_KEYS } from '../src/config.js';

/** 把嵌套 defaults 展平成点分键。数组与标量都算叶子。 */
function flatten(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => flatten(v, prefix === '' ? k : `${prefix}.${k}`));
}

describe('contract ⇄ schema 键集对齐', () => {
  it('SPIRIT_DEFAULTS 展平后的键集与 SCHEMA_FIELD_KEYS 完全相等（双向）', () => {
    const fromDefaults = flatten(SPIRIT_DEFAULTS).sort();
    const fromSchema = [...SCHEMA_FIELD_KEYS].sort();
    expect(fromDefaults).toEqual(fromSchema);
  });

  it('live 节键都在 defaults 里（volatile 节的默认值不得有孤儿键）', () => {
    const liveKeys = Object.keys(SPIRIT_DEFAULTS.live);
    for (const key of liveKeys) expect(SCHEMA_FIELD_KEYS).toContain(`live.${key}`);
    // 反向：清单里的 live.* 都必须真有默认值
    for (const key of SCHEMA_FIELD_KEYS.filter((k) => k.startsWith('live.'))) {
      expect(liveKeys).toContain(key.slice('live.'.length));
    }
  });

  it('所有数值区间键都在 SPIRIT_RANGES 里且区间合法（lo<hi、lo>=0）', () => {
    for (const [key, [lo, hi]] of Object.entries(SPIRIT_RANGES)) {
      expect(lo, key).toBeLessThan(hi);
      expect(lo, key).toBeGreaterThanOrEqual(0);
      // 区间表里不得有 defaults 之外的野键
      expect(flatten(SPIRIT_DEFAULTS), key).toContain(key);
    }
    expect(RANGE_KEYS.sort()).toEqual(Object.keys(SPIRIT_RANGES).sort());
  });

  it('每个数值型默认值都落在自己的区间内', () => {
    for (const key of Object.keys(SPIRIT_RANGES)) {
      const [lo, hi] = SPIRIT_RANGES[key]!;
      const value = key.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], SPIRIT_DEFAULTS);
      expect(typeof value, key).toBe('number');
      expect(value as number, key).toBeGreaterThanOrEqual(lo);
      expect(value as number, key).toBeLessThanOrEqual(hi);
    }
  });
});

describe('版本号同串', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    version: string;
    engines: { dsh: string; node: string };
  };
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../dsh.plugin.json', import.meta.url)), 'utf8')) as {
    version: string;
    engines: { dsh: string };
  };

  it('package.json ⇄ dsh.plugin.json ⇄ SPIRIT_VERSION 三处同值', () => {
    expect(pkg.version).toBe(manifest.version);
    expect(manifest.version).toBe(SPIRIT_VERSION);
  });

  it('engines.dsh 两文件逐字同串（不做第二份抄写）', () => {
    expect(pkg.engines.dsh).toBe(manifest.engines.dsh);
  });

  it('声明线只含已实测的 0.2.x（不抄姊妹包的 19 线宽声明）', () => {
    const lines = pkg.engines.dsh.split('||').map((s) => s.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.startsWith('0.2.'), line).toBe(true);
  });
});
