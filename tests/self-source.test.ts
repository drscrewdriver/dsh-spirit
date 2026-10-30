import { describe, expect, it } from 'vitest';

import { isOwnExperienceFromEvent, isOwnExperienceSource } from '../src/util/self-source.js';

describe('isOwnExperienceSource（单源双形状）', () => {
  it('认 v4 producer-owned kind', () => {
    expect(isOwnExperienceSource({ kind: 'plugin:spirit', form: 'snapshot' })).toBe(true);
  });

  it('认 v3 旧形状（老会话日志里的行，只认 v4 会在读旧会话时整段失效）', () => {
    expect(isOwnExperienceSource({ kind: 'plugin', plugin: 'spirit' })).toBe(true);
  });

  it('不认用户行——这是最关键的一条：误判会把用户真说的话从统计与对账里抹掉', () => {
    expect(isOwnExperienceSource({ kind: 'user' })).toBe(false);
    expect(isOwnExperienceSource(undefined)).toBe(false);
    expect(isOwnExperienceSource(null)).toBe(false);
    expect(isOwnExperienceSource('plugin:spirit')).toBe(false);
    expect(isOwnExperienceSource({ kind: 42 })).toBe(false);
  });

  it('不认同机姊妹插件的行（署名不同就是不同来源）', () => {
    expect(isOwnExperienceSource({ kind: 'plugin:memory', form: 'recall' })).toBe(false);
    expect(isOwnExperienceSource({ kind: 'plugin', plugin: 'memory' })).toBe(false);
  });
});

describe('isOwnExperienceFromEvent', () => {
  it('从事件里取 source 判定', () => {
    expect(isOwnExperienceFromEvent({ source: { kind: 'plugin:spirit' } })).toBe(true);
    expect(isOwnExperienceFromEvent({ source: { kind: 'user' } })).toBe(false);
    // 形状不认识 ⇒ 判否，不抛（漏判的代价只是多一次无害重注）
    expect(isOwnExperienceFromEvent({})).toBe(false);
    expect(isOwnExperienceFromEvent(null)).toBe(false);
  });
});
