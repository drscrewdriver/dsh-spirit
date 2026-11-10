/**
 * 事务轨查询面（Phase 5 / T5.4）：timeline-query / resource-lookup 两端点。
 *
 * 走真库（openSpiritDb + TxnStore.insert），端点直调 handleEndpoint——测的是分发与
 * 查询语义，不是纯投影。四条必钉：
 * 1. 端点可分发（不是 unknown endpoint）。
 * 2. 时间范围闭两端 + 区间外行不返回。
 * 3. 资源反查按 basename 等值命中，未知 cue ⇒ 空命中不报错。
 * 4. 未装配（deps.txn 缺席）⇒ unavailable，不是 500。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { TxnStore, type TxnInsertInput } from '../src/store/transaction.js';
import { handleEndpoint, type RpcDeps } from '../src/rpc.js';
import { SPIRIT_RPC_PREFIX } from '../src/contract.js';
import { ExperienceStore } from '../src/store/experience.js';
import { TRUST_STRUCTURE_SIGNAL } from '../src/types.js';

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

function openTxn(): TxnStore {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-rpc-timeline-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('openSpiritDb 失败');
  dbs.push(opened.db);
  return new TxnStore({ db: () => opened.db, logger });
}

/** 只填查询面用得上的字段，其余给可落库的最小值。 */
function row(over: Partial<TxnInsertInput>): TxnInsertInput {
  return {
    id: 'txn-x',
    sessionId: 's1',
    workspaceId: 'ws-a',
    tsMs: 1_700_000_000_000,
    turnSeq: 1,
    cardLine: '默认事务',
    sourceTrust: TRUST_STRUCTURE_SIGNAL,
    ...over,
  };
}

function depsWith(txn: TxnStore | undefined): RpcDeps {
  return {
    store: new ExperienceStore({ db: null, logger }),
    drscVerdict: () => 'skipped',
    logger,
    ...(txn === undefined ? {} : { txn }),
  } as unknown as RpcDeps;
}

const ep = (op: string): string => `${SPIRIT_RPC_PREFIX}${op}`;

describe('T5.4 timeline-query', () => {
  it('可分发 + 区间闭两端：范围内命中、范围外不返回', async () => {
    const txn = openTxn();
    const t0 = 1_700_000_000_000;
    expect(txn.insert(row({ id: 'txn-in', tsMs: t0, cardLine: '范围内的这周' })).ok).toBe(true);
    expect(txn.insert(row({ id: 'txn-out', tsMs: t0 - 30 * 86_400_000, cardLine: '上个月' })).ok).toBe(true);

    const res = await handleEndpoint(ep('timeline-query'), { from: t0 - 7 * 86_400_000, to: t0 }, depsWith(txn));
    expect(res.ok, '端点应被分发').toBe(true);
    if (!res.ok) return;
    const value = res.value as { rows: Array<{ id: string }>; from: number; to: number };
    expect(value.from).toBe(t0 - 7 * 86_400_000);
    expect(value.to).toBe(t0);
    const ids = value.rows.map((r) => r.id);
    expect(ids).toContain('txn-in');
    expect(ids, '区间外的行不得混进来').not.toContain('txn-out');
  });

  it('空命中 ⇒ rows 为空数组，不报错', async () => {
    const txn = openTxn();
    const res = await handleEndpoint(ep('timeline-query'), { from: 1, to: 2 }, depsWith(txn));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.value as { rows: unknown[] }).rows).toEqual([]);
  });

  it('未装配 deps.txn ⇒ unavailable（不是 unknown endpoint、也不是 500）', async () => {
    const res = await handleEndpoint(ep('timeline-query'), {}, depsWith(undefined));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('unavailable');
  });
});

describe('T5.4 resource-lookup', () => {
  it('按 basename 等值命中，带 matchedCue/matchedKind', async () => {
    const txn = openTxn();
    expect(txn.insert(row({ id: 'txn-a', cardLine: '改了投递脚本', cues: [{ cue: 'deliver.ts', kind: 'file' }] })).ok).toBe(true);
    const res = await handleEndpoint(ep('resource-lookup'), { cue: 'deliver.ts' }, depsWith(txn));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hits = (res.value as { hits: Array<{ row: { id: string }; matchedCue: string; matchedKind: string }> }).hits;
    expect(hits.some((h) => h.row.id === 'txn-a' && h.matchedCue === 'deliver.ts' && h.matchedKind === 'file')).toBe(true);
  });

  it('未知 cue ⇒ 空命中，不报错', async () => {
    const txn = openTxn();
    const res = await handleEndpoint(ep('resource-lookup'), { cue: '不存在的文件.ts' }, depsWith(txn));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.value as { hits: unknown[] }).hits).toEqual([]);
  });

  it('cue 为空 ⇒ bad-request', async () => {
    const txn = openTxn();
    const res = await handleEndpoint(ep('resource-lookup'), { cue: '' }, depsWith(txn));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('bad-request');
  });
});
