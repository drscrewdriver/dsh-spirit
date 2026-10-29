/**
 * 枚举单源门禁：字面量取值只允许出现在 `src/types.ts`。
 *
 * 别的文件若要取值就 import 常量，不得再抄一份字面量——两串字面量迟早漂移，
 * 而漂移的后果是静默的（条目落不进档、卡里出现空句、DB 写进未知 trigger）。
 * 判据只看**代码里的带引号字面量**（注释先剥掉，避免文档性提法误报）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AROUSAL_TIERS,
  LANES,
  NOTICE_KINDS,
  REACTION_TIERS,
  SPIRIT_VERDICTS,
  TRIGGER_KINDS,
  VALENCE_TIERS,
  VOICE_TIERS,
} from '../src/types.js';

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));
const SINGLE_SOURCE_FILE = 'types.ts';

const ALL_LITERALS: readonly string[] = [
  ...TRIGGER_KINDS,
  ...NOTICE_KINDS,
  ...REACTION_TIERS,
  ...VALENCE_TIERS,
  ...AROUSAL_TIERS,
  ...VOICE_TIERS,
  ...LANES,
  ...SPIRIT_VERDICTS,
];

/** 剥块注释与行注释（本仓代码风格可控，正则足够）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|\s)\/\/[^\n]*/gu, '$1');
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => `${dir}/${entry}`);
}

describe('枚举字面量单源', () => {
  it('src 下除 types.ts 外没有任何文件带引号抄写枚举字面量', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const base = file.slice(file.lastIndexOf('/') + 1);
      if (base === SINGLE_SOURCE_FILE) continue;
      const body = stripComments(readFileSync(file, 'utf8'));
      for (const literal of ALL_LITERALS) {
        // 只认独立带引号字面量（'x' / "x"），对象键 neg: 之类不算抄写
        const re = new RegExp(`['"]${literal}['"]`, 'u');
        if (re.test(body)) offenders.push(`${base} → '${literal}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('取值域互不重叠且非空（防止后来者把两族合并成一份字面量）', () => {
    const groups = [TRIGGER_KINDS, NOTICE_KINDS, REACTION_TIERS, VALENCE_TIERS, AROUSAL_TIERS, VOICE_TIERS, LANES];
    for (const group of groups) expect(group.length).toBeGreaterThan(0);
    // trigger 与 notice 语义不同族，字面量不得相同
    expect(TRIGGER_KINDS.some((t) => (NOTICE_KINDS as readonly string[]).includes(t))).toBe(false);
    // 档位在两轴上可同名（'mid'/'normal' 各自唯一），但同族内不得重复
    for (const group of groups) expect(new Set(group).size).toBe(group.length);
  });
});
