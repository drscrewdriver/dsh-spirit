/**
 * 记忆星海：纯函数与窗口读取的门禁。
 *
 * 这里**不测像素**：几何与绘制在客户端另有单测（layout/projection）。本文件只守三条
 * 会静默坏掉的语义：
 * 1. 亮度真的能暗下去（没有 0.5 地板）；
 * 2. 归属轴不读自由文本；
 * 3. 窗口读取只取未取代行、且有上限。
 */
import { describe, expect, it } from 'vitest';

import { SEA_EDGE_MAX, SEA_MAX_NEIGHBORS, axisOf, buildSeaScene, fadeTierOf, seaFreshness } from '../src/sea/scene.js';
import { ExperienceStore } from '../src/store/experience.js';
import type { ExperienceDraft, ExperienceEntry, TriggerKind } from '../src/types.js';

const logger = { info: () => {}, warn: () => {} };

function entryOf(over: Partial<ExperienceEntry> & { id: string; tsMs: number }): ExperienceEntry {
  return {
    sessionId: 's1',
    workspaceId: 'w1',
    turnSeq: 1,
    trigger: 'neutral',
    notice: 'task_progress',
    reaction: 'none',
    text: '这一轮做了点事',
    fact: {},
    lane: 'live',
    personaRevision: 1,
    updatedAt: over.tsMs,
    ...over,
  };
}

describe('seaFreshness（无地板老化）', () => {
  it('同一时刻为 1；越久越暗且能低于 0.01', () => {
    expect(seaFreshness(1_000, 1_000, 60_000)).toBe(1);
    const old = seaFreshness(0, 100 * 60_000, 60_000);
    expect(old).toBeLessThan(0.01);
    expect(old).toBeGreaterThan(0);
  });

  it('半衰期 <= 0 视为关闭衰减', () => {
    expect(seaFreshness(0, 10 ** 12, 0)).toBe(1);
    expect(seaFreshness(0, 10 ** 12, -1)).toBe(1);
  });

  it('未来时间戳不会产生 >1 的亮度', () => {
    expect(seaFreshness(2_000, 1_000, 60_000)).toBe(1);
  });
});

