/**
 * 长觉引擎行为测试（v0.3.5）：假 llm 通道跑全链——归题/洞察/因果边/碰撞/取消/水位，
 * 外加三条专项断言：G20 出境（prompt 不含用户原文）、G15 行为版（蒸完整轮注入输入不变）、
 * fail-closed（半配拒蒸）。真库夹具，通道用同签名假实现（照 prime-sync 打桩范式）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SPIRIT_DEFAULTS, type SpiritConfig } from '../src/contract.js';
import { openSpiritDb } from '../src/db/open.js';
import { ExperienceStore } from '../src/store/experience.js';
import { TopicStore } from '../src/store/topics.js';
import { InsightStore } from '../src/store/insights.js';
import { EdgeStore } from '../src/store/edges.js';
import { RuminateRunner, SLEEP_WATERMARK_KEY } from '../src/distill/ruminate.js';
import { NoDistillRouteError, type DistillCallResult, type DistillRoute, type LlmChannel } from '../src/distill/llm.js';
import { TRIGGER_TOOL_FAILURE } from '../src/types.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
const openDbs: DatabaseSync[] = [];
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-rum-'));
});
afterEach(() => {
  for (const db of openDbs.splice(0, openDbs.length)) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const ROUTE: DistillRoute = { provider: 'test', model: 'fake-1' };

/** 假通道：按调用序回放 canned 文本（支持函数式按次生成），并记录收到的 user 文本（G20 断言用）。 */
function fakeChannel(canned: Array<string | ((callIndex: number) => string)>): { channel: LlmChannel; users: string[] } {
  const users: string[] = [];
  let index = 0;
  return {
    users,
    channel: {
      async complete(opts): Promise<DistillCallResult> {
        users.push(opts.user);
        index += 1;
        const item = canned[Math.min(index - 1, canned.length - 1)];
        const text = typeof item === 'function' ? item(index - 1) : (item ?? '{}');
        return { text, route: opts.route, outputTokens: 42 };
      },
    },
  };
}

function harness(cfgOver: Partial<SpiritConfig> = {}, canned: Array<string | ((callIndex: number) => string)> = ['{}'], channelOverride?: LlmChannel) {
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开成功');
  openDbs.push(opened.db);
  const db = opened.db;
  const store = new ExperienceStore({ db, logger });
  const topics = new TopicStore({ db: () => db, logger });
  const insights = new InsightStore({ db: () => db, logger });
  const edges = new EdgeStore({ db: () => db, logger });
  const cfg = structuredClone(SPIRIT_DEFAULTS);
  cfg.distill.enabled = true;
  cfg.live.distillEnabled = true;
  cfg.distill.batchMin = 4;
  Object.assign(cfg, cfgOver);
  const fake = channelOverride === undefined ? fakeChannel(canned) : undefined;
  const channel = channelOverride ?? fake?.channel;
  const runner = new RuminateRunner({
    db: () => db,
    store,
    topics,
    insights,
    edges,
    channel: () => channel,
    defaultModel: () => ROUTE,
    cfg: () => cfg,
    logger,
  });
  return { db, store, topics, insights, edges, cfg, runner, fake };
}

/** 铺 n 条在场条目（带 quote 的 fact 用于出境反证）。 */
function seedEntries(store: ExperienceStore, n: number, sessionId = 's1') {
  for (let i = 0; i < n; i += 1) {
    store.append(
      { id: `${sessionId}-${i}`, sessionId, workspaceId: 'w1', turnSeq: i, tsMs: 10_000 + i * 1_000, personaRevision: 1 },
      { trigger: TRIGGER_TOOL_FAILURE, notice: 'environment', reaction: 'mild', text: `第 ${i} 句查表体验`, fact: { tool: 'bash', quote: '用户的机密原话ABC' }, lane: 'live' },
    );
  }
}

const INDUCTION_OK = JSON.stringify({
  topics: [{ name: 'bash 的事', entry_ids: ['s1-0', 's1-1', 's1-2', 's1-3'] }],
  insights: [{ topic: 'bash 的事', text: '这条线一直卡在 bash 上', evidence: ['s1-0', 's1-2'] }],
  edges: [{ from: 's1-0', to: 's1-1', relation: '导致', evidence: ['s1-0', 's1-1'], confidence: 800 }],
});

