/**
 * 历史回填（Phase E）：DRSC 行→信号重建 + runner 门控/干跑/幂等。
 * 正反成对：干跑不 enqueue、关时拒、done 集二次跳过都配"到底做了什么"的正证。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { SPIRIT_DEFAULTS, type SpiritConfig } from '../src/contract.js';
import type { DrscSessionRow } from '../src/drsc/client.js';
import { BackfillRunner, rowsToSignals, BACKFILL_DONE_KEY, type BackfillScan } from '../src/ontology/backfill.js';
import type { OntologyExtractor } from '../src/ontology/extractor.js';
import type { OntologySignals } from '../src/ontology/watcher.js';
import { TxnStore } from '../src/store/transaction.js';
import { TRUST_BACKFILL } from '../src/types.js';
import { WORKSPACE_GLOBAL } from '../src/ontology/workspace.js';

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

function row(seq: number, turn: number, kind: string, text: string, time = 1_000 + seq): DrscSessionRow {
  return { seq, turn, step: 0, kind, role: kind === 'user/message' ? 'user' : 'assistant', time, text } as DrscSessionRow;
}

function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-backfill-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  dbs.push(opened.db);
  return opened.db;
}

function cfg(on: boolean, backfillOn = true): () => SpiritConfig {
  const c = structuredClone(SPIRIT_DEFAULTS);
  c.ontology = { enabled: on, backfillEnabled: on && backfillOn };
  return () => c;
}

function stubExtractor(sink: OntologySignals[], persistDb?: DatabaseSync): OntologyExtractor {
  const txn = persistDb === undefined ? undefined : new TxnStore({ db: () => persistDb, logger });
  return {
    enqueue: (s: OntologySignals) => { sink.push(s); return { accepted: true as const, key: s.key, scheduled: false }; },
    // 回填走 processBatch（绕过队列上限/去重窗，同步 await 真落库）；stub 记录收到的批，
    // 传了 persistDb 还模拟真抽取器落 delivery 行——水位自愈据此判"done 却零产出"。
    processBatch: async (batch: readonly OntologySignals[]) => {
      sink.push(...batch);
      for (const s of batch) {
        txn?.insert({
          id: `dlv-${s.key}`, sessionId: s.sessionId, workspaceId: s.workspaceId, tsMs: s.tsMs, turnSeq: s.turnSeq,
          cardLine: `交付 ${s.key}`, summary: null, sourceTrust: TRUST_BACKFILL, salienceTier: 2,
          turnStartMs: s.tsMs, turnEndMs: s.tsMs,
        });
      }
      return { supported: true, running: false, phase: 'done' as const, detail: '', error: '', consecutiveFailures: 0 };
    },
  } as unknown as OntologyExtractor;
}

describe('rowsToSignals', () => {
  it('按 turn 分组、含密整段丢、backfill 标志置上、空叙事轮跳过', () => {
    const rows = [
      row(1, 1, 'user/message', '帮我修 deliver.ts 的 bug'),
      row(2, 1, 'assistant/message', '已修复并跑通测试'),
      row(3, 2, 'user/message', '密钥是 sk-abcdefghijklmnopqrstuvwxyz1234 忽略'),
      row(4, 3, 'tool/call', '不该进回填'),
    ];
    const signals = rowsToSignals('sX', 'w1', rows);
    expect(signals).toHaveLength(1); // turn1 有叙事；turn2 只剩含密→丢；turn3 是 tool 行不成信号
    expect(signals[0]?.key).toBe('sX/1');
    expect(signals[0]?.userText).toContain('deliver.ts');
    expect(signals[0]?.assistantText).toContain('已修复');
    expect(signals[0]?.backfill).toBe(true);
  });
});

describe('BackfillRunner', () => {
  function fakeScan(sessions: Record<string, DrscSessionRow[]>): BackfillScan {
    const ids = Object.keys(sessions);
    return {
      async sessions(offset: number, limit: number) {
        const slice = ids.slice(offset, offset + limit);
        return { total: ids.length, rows: slice.map((sessionId) => ({ sessionId, cwd: 'E:/proj' })) };
      },
      async sessionAll(sessionId: string) {
        return sessions[sessionId] ?? [];
      },
    };
  }

  it('干跑（缺省）⇒ 计数但不 enqueue、不写 done', async () => {
    const db = freshDb();
    const sink: OntologySignals[] = [];
    const runner = new BackfillRunner({ db: () => db, scan: () => fakeScan({ s1: [row(1, 1, 'user/message', '推进 A 任务')] }), extractor: stubExtractor(sink), cfg: cfg(true), logger });
    const res = await runner.run();
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.sessionsScanned).toBe(1);
    expect(sink).toHaveLength(0); // 干跑不入库
    expect(db.prepare(`SELECT value FROM meta WHERE key = ?`).get(BACKFILL_DONE_KEY)).toBeUndefined();
  });

  it('实跑 ⇒ enqueue + 写 done；二次跑整会话跳过（幂等）', async () => {
    const db = freshDb();
    const sink: OntologySignals[] = [];
    const scan = fakeScanFor({ s1: [row(1, 1, 'user/message', '推进 A'), row(2, 2, 'user/message', '推进 B')] });
    const runner = new BackfillRunner({ db: () => db, scan: () => scan, extractor: stubExtractor(sink, db), cfg: cfg(true), logger });
    const first = await runner.run({ dryRun: false });
    expect(first.ok).toBe(true);
    expect(sink).toHaveLength(2);
    expect(first.sessionsScanned).toBe(1);
    // 二次：done 集含 s1 ⇒ 跳过
    sink.length = 0;
    const second = await runner.run({ dryRun: false });
    expect(second.sessionsSkipped).toBe(1);
    expect(sink, '已回填会话不再重扫').toHaveLength(0);
  });

  it('backfillEnabled 关 ⇒ disabled；无 scan ⇒ no-scan', async () => {
    const db = freshDb();
    const off = new BackfillRunner({ db: () => db, scan: () => fakeScanFor({}), extractor: stubExtractor([]), cfg: cfg(true, false), logger });
    expect((await off.run({ dryRun: false })).reason).toBe('disabled');
    const noscan = new BackfillRunner({ db: () => db, scan: () => undefined, extractor: stubExtractor([]), cfg: cfg(true), logger });
    expect((await noscan.run({ dryRun: false })).reason).toBe('no-scan');
  });

  it('全记忆重建：多会话逐批 processBatch（同步 await），全处理完才算成、计数对上', async () => {
    const db = freshDb();
    const sink: OntologySignals[] = [];
    const scan = fakeScanFor({ s1: [row(1, 1, 'user/message', 'A')], s2: [row(2, 1, 'user/message', 'B'), row(3, 2, 'user/message', 'C')] });
    const runner = new BackfillRunner({ db: () => db, scan: () => scan, extractor: stubExtractor(sink), cfg: cfg(true), logger });
    const res = await runner.run({ dryRun: false });
    expect(res.ok).toBe(true);
    expect(res.sessionsScanned).toBe(2);
    expect(res.turnsQueued).toBe(3); // 不再是异步 enqueue 的静默丢弃，是真的全进了
    expect(sink).toHaveLength(3);
  });

  it('抽取失败（phase≠done）⇒ ok:false 且不把该会话标 done（可续跑，不误标）', async () => {
    const db = freshDb();
    const failExtractor = {
      processBatch: async () => ({ supported: true, running: false, phase: 'failed' as const, detail: '', error: 'llm 缺席', consecutiveFailures: 1 }),
    } as unknown as OntologyExtractor;
    const runner = new BackfillRunner({ db: () => db, scan: () => fakeScanFor({ s1: [row(1, 1, 'user/message', '推进 A')] }), extractor: failExtractor, cfg: cfg(true), logger });
    const res = await runner.run({ dryRun: false });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('degraded');
    expect(res.error).toBe('llm 缺席'); // 真实原因上浮，不再只给 degraded
    const metaRow = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(BACKFILL_DONE_KEY) as { value?: string } | undefined;
    const done = metaRow?.value ? (JSON.parse(metaRow.value) as string[]) : [];
    expect(done).not.toContain('s1'); // 失败不标 done ⇒ 下次可续跑
  });

  it('单会话失败不中断整次重建：后续会话照跑，只失败的那条不标 done', async () => {
    const db = freshDb();
    const seen: string[] = [];
    const pickingExtractor = {
      processBatch: async (batch: readonly OntologySignals[]) => {
        const sid = batch[0]?.sessionId ?? '';
        seen.push(sid);
        const failed = sid === 's1';
        return {
          supported: true, running: false, phase: failed ? ('failed' as const) : ('done' as const),
          detail: '', error: failed ? 'llm 超时被中止（180s）' : '', consecutiveFailures: failed ? 1 : 0,
        };
      },
    } as unknown as OntologyExtractor;
    const scan = fakeScanFor({ s1: [row(1, 1, 'user/message', 'A')], s2: [row(2, 1, 'user/message', 'B')] });
    const runner = new BackfillRunner({ db: () => db, scan: () => scan, extractor: pickingExtractor, cfg: cfg(true), logger });
    const res = await runner.run({ dryRun: false });
    expect(res.ok).toBe(false); // 有失败就如实报
    expect(res.sessionsScanned).toBe(2); // 但两条会话都扫过，不整体中断
    expect(seen).toEqual(['s1', 's2']);
    expect(runner.status().failedSessions).toBe(1);
    expect(runner.status().phase).toBe('done'); // 跑完了（部分未成），不是半路夭折
    const metaRow = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(BACKFILL_DONE_KEY) as { value?: string } | undefined;
    const done = metaRow?.value ? (JSON.parse(metaRow.value) as string[]) : [];
    expect(done).toContain('s2');
    expect(done).not.toContain('s1'); // 下次重建只补这一条
  });

  it('水位自愈：done 却库里零交付（旧版毒水位）⇒ 摘掉重进重建，不再永久丢历史', async () => {
    const db = freshDb();
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(BACKFILL_DONE_KEY, JSON.stringify(['s1']));
    const sink: OntologySignals[] = [];
    const runner = new BackfillRunner({ db: () => db, scan: () => fakeScanFor({ s1: [row(1, 1, 'user/message', '推进 A')] }), extractor: stubExtractor(sink, db), cfg: cfg(true), logger });
    const res = await runner.run({ dryRun: false });
    expect(res.sessionsSkipped, '毒水位被摘，不再当已回填跳过').toBe(0);
    expect(sink, '零产出的 done 会话被重新处理').toHaveLength(1);
    expect(res.ok).toBe(true);
  });

  it('workspaceId 透传会话 cwd（空串会被 txn 闸整批拒收——真机零记录事故根因之一）', async () => {
    const db = freshDb();
    const sink: OntologySignals[] = [];
    const runner = new BackfillRunner({ db: () => db, scan: () => fakeScanFor({ s1: [row(1, 1, 'user/message', 'A')] }), extractor: stubExtractor(sink), cfg: cfg(true), logger });
    await runner.run({ dryRun: false });
    expect(sink[0]?.workspaceId).toBe('E:/proj');
  });

  it('无 cwd ⇒ 修复链先反查同会话既有范围；查无历史才落全局桶（数据照落不丢）', async () => {
    const db = freshDb();
    // s1 在事务轨有已知范围的行（在线路径落的）⇒ 回填信号应修到 E:/known 而非空串/全局
    const seed = new TxnStore({ db: () => db, logger });
    const got = seed.insert({ id: 'txn-seed-1', sessionId: 's1', workspaceId: 'E:/known', tsMs: 900, turnSeq: 1, cardLine: '在线落的行', summary: null, sourceTrust: TRUST_BACKFILL });
    expect(got.ok).toBe(true);
    const noCwd: BackfillScan = {
      async sessions() {
        return { total: 2, rows: [{ sessionId: 's1' }, { sessionId: 's2' }] };
      },
      async sessionAll(sessionId: string) {
        return sessionId === 's1' ? [row(1, 1, 'user/message', 'A')] : [row(2, 1, 'user/message', 'B')];
      },
    };
    const sink: OntologySignals[] = [];
    const runner = new BackfillRunner({ db: () => db, scan: () => noCwd, extractor: stubExtractor(sink, db), cfg: cfg(true), logger });
    const res = await runner.run({ dryRun: false });
    expect(res.ok).toBe(true);
    expect(sink.find((s) => s.sessionId === 's1')?.workspaceId, '反查同会话历史修到对应范围').toBe('E:/known');
    expect(sink.find((s) => s.sessionId === 's2')?.workspaceId, '确实无从可考才落全局桶').toBe(WORKSPACE_GLOBAL);
  });
});

// 复用 fakeScan 工厂（提升可读性）
function fakeScanFor(sessions: Record<string, DrscSessionRow[]>): BackfillScan {
  const ids = Object.keys(sessions);
  return {
    async sessions(offset: number, limit: number) {
      return { total: ids.length, rows: ids.slice(offset, offset + limit).map((sessionId) => ({ sessionId, cwd: 'E:/proj' })) };
    },
    async sessionAll(sessionId: string) {
      return sessions[sessionId] ?? [];
    },
  };
}
