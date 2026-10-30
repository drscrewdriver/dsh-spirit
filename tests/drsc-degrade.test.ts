/**
 * DRSC 三态降级一致（spec Test Plan 点名的那一条）。
 *
 * 计划里的硬约束是：**当前会话的新回合可能还不在 DRSC 里**（扫盘投影，interval 30s、
 * 新鲜度 ≤1 分钟），所以即时路绝不依赖它。此前只散了单点用例（缺席⇒skipped、
 * 超时⇒整段省略、未知字段⇒不猜），**没有一条把"三态下降级行为一致"当断言来量**，
 * 而"滞后"这一态之前完全没有用例。
 *
 * 这里守的不变式（三种状态各自跑一轮真编排）：
 * 1. 档位与「刚刚」段**逐字节相同** —— 本轮的体验只来自实时采集，不来自投影语料；
 * 2. 条目照常落库 —— 历史路坏不影响记录轨；
 * 3. 缺席 / 未知字段 ⇒ 想起段为空（**不编造**）；滞后 ⇒ 只准引用确实在语料里的旧回合，
 *    绝不出现本轮那条刚发生的体验句（它还没被投影）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Spirit, type PreStepInput } from '../src/spirit.js';
import { TurnWatcher } from '../src/experience/watcher.js';
import { ExperienceStore } from '../src/store/experience.js';
import { openSpiritDb } from '../src/db/open.js';
import { DrscClient } from '../src/drsc/client.js';
import { DrscProbe } from '../src/drsc/probe.js';
import { DEFAULT_PERSONA } from '../src/persona/types.js';
import { SPIRIT_DEFAULTS, type SpiritConfig } from '../src/contract.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };

/** 真机同装实探到的 status 包络（没有时间戳字段，last_sync 是结果对象）。 */
const STATUS_OK = { ok: true, sessions: 2, segments: 9, schema_version: '5', last_sync: { ok: true, busy: false }, syncing: false };

/** 语料里只有**别的会话的旧回合**：本轮那条刚发生的体验不可能在里面。 */
const OLD_HITS = { ok: true, hits: [
  { session_id: 'session-old', seq: 3, kind: 'user/message', rank: 0, snippet: '上次你说先把投递放一放', time: 1, on_surface: 1, turn: 1 },
] };

function cfgWith(over: Partial<SpiritConfig> = {}): () => SpiritConfig {
  return () => ({ ...SPIRIT_DEFAULTS, ...over });
}

function input(over: Partial<PreStepInput> = {}): PreStepInput {
  return {
    agentId: 'a1', sessionId: 's-live', workspaceId: 'w1', ownerId: 's-live', isSubagent: false,
    newUserText: '把投递那个脚本再跑一次', messageCount: 1, now: 10_000, ...over,
  };
}

/** 假桩的形状就是 `typeof fetch`（返回体只需 `ok/status/json`，其余字段宿主不读）。 */
type Fetch = typeof fetch;
const jsonResp = (body: unknown): unknown => ({ ok: true, status: 200, json: async () => body });

/**
 * 三态：缺席（连不上）/ 滞后（在，但本轮没投影）/ 未知字段（返回我们无法解析的形状）。
 * 注意 `op=` 是拼在 **URL**（fetch 的第一个参数）上的：上一版去读 `init.query`，
 * 于是 search 也拿到了 status 响应，想起段永远为空——假桩测的是自己。
 */
function fetchFor(state: 'absent' | 'stale' | 'unknown'): Fetch {
  if (state === 'absent') {
    return (async () => { throw new Error('ECONNREFUSED 127.0.0.1:8080'); }) as unknown as Fetch;
  }
  const pick = (u: string): unknown => {
    if (u.includes('op=search')) return state === 'unknown' ? { ok: true, data: { rows: [{ text: 1 }] } } : OLD_HITS;
    return STATUS_OK;
  };
  return ((req: unknown) => Promise.resolve(jsonResp(pick(String(req ?? ''))))) as unknown as Fetch;
}

/**
 * 跑一个完整会话轮：上一轮工具失败 ⇒ `turn/end` 结算一条实时条目；本轮 pre-step ⇒ 出卡。
 * 三态之间只有"历史路给不给东西"的差别，其它输入完全一致（同 persona / 同事件流 / 同时钟）。
 */