describe('axisOf（只读结构化事实）', () => {
  const axisOfTrigger = (trigger: TriggerKind, userChars = 0): number =>
    axisOf({ trigger, fact: userChars > 0 ? { userChars } : {} });

  it('六个 trigger 都落在 [-1,1] 且方向符合预期', () => {
    expect(axisOfTrigger('user_interruption')).toBeGreaterThan(0);
    expect(axisOfTrigger('tool_failure')).toBeLessThan(0);
    expect(axisOfTrigger('neutral')).toBe(0);
    for (const trigger of ['user_interruption', 'tool_failure', 'recovery', 'task_close', 'long_gap', 'neutral'] as const) {
      const value = axisOfTrigger(trigger);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('userChars 只做有界微调（最多 +0.2）', () => {
    const bare = axisOfTrigger('neutral');
    const chatty = axisOfTrigger('neutral', 10_000);
    expect(chatty - bare).toBeCloseTo(0.2, 5);
  });

  it('text 不参与：把 text 写成「主人」也不挪动轴', () => {
    const base = axisOf({ trigger: 'neutral', fact: {} });
    const injected = axisOf({ trigger: 'neutral', fact: {}, ...{ text: '主人说今天很累' } } as never);
    expect(injected).toBe(base);
  });
});

describe('fadeTierOf（淡出读数复算）', () => {
  const cfg = { enabled: true, fullMinScore: 550, gistMinScore: 250, gistMinSalience: 1 };

  it('关闸时一律 full', () => {
    expect(fadeTierOf({ salience: 0, gist: '' }, 0, { ...cfg, enabled: false })).toBe('full');
  });

  it('按 m = salience/2 × freshness 分三档', () => {
    expect(fadeTierOf({ salience: 2, gist: 'g' }, 1, cfg)).toBe('full');
    expect(fadeTierOf({ salience: 2, gist: 'g' }, 0.5, cfg)).toBe('gist');
    expect(fadeTierOf({ salience: 2, gist: 'g' }, 0.1, cfg)).toBe('held');
  });

  it('没有 gist 的旧行不下沉到 gist 档（宁缺毋造）', () => {
    expect(fadeTierOf({ salience: 2, gist: '' }, 0.5, cfg)).toBe('held');
  });
});

describe('buildSeaScene', () => {
  const now = 10_000_000;
  const entries: ExperienceEntry[] = [
    entryOf({ id: 'a', tsMs: now - 30_000, trigger: 'user_interruption', salience: 2, gist: 'g-a' }),
    entryOf({ id: 'b', tsMs: now - 20_000, trigger: 'tool_failure', salience: 1, text: '工具挂了，我先记下' }),
    entryOf({ id: 'c', tsMs: now - 10_000, trigger: 'neutral', salience: 0, feedbackScore: 5 }),
  ];
  const cues = new Map<string, string[]>([
    ['a', ['累', '今天']],
    ['b', ['报错']],
    ['c', ['今天']],
  ]);

  it('点字段齐备且与输入同序', () => {
    const graph = buildSeaScene(entries, {
      now,
      halfLifeMs: 60_000,
      total: 42,
      moodLabel: '平稳',
      degraded: false,
      window: 10,
      cues,
    });
    expect(graph.points.map((point) => point.id)).toEqual(['a', 'b', 'c']);
    expect(graph.stats.loaded).toBe(3);
    expect(graph.stats.total).toBe(42);
    expect(graph.stats.moodLabel).toBe('平稳');
    expect(graph.stats.span).toEqual({ from: now - 30_000, to: now - 10_000 });
    expect(graph.points[0]!.gist).toBe('g-a');
    expect(graph.points[2]!.feedback).toBe(5);
    // 线索与点同体下发（详情卡/手记卡片的“证据面” chips）
    expect(graph.points[0]!.cues).toEqual(['累', '今天']);
    // 无 fade 参数 ⇒ 不假装知道档位（全部 full）；带 fade 的分布见下面那条
    expect(graph.points.map((point) => point.tier)).toEqual(['full', 'full', 'full']);
  });

  it('共享 cue 会连边，且边可解释（只出 cue 类）', () => {
    const graph = buildSeaScene(entries, { now, halfLifeMs: 60_000, total: 3, moodLabel: '', degraded: false, window: 10, cues });
    const pairs = graph.edges.map((edge) => `${edge.a}-${edge.b}`);
    expect(pairs).toContain('a-c'); // 共享「今天」
    const ac = graph.edges.find((edge) => edge.a === 'a' && edge.b === 'c');
    expect(ac?.kind).toBe('cue'); // 共享 cue 的边标 cue，不冒充时间边
    expect(graph.stats.edges).toBe(graph.edges.length);
  });

  it('没有任何 cue 时仍靠时间邻居成线', () => {
    const graph = buildSeaScene(entries, { now, halfLifeMs: 60_000, total: 3, moodLabel: '', degraded: false, window: 10 });
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  it('每点边数不超过上限', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      entryOf({ id: `n${index}`, tsMs: now - index * 1_000, salience: 1 }),
    );
    const cuesAll = new Map(many.map((entry) => [entry.id, ['共同词']]));
    const graph = buildSeaScene(many, { now, halfLifeMs: 60_000, total: 20, moodLabel: '', degraded: false, window: 20, cues: cuesAll });
    const degree = new Map<string, number>();
    for (const edge of graph.edges) {
      degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
      degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
    }
    for (const count of degree.values()) expect(count).toBeLessThanOrEqual(SEA_MAX_NEIGHBORS);
  });

  it('淡出档位与 stats.fade 同源（同一个值，不两处重算）', () => {
    const graph = buildSeaScene(entries, {
      now,
      halfLifeMs: 60_000,
      total: 3,
      moodLabel: '',
      degraded: false,
      window: 10,
      fade: { enabled: true, fullMinScore: 550, gistMinScore: 250, gistMinSalience: 1 },
    });
    const counted = { full: 0, gist: 0, held: 0 };
    for (const point of graph.points) counted[point.tier] += 1;
    expect(counted).toEqual({ full: 1, gist: 0, held: 2 }); // b 没有 gist ⇒ 宁缺毋造直接 held
    expect(graph.stats.fade).toEqual(counted);
  });

  it('边按来源分类：cue 与 time 各得其位（不得全标成同一种）', () => {
    const graph = buildSeaScene(entries, { now, halfLifeMs: 60_000, total: 3, moodLabel: '', degraded: false, window: 10, cues });
    const kinds = new Set(graph.edges.map((edge) => edge.kind));
    expect(kinds.has('cue')).toBe(true); // a-c 共享「今天」
    expect(kinds.has('time')).toBe(true); // a-b 无共享 cue，靠时间邻居
    const ab = graph.edges.find((edge) => edge.a === 'a' && edge.b === 'b');
    expect(ab?.kind).toBe('time');
  });

  it('被取代行同窗时产出 supersede 边，并计入 ghosts', () => {
    const ghost = entryOf({ id: 'g', tsMs: now - 5_000, supersededBy: 'c' });
    const graph = buildSeaScene([...entries, ghost], { now, halfLifeMs: 60_000, total: 4, moodLabel: '', degraded: false, window: 10 });
    expect(graph.points.filter((point) => point.superseded).map((point) => point.id)).toEqual(['g']);
    expect(graph.stats.ghosts).toBe(1);
    expect(graph.edges.some((edge) => edge.kind === 'supersede' && edge.a === 'c' && edge.b === 'g')).toBe(true);
  });

  it('取代链另一端不在窗内时不造悬空边', () => {
    const orphan = entryOf({ id: 'o', tsMs: now - 5_000, supersededBy: '不在窗内' });
    const graph = buildSeaScene([...entries, orphan], { now, halfLifeMs: 60_000, total: 4, moodLabel: '', degraded: false, window: 10 });
    expect(graph.edges.some((edge) => edge.kind === 'supersede')).toBe(false);
  });

  it('线索最多带 4 条（卡片宽度有限，多了就是噪声）', () => {
    const one = [entryOf({ id: 'x', tsMs: now })];
    const many = new Map<string, string[]>([['x', ['a', 'b', 'c', 'd', 'e', 'f']]]);
    const graph = buildSeaScene(one, { now, halfLifeMs: 60_000, total: 1, moodLabel: '', degraded: false, window: 10, cues: many });
    expect(graph.points[0]!.cues).toEqual(['a', 'b', 'c', 'd']);
  });

  it('窗口截断在 scene 层也生效（不只靠 store 少读）', () => {
    const graph = buildSeaScene(entries, { now, halfLifeMs: 60_000, total: 99, moodLabel: '', degraded: false, window: 2, cues });
    expect(graph.points.map((point) => point.id)).toEqual(['b', 'c']);
    expect(graph.stats.loaded).toBe(2);
    expect(graph.stats.window).toBe(2);
    expect(graph.stats.total).toBe(99);
  });

  it('总边数不超过 SEA_EDGE_MAX', () => {
    // 75 个 cue 桶 × 每桶 40 点：度数限制会放行约 9000 条，再由总量上限截住
    const many = Array.from({ length: 3_000 }, (_, index) => entryOf({ id: `p${index}`, tsMs: now - index * 1_000, salience: 1 }));
    const cues = new Map(many.map((entry, index) => [entry.id, [`cue${Math.floor(index / 40)}`]]));
    const graph = buildSeaScene(many, { now, halfLifeMs: 60_000, total: 3_000, moodLabel: '', degraded: false, window: 3_000, cues });
    expect(graph.edges.length).toBe(SEA_EDGE_MAX);
    expect(graph.stats.edges).toBe(SEA_EDGE_MAX);
  });

  it('满窗 3000 点的投影耗时在首屏预算内', () => {
    const many = Array.from({ length: 3_000 }, (_, index) => entryOf({ id: `q${index}`, tsMs: now - index * 1_000, salience: index % 3 }));
    const cues = new Map(many.map((entry, index) => [entry.id, [`c${index % 90}`, `k${index % 37}`]]));
    const started = performance.now();
    const graph = buildSeaScene(many, { now, halfLifeMs: 60_000, total: 3_000, moodLabel: '', degraded: false, window: 3_000, cues });
    const elapsed = performance.now() - started;
    expect(graph.points).toHaveLength(3_000);
    // 阈值给的是“投影本身”的天花板（不含 RPC/序列化）：超了就不是“慢一点”，而是首屏会卡
    expect(elapsed, `buildSeaScene(3000) took ${elapsed.toFixed(1)}ms`).toBeLessThan(1_500);
  });

  it('同一输入两次构建逐字节一致（确定性）', () => {
    const opts = { now, halfLifeMs: 60_000, total: 3, moodLabel: '', degraded: false, window: 10, cues };
    expect(JSON.stringify(buildSeaScene(entries, opts))).toBe(JSON.stringify(buildSeaScene(entries, opts)));
  });
});

describe('ExperienceStore.listRecent（窗口读取）', () => {
  function draftOf(text: string): ExperienceDraft {
    return { trigger: 'neutral', notice: 'task_progress', reaction: 'none', text, fact: {}, lane: 'live' };
  }

  function storeWithThree(): ExperienceStore {
    const store = new ExperienceStore({ db: null, logger });
    for (let index = 0; index < 3; index += 1) {
      store.append(
        { id: `e${index}`, sessionId: index === 2 ? 's2' : 's1', workspaceId: 'w1', turnSeq: index + 1, tsMs: 1_000 + index, personaRevision: 1 },
        draftOf(`第 ${index} 条`),
      );
    }
    return store;
  }

  it('按时间升序返回且只取未取代行', () => {
    const store = storeWithThree();
    store.supersede('e1', 'e2');
    const rows = store.listRecent(10);
    expect(rows.map((row) => row.id)).toEqual(['e0', 'e2']);
    expect(store.countAll()).toBe(2);
  });

  it('可按会话收窄', () => {
    const store = storeWithThree();
    expect(store.listRecent(10, { sessionId: 's2' }).map((row) => row.id)).toEqual(['e2']);
  });

  it('limit 生效（取最近 N 条）', () => {
    const store = storeWithThree();
    expect(store.listRecent(1).map((row) => row.id)).toEqual(['e2']);
  });
});

describe('本体交付点入图（v0.6：星海与翻阅/本周同一事实面）', () => {
  const entries = [
    entryOf({ id: 'e1', tsMs: 100_000 }),
    entryOf({ id: 'e2', tsMs: 200_000 }),
  ];
  const deliveries = [
    { id: 'dlv-s9/1', tsMs: 150_000, sessionId: 's9', turnSeq: 1, cardLine: '我修好了端口漂移', summary: '按规则固定 tick，不再反复探测' },
    { id: 'txn-s9/2', tsMs: 151_000, sessionId: 's9', turnSeq: 2, cardLine: '不该出现的步骤行', summary: null },
  ];

  it('交付点合入且按时间升序；kind/lane/axis 符合投影语义', () => {
    const graph = buildSeaScene(entries, {
      now: 200_000, halfLifeMs: 600_000, total: 2, moodLabel: '', degraded: false, window: 10, deliveries,
    });
    expect(graph.points.map((p) => p.id)).toEqual(['e1', 'dlv-s9/1', 'txn-s9/2', 'e2']);
    const d = graph.points.find((p) => p.id === 'dlv-s9/1');
    expect(d?.kind).toBe('delivery');
    expect(d?.lane).toBe('onto');
    expect(d?.axis).toBeGreaterThan(0);
    expect(d?.feedback).toBeNull();
    expect(d?.text).toBe('我修好了端口漂移');
    expect(graph.stats.byLane['onto']).toBe(2);
    expect(graph.stats.loaded).toBe(4);
  });

  it('体验点带 kind:experience；无交付入参时图与旧版逐字节同构', () => {
    const graph = buildSeaScene(entries, { now: 200_000, halfLifeMs: 600_000, total: 2, moodLabel: '', degraded: false, window: 10 });
    expect(graph.points.every((p) => p.kind === 'experience')).toBe(true);
    expect(graph.stats.byLane['onto']).toBeUndefined();
  });

  it('同会话时间邻近：交付与体验能连上时间边（不是孤岛）', () => {
    const graph = buildSeaScene(entries, {
      now: 200_000, halfLifeMs: 600_000, total: 2, moodLabel: '', degraded: false, window: 10,
      deliveries: [{ id: 'dlv-s1/9', tsMs: 200_500, sessionId: 's1', turnSeq: 9, cardLine: '交付贴隔壁', summary: null }],
    });
    const linked = graph.edges.some((e) => (e.a === 'e2' && e.b === 'dlv-s1/9') || (e.b === 'e2' && e.a === 'dlv-s1/9'));
    expect(linked, '时间邻居连线应把同段交付挂上图').toBe(true);
  });
});
