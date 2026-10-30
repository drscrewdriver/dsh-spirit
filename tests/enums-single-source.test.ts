/**
 * 枚举单源门禁（收窄版）。
 *
 * 先说清**这条测试管什么、不管什么**——判据定歪的门禁最后只会被加白名单绕过去，
 * 那比没有门禁更糟（它还给出"绿了"的假信号）。
 *
 * 管：某个文件里再抄一份**完整取值域**（数组/元组/set 里出现 ≥2 个本域字面量）。
 *     这种"第二份清单"迟早漂移，而漂移是静默的（条目落不进档、DB 写进未知 trigger）。
 * 不管：单个字面量出现在查表键、`case` 标签或比较里。全格查表本来就要逐个写键，
 *     把这种也判违规会误报成片；它的正确约束是**完备性**，由各表自己的
 *     "全格覆盖"测试守（见 slot/grid、experience/render 的用例）。
 *
 * 因此：引用单值请优先用 types.ts 的命名单例（`LANE_DRSC` / `VALENCE_MID` …），
 * 只有查表键与分支标签才写字面量。
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

/** 按族分组，便于报出"哪一族被复制了"。 */
const GROUPS: Readonly<Record<string, readonly string[]>> = {
  TRIGGER_KINDS,
  NOTICE_KINDS,
  REACTION_TIERS,
  VALENCE_TIERS,
  AROUSAL_TIERS,
  VOICE_TIERS,
  LANES,
  SPIRIT_VERDICTS,
};
const ALL_LITERALS: readonly string[] = Object.values(GROUPS).flat();

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|\s)\/\/[^\n]*/gu, '$1');
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => `${dir}/${entry}`);
}

/** 抓出所有"带引号项的数组/元组/set 字面量"文本片段。 */
function collectCollectionLiterals(body: string): string[] {
  const out: string[] = [];
  const re = /[[({]\s*(?:['"][^'"]{2,40}['"]\s*,\s*)+['"][^'"]{2,40}['"]\s*[)\]}]/gu;
  for (const match of body.matchAll(re)) out.push(match[0]);
  return out;
}

describe('枚举字面量单源', () => {
  it('除 types.ts 外没有任何文件复制了一份取值域（≥2 个同族字面量的集合字面量）', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const base = file.slice(file.lastIndexOf('/') + 1);
      if (base === SINGLE_SOURCE_FILE) continue;
      const body = stripComments(readFileSync(file, 'utf8'));
      for (const collection of collectCollectionLiterals(body)) {
        const hits = ALL_LITERALS.filter((literal) => collection.includes(`'${literal}'`) || collection.includes(`"${literal}"`));
        if (hits.length < 2) continue;
        // 同族 ≥2 才算复制；跨族各命中一个（如 [VALENCE_MID, AROUSAL_LOW] 的字面量形式）同样算
        const families = Object.entries(GROUPS)
          .filter(([, values]) => hits.some((hit) => values.includes(hit)))
          .map(([name]) => name);
        const sameFamily = Object.values(GROUPS).some((values) => hits.filter((hit) => values.includes(hit)).length >= 2);
        offenders.push(`${base} → [${hits.join(', ')}] (族: ${families.join('/')}${sameFamily ? '，同族复制' : ''})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('各取值域非空、族内无重复，且 trigger 与 notice 两族字面量不相交', () => {
    for (const [name, values] of Object.entries(GROUPS)) {
      expect(values.length, name).toBeGreaterThan(0);
      expect(new Set(values).size, name).toBe(values.length);
    }
    expect(TRIGGER_KINDS.some((t) => (NOTICE_KINDS as readonly string[]).includes(t))).toBe(false);
  });

  it('types.ts 里每个集合字面量都恰好等于它声明的取值域（防止漏加成员后测试失去意义）', () => {
    const body = readFileSync(`${SRC_ROOT}/types.ts`, 'utf8');
    for (const [name, values] of Object.entries(GROUPS)) {
      // 命名单例组成的域（REACTION_TIERS 等）与字面量数组两种写法都要能对上成员数
      expect(body.includes(`export const ${name}`), name).toBe(true);
      const declared = body.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`, 'u'))?.[1] ?? '';
      const members = declared.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      expect(members.length, `${name} 成员数`).toBe(values.length);
    }
  });
});