async function runOne(state: 'absent' | 'stale' | 'unknown' | 'local-only') {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-degrade-'));
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应可打开');
  const store = new ExperienceStore({ db: opened.db, logger });
  const watcher = new TurnWatcher({ gapThresholdMs: 180_000 });
  const client = state === 'absent'
    ? new DrscClient({ fetchImpl: fetchFor('absent'), timeoutMs: 50 })
    : state === 'local-only'
      ? undefined
      : new DrscClient({ fetchImpl: fetchFor(state), timeoutMs: 50 });
  const probe = client === undefined
    ? undefined
    : new DrscProbe({ client, enabled: () => true, ttlMs: () => 15_000 });
  const cfg = cfgWith();
  const spirit = new Spirit(
    {
      cfg,
      live: () => cfg().live,
      store,
      watcher,
      modes: { isOff: () => false, isBypass: () => false },
      history: probe === undefined ? { store } : { store, client, probe },
      logger,
      recentEntries: (sessionId, k) => store.recent(sessionId, k),
      previousEntries: () => [],
    },
    DEFAULT_PERSONA,
  );

  // 第一轮：工具失败 → turn/start|end 让实时路记一条
  const first = input({ now: 1_000 });
  spirit.observeEvent('s-live', { type: 'turn/start', data: { turn: 1 } }, 1_000);
  spirit.observeEvent('s-live', { type: 'tool/call', data: { callId: 'c1', name: 'bash' } }, 1_100);
  spirit.observeEvent('s-live', { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: true } } }, 1_200);
  spirit.observeEvent('s-live', { type: 'turn/end', data: { turn: 1 } }, 1_300);
  await spirit.onPreStep(first);

  // 第二轮：本轮的卡只该带"实时路的刚刚"，历史段能不给但不能瞎给
  const outcome = await spirit.onPreStep(input({ now: 20_000, newUserText: '把投递那个脚本再跑一次' }));
  const cardText = outcome.kind === 'injected' ? outcome.text : '';
  const entryCount = store.count('s-live');
  opened.db.close();
  rmSync(dir, { recursive: true, force: true });
  return { outcome, cardText, entryCount };
}

describe('DRSC 三态降级一致（即时路绝不依赖投影语料）', () => {
  it('缺席 / 滞后 / 未知字段 / 根本没装：条目数与卡内「刚刚」完全一致', async () => {
    const [absent, stale, unknown, localOnly] = await Promise.all([
      runOne('absent'), runOne('stale'), runOne('unknown'), runOne('local-only'),
    ]);
    // 记录轨与历史路无关：三态都落了 1 条实时条目
    expect(absent.entryCount).toBe(1);
    expect([stale.entryCount, unknown.entryCount, localOnly.entryCount]).toEqual([1, 1, 1]);

    // 同一状态跑两遍不会更说明问题；跨状态比的是"同一段实时内容"
    const recentOf = (card: string): string[] => card.split('\n').filter((line) => line.startsWith('刚刚：'));
    const statusOf = (card: string): string => card.split('\n').find((line) => line.startsWith('状态：')) ?? '';
    expect(recentOf(absent.cardText).length, '近因段不该因为 DRSC 不可用就变短').toBeGreaterThan(0);
    expect(recentOf(stale.cardText)).toEqual(recentOf(absent.cardText));
    expect(recentOf(unknown.cardText)).toEqual(recentOf(absent.cardText));
    expect(recentOf(localOnly.cardText)).toEqual(recentOf(absent.cardText));
    expect(statusOf(stale.cardText)).toBe(statusOf(absent.cardText));
    expect(statusOf(unknown.cardText)).toBe(statusOf(absent.cardText));
    expect(statusOf(localOnly.cardText)).toBe(statusOf(absent.cardText));
  }, 30_000);

  it('缺席与未知字段 ⇒ 想起段为空（读不懂不等于没有）；滞后 ⇒ 只准引用语料里确实存在的旧回合', async () => {
    const absent = await runOne('absent');
    const unknown = await runOne('unknown');
    const stale = await runOne('stale');
    const recalled = (card: string): string[] => card.split('\n').filter((line) => line.startsWith('想起：'));

    expect(recalled(absent.cardText), '连不上就整段省略，不编造').toEqual([]);
    expect(recalled(unknown.cardText), '形状读不懂就整段省略，不猜字段').toEqual([]);
    // 滞后：语料里只有别的会话的旧句子；本轮刚发生的那条体验**不可能**在里面
    const hits = recalled(stale.cardText);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((line) => line.includes('上次你说先把投递放一放'))).toBe(true);
    const liveText = stale.cardText.split('\n').find((line) => line.startsWith('刚刚：')) ?? '';
    expect(hits.some((line) => line === `想起：${liveText.slice('刚刚：'.length)}`), '本轮内容绝不来自投影语料').toBe(false);
  }, 30_000);

  it('三态都不抛穿主会话（编排层 fail-open）', async () => {
    for (const state of ['absent', 'stale', 'unknown'] as const) {
      const r = await runOne(state);
      expect(['injected', 'passthrough', 'recorded']).toContain(r.outcome.kind);
    }
  }, 30_000);
});