describe('RuminateRunner 全链（假通道）', () => {
  it('攒够→归纳→落库：主题/洞察/因果边/水位/报告一次跑齐；prompt 不含用户原文（G20）', async () => {
    const h = harness({}, [INDUCTION_OK]);
    seedEntries(h.store, 4);
    const beforeIds = h.store.recent('s1', 10).map((e) => e.id);
    const status = await h.runner.runNow();
    expect(status.phase).toBe('done');
    expect(status.lastReport?.insightsCreated).toBe(1);
    expect(status.lastReport?.edgesCreated).toBe(1);
    expect(status.lastReport?.model).toBe('test/fake-1');
    const topics = h.topics.topicsWithCounts();
    expect(topics.some((t) => t.topic.name === 'bash 的事')).toBe(true);
    // 水位推进 + 去重窗：立刻再跑不会重蒸同批（dedup-window 拦截，不产生第二次模型调用）
    const usersAfterFirst = (h.fake?.users.length ?? 0);
    const again = await h.runner.runNow();
    expect(again.phase).toBe('failed');
    expect(again.error).toBe('dedup-window');
    expect(h.fake?.users.length).toBe(usersAfterFirst);
    // 报告跨实例可读（hydrate 自 meta）：宿主重启后面板不致失忆
    const reopened = openSpiritDb(dir);
    if (!reopened.ok) throw new Error('库应已存在');
    openDbs.push(reopened.db);
    const fresh = new RuminateRunner({ db: () => reopened.db, store: h.store, topics: h.topics, insights: h.insights, edges: h.edges, channel: () => undefined, cfg: () => h.cfg, logger });
    expect(fresh.status().lastReport?.insightsCreated).toBe(1);
    expect(fresh.status().supported).toBe(false); // llm 缺席信封与报告回读互不干扰
    // G15 行为版：蒸完整轮，工作记忆可见面逐字不变（注入输入不被蒸馏写盘抖动）
    expect(h.store.recent('s1', 10).map((e) => e.id)).toEqual(beforeIds);
    // G20：prompt 里绝无用户原文（factBits 不吐 quote），查表句本体在场
    const user = h.fake?.users[0] ?? '';
    expect(user).not.toContain('机密原话ABC');
    expect(user).toContain('第 0 句查表体验');
  });

  it('碰撞：同题旧账在场 + 判定 conflict ⇒ 双留进冲突清单；幻觉 id 被校验丢弃', async () => {
    const now = Date.now();
    // 先建旧账（单独 harness 段：需要知道旧行 id 才能写 verdict，用函数式 canned 延迟生成）
    const pre = harness({}, []);
    seedEntries(pre.store, 4);
    const t = pre.topics.ensureTopic('bash 的事', 'heuristic', now);
    const oldRows = pre.insights.insertBatch(now, 'run-0', [{ topicId: t.id, text: '旧账：bash 一直顺', evidenceIds: ['s1-0'] }]);
    const oldId = oldRows[0]?.id ?? '';
    expect(oldId).not.toBe('');
    // 同一库重建 runner（关句柄已交给 harness 的 db，这里新开一个连接指向同库）
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('库应已存在');
    openDbs.push(opened.db);
    const store = new ExperienceStore({ db: opened.db, logger });
    const topics = new TopicStore({ db: () => opened.db, logger });
    const insights = new InsightStore({ db: () => opened.db, logger });
    const edges = new EdgeStore({ db: () => opened.db, logger });
    const cfg = structuredClone(SPIRIT_DEFAULTS);
    cfg.distill.enabled = true;
    cfg.distill.batchMin = 4;
    const fake = fakeChannel([
      INDUCTION_OK,
      () => JSON.stringify({ verdicts: [{ a: 'p0', b: oldId, action: 'conflict' }, { a: 'p0', b: '不存在的id', action: 'duplicate' }] }),
    ]);
    const runner = new RuminateRunner({ db: () => opened.db, store, topics, insights, edges, channel: () => fake.channel, defaultModel: () => ROUTE, cfg: () => cfg, logger });
    seedEntries(store, 4, 's2'); // 新会话条目凑批（旧账引用的是 s1 条目，evidence 校验在 s2 集内）
    // 修正：INDUCTION_OK 的 evidence 是 s1-*，s2 铺量后 batch 含 s1+s2 混合——evidence 仍在批内即可
    const status = await runner.runNow();
    expect(status.phase).toBe('done');
    // 幻觉 id（'不存在的id'）被 validateCollisions 丢弃；真旧行对判定 conflict ⇒ 双留
    const conflicts = insights.conflictList();
    expect(conflicts.length).toBeGreaterThanOrEqual(2);
    expect(conflicts.some((c) => c.id === oldId)).toBe(true);
    opened.db.close();
  });

  it('取消：第一次调用期间 requestCancel ⇒ cancelled，洞察一条不落（安全边界在调用之间）', async () => {
    const h = harness();
    seedEntries(h.store, 4);
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('库应已存在');
    openDbs.push(opened.db);
    // 先声明 holder，slow 通道里对**正在跑的实例** requestCancel
    const holder: { runner?: RuminateRunner } = {};
    const slow: LlmChannel = {
      async complete(opts) {
        holder.runner?.requestCancel();
        return { text: INDUCTION_OK, route: opts.route, outputTokens: 1 };
      },
    };
    const target = new RuminateRunner({
      db: () => opened.db,
      store: h.store,
      topics: h.topics,
      insights: h.insights,
      edges: h.edges,
      channel: () => slow,
      defaultModel: () => ROUTE,
      cfg: () => h.cfg,
      logger,
    });
    holder.runner = target;
    try {
      const status = await target.runNow();
      expect(status.phase).toBe('cancelled');
      expect(h.topics.topicsWithCounts().some((t) => t.topic.name === 'bash 的事' && t.topic.origin === 'distilled')).toBe(false);
    } finally {
      opened.db.close();
      const i = openDbs.indexOf(opened.db);
      if (i >= 0) openDbs.splice(i, 1);
    }
  });

  it('fail-closed：半配（只有 provider）⇒ NoDistillRouteError 拒蒸、phase failed、错误说人话；未配模型但宿主默认在 ⇒ 跟随默认', async () => {
    const h = harness();
    h.cfg.distill.provider = 'only-provider';
    seedEntries(h.store, 4);
    const status = await h.runner.runNow();
    expect(status.phase).toBe('failed');
    expect(status.error).toContain('成对');
    // 全留空 ⇒ 走 defaultModel（宿主默认）不抛 NoDistillRouteError
    const h2 = harness({}, [INDUCTION_OK]);
    h2.cfg.distill.provider = '';
    h2.cfg.distill.model = '';
    seedEntries(h2.store, 4);
    const ok = await h2.runner.runNow();
    expect(ok.phase).toBe('done');
    expect(ok.lastReport?.model).toBe('test/fake-1');
  });

  it('双闸与缺席：distill.enabled=false ⇒ run 拒 disabled；channel 缺席 ⇒ unsupported（都是 accepted:false）', async () => {
    const h = harness();
    h.cfg.distill.enabled = false;
    expect(h.runner.run()).toEqual({ accepted: false, reason: 'disabled' });
    const h2 = harness({}, [], undefined);
    // channel 缺席：直接构造无通道的 runner
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('库应已存在');
    const bare = new RuminateRunner({ db: () => opened.db, store: h2.store, topics: h2.topics, insights: h2.insights, edges: h2.edges, channel: () => undefined, cfg: () => h2.cfg, logger });
    opened.db.close();
    expect(bare.run()).toEqual({ accepted: false, reason: 'unsupported' });
    expect(bare.status().supported).toBe(false);
  });

  it('双闸分报：部署关+live 开 ⇒ disabled；部署关+live 也关 ⇒ toggle-off（面板开关才是真控制线）', () => {
    const h = harness();
    h.cfg.distill.enabled = false;
    h.cfg.live.distillEnabled = true;
    expect(h.runner.run()).toEqual({ accepted: false, reason: 'disabled' });
    h.cfg.live.distillEnabled = false;
    expect(h.runner.run()).toEqual({ accepted: false, reason: 'toggle-off' });
  });

  it('NoDistillRouteError 是 Error 子类且 name 稳定（调用方按它分类豁免退避）', () => {
    const err = new NoDistillRouteError('x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NoDistillRouteError');
  });

  it('水位键名稳定（meta 单键契约）', () => {
    expect(SLEEP_WATERMARK_KEY).toBe('sleep.watermark');
  });

  it('run() 受理路径不得自拦（round-29 双拓 bug 回归钉：预占窗/占位重检）：受理⇒done 出报告', async () => {
    const h = harness({}, [INDUCTION_OK]);
    seedEntries(h.store, 4);
    const r = h.runner.run();
    expect(r.accepted).toBe(true);
    // 等到终局（受理后的任务体异步起跑，不能拿 running=false 当退出条件—那会抢在启动前退出）
    for (let i = 0; i < 200; i += 1) {
      const s = h.runner.status();
      if (s.phase === 'done' || s.phase === 'failed') break;
      await new Promise((res) => setTimeout(res, 10));
    }
    const st = h.runner.status();
    expect(st.error).toBe('');
    expect(st.phase).toBe('done');
    expect(st.lastReport?.insightsCreated).toBe(1);
  });
});
