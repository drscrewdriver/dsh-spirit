/**
 * 编年汇编门禁（v0.10 定位重钉）。
 *
 * 四条断言就是这次重定位的四条纪律：
 * 1. **事不依赖感**：只有交付、没有体验条目时，编年仍然有内容；
 * 2. **重复才报数**：同日同句才给 `repeat > 1`，不同日不合并（去年那个坑不是今天这个）；
 * 3. **事压过感**：同一天里事排在感之前（默认面第一屏不该是伤疤）；
 * 4. **不编造**：窗口外的行不进轴，空窗口老实返回 `empty`。
 */
import { describe, expect, it } from 'vitest';

import {
  CHRONICLE_TEXT_MAX,
  buildChronicle,
  chronicleText,
  localDayKey,
  type ChronicleInput,
  type ChronicleLearnedInput,
} from '../src/chronicle/build.js';
import { TRIGGER_NEUTRAL, TRIGGER_TOOL_FAILURE } from '../src/types.js';
import { NOTICE_SELF_MISTAKE, NOTICE_TASK_PROGRESS } from '../src/types.js';

/** 固定日键：避开本机时区，把断言钉在"分桶逻辑"而不是"跑测试的机器在哪"。 */
const dayOf = (tsMs: number): string => `d${Math.floor(tsMs / 100_000)}`;

function feel(id: string, tsMs: number, text: string): ChronicleInput['feels'][number] {
  return { id, tsMs, trigger: TRIGGER_TOOL_FAILURE, notice: NOTICE_SELF_MISTAKE, text };
}

function work(id: string, tsMs: number, cardLine: string, summary?: string): ChronicleInput['works'][number] {
  return { id, tsMs, cardLine, ...(summary === undefined ? {} : { summary }) };
}

describe('编年汇编', () => {
  it('只有交付也要读得通（事不依赖感）', () => {
    const result = buildChronicle({
      feels: [],
      works: [work('w1', 1_000_000, '交付物：把星图接上交付')],
      from: 0,
      to: 2_000_000,
      dayKeyOf: dayOf,
    });
    expect(result.empty).toBe(false);
    expect(result.days).toHaveLength(1);
    expect(result.days[0]?.items[0]?.kind).toBe('work');
    // 交付标签由徽标承担，正文里不重复前缀
    expect(result.days[0]?.items[0]?.text).toBe('把星图接上交付');
  });

  it('同日同句才聚合，跨日不合并', () => {
    const sameDay = buildChronicle({
      feels: [feel('f1', 1_000_000, '手边的动作没成'), feel('f2', 1_100_000, '手边的动作没成')],
      works: [],
      from: 0,
      to: 2_000_000,
      dayKeyOf: () => 'same',
    });
    expect(sameDay.days[0]?.items).toHaveLength(1);
    expect(sameDay.days[0]?.items[0]?.repeat).toBe(2);
    // 取最近一次发生的时刻，不是最早那次（编年是"最后一次是什么时候"的口径）
    expect(sameDay.days[0]?.items[0]?.tsMs).toBe(1_100_000);

    const crossDay = buildChronicle({
      feels: [feel('f1', 1_000_000, '手边的动作没成'), feel('f2', 1_500_000, '手边的动作没成')],
      works: [],
      from: 0,
      to: 2_000_000,
      dayKeyOf: dayOf,
    });
    const items = crossDay.days.flatMap((day) => day.items);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.repeat === 1)).toBe(true);
  });

  it('同一天里事排在感之前', () => {
    const result = buildChronicle({
      feels: [feel('f1', 1_500_000, '手边的动作没成')],
      works: [work('w1', 1_000_000, '交付：写完了定位书')],
      from: 0,
      to: 2_000_000,
      dayKeyOf: () => 'same',
    });
    expect(result.days[0]?.items.map((item) => item.kind)).toEqual(['work', 'feel']);
  });

  it('窗口外的行不进轴；空窗口老实报 empty', () => {
    const outside = buildChronicle({
      feels: [feel('f1', 9_000, '很久以前')],
      works: [work('w1', 9_000, '交付：很久以前的事')],
      from: 1_000_000,
      to: 2_000_000,
      dayKeyOf: dayOf,
    });
    expect(outside.empty).toBe(true);
    expect(outside.total).toBe(0);
  });

  it('里程碑首行进正文、其余行退到 detail', () => {
    const result = buildChronicle({
      feels: [],
      works: [],
      milestones: [{ periodKey: '2026-11', tsMs: 1_200_000, summary: '11 月：把星海改完了\n11/12 · 交付 · 三个面\n11/20 · 决定 · 不再加召回' }],
      from: 0,
      to: 2_000_000,
      dayKeyOf: () => 'same',
    });
    const item = result.days[0]?.items[0];
    expect(item?.kind).toBe('milestone');
    expect(item?.text).toBe('11 月：把星海改完了');
    expect(item?.detail).toContain('11/20');
  });

  it('记着进轴，但不与日记混（日记是随手记，不进经历轴）', () => {
    const result = buildChronicle({
      feels: [],
      works: [],
      notes: [{ id: 'mm-1', tsMs: 1_000_000, text: '以后标题都用中文' }],
      from: 0,
      to: 2_000_000,
      dayKeyOf: dayOf,
    });
    expect(result.days[0]?.items[0]).toMatchObject({ kind: 'note', text: '以后标题都用中文' });
    expect(result.days[0]?.counts.note).toBe(1);
  });

  it('天倒序：近的在前', () => {
    const result = buildChronicle({
      feels: [feel('old', 1_000_000, '旧的一天')],
      works: [work('new', 9_000_000, '交付：新的一天')],
      from: 0,
      to: 10_000_000,
      dayKeyOf: dayOf,
    });
    expect(result.days).toHaveLength(2);
    const [first, second] = result.days;
    expect(String(first?.day) > String(second?.day)).toBe(true);
  });

  it('正文归一：折行、截断、去交付前缀', () => {
    expect(chronicleText('交付物：  a\n\nb   c')).toBe('a b c');
    const long = 'x'.repeat(CHRONICLE_TEXT_MAX + 40);
    const cut = chronicleText(long);
    expect(cut).toHaveLength(CHRONICLE_TEXT_MAX);
    expect(cut.endsWith('…')).toBe(true);
    // 中性轮的句子照旧可以进轴：编年不筛情绪强度，只筛"有没有东西"
    expect(chronicleText('寻常的一轮，没什么特别')).toBe('寻常的一轮，没什么特别');
    expect(NOTICE_TASK_PROGRESS).toBe('task_progress');
    expect(TRIGGER_NEUTRAL).toBe('neutral');
  });

  it('本机日键是 YYYY-MM-DD', () => {
    expect(localDayKey(Date.UTC(2026, 10, 22, 5, 0, 0))).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });
});

