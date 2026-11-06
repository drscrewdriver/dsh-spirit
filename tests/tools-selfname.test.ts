/**
 * 自称工具（v0.3.4）的合并腿单测：mergeSelfNames 是纯函数，
 * 模型经 spirit_selfname 递进来的一切都要过它——上限/去重/精确删在这里把守，
 * 不依赖 ctx 与宿主，能测尽测。
 */
import { describe, expect, it } from 'vitest';

import { mergeSelfNames } from '../src/tools/selfname.js';
import { PERSONA_LIMITS } from '../src/persona/types.js';

describe('mergeSelfNames（模型写自称的收窄腿）', () => {
  it('add 追加、remove 精确删、去重保序', () => {
    expect(mergeSelfNames(['我'], ['本鱼', '鱼鱼'], [])).toEqual(['我', '本鱼', '鱼鱼']);
    expect(mergeSelfNames(['我', '本鱼'], [], ['本鱼'])).toEqual(['我']);
    expect(mergeSelfNames(['我', '我'], ['我'], [])).toEqual(['我']);
  });

  it('remove 不存在的词是无害 no-op（幂等，不报错不越删）', () => {
    expect(mergeSelfNames(['我'], [], ['不存在'])).toEqual(['我']);
  });

  it('上限有顶：超 8 个截断、单条超 24 字截断（模型递来长句也收窄得动）', () => {
    const many = mergeSelfNames([], Array.from({ length: 20 }, (_, i) => `自称${i}`), []);
    expect(many.length).toBe(PERSONA_LIMITS.selfNames);
    const long = mergeSelfNames([], ['鱼'.repeat(60)], []);
    expect(long[0]?.length).toBe(PERSONA_LIMITS.aliasChars);
  });

  it('空白项与前后空格：trim 后空串丢弃（不留空行进注入）', () => {
    expect(mergeSelfNames(['我'], ['  ', ' 本鱼 ', ''], [])).toEqual(['我', '本鱼']);
  });
});
