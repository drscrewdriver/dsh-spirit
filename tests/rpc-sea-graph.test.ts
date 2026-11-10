/**
 * `sea-graph` 端点门禁（host 半）。
 *
 * 只测三件会静默坏掉的事：窗口钳位、会话作用域的参数校验、降级标记如实上报。
 * 不测图长什么样——那是 `sea-scene.test.ts` 与客户端 layout 单测的事。
 */
import { describe, expect, it } from 'vitest';

import { SPIRIT_DEFAULTS } from '../src/contract.js';
import { SPIRIT_RPC_PREFIX } from '../src/contract.js';
import { handleEndpoint, type RpcDeps } from '../src/rpc.js';
import { ExperienceStore } from '../src/store/experience.js';
import type { ExperienceDraft } from '../src/types.js';

const logger = { info: () => {}, warn: () => {} };

function draftOf(text: string): ExperienceDraft {
  return { trigger: 'neutral', notice: 'task_progress', reaction: 'none', text, fact: {}, lane: 'live' };
}

function makeDeps(): { deps: RpcDeps; store: ExperienceStore } {
  const store = new ExperienceStore({ db: null, logger });
  for (let index = 0; index < 3; index += 1) {
    store.append(
      { id: `e${index}`, sessionId: 's1', workspaceId: 'w1', turnSeq: index + 1, tsMs: 1_000 + index, personaRevision: 1 },
      draftOf(`第 ${index} 条经历`),
    );
  }
  const deps = {
    spirit: {},
    stats: { latest: () => null, snapshot: () => null, agentOfSession: () => undefined },
    store,
    modes: { isOff: () => false, isBypass: () => false },
    personas: {},
    dataDir: '.',
    cfg: () => SPIRIT_DEFAULTS,
    drscVerdict: () => 'skipped' as const,
    logger,
  } as unknown as RpcDeps;
  return { deps, store };
}

describe('sea-graph', () => {
  it('返回窗口内的点与统计，降级标记来自 store.persistent', async () => {
    const { deps } = makeDeps();
    const result = await handleEndpoint(`${SPIRIT_RPC_PREFIX}sea-graph`, {}, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graph = result.value as { points: unknown[]; stats: { loaded: number; degraded: boolean; window: number } };
    expect(graph.points).toHaveLength(3);
    expect(graph.stats.loaded).toBe(3);
    expect(graph.stats.degraded).toBe(true); // db=null ⇒ 内存镜像，必须如实上报
  });

  it('limit 超上限被钳到 SEA_WINDOW_LIMIT，非法值退回缺省', async () => {
    const { deps } = makeDeps();
    const huge = await handleEndpoint(`${SPIRIT_RPC_PREFIX}sea-graph`, { limit: 99_999 }, deps);
    expect(huge.ok).toBe(true);
    if (huge.ok) expect((huge.value as { stats: { window: number } }).stats.window).toBe(3_000);

    const bad = await handleEndpoint(`${SPIRIT_RPC_PREFIX}sea-graph`, { limit: -5 }, deps);
    expect(bad.ok).toBe(true);
    if (bad.ok) expect((bad.value as { stats: { window: number } }).stats.window).toBe(1);
  });

  it('scope=session 缺 sessionId 直接拒，不退回全库', async () => {
    const { deps } = makeDeps();
    const result = await handleEndpoint(`${SPIRIT_RPC_PREFIX}sea-graph`, { scope: 'session' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('bad-request');
  });

  it('本体层开时交付行进图（v0.6）：dlv- 前缀才画，步骤遥测行不进星图', async () => {
    const { deps } = makeDeps();
    (deps as { txn?: unknown }).txn = {
      listRecent: () => [
        { id: 'dlv-s1/2', tsMs: 2_500, sessionId: 's1', turnSeq: 2, cardLine: '我交付了 X', summary: '摘要' },
        { id: 'txn-s1/3', tsMs: 2_600, sessionId: 's1', turnSeq: 3, cardLine: '步骤行不该出现', summary: null },
      ],
    };
    const result = await handleEndpoint(`${SPIRIT_RPC_PREFIX}sea-graph`, {}, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graph = result.value as { points: Array<{ id: string; kind?: string }> };
    expect(graph.points.some((p) => p.id === 'dlv-s1/2' && p.kind === 'delivery')).toBe(true);
    expect(graph.points.some((p) => p.id === 'txn-s1/3'), '非交付行不入图').toBe(false);
  });
});
