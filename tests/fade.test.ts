/**
 * 刀1 滑窗淡出：档位量化、形态降级链、反馈两轴分离、v0.1 逐字节回归臂。
 *
 * 这里盯的是最贵的静默回归：**淡出把 unchanged 门弄失效**（now 每轮漂移 ⇒ 指纹每轮变
 * ⇒ 每轮重发）。量化纪律的全部意义就是让"档内"与"档变"成为仅有的两个状态。
 */
import { describe, expect, it } from 'vitest';

import { attentionWeight, fadeScoreMs, feedbackFirst, formOf, formText, FORM_FULL, FORM_GIST, FORM_HELD, type FadeConfig } from '../src/recall/form.js';
import { recentForms, formsDigest } from '../src/recall/recent.js';
import { SPIRIT_DEFAULTS } from '../src/contract.js';
import { renderGistText } from '../src/experience/render.js';
import type { ExperienceEntry, NoticeKind, TriggerKind } from '../src/types.js';

const FADE: FadeConfig = {
  fadeEnabled: true,
  feedbackEnabled: true,
  fadeHalfLifeMs: 1_000,
  fullMinScore: 550,
  gistMinSalience: 1,
  gistMinScore: 250,
};

function entry(over: Partial<ExperienceEntry> & { id: string }): ExperienceEntry {
  return {
    sessionId: 's1', workspaceId: 'w1', turnSeq: 1, tsMs: 0,
    trigger: 'tool_failure', notice: 'self_mistake', reaction: 'mild',
    text: '手边的动作没成，我记着这一下', gist: '有一次没走通，我记着', salience: 2,
    fact: {}, lane: 'live', personaRevision: 1, updatedAt: 0, ...over,
  } as ExperienceEntry;
}

describe('attentionWeight：量化与地板（对齐 prime 0.5^(Δt/halfLife)，同式同地板）', () => {
  it('同一半衰期档内权重恒定（now 漂移不改变档位——指纹稳定的前提）', () => {
    const w1 = attentionWeight(0, 999, 1_000);
    const w2 = attentionWeight(0, 1_500, 1_000);
    const w3 = attentionWeight(0, 1_999, 1_000);
    expect(w1).toBe(1);
    expect(w2).toBe(0.5);
    expect(w3).toBe(0.5);
    // 再跨一档仍是 0.5（地板）而不是 0.25 —— 时间至多让条目变淡一半
    expect(attentionWeight(0, 9_000, 1_000)).toBe(0.5);
  });

  it('halfLife<=0 ⇒ 恒 1（pin 基线：窗口冻结）', () => {
    expect(attentionWeight(0, 10 ** 12, 0)).toBe(1);
  });

  it('fadeScoreMs 给千分位整数（离散，可进指纹）', () => {
    expect(fadeScoreMs(entry({ id: 'a', salience: 2 }), 0, FADE)).toBe(1000);
    expect(fadeScoreMs(entry({ id: 'b', salience: 1 }), 1_500, FADE)).toBe(250);
    expect(fadeScoreMs(entry({ id: 'c', salience: 2 }), 1_500, FADE)).toBe(500);
  });
});

describe('formOf：降级链 full → gist → held', () => {
  it('fadeEnabled=false ⇒ 恒 full（v0.1 回归臂的单元面）', () => {
    expect(formOf(entry({ id: 'x' }), 10 ** 9, { ...FADE, fadeEnabled: false })).toBe(FORM_FULL);
  });
  it('高 salience 新条目 full；跨一档到 gist；salience 低/无残句 ⇒ held', () => {
    expect(formOf(entry({ id: 'x', salience: 2 }), 0, FADE)).toBe(FORM_FULL);
    expect(formOf(entry({ id: 'x', salience: 2 }), 1_500, FADE)).toBe(FORM_GIST);
    // 地板 0.5 的语义后果：salience=1 的时间下限 m=250 恰在 gist 地板上——
    // “重要的事淡成残句但永不被逐出”正是人的形状；held 经“无残句/低档”达成
    expect(formOf(entry({ id: 'x', salience: 1 }), 3_500, FADE)).toBe(FORM_GIST);
    expect(formOf(entry({ id: 'x', salience: 1 }), 3_500, { ...FADE, gistMinScore: 300 })).toBe(FORM_HELD);
  });
  it('无 gist 列（v1 迁移旧行）⇒ 不给 gist 档，直接 held（宁缺毋造）', () => {
    const old = entry({ id: 'x', gist: undefined });
    expect(formOf(old, 1_500, FADE)).toBe(FORM_HELD);
  });
  it('salience 低于 gistMinSalience ⇒ held（弱条目连残句都不配；v1 旧行落 0 正是这条路径）', () => {
    expect(formOf(entry({ id: 'x', salience: 1 }), 0, { ...FADE, gistMinSalience: 2 })).toBe(FORM_HELD);
  });
  it('formText：held ⇒ 空串；gist ⇒ 取 gist 列', () => {
    const e = entry({ id: 'x' });
    expect(formText(e, FORM_HELD)).toBe('');
    expect(formText(e, FORM_GIST)).toBe(e.gist);
    expect(formText(e, FORM_FULL)).toBe(e.text);
  });
});

