/**
 * 「温度」层门禁（v0.10）：编年上「得知 / 关于这个人」两路的温度判定。
 *
 * 这一层是唯一向 fish-memory 借形的地方，所以每个断言都要钉住"借的是判断，不是存储"：
 * 1. 重要度用上游 `priority`，缺列不冒充"不重要"；
 * 2. 永久档（persistence=t）顶格——一个"永久"标记比任何数字都强；
 * 3. 重要的事降得慢（半衰期随重要度拉长）；
 * 4. 被想起会加热；失效只折减、不删除；
 * 5. 分类：chat 家族强制归「关于这个人」（type 名靠不住，家族才是判据）。
 */
import { describe, expect, it } from 'vitest';

import type { L1WarmthRow } from '../src/prime/l1-source.js';
import {
  WARMTH_COOL_MIN,
  WARMTH_HALF_LIFE_BOND_MS,
  WARMTH_HALF_LIFE_LEARNED_MS,
  WARMTH_MILD_MIN,
  WARMTH_WARM_MIN,
  clip,
  freshnessOf,
  halfLifeBaseOf,
  halfLifeOf,
  importanceOf,
  kindOfL1,
  recallHeatOf,
  tierOf,
  toWarmItems,
  warmthOf,
} from '../src/prime/l1-warmth.js';

const DAY = 86_400_000;

function row(over: Partial<L1WarmthRow> = {}): L1WarmthRow {
  return {
    id: 'r1',
    type: 'work_fact',
    family: 'work',
    content: '某条事实',
    tsMs: 0,
    priority: 85,
    persistence: '',
    validTo: '',
    workspaceId: '',
    sessionId: '',
    ...over,
  };
}

describe('温度：分类', () => {
  it('chat 家族强制归「关于这个人」（type 名靠不住）', () => {
    expect(kindOfL1({ type: 'episodic', family: 'chat' })).toBe('bond');
    expect(kindOfL1({ type: 'episodic', family: 'work' })).toBe('bond');
    expect(kindOfL1({ type: 'work_fact', family: 'work' })).toBe('learned');
    expect(kindOfL1({ type: 'user_communication', family: 'chat' })).toBe('bond');
  });

  it('任务/产物交回交付轨（编年不重复画同一件事）', () => {
    expect(kindOfL1({ type: 'work_task', family: 'work' })).toBe('skip');
    expect(kindOfL1({ type: 'work_artifact', family: 'work' })).toBe('skip');
  });

  it('未收录的 type 归「得知」，不静默吞掉', () => {
    expect(kindOfL1({ type: 'brand_new_type', family: 'work' })).toBe('learned');
  });
});

describe('温度：重要度与半衰期', () => {
  it('优先用上游 priority；缺列时按类别给保守底（不冒充不重要）', () => {
    expect(importanceOf(row({ priority: 90 }))).toBeCloseTo(0.9, 5);
    expect(importanceOf(row({ priority: undefined, type: 'work_fact' }))).toBeCloseTo(0.5, 5);
    expect(importanceOf(row({ priority: undefined, type: 'user_info' }))).toBeCloseTo(0.8, 5);
  });

  it('永久档顶格（persistence=t 赢过任何 priority 数字）', () => {
    expect(importanceOf(row({ priority: 70, persistence: 't' }))).toBe(1);
  });

  it('重要的事降得慢', () => {
    expect(halfLifeOf(1, 'learned')).toBeGreaterThan(halfLifeOf(0.5, 'learned'));
    expect(halfLifeOf(0, 'learned')).toBe(WARMTH_HALF_LIFE_LEARNED_MS);
  });

  it('基准按类别分开：关系记忆记得比流水事实久（真机分布逼出来的）', () => {
    // 单基准下 learned 四档塌成两档（hot 756/warm 226/cool 0/faded 0），bond 会被记成快忘了
    expect(halfLifeBaseOf('bond')).toBe(WARMTH_HALF_LIFE_BOND_MS);
    expect(halfLifeBaseOf('learned')).toBe(WARMTH_HALF_LIFE_LEARNED_MS);
    expect(halfLifeBaseOf('bond')).toBeGreaterThan(halfLifeBaseOf('learned') * 5);
    // 同一时刻、同一重要度，bond 必须比 learned 暖
    const args = { tsMs: 1_000, now: 1_000 + 10 * DAY, importance: 0.9, recallHits: 0, expired: false };
    expect(warmthOf({ ...args, kind: 'bond' })).toBeGreaterThan(warmthOf({ ...args, kind: 'learned' }));
  });
});

