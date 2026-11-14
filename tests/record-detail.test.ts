/**
 * 记录详情（v0.8.17）：搜索命中行内展开的数据源。
 * 正反成对：任务带交付列表、交付带摘要、体验带残句与情绪、找不到返回 undefined。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { SPIRIT_RPC_PREFIX } from '../src/contract.js';
import { openSpiritDb } from '../src/db/open.js';
import { loadExperienceDetail } from '../src/search/detail-exp.js';
import { loadRecordDetail } from '../src/search/detail-records.js';
import { handleEndpoint, type RpcDeps } from '../src/rpc.js';
import { ModelMemoryStore, GoalStore } from '../src/memory/store.js';
import { OntologyStore } from '../src/store/ontology.js';
import { TxnStore } from '../src/store/transaction.js';
import { ExperienceStore } from '../src/store/experience.js';
import { TRUST_BACKFILL } from '../src/types.js';
import type { ExperienceDraft } from '../src/types.js';

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

function fresh(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-record-detail-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  dbs.push(opened.db);
  return opened.db;
}

describe('loadRecordDetail（非体验轨）', () => {
  it('任务：状态/下一步/记录时间 + 交付列表；找不到 ⇒ undefined', () => {
    const db = fresh();
    const onto = new OntologyStore({ db: () => db, logger });
    const txn = new TxnStore({ db: () => db, logger });
    onto.upsertTask({ id: 'task-a', title: 'plugin-9lang-five-dim', status: 'progress', workspaceId: 'E:/p', tsMs: 1_700_000, nextStep: '修正 ru.json 乱码' });
    txn.insert({ id: 'dlv-s1/3', sessionId: 's1', workspaceId: 'E:/p', tsMs: 1_700_500, turnSeq: 3, cardLine: '修正了 ru.json 乱码', summary: null, sourceTrust: TRUST_BACKFILL });
    onto.assignTaskDelivery({ taskId: 'task-a', deliveryId: 'dlv-s1/3', origin: 'live', tsMs: 1_700_500 });

    const detail = loadRecordDetail(db, 'task', 'task-a');
    expect(detail?.title).toBe('plugin-9lang-five-dim');
    expect(detail?.lines.some((line) => line.includes('下一步：修正 ru.json 乱码'))).toBe(true);
    expect(detail?.lines.some((line) => line.includes('交付（1）'))).toBe(true);
    expect(detail?.lines.some((line) => line.includes('修正了 ru.json 乱码'))).toBe(true);
    expect(loadRecordDetail(db, 'task', 'nope')).toBeUndefined();
  });

  it('交付/记着/目的/实体各自出明细；缺参/降级面不抛', () => {
    const db = fresh();
    const txn = new TxnStore({ db: () => db, logger });
    const memory = new ModelMemoryStore({ db: () => db, logger });
    const goals = new GoalStore({ db: () => db, logger });
    txn.insert({ id: 'dlv-2', sessionId: 's1', workspaceId: 'E:/p', tsMs: 1_700_000, turnSeq: 2, cardLine: '修好了端口漂移', summary: '定位到网关挡住', sourceTrust: TRUST_BACKFILL });
    memory.write({ scope: 'work', kind: 'preference', text: '这个项目只用 pnpm', workspaceId: 'E:/p' });
    goals.add({ title: '让鱼记住整段生涯', workspaceId: 'E:/p' });

    expect(loadRecordDetail(db, 'delivery', 'dlv-2')?.lines.some((line) => line.includes('摘要：定位到网关挡住'))).toBe(true);
    const memId = (db.prepare(`SELECT id FROM model_memory LIMIT 1`).get() as { id?: string }).id ?? '';
    expect(loadRecordDetail(db, 'memory', memId)?.lines.some((line) => line.includes('账本：work'))).toBe(true);
    const goalId = (db.prepare(`SELECT id FROM goal LIMIT 1`).get() as { id?: string }).id ?? '';
    expect(loadRecordDetail(db, 'goal', goalId)?.lines.some((line) => line.includes('状态：open'))).toBe(true);
    expect(loadRecordDetail(null, 'task', 'x')).toBeUndefined();
  });
});

describe('loadExperienceDetail（体验轨）', () => {
  it('正文/残句/情绪/来源/时间齐；找不到 ⇒ undefined', () => {
    const db = fresh();
    const exp = new ExperienceStore({ db, logger });
    const draft: ExperienceDraft = { trigger: 'recovery', notice: 'task_progress', reaction: 'mild', text: '我修好了端口漂移', fact: {}, lane: 'live' };
    exp.append({ id: 'e1', sessionId: 's1', workspaceId: 'E:/p', turnSeq: 1, tsMs: 1_700_000, personaRevision: 1 }, draft);
    const detail = loadExperienceDetail(db, 'e1');
    expect(detail?.title).toBe('我修好了端口漂移');
    expect(detail?.lines.some((line) => line.includes('情绪：'))).toBe(true);
    expect(detail?.lines.some((line) => line.includes('记录时间：'))).toBe(true);
    expect(loadExperienceDetail(db, 'nope')).toBeUndefined();
  });
});

describe('record-detail RPC', () => {
  it('未装配 ⇒ unavailable；非法 kind ⇒ bad-request；找不到 ⇒ not-found；命中 ⇒ 原样返回', async () => {
    const bare = { logger } as unknown as RpcDeps;
    expect((await handleEndpoint(`${SPIRIT_RPC_PREFIX}record-detail`, { kind: 'task', id: 'x' }, bare)).ok).toBe(false);

    const deps = {
      logger,
      recordDetail: (kind: string, id: string) => (id === 'missing' ? undefined : { kind, id, title: 'plugin-9lang-five-dim', lines: ['状态：progress'], ts: 1 }),
    } as unknown as RpcDeps;
    const bad = await handleEndpoint(`${SPIRIT_RPC_PREFIX}record-detail`, { kind: 'nope', id: 'x' }, deps);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('bad-request');
    const missing = await handleEndpoint(`${SPIRIT_RPC_PREFIX}record-detail`, { kind: 'task', id: 'missing' }, deps);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('not-found');
    const hit = await handleEndpoint(`${SPIRIT_RPC_PREFIX}record-detail`, { kind: 'task', id: 'task-a' }, deps);
    expect(hit.ok).toBe(true);
    if (hit.ok) expect((hit.value as { lines: string[] }).lines[0]).toBe('状态：progress');
  });
});