describe('recentForms：排序→反馈重排→定档 的接缝', () => {
  it('fade 缺省 ⇒ 与 v0.1 完全一致（原文、无过滤、无重排）', () => {
    const items = [entry({ id: 'a', tsMs: 100 }), entry({ id: 'b', tsMs: 200 })];
    const formed = recentForms(items, { now: 250, halfLifeMs: 1_000, limit: 5 });
    expect(formed.map((f) => f.text)).toEqual(items.map((i) => i.text));
    expect(formed.every((f) => f.form === FORM_FULL)).toBe(true);
    expect(formsDigest(formed)).toBe('full,full');
  });

  it('held 被滤掉，full/gist 保留其文本形态', () => {
    const items = [
      entry({ id: 'fresh', tsMs: 900, salience: 2 }),
      entry({ id: 'mid', tsMs: 0, salience: 2 }), // 跨一档 ⇒ gist
      entry({ id: 'weak', tsMs: 0, salience: 1, reaction: 'mild' }),
    ];
    const formed = recentForms(items, { now: 1_500, halfLifeMs: 1_000, limit: 5, fade: FADE });
    const ids = formed.map((f) => f.entry.id);
    expect(ids).toContain('fresh');
    expect(formed.find((f) => f.entry.id === 'mid')?.form).toBe(FORM_GIST);
    // salience=1 且 Δt 跨档 ⇒ m=250×? 视地板而定；只断言"要么保留要么消失"，不许保留空文本
    for (const f of formed) expect(f.text).not.toBe('');
    void ids;
  });

  it('反馈只重排：打分改变先后，不改变谁在场（两轴分离）', () => {
    const a = entry({ id: 'a', tsMs: 100, feedbackScore: undefined });
    const b = entry({ id: 'b', tsMs: 200, feedbackScore: undefined });
    const hi = entry({ id: 'a', tsMs: 100, feedbackScore: 5 });
    const before = recentForms([a, b], { now: 250, halfLifeMs: 0, limit: 5, fade: FADE }).map((f) => f.entry.id);
    const after = recentForms([hi, b], { now: 250, halfLifeMs: 0, limit: 5, fade: FADE }).map((f) => f.entry.id);
    expect([...before].sort()).toEqual([...after].sort());
    expect(after[0]).toBe('a');
  });

  it('feedbackFirst：未打分保持原序（稳定重排，不破字节全等）', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const items = ids.map((id, i) => ({ id, score: i === 2 ? 4 : 0 }));
    const out = feedbackFirst(items, (x) => x.score);
    expect(out.map((x) => x.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('feedbackEnabled=false ⇒ 打分不参与任何事', () => {
    const hi = entry({ id: 'a', tsMs: 100, feedbackScore: 5 });
    const b = entry({ id: 'b', tsMs: 200 });
    const formed = recentForms([hi, b], { now: 250, halfLifeMs: 0, limit: 5, fade: { ...FADE, feedbackEnabled: false } });
    expect(formed.map((f) => f.entry.id)).toEqual(['b', 'a']); // 纯近因序，打分无效
  });
});

describe('gist 编译期派生（禁运行时造句的正面：表完备）', () => {
  it('每个 trigger × notice 组合都能出 gist，且形状与主句同构（面词：残句）', () => {
    const triggers: TriggerKind[] = ['user_interruption', 'tool_failure', 'recovery', 'task_close', 'long_gap', 'neutral'];
    const notices: NoticeKind[] = ['self_mistake', 'user_state', 'task_progress', 'task_stall', 'being_ignored', 'being_acknowledged', 'environment'];
    for (const t of triggers) {
      for (const n of notices) {
        const gist = renderGistText(t, n);
        expect(gist.length, `${t}/${n}`).toBeGreaterThan(0);
        expect(gist).toContain('：');
      }
    }
  });
  it('缺格 trigger ⇒ 空串（不抛、不占位）', () => {
    expect(renderGistText('nope' as TriggerKind, 'self_mistake')).toBe('');
  });
});

describe('默认值口径（防"把淡出默认打开"这类事故）', () => {
  it('fadeEnabled/ledger/bias 缺省全关；阈值千分位与 0..2 salience 域对齐', () => {
    expect(SPIRIT_DEFAULTS.recall.fadeEnabled).toBe(false);
    expect(SPIRIT_DEFAULTS.live.fadeEnabled).toBe(false);
    expect(SPIRIT_DEFAULTS.ledger.enabled).toBe(false);
    expect(SPIRIT_DEFAULTS.bias.enabled).toBe(false);
    expect(SPIRIT_DEFAULTS.recall.fadeFullMinScore).toBeLessThanOrEqual(1000);
    expect(SPIRIT_DEFAULTS.recall.gistMinSalience).toBeGreaterThanOrEqual(1);
    expect(SPIRIT_DEFAULTS.recall.fadeHalfLifeMs).toBe(SPIRIT_DEFAULTS.recall.halfLifeMs);
  });
});