describe('编年：learned 日配额（v0.10 真机逼出来的）', () => {
  it('learned 每天最多 5 条，按温度取最暖的', () => {
    // 真机 11-23 那天原本 131 条 learned；不限流编年就是流水账
    const learned: ChronicleLearnedInput[] = Array.from({ length: 20 }, (_, i) => ({
      kind: 'learned' as const,
      id: `l${i}`,
      tsMs: 1_000_000 + i,
      text: `第 ${i} 条知识`,
      // 只有第 7 条最暖，它必须留下；最冷的排后面
      warmth: i === 7 ? ('hot' as const) : i < 12 ? ('cool' as const) : ('faded' as const),
    }));
    const result = buildChronicle({
      feels: [],
      works: [],
      learned,
      from: 0,
      to: 2_000_000,
      dayKeyOf: () => 'same',
    });
    const kept = result.days[0]?.items ?? [];
    const learnedKept = kept.filter((item) => item.kind === 'learned');
    expect(learnedKept).toHaveLength(5);
    expect(kept.some((item) => item.id === 'l7')).toBe(true);
    expect(learnedKept.every((item) => item.warmth !== 'faded')).toBe(true);
  });

  it('bond 不受配额限制（真机每天 1–6 条，天然不会淹）', () => {
    const learned: ChronicleLearnedInput[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'bond' as const,
      id: `b${i}`,
      tsMs: 1_000_000 + i,
      text: `关于这个人的第 ${i} 条`,
      warmth: 'warm' as const,
    }));
    const result = buildChronicle({
      feels: [],
      works: [],
      learned,
      from: 0,
      to: 2_000_000,
      dayKeyOf: () => 'same',
    });
    expect(result.days[0]?.counts.bond).toBe(10);
  });

  it('learnedPerDay=0 时一条都不出（配额可关到零）', () => {
    const result = buildChronicle({
      feels: [],
      works: [],
      learned: [{ kind: 'learned', id: 'x', tsMs: 1_000_000, text: '一条', warmth: 'hot' }],
      from: 0,
      to: 2_000_000,
      learnedPerDay: 0,
      dayKeyOf: () => 'same',
    });
    expect(result.days[0]?.counts.learned).toBe(0);
  });
});
