/**
 * 回响记录读面（v0.8.11）：`echo-records`（含 echo-refs 别名）+ `inject-echo` 附带 records/recall/tone。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { SPIRIT_RPC_PREFIX } from '../src/contract.js';
import { openSpiritDb } from '../src/db/open.js';
import { resolveEchoId } from '../src/echo/identity.js';
import { EchoLog } from '../src/echo-log.js';
import { EchoRecallStore } from '../src/store/echo-recall.js';
import { EchoRefStore } from '../src/store/echo-ref.js';
import { handleEndpoint, type RpcDeps } from '../src/rpc.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterAll(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fresh(): { db: DatabaseSync; refs: EchoRefStore; echo: EchoRecallStore } {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-records-rpc-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  dbs.push(opened.db);
  return {
    db: opened.db,
    refs: new EchoRefStore({ db: () => opened.db, logger }),
    echo: new EchoRecallStore({ db: () => opened.db, logger }),
  };
}

describe('echo-records RPC', () => {
  it('未装配 ⇒ unavailable（echo-records 与旧名 echo-refs 同口径）', async () => {
    const bare = { logger } as unknown as RpcDeps;
    for (const op of ['echo-records', 'echo-refs']) {
      const result = await handleEndpoint(`${SPIRIT_RPC_PREFIX}${op}`, {}, bare);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('unavailable');
    }
  });

  it('列出记录：echo-<uuid> + recordTs + lastRecallId；kind/关键词过滤生效；refs 别名同内容', async () => {
    const { db, refs } = fresh();
    const taskEcho = resolveEchoId(db, 'task', 'task-a')!;
    const expEcho = resolveEchoId(db, 'experience', 'e-9')!;
    refs.upsert({ sessionId: 's1', echoId: taskEcho, kind: 'task', memId: 'task-a', title: 'plugin-9lang-five-dim', at: 1_000, recordTs: 900, lastRecallId: 'recall-1' });
    refs.upsert({ sessionId: 's1', echoId: expEcho, kind: 'experience', memId: 'e-9', title: '端口固定住了', at: 5_000, recordTs: 4_000, lastRecallId: 'recall-2' });
    const deps = { logger, echoRefs: refs } as unknown as RpcDeps;

    const all = await handleEndpoint(`${SPIRIT_RPC_PREFIX}echo-records`, { sessionId: 's1' }, deps);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const view = all.value as { records: Array<{ echoId: string; title: string; recordTs: number; lastRecallId: string }>; refs: unknown[]; total: number };
    expect(view.total).toBe(2);
    expect(view.records[0]?.title, '最新想起在前').toBe('端口固定住了');
    expect(view.records[0]?.echoId).toMatch(/^echo-[0-9a-f-]{36}$/);
    expect(view.records[0]?.recordTs).toBe(4_000);
    expect(view.records[0]?.lastRecallId).toBe('recall-2');
    expect(view.refs).toHaveLength(2);

    const byRecord = await handleEndpoint(`${SPIRIT_RPC_PREFIX}echo-records`, { sessionId: 's1', order: 'record' }, deps);
    if (byRecord.ok) expect((byRecord.value as { records: Array<{ memId: string }> }).records.map((r) => r.memId)).toEqual(['e-9', 'task-a']);

    const byWord = await handleEndpoint(`${SPIRIT_RPC_PREFIX}echo-refs`, { sessionId: 's1', q: '端口' }, deps);
    if (byWord.ok) expect((byWord.value as { records: Array<{ memId: string }> }).records.map((r) => r.memId)).toEqual(['e-9']);
  });
});

describe('echo-locate（按号定位）', () => {
  it('未装配 ⇒ unavailable；装配后返回 hits（标题/记录时间/最近回响号）', async () => {
    const bare = { logger } as unknown as RpcDeps;
    expect((await handleEndpoint(`${SPIRIT_RPC_PREFIX}echo-locate`, { q: 'echo-x' }, bare)).ok).toBe(false);

    const deps = {
      logger,
      echoLocate: (q: string) => (q.trim() === '' ? { idQuery: false, hits: [] } : {
        idQuery: true,
        hits: [{ echoId: 'echo-3f9a2b7c-1d4e-4a5b-8c9d-0e1f2a3b4c5d', kind: 'task', memId: 'task-a', title: 'plugin-9lang-five-dim', recordTs: 1_700_000_000_000, sessionId: 's1', lastRecallId: 'recall-1' }],
      }),
    } as unknown as RpcDeps;
    const result = await handleEndpoint(`${SPIRIT_RPC_PREFIX}echo-locate`, { q: 'echo-3f9a' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.value as { idQuery: boolean; hits: Array<{ title: string; echoId: string }> };
    expect(view.idQuery).toBe(true);
    expect(view.hits[0]?.title).toBe('plugin-9lang-five-dim');
  });
});

describe('spirit-search（全域文本搜索）', () => {
  it('未装配 ⇒ unavailable；装配后原样返回 hits（不分类型）', async () => {
    const bare = { logger } as unknown as RpcDeps;
    expect((await handleEndpoint(`${SPIRIT_RPC_PREFIX}spirit-search`, { q: 'x' }, bare)).ok).toBe(false);
    const deps = {
      logger,
      searchAll: (q: string) => [
        { kind: 'task', id: 'task-a', echoId: 'echo-1', title: `任务命中 ${q}`, ts: 3 },
        { kind: 'delivery', id: 'dlv-1', echoId: 'echo-2', title: '交付命中', ts: 2 },
        { kind: 'experience', id: 'e-1', echoId: 'echo-3', title: '体验命中', ts: 1 },
      ],
    } as unknown as RpcDeps;
    const result = await handleEndpoint(`${SPIRIT_RPC_PREFIX}spirit-search`, { q: '端口' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hits = (result.value as { hits: Array<{ kind: string }> }).hits;
    expect(hits.map((hit) => hit.kind)).toEqual(['task', 'delivery', 'experience']);
  });
});

describe('inject-echo 附带 records / recall / tone', () => {
  it('装配 echoRefs ⇒ records[] + recall{recallId,flashback} + tone；语气不混入记录', async () => {
    const { db, refs, echo } = fresh();
    const taskEcho = resolveEchoId(db, 'task', 'task-a')!;
    echo.record({
      sessionId: 's1', agentId: 'a', at: 2_000, kind: 'injected', id: 'recall-2000', segments: [], excerpts: [],
      preview: '状态：平常·按平时那样说', flashback: true,
      text: '状态：平常·按平时那样说\n开场：又见面了\n线程：plugin-9lang-five-dim · 进行中',
    });
    refs.upsert({ sessionId: 's1', echoId: taskEcho, kind: 'task', memId: 'task-a', title: 'plugin-9lang-five-dim', at: 2_000, recordTs: 1_500, lastRecallId: 'recall-2000' });
    const log = new EchoLog();
    log.record({ at: 2_000, agentId: 'a', sessionId: 's1', workspaceId: 'w', kind: 'injected', fingerprint: 'fp', text: '状态：平常' });
    const deps = { logger, echo: log, echoRefs: refs, echoRecall: echo } as unknown as RpcDeps;

    const result = await handleEndpoint(`${SPIRIT_RPC_PREFIX}inject-echo`, { sessionId: 's1' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.value as {
      records?: Array<{ echoId: string; kind: string }>;
      recall?: { recallId: string; at: number; flashback: boolean };
      tone?: { state?: string; opening?: string };
    };
    expect(view.records).toHaveLength(1);
    expect(view.records?.[0]?.echoId).toBe(taskEcho);
    expect(view.recall?.recallId).toBe('recall-2000');
    expect(view.recall?.flashback, '旧事召回打 flashback 标').toBe(true);
    expect(view.tone?.state).toBe('平常·按平时那样说');
    expect(view.records?.some((row) => row.kind === 'tone')).toBe(false);
  });

  it('未装配 echoRefs ⇒ 不附带 records/recall/tone（旧行为不变）', async () => {
    const { echo } = fresh();
    echo.record({ sessionId: 's1', agentId: 'a', at: 1_000, kind: 'injected', segments: [], excerpts: [], preview: 'p', text: '状态：稳' });
    const deps = { logger, echoRecall: echo } as unknown as RpcDeps;
    const result = await handleEndpoint(`${SPIRIT_RPC_PREFIX}inject-echo`, { sessionId: 's1' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.value as { records?: unknown; recall?: unknown; tone?: unknown };
    expect(view.records).toBeUndefined();
    expect(view.recall).toBeUndefined();
    expect(view.tone).toBeUndefined();
  });
});
