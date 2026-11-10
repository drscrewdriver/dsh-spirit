/**
 * 本体层注入（Phase C / TC.1）：反馈(tier1)/线程(tier2)段位进卡 + 逆 salience 丢尾 + 关轨逐字节回归。
 *
 * 关键不变式：
 * - 反馈/线程/做成三段都是 gist 稳定串（新评价/新任务才变），进指纹不致每轮 churn；
 * - 关轨（三段皆 undefined）⇒ 卡与指纹与旧形状逐字节相同；
 * - 预算紧时按 salience 逆序丢：反馈最晚被丢，线程/做成/情绪依次。
 */
import { describe, expect, it } from 'vitest';

import { Spirit, type PreStepInput } from '../src/spirit.js';
import { TurnWatcher } from '../src/experience/watcher.js';
import { ExperienceStore } from '../src/store/experience.js';
import { DEFAULT_PERSONA } from '../src/persona/types.js';
import { SPIRIT_DEFAULTS, type SpiritConfig, type SpiritLiveSettings } from '../src/contract.js';
import { renderCard } from '../src/slot/render.js';
import type { Mood } from '../src/types.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
const MOOD = { valence: 'mid', arousal: 'normal', label: '平常', revision: 3, updatedAt: 0 } as unknown as Mood;

function cfgWith(patch: Partial<SpiritConfig> = {}, live?: Partial<SpiritLiveSettings>): () => SpiritConfig {
  const base: SpiritConfig = structuredClone(SPIRIT_DEFAULTS);
  const merged: SpiritConfig = { ...base, ...patch, live: { ...base.live, ...live } };
  return () => merged;
}

interface Readers {
  feedback?: string;
  thread?: string;
  transaction?: string;
}

function harness(readers: Readers = {}): Spirit {
  const store = new ExperienceStore({ db: null, logger });
  const watcher = new TurnWatcher({ gapThresholdMs: 180_000 });
  return new Spirit(
    {
      cfg: cfgWith(),
      live: () => cfgWith()().live,
      store,
      watcher,
      modes: { isOff: () => false, isBypass: () => false },
      history: { store },
      logger,
      recentEntries: (sessionId, k) => store.recent(sessionId, k),
      previousEntries: () => [],
      ...(readers.feedback === undefined ? {} : { recentFeedbackLine: () => readers.feedback }),
      ...(readers.thread === undefined ? {} : { recentThreadLine: () => readers.thread }),
      ...(readers.transaction === undefined ? {} : { recentTxnCardLine: () => readers.transaction }),
    },
    DEFAULT_PERSONA,
  );
}

function input(over: Partial<PreStepInput> = {}): PreStepInput {
  return { agentId: 'a1', sessionId: 's1', workspaceId: 'w1', ownerId: 's1', isSubagent: false, newUserText: '继续', messageCount: 1, now: 1_000, ...over };
}

describe('renderCard 本体段（单元）', () => {
  const base = { mood: MOOD, recent: ['手边的动作没成，我记着这一下。'], recalled: [], maxBytes: 512, maxCharsPerEntry: 120 };

  it('feedback + thread 传入 ⇒ 两段出现、used 计数对', () => {
    const card = renderCard({ ...base, feedback: '认可：改了 deliver.ts', thread: '本体层记忆 · 进行中 · 下一步：注入' });
    expect(card.text).toContain('反馈：认可：改了 deliver.ts');
    expect(card.text).toContain('线程：本体层记忆 · 进行中 · 下一步：注入');
    expect(card.used.feedback).toBe(1);
    expect(card.used.thread).toBe(1);
  });

  it('省略 feedback/thread ⇒ used 不含这两个键、无对应段（关轨逐字节）', () => {
    const card = renderCard(base);
    expect(card.text).not.toContain('反馈：');
    expect(card.text).not.toContain('线程：');
    expect('feedback' in card.used).toBe(false);
    expect('thread' in card.used).toBe(false);
  });

  it('逆 salience 丢尾：预算恰好够状态+反馈时，线程被丢、反馈保住', () => {
    const noExtras = { mood: MOOD, recent: [], recalled: [], maxCharsPerEntry: 120 };
    // 先量出"状态+反馈"恰好装得下的字节数。
    const withFb = renderCard({ ...noExtras, maxBytes: 900, feedback: '认可：好' });
    expect(withFb.used.feedback).toBe(1);
    const budget = withFb.bytes;
    // 同样预算下塞一条长线程：反馈(tier1)保住，线程(tier2)装不下被丢。
    const tight = renderCard({ ...noExtras, maxBytes: budget, feedback: '认可：好', thread: '一条很长很长的任务线标题需要很多字节'.repeat(6) });
    expect(tight.used.feedback, '反馈 tier1 最晚被丢').toBe(1);
    expect(tight.used.thread, '线程 tier2 装不下 ⇒ 该段不进卡（键不出现）').toBeUndefined();
    expect(tight.dropped).toBeGreaterThan(0);
  });
});

describe('Spirit 编排（本体段进卡与指纹）', () => {
  it('开轨：卡带反馈+线程段，指纹含 |fb: 与 |th:', async () => {
    const outcome = await harness({ feedback: '认可：改了 deliver.ts', thread: '本体层记忆 · 进行中', transaction: '做了 X' }).onPreStep(input());
    expect(outcome.kind).toBe('injected');
    if (outcome.kind !== 'injected') return;
    expect(outcome.text).toContain('反馈：认可：改了 deliver.ts');
    expect(outcome.text).toContain('线程：本体层记忆 · 进行中');
    expect(outcome.fingerprint).toContain('|fb:认可：改了 deliver.ts');
    expect(outcome.fingerprint).toContain('|th:本体层记忆 · 进行中');
  });

  it('关轨（无 reader）：卡与指纹不含本体段，逐字节等于基线', async () => {
    const off = await harness().onPreStep(input());
    expect(off.kind).toBe('injected');
    if (off.kind !== 'injected') return;
    expect(off.text).not.toContain('反馈：');
    expect(off.text).not.toContain('线程：');
    expect(off.fingerprint).not.toContain('|fb:');
    expect(off.fingerprint).not.toContain('|th:');
  });

  it('指纹稳定性：同反馈/线程两次编排指纹相等；换反馈 ⇒ 变', async () => {
    const a1 = await harness({ feedback: '认可：A', thread: 'T · 进行中' }).onPreStep(input());
    const a2 = await harness({ feedback: '认可：A', thread: 'T · 进行中' }).onPreStep(input());
    const b1 = await harness({ feedback: '不满：B', thread: 'T · 进行中' }).onPreStep(input());
    if (a1.kind !== 'injected' || a2.kind !== 'injected' || b1.kind !== 'injected') return expect(false).toBe(true);
    expect(a1.fingerprint).toBe(a2.fingerprint);
    expect(a1.fingerprint).not.toBe(b1.fingerprint);
  });
});
