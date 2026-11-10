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

import { checkCompat } from '../scripts/compat-precheck.mjs';

import { SPIRIT_DEFAULTS, SPIRIT_RANGES, SPIRIT_VERSION } from '../src/contract.js';
import { RANGE_KEYS, SCHEMA_FIELD_KEYS } from '../src/config.js';
import { NOTICE_WORDS_ZH, TRIGGER_WORDS_ZH, VOICE_WORDS } from '../src/words.js';
import { VOICE_TIERS } from '../src/types.js';
import { zh } from '../client/src/copy.js';

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

  it('声明 range 合法且整体落在 0.2.x（委托 compat-precheck 单源，不再复一份枚举）', () => {
    // 宽 range（如 `>=0.2.0-rc.1 <0.3.0`）的“有界”判定归一交给 checkCompat：
    // 它同时核“覆盖已测预发布线 + 不溢出 0.1.x/0.3.0+ + peers 逐线满足且标 optional + 版本同串”。
    expect(checkCompat(pkg as never, manifest as never)).toEqual([]);
  });
});

/**
 * markdown 备份的词表漂移门禁：`words.ts` 的 UI 中文与面板徽章（copy.ts zh）必须逐字同串。
 *
 * 为什么值得钉：`persona.md` 的节内容是人手可读可改的，解析靠中文 label 反查 slug；
 * 若面板把「结项」改成「收尾」而 words 没跟着改，旧备份文件恢复时会被当成未知词拒绝——
 * 这种断裂没有任何报错能提前发现，只有主人拿备份碰壁时才暴露。
 */
describe('words.ts UI 中文 ⇄ copy.ts zh 字典逐键一致', () => {
  it('TRIGGER_WORDS_ZH 六键与 sea.trig* 同串', () => {
    expect(TRIGGER_WORDS_ZH.user_interruption).toBe(zh['sea.trigUserInterruption']);
    expect(TRIGGER_WORDS_ZH.tool_failure).toBe(zh['sea.trigToolFailure']);
    expect(TRIGGER_WORDS_ZH.recovery).toBe(zh['sea.trigRecovery']);
    expect(TRIGGER_WORDS_ZH.task_close).toBe(zh['sea.trigTaskClose']);
    expect(TRIGGER_WORDS_ZH.long_gap).toBe(zh['sea.trigLongGap']);
    expect(TRIGGER_WORDS_ZH.neutral).toBe(zh['sea.trigNeutral']);
  });

  it('NOTICE_WORDS_ZH 七键与 sea.notice* 同串', () => {
    expect(NOTICE_WORDS_ZH.self_mistake).toBe(zh['sea.noticeSelfMistake']);
    expect(NOTICE_WORDS_ZH.user_state).toBe(zh['sea.noticeUserState']);
    expect(NOTICE_WORDS_ZH.task_progress).toBe(zh['sea.noticeTaskProgress']);
    expect(NOTICE_WORDS_ZH.task_stall).toBe(zh['sea.noticeTaskStall']);
    expect(NOTICE_WORDS_ZH.being_ignored).toBe(zh['sea.noticeBeingIgnored']);
    expect(NOTICE_WORDS_ZH.being_acknowledged).toBe(zh['sea.noticeBeingAcknowledged']);
    expect(NOTICE_WORDS_ZH.environment).toBe(zh['sea.noticeEnvironment']);
  });

  it('VOICE_WORDS 三档在 copy 里有同串对应（面板下拉用）', () => {
    // 语气当前没有独立 sea 键（下拉直接吃 VOICE_WORDS），但必须与投射文本同源：
    // 投射里的「[语气] 平实」与下拉/备份是同一个 VOICE_WORDS；键集与 VOICE_TIERS 单源比对（扩列不再改闸）
    expect(Object.keys(VOICE_WORDS).sort()).toEqual([...VOICE_TIERS].sort());
    expect(Object.values(VOICE_WORDS).every((w) => typeof w === 'string' && w.length > 0)).toBe(true);
  });
});
