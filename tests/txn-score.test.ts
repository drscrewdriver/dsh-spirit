/**
 * 交付条目规则打分（v0.7）：确定性、可解释、零 LLM。
 * 正反成对：档位/来源/结构/近因/噪声五组加罚分逐项可验；同分以新者胜。
 */
import { describe, expect, it } from 'vitest';

import { pickBest, ruleScore, type ScorableTxn } from '../src/recall/txn-score.js';

const NOW = 1_790_000_000_000;
const base = (over: Partial<ScorableTxn> = {}): ScorableTxn => ({
  salienceTier: 2,
  sourceTrust: 'derived_summary',
  cardLine: '我修好了端口漂移并写了测试',
  summary: '按规则固定 tick，不再反复探测',
  cues: [{ cue: '端口', kind: 'noun' }],
  tsMs: NOW - 60_000,
  ...over,
});

describe('ruleScore', () => {
  it('档位基底单调：tier1 > tier2 > tier3 > 其他', () => {
    const t1 = ruleScore(base({ salienceTier: 1 }), { now: NOW });
    const t2 = ruleScore(base({ salienceTier: 2 }), { now: NOW });
    const t3 = ruleScore(base({ salienceTier: 3 }), { now: NOW });
    const t4 = ruleScore(base({ salienceTier: 4 }), { now: NOW });
    expect(t1).toBeGreaterThan(t2);
    expect(t2).toBeGreaterThan(t3);
    expect(t3).toBeGreaterThan(t4);
  });

  it('来源加分：user_explicit(+20) > derived_summary(+10) > structure_signal(+0)', () => {
    const user = ruleScore(base({ sourceTrust: 'user_explicit' }), { now: NOW });
    const derived = ruleScore(base({ sourceTrust: 'derived_summary' }), { now: NOW });
    const structure = ruleScore(base({ sourceTrust: 'structure_signal' }), { now: NOW });
    expect(user - derived).toBe(10);
    expect(derived - structure).toBe(10);
  });

  it('结构加分与噪声罚分：cue(+10)、summary(+8)、短句(-10) 逐项生效', () => {
    const full = ruleScore(base(), { now: NOW });
    expect(ruleScore(base({ cues: [] }), { now: NOW })).toBe(full - 10);
    expect(ruleScore(base({ summary: '' }), { now: NOW })).toBe(full - 8);
    const short = ruleScore(base({ cardLine: '我回复了好' }), { now: NOW });
    expect(short).toBe(full - 10);
  });

  it('近因微调只在 24h 内（上限 +12）；跨天不靠它', () => {
    const fresh = ruleScore(base({ tsMs: NOW }), { now: NOW });
    const dayOld = ruleScore(base({ tsMs: NOW - 24 * 3_600_000 }), { now: NOW });
    expect(fresh - dayOld).toBe(12);
    // 越老不再继续掉分（跨天交给档位，不做第二套衰减）
    expect(ruleScore(base({ tsMs: NOW - 72 * 3_600_000 }), { now: NOW })).toBe(dayOld);
  });
});

describe('pickBest', () => {
  it('同档内取"更有分量"的：有 summary 的旧交付胜最新短句', () => {
    const trivialNewest = base({ cardLine: '我回复了好', summary: '', cues: [], tsMs: NOW });
    const richOlder = base({ tsMs: NOW - 6 * 3_600_000 });
    expect(pickBest([trivialNewest, richOlder], { now: NOW })).toBe(richOlder);
  });

  it('同分取新者；空窗口 undefined（不编造）', () => {
    const a = base({ tsMs: NOW - 3_600_000 });
    const b = base({ tsMs: NOW - 60_000 });
    expect(pickBest([a, b], { now: NOW })).toBe(b);
    expect(pickBest([], { now: NOW })).toBeUndefined();
  });
});