describe('温度：鲜活度与加热', () => {
  it('半衰一格：一个半衰期后剩一半', () => {
    // 时间戳用非 0 的真值：`tsMs <= 0` 是"解析失败"的哨兵（上游缺 stamp），必须返 0 而不是"冻在最新"
    expect(freshnessOf(1_000, 1_000 + WARMTH_HALF_LIFE_LEARNED_MS, WARMTH_HALF_LIFE_LEARNED_MS)).toBeCloseTo(0.5, 5);
    expect(freshnessOf(0, WARMTH_HALF_LIFE_LEARNED_MS, WARMTH_HALF_LIFE_LEARNED_MS)).toBe(0);
  });

  it('被想起会加热，但有顶', () => {
    expect(recallHeatOf(0)).toBe(0);
    expect(recallHeatOf(1)).toBeCloseTo(0.08, 5);
    expect(recallHeatOf(100)).toBeLessThanOrEqual(0.4);
  });

  it('失效只折减不删除（"曾经的看法"仍要看得到）', () => {
    const live = warmthOf({ tsMs: 1_000, now: 1_000 + DAY, importance: 1, kind: 'learned', recallHits: 0, expired: false });
    const expired = warmthOf({ tsMs: 1_000, now: 1_000 + DAY, importance: 1, kind: 'learned', recallHits: 0, expired: true });
    expect(expired).toBeLessThan(live);
    expect(expired).toBeGreaterThan(0);
  });

  it('分档阈值是闭区间且顺序单调', () => {
    expect(tierOf(WARMTH_WARM_MIN)).toBe('hot');
    expect(tierOf(WARMTH_MILD_MIN)).toBe('warm');
    expect(tierOf(WARMTH_COOL_MIN)).toBe('cool');
    expect(tierOf(0)).toBe('faded');
  });
});

describe('温度：L1 行 → 暖条目', () => {
  it('只有 chat/work 家族里非任务类才成条；id 前缀可辨识来源', () => {
    const items = toWarmItems(
      [
        row({ id: 'a', type: 'user_info', family: 'chat', priority: 90 }),
        row({ id: 'b', type: 'work_fact', priority: 85 }),
        row({ id: 'c', type: 'work_task', priority: 90 }),
      ],
      { now: 0 },
    );
    expect(items.map((item) => item.id)).toEqual(['l1-a', 'l1-b']);
    expect(items[0]?.kind).toBe('bond');
    expect(items[1]?.kind).toBe('learned');
  });

  it('引用计数来自调用方（自己的账，不是上游的召回账）', () => {
    const items = toWarmItems([row({ id: 'x', tsMs: 1_000 })], {
      now: 1_000 + WARMTH_HALF_LIFE_LEARNED_MS,
      recallHitsOf: (id) => (id === 'x' ? 3 : 0),
    });
    expect(items[0]?.recallHits).toBe(3);
    // 一个半衰期 ⇒ 0.5 基础上再加热 3×0.08
    expect(items[0]?.warmth).toBeGreaterThan(0.7);
  });

  it('空正文不成条；长正文截断且不切半个字', () => {
    expect(toWarmItems([row({ content: '   ' })], { now: 0 })).toHaveLength(0);
    const long = '字'.repeat(400);
    expect(clip(long, 200)).toHaveLength(200);
    expect(Array.from(clip(long, 200)).at(-1)).toBe('…');
  });
});
