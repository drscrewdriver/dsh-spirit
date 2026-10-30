/**
 * client 文案体检。
 *
 * 两件容易漂的事：
 * 1. **死文案**（键定义了却没人引用）= 有段界面根本没渲染出来，而没人会报错；
 * 2. **en 少键**：新增 zh 键忘了补 en，切到英文时按钮会变 `undefined`。
 * 第二条已由 `Record<CopyKey, string>` 在编译期挡住，这里再补第一条与一次总数核对。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { COPY_KEYS, DICTS, copyOf, zh } from '../client/src/copy.js';

const CLIENT_DIR = fileURLToPath(new URL('../client/src', import.meta.url));

function clientSources(): string {
  return readdirSync(CLIENT_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .filter((f) => !f.endsWith('copy.ts'))
    .map((f) => readFileSync(join2(CLIENT_DIR, f), 'utf8'))
    .join('\n');
}

function join2(dir: string, file: string): string {
  return `${dir}/${file}`;
}

describe('client 文案', () => {
  const sources = clientSources();

  it('没有死文案：每个键都至少被一处组件引用', () => {
    /**
     * 判据宽窄要正好：只认 `copy['k']` 会把**间接引用**误报成死文案
     *（面板按 `DRSC_VERDICT_KEYS[verdict]` 取键，键名只出现在那张映射表里）。
     * 而真死的键在任何组件里都不会以字面量出现，所以"出现在除 copy.ts 外的源码里"就是足够的判据。
     */
    const dead = COPY_KEYS.filter((key) => !sources.includes(key));
    expect(dead).toEqual([]);
  });

  it('zh 与 en 键集完全一致（缺一个键英文界面就会显示 undefined）', () => {
    const zhKeys = Object.keys(zh).sort();
    expect(Object.keys(DICTS.en).sort()).toEqual(zhKeys);
    expect(COPY_KEYS.length).toBe(zhKeys.length);
  });

  it('未知语言退 zh（宿主语言早于字典时不能报错也不能空）', () => {
    expect(copyOf('fr')['pill.labelOn']).toBe(zh['pill.labelOn']);
    expect(copyOf(undefined)['pill.labelOn']).toBe(zh['pill.labelOn']);
    expect(copyOf('en-US')['pill.labelOn']).toBe(DICTS.en['pill.labelOn']);
  });

  it('座位标题传 thunk，不在 apply 期把语言存成字符串', () => {
    /**
     * 真宿主 0.2.0-rc.2 实测：client apply 跑在宿主写 `<html lang>` 之前（初始文档
     * `lang="en"`），于是导航条出现英文「Journal」而面板内是中文。宿主契约明写
     * “thunk 跟随当前语言”（dsh-client-ui-slots resolveSlotLabel），所以这里守的是：
     * label 必须是函数，且 entry.ts 不得再把取词结果存在 apply 作域变量里。
     */
    const entry = readFileSync(join2(CLIENT_DIR, 'entry.ts'), 'utf8');
    expect(entry).toMatch(/label:\s*\(\)\s*=>\s*currentCopy\(\)\['section\.label'\]/u);
    expect(entry).not.toMatch(/label:\s*copy\[/u);
    expect(entry).not.toMatch(/const copy = copyOf/u);
  });
});
