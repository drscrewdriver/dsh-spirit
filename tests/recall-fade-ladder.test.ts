/**
 * 淡出台阶 0-7-30（v19）：边界四点 / 单调不增 / 末阶地板 / 指纹稳定 / 冻结臂。
 *
 * 核心修复点：旧实现 `max(0.5, 0.5^floor(Δt/90min))` 只有「1.0 / 0.5」两档，
 * 「昨天的事」与「上个月的事」权重完全一样。新实现让中间那阶（750）真正存在。
 */
import { describe, expect, it } from 'vitest';

import {
  FADE_FLOOR_PERMILLE,
  fadeScoreMs,
  formDigest,
  formOf,
  ladderWeightPermille,
  type FadeConfig,
} from '../src/recall/form.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 14, 0, 0, 0);

function cfg(over: Partial<FadeConfig> = {}): FadeConfig {
  return {
    fadeEnabled: true,
    feedbackEnabled: true,
    fadeHalfLifeMs: 5_400_000,
    fadeHotDays: 7,
    fadeColdDays: 30,
    fadeWarmWeight: 750,
    fadeColdWeight: 500,
    fullMinScore: 550,
    gistMinScore: 250,
    gistMinSalience: 1,
    ...over,
  };
}

function at(days: number): number {
  return NOW - days * DAY;
}

/** 带 gist 的条目（formOf 走 gist 形态的必要条件：gist 只能编译期派生、运行时绝不造）。 */
function e(days: number, salience: number): { tsMs: number; salience: number; gist: string; text: string } {
  return { tsMs: at(days), salience, gist: '有一次没走通，我记着', text: '手边的动作没成，我记着这一下' };
}

describe('台阶权重（千分位）', () => {
  it('边界四点：hot−1ms → 1000 / hot → 750 / cold−1ms → 750 / cold → 500', () => {
    const c = cfg();
    expect(ladderWeightPermille(NOW - 7 * DAY + 1, NOW, c)).toBe(1_000);
    expect(ladderWeightPermille(NOW - 7 * DAY, NOW, c)).toBe(750);
    expect(ladderWeightPermille(NOW - 30 * DAY + 1, NOW, c)).toBe(750);
    expect(ladderWeightPermille(NOW - 30 * DAY, NOW, c)).toBe(500);
  });

  it('单调不增（0..400 天采样）', () => {
    const c = cfg();
    let prev = 1_001;
    for (const days of [0, 1, 6.9, 7, 10, 29.9, 30, 90, 365, 4_000]) {
      const w = ladderWeightPermille(at(days), NOW, c);
      expect(w).toBeLessThanOrEqual(prev);
      prev = w;
    }
  });

  it('末阶地板：年龄再大也停在 fadeColdWeight', () => {
    const c = cfg();
    expect(ladderWeightPermille(at(3_650), NOW, c)).toBe(500);
    expect(ladderWeightPermille(at(3_650), NOW, c)).toBe(FADE_FLOOR_PERMILLE);
  });

  it('冻结语义：fadeHalfLifeMs=0 ⇒ 全阶 1000', () => {
    const c = cfg({ fadeHalfLifeMs: 0 });
    for (const days of [0, 7, 30, 3_650]) expect(ladderWeightPermille(at(days), NOW, c)).toBe(1_000);
  });

  it('钳制：权重越界被夹到 500..1000，且 cold ≤ warm', () => {
    expect(ladderWeightPermille(at(10), NOW, cfg({ fadeWarmWeight: 5_000 }))).toBe(1_000);
    expect(ladderWeightPermille(at(40), NOW, cfg({ fadeColdWeight: 5_000 }))).toBe(750);
    expect(ladderWeightPermille(at(40), NOW, cfg({ fadeWarmWeight: 600, fadeColdWeight: 900 }))).toBe(600);
  });

  it('hot=0 的保守臂：立刻进「一周后」阶', () => {
    expect(ladderWeightPermille(at(0), NOW, cfg({ fadeHotDays: 0 }))).toBe(750);
  });
});

describe('分数与形态（salience 2.0）', () => {
  it('1 天 full m=1000 / 10 天 full m=750 / 90 天 gist m=500', () => {
    const c = cfg();
    expect(fadeScoreMs(e(1, 2), NOW, c)).toBe(1_000);
    expect(fadeScoreMs(e(10, 2), NOW, c)).toBe(750);
    expect(fadeScoreMs(e(90, 2), NOW, c)).toBe(500);
    expect(formOf(e(1, 2) as never, NOW, c)).toBe('full');
    expect(formOf(e(10, 2) as never, NOW, c)).toBe('full');
    expect(formOf(e(90, 2) as never, NOW, c)).toBe('gist');
  });

  it('低 salience 不被台阶硬捧（0.5 仍 held）', () => {
    const c = cfg();
    expect(fadeScoreMs(e(1, 0.5), NOW, c)).toBe(250);
    expect(formOf(e(1, 0.5) as never, NOW, c)).toBe('held');
  });

  it('指纹稳定：同 salience + 同阶 ⇒ 同 formDigest', () => {
    const c = cfg();
    const a = formOf({ tsMs: at(8), salience: 2 } as never, NOW, c);
    const b = formOf({ tsMs: at(20), salience: 2 } as never, NOW + 5 * DAY, c);
    expect(a).toBe(b);
    expect(formDigest([a, b])).toBe(formDigest([b, a]));
  });

  it('冻结臂：fadeEnabled=false ⇒ 恒 full（与 v0.1 逐字节一致）', () => {
    const c = cfg({ fadeEnabled: false });
    expect(formOf({ tsMs: at(3_650), salience: 0.5 } as never, NOW, c)).toBe('full');
  });
});