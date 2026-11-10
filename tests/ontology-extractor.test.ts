/**
 * 本体抽取器（Phase B / TB.1+TB.4）：信号 → 攒批 → 假 LLM → 校验 → delivery/entities/relations/task 落库。
 *
 * 正反成对：关时零落库、幻觉 key 丢弃都配"库里到底进了什么/没进"的正证。
 * 另测 watcher 的正文脱敏（含密 userText 置空）——P1 分级信任的落地面。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SPIRIT_DEFAULTS, type SpiritConfig } from '../src/contract.js';
import { openSpiritDb } from '../src/db/open.js';
import type { DistillCallResult, DistillRoute, LlmChannel } from '../src/distill/llm.js';
import { NoDistillRouteError } from '../src/distill/llm.js';
import { TxnStore } from '../src/store/transaction.js';
import { OntologyStore } from '../src/store/ontology.js';
import { OntologyExtractor } from '../src/ontology/extractor.js';
import { OntologyWatcher } from '../src/ontology/watcher.js';
import type { OntologySignals } from '../src/ontology/watcher.js';
import { handleEndpoint, type RpcDeps } from '../src/rpc.js';
import { SPIRIT_RPC_PREFIX } from '../src/contract.js';

const logger = { warn: (m: string) => m, info: (m: string) => m, error: (m: string) => m };
const ROUTE: DistillRoute = { provider: 'test', model: 'fake-onto' };
const openDbs: DatabaseSync[] = [];
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-onto-extract-'));
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

function fakeChannel(canned: string[]): { channel: LlmChannel; calls: () => number } {
  let calls = 0;
  let idx = 0;
  return {
    channel: {
      async complete(): Promise<DistillCallResult> {
        calls += 1;
        const text = canned[Math.min(idx, canned.length - 1)] ?? '{}';
        idx += 1;
        return { text, route: ROUTE, outputTokens: 10 };
      },
    },
    calls: () => calls,
  };
}

function cfgWith(patch: Partial<SpiritConfig> = {}): SpiritConfig {
  const cfg = structuredClone(SPIRIT_DEFAULTS);
  cfg.ontology.enabled = true;
  Object.assign(cfg, patch);
  return cfg;
}

function signal(key: string, over: Partial<OntologySignals> = {}): OntologySignals {
  const n = Number(key.split('/')[1] ?? '1');
  return {
    key,
    sessionId: 's1',
    workspaceId: 'w1',
    turnSeq: n,
    tsMs: 1_700_000_000_000 + n * 1000,
    userText: `推进第 ${n} 步`,
    assistantText: '',
    todoTitles: [`任务 ${n}`],
    toolNames: ['vitest'],
    pathBases: [`file-${n}.ts`],
    ...over,
  };
}

function harness(canned: string[], cfg: SpiritConfig = cfgWith()): {
  extractor: OntologyExtractor; txn: TxnStore; onto: OntologyStore; fake: { channel: LlmChannel; calls: () => number }; runScheduled: () => Promise<void>;
} {
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  openDbs.push(opened.db);
  const txn = new TxnStore({ db: () => opened.db, logger });
  const onto = new OntologyStore({ db: () => opened.db, logger });
  const fake = fakeChannel(canned);
  const tasks: Array<() => unknown> = [];
  const extractor = new OntologyExtractor({
    db: () => opened.db, txnStore: txn, store: onto, channel: () => fake.channel,
    defaultModel: () => ROUTE, cfg: () => cfg, logger,
    // 假调度器：捕获任务体不自动跑，由 runScheduled 手动驱动（照 txn-collect 先例）。
    schedule: (task) => {
      tasks.push(task);
    },
  });
  return {
    extractor,
    txn,
    onto,
    fake,
    runScheduled: async () => {
      for (const t of tasks.splice(0)) await t();
    },
  };
}

const KEYS = ['s1/1', 's1/2', 's1/3', 's1/4', 's1/5', 's1/6', 's1/7', 's1/8'];
const OK_OUTPUT = JSON.stringify({
  rows: KEYS.map((k) => ({
    key: k,
    gist: `交付 ${k}`,
    summary: `完整交付 ${k}`,
    entities: [
      { kind: 'project', name: 'dsh-spirit', role: 'subject' },
      { kind: 'person', name: 'joshua', role: 'actor' },
    ],
    relations: [{ from: 'joshua', to: 'dsh-spirit', relation: '负责' }],
    task: { title: '本体层记忆', status: 'progress', next_step: '注入' },
  })),
});

describe('OntologyExtractor 攒批落库', () => {
  it('攒够 8 批 → delivery + entities + relations + task 全落', async () => {
    const h = harness([OK_OUTPUT]);
    for (const k of KEYS) expect(h.extractor.enqueue(signal(k)).accepted).toBe(true);
    await h.runScheduled();
    const status = h.extractor.status();
    expect(status.phase).toBe('done');
    expect(status.lastReport?.deliveries).toBe(8);
    expect(h.txn.listRecent(50).filter((d) => d.salienceTier === 2)).toHaveLength(8);
    const ents = h.onto.listEntities(10);
    expect(ents.map((e) => e.name)).toContain('dsh-spirit');
    expect(ents.find((e) => e.name === 'dsh-spirit')?.importance).toBe(8); // 8 轮都提到
    expect(h.onto.listTasks('w1').some((t) => t.title === '本体层记忆' && t.status === 'progress')).toBe(true);
    const spirit = ents.find((e) => e.name === 'dsh-spirit');
    expect(spirit && h.onto.listDeliveriesByEntity(spirit.id)).toHaveLength(8);
    expect(spirit && h.onto.listEdgesByEntity(spirit.id).length).toBeGreaterThan(0);
  });

  it('不足批 ⇒ 不触发 LLM（严禁每轮同步调用）', () => {
    const h = harness([OK_OUTPUT]);
    for (const k of KEYS.slice(0, 7)) h.extractor.enqueue(signal(k));
    expect(h.fake.calls()).toBe(0);
    expect(h.extractor.pending()).toBe(7);
  });

  it('关时（ontology.enabled=false）⇒ enqueue 拒、零落库', async () => {
    const h = harness([OK_OUTPUT], cfgWith({ ontology: { enabled: false, backfillEnabled: false } }));
    for (const k of KEYS) expect(h.extractor.enqueue(signal(k)).accepted).toBe(false);
    expect(h.fake.calls()).toBe(0);
    expect(h.txn.countAll()).toBe(0);
    expect(h.onto.countEvaluations()).toBe(0);
  });

  it('幻觉 key（不在批内）⇒ 整行丢弃（正证：库里没那条）', async () => {
    const ghost = JSON.stringify({ rows: [...KEYS.map((k) => ({ key: k, gist: `交付 ${k}`, summary: '', entities: [], relations: [], task: null })), { key: 'ghost/9', gist: '幻觉', summary: '', entities: [], relations: [], task: null }] });
    const h = harness([ghost]);
    for (const k of KEYS) h.extractor.enqueue(signal(k));
    await h.runScheduled();
    const status = h.extractor.status();
    expect(status.lastReport?.deliveries).toBe(8);
    expect(h.txn.listRecent(50).some((d) => d.id === 'dlv-ghost/9')).toBe(false);
  });
});

describe('OntologyWatcher 正文脱敏（P1 落地）', () => {
  it('用户消息含密钥 ⇒ userText 置空，不整段进原料（同轮有非密 todo 仍可成行）', () => {
    const w = new OntologyWatcher();
    w.observe('s1', 'w1', { type: 'turn/start', data: { turn: 1 } }, 1000);
    w.observe('s1', 'w1', { type: 'todo/write', data: { todos: [{ content: '看配置' }] } }, 1000);
    w.observe('s1', 'w1', { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '配置 sk-abcdefghijklmnopqrstuvwxyz1234 帮我看看' }] } }, 1001);
    const signals = w.takeSignals('s1', 1002);
    expect(signals).not.toBeNull();
    expect(signals?.userText, '含密整段丢弃，绝不进 LLM 原料').toBe('');
    expect(signals?.todoTitles).toContain('看配置');
  });

  it('正常用户消息 ⇒ userText 保留（脱敏不误伤）', () => {
    const w = new OntologyWatcher();
    w.observe('s1', 'w1', { type: 'turn/start', data: { turn: 2 } }, 1000);
    w.observe('s1', 'w1', { type: 'user/message', data: { source: { kind: 'user' }, content: '这次干的不错，继续推进本体层' } }, 1001);
    const signals = w.takeSignals('s1', 1002);
    expect(signals?.userText).toContain('干的不错');
  });
});

describe('冷路径健壮性（超时预算 + 拆批重试）', () => {
  /** 用自定义 channel 起一个抽取器（harness 的假 channel 只回 canned，不够表达失败/拆批）。 */
  function extractorWith(channel: LlmChannel): { extractor: OntologyExtractor; txn: TxnStore } {
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('库应打开');
    openDbs.push(opened.db);
    const txn = new TxnStore({ db: () => opened.db, logger });
    const onto = new OntologyStore({ db: () => opened.db, logger });
    const extractor = new OntologyExtractor({
      db: () => opened.db, txnStore: txn, store: onto, channel: () => channel,
      defaultModel: () => ROUTE, cfg: () => cfgWith(), logger,
    });
    return { extractor, txn };
  }

  it('单批超时预算 ≥ 180s（不沿用 txn 的 30s：一批十几轮正文，真机必撞超时）', async () => {
    const budgets: number[] = [];
    const channel: LlmChannel = {
      async complete(opts) {
        budgets.push(opts.timeoutMs);
        return { text: '{}', route: ROUTE, outputTokens: 1 };
      },
    };
    const { extractor } = extractorWith(channel);
    await extractor.processBatch([signal('s1/1')]);
    expect(budgets[0]).toBeGreaterThanOrEqual(180_000);
  });

  it('批里有坏轮 ⇒ 对半拆批重试：好轮照落库，只丢坏的那一轮', async () => {
    let calls = 0;
    const channel: LlmChannel = {
      async complete(opts) {
        calls += 1;
        // abort 原文：旧实现原样上浮成 "This operation was aborted"，这里模拟超时
        if (opts.user.includes('BAD')) throw new Error('llm 超时被中止（180s）');
        const keys = [...opts.user.matchAll(/\[key=([^\]]+)\]/g)].map((m) => m[1] ?? '');
        return {
          text: JSON.stringify({ rows: keys.map((k) => ({ key: k, gist: `交付 ${k}`, summary: '', entities: [], relations: [], task: null })) }),
          route: ROUTE, outputTokens: 5,
        };
      },
    };
    const { extractor, txn } = extractorWith(channel);
    const status = await extractor.processBatch([
      signal('s1/1'), signal('s1/2'), signal('s1/3', { userText: 'BAD 这一步' }), signal('s1/4'),
    ]);
    expect(status.phase, '坏轮彻底失败仍如实报（不假装全成）').toBe('failed');
    expect(calls, '拆批发生：不是一次死掉').toBeGreaterThan(1);
    const ids = txn.listRecent(50).map((d) => d.id);
    expect(ids, '好轮已落库（一半不再给全批陪葬）').toContain('dlv-s1/1');
    expect(ids).toContain('dlv-s1/2');
    expect(ids).toContain('dlv-s1/4');
    expect(ids, '坏轮不落').not.toContain('dlv-s1/3');
  });

  it('配置类错误（无路由）⇒ 不拆批：拆小也好不了，只打一次', async () => {
    let calls = 0;
    const channel: LlmChannel = {
      async complete() {
        calls += 1;
        throw new NoDistillRouteError('宿主 llm 服务不可用');
      },
    };
    const { extractor } = extractorWith(channel);
    const status = await extractor.processBatch([signal('s1/1'), signal('s1/2'), signal('s1/3'), signal('s1/4')]);
    expect(status.phase).toBe('failed');
    expect(calls, '不可重试错误不浪费时间拆批').toBe(1);
  });

  it('模型回包不可解析 ⇒ failed（零产出不再当 done：真机 132 会话毒水位的根因）', async () => {
    const channel: LlmChannel = {
      async complete() {
        return { text: '这显然不是 JSON，也不含任何平衡花括号', route: ROUTE, outputTokens: 1 };
      },
    };
    const { extractor, txn } = extractorWith(channel);
    const status = await extractor.processBatch([signal('s1/1'), signal('s1/2')]);
    expect(status.phase, '解析 0 行是失败不是成功').toBe('failed');
    expect(status.error).toContain('零产出');
    expect(txn.countAll()).toBe(0);
  });

  it('合法 JSON 但 rows 空 ⇒ 同样 failed；输出预算随批扩（8 行批 ≥ 单行预算×8）', async () => {
    const budgets: number[] = [];
    const channel: LlmChannel = {
      async complete(opts) {
        budgets.push(opts.maxTokens);
        return { text: '{"rows":[]}', route: ROUTE, outputTokens: 1 };
      },
    };
    const { extractor } = extractorWith(channel);
    const single = await extractor.processBatch([signal('s1/1')]);
    expect(single.phase).toBe('failed');
    const eight = await extractor.processBatch(KEYS.map((k) => signal(k)));
    expect(eight.phase).toBe('failed');
    expect(budgets[0], '单行预算 700 量级').toBeGreaterThanOrEqual(700);
    // 拆批重试后末次调用可能是单行批，故看整场最大值：8 行整批的预算必明显大于单行批
    expect(Math.max(...budgets), '8 行批预算随批扩（≥ 700×8）').toBeGreaterThanOrEqual(700 * 8);
  });
});

describe('本体查询 op（Phase D）', () => {
  async function populated(): Promise<{ deps: RpcDeps; onto: OntologyStore; txn: TxnStore }> {
    const h = harness([OK_OUTPUT]);
    for (const k of KEYS) h.extractor.enqueue(signal(k));
    await h.runScheduled();
    const deps = { logger, ontology: h.onto, txn: h.txn } as unknown as RpcDeps;
    return { deps, onto: h.onto, txn: h.txn };
  }

  it('entity-graph 出节点与边', async () => {
    const { deps } = await populated();
    const res = await handleEndpoint(`${SPIRIT_RPC_PREFIX}entity-graph`, {}, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const g = res.value as { nodes: Array<{ name: string }>; edges: unknown[] };
    expect(g.nodes.map((n) => n.name)).toContain('dsh-spirit');
    expect(g.edges.length).toBeGreaterThan(0);
  });

  it('entity-lookup 按名反查 delivery', async () => {
    const { deps } = await populated();
    const res = await handleEndpoint(`${SPIRIT_RPC_PREFIX}entity-lookup`, { name: 'dsh-spirit' }, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.value as { entity: unknown; deliveries: Array<{ id: string }> };
    expect(r.entity).not.toBeNull();
    expect(r.deliveries).toHaveLength(8);
  });

  it('task-list / task-detail', async () => {
    const { deps } = await populated();
    const list = await handleEndpoint(`${SPIRIT_RPC_PREFIX}task-list`, { workspaceId: 'w1' }, deps);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const tasks = (list.value as { tasks: Array<{ id: string; title: string }> }).tasks;
    expect(tasks.some((t) => t.title === '本体层记忆')).toBe(true);
    const detail = await handleEndpoint(`${SPIRIT_RPC_PREFIX}task-detail`, { taskId: tasks[0]!.id }, deps);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect((detail.value as { deliveries: unknown[] }).deliveries.length).toBeGreaterThan(0);
  });

  it('未装配本体 ⇒ unavailable；task-list 空 workspaceId ⇒ 跨工作区全局（不报错）', async () => {
    const bare = { logger } as unknown as RpcDeps;
    expect((await handleEndpoint(`${SPIRIT_RPC_PREFIX}entity-graph`, {}, bare)).ok).toBe(false);
    const h = harness([OK_OUTPUT]);
    const deps = { logger, ontology: h.onto, txn: h.txn } as unknown as RpcDeps;
    // v0.5：空 workspaceId 不再报 bad-request，而是跨工作区取全局最近（面板「本体」翻阅依赖）
    const all = await handleEndpoint(`${SPIRIT_RPC_PREFIX}task-list`, {}, deps);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(Array.isArray((all.value as { tasks: unknown[] }).tasks)).toBe(true);
  });
});
