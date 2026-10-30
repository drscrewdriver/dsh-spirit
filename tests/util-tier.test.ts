import { describe, expect, it } from 'vitest';

import { AROUSAL_TIERS, LANES, REACTION_TIERS, TRIGGER_KINDS, VALENCE_TIERS, type ArousalTier, type ReactionTier } from '../src/types.js';
import { clampInt, clampTier, isDirtyTier } from '../src/util/tier.js';

describe('clampTier（写侧钳制）', () => {
  it('合法值原样通过', () => {
    expect(clampTier('mild', REACTION_TIERS, 'none')).toBe('mild');
  });

  it('非法值一律退兜底，不抛', () => {
    const bad: unknown[] = [null, undefined, 0, NaN, {}, [], 'strong-ish', '', 'NONE'];
    for (const value of bad) {
      expect(clampTier(value, REACTION_TIERS, 'none'), String(value)).toBe('none');
    }
  });

  it('脏值能被读侧识别出来（配合一次性告警）', () => {
    expect(isDirtyTier('mild', REACTION_TIERS)).toBe(false);
    expect(isDirtyTier('rage', REACTION_TIERS)).toBe(true);
    expect(isDirtyTier(undefined, VALENCE_TIERS)).toBe(true);
  });

  it('兜底值本身必须在域内（否则钳制等于制造新的非法值）', () => {
    const fallbacks: Array<[readonly string[], string]> = [
      [REACTION_TIERS, 'none'],
      [VALENCE_TIERS, 'mid'],
      [AROUSAL_TIERS, 'normal'],
      [LANES, 'live'],
    ];
    for (const [domain, fallback] of fallbacks) {
      expect(domain).toContain(fallback);
      expect(clampTier('!!', domain, fallback)).toBe(fallback as ReactionTier | ArousalTier | string);
    }
  });
});

describe('clampInt（预算/开关类整数）', () => {
  it('非有限值全部退兜底', () => {
    const bad: unknown[] = [null, undefined, '800', NaN, Infinity, -Infinity, {}, []];
    for (const value of bad) expect(clampInt(value, 0, 100, 42), String(value)).toBe(42);
  });

  it('小数向下取整、越界夹端点', () => {
    expect(clampInt(1.7, 0, 10, 0)).toBe(1);
    expect(clampInt(-1, 0, 10, 0)).toBe(0);
    expect(clampInt(999, 0, 10, 0)).toBe(10);
    expect(clampInt(0, 0, 10, 5)).toBe(0);
  });

  it('负数预算不会被当成"合法大值"（这是"改值不生效"类事故的最初形状）', () => {
    expect(clampInt(-5, 0, 2_000, 384)).toBe(0);
  });
});

describe('取值域自身', () => {
  it('trigger 族覆盖六类且无重复', () => {
    expect(TRIGGER_KINDS).toHaveLength(6);
    expect(new Set(TRIGGER_KINDS).size).toBe(6);
  });
});
