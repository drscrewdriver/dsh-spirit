/**
 * 回响记录回填（v0.8.11）：只回填有原文的轮次、echo 号走注册表（不重生）、水位幂等。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { splitEchoEntries } from '../src/echo-log.js';
import { resolveEntryTimes } from '../src/echo-times.js';
import { backfillEchoRefs, ECHO_RECORDS_WATERMARK } from '../src/echo/refs-backfill.js';
import { EchoRecallStore } from '../src/store/echo-recall.js';
import { EchoRefStore } from '../src/store/echo-ref.js';
import { OntologyStore } from '../src/store/ontology.js';

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

function fresh(): { db: DatabaseSync; echo: EchoRecallStore; refs: EchoRefStore } {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-records-backfill-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  dbs.push(opened.db);
  return {
    db: opened.db,
    echo: new EchoRecallStore({ db: () => opened.db, logger }),
    refs: new EchoRefStore({ db: () => opened.db, logger }),
  };
}

describe('backfillEchoRefs（记录回填）', () => {
  it('有原文的轮次解析成记录；无 text 的旧行跳过；水位幂等；echo 号不重生', () => {
    const { db, echo, refs } = fresh();
    const onto = new OntologyStore({ db: () => db, logger });
    onto.upsertTask({ id: 'task-a', title: 'plugin-9lang-five-dim', status: 'progress', workspaceId: 'E:/p', tsMs: 1_700_000 });
    echo.record({
      sessionId: 's1', agentId: 'a', at: Date.now() - 1_000, kind: 'injected', id: 'recall-aaa', segments: [],
      excerpts: [], preview: '状态：平常', text: '状态：平常·按平时那样说\n线程：plugin-9lang-five-dim · 进行中',
    });
    // 无 text 的旧行（只有摘要）：不得被反推成记录
    echo.record({ sessionId: 's1', agentId: 'a', at: Date.now() - 2_000, kind: 'injected', segments: [], excerpts: [], preview: '状态：老行' });

    const run = (force = false) => backfillEchoRefs({
      db: () => db,
      refs,
      resolve: (sessionId, text, at) => resolveEntryTimes(db, sessionId, splitEchoEntries(text), at),
      force,
      logger,
    });

    const first = run();
    expect(first.skipped).toBe(false);
    expect(first.steps, '只数有 text 的轮次').toBe(1);
    expect(first.records).toBe(1);
    const listed = refs.list({ sessionId: 's1' });
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0]?.echoId).toMatch(/^echo-[0-9a-f-]{36}$/);
    expect(listed.rows[0]?.title).toBe('plugin-9lang-five-dim');
    expect(listed.rows[0]?.lastRecallId).toBe('recall-aaa');
    const echoId = listed.rows[0]?.echoId;

    // 水位存在 ⇒ 不重跑
    expect(run().skipped).toBe(true);
    // 强制重跑：合并但不重生新号
    const forced = run(true);
    expect(forced.records).toBe(1);
    expect(refs.list({ sessionId: 's1' }).rows[0]?.echoId).toBe(echoId);
    const wm = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(ECHO_RECORDS_WATERMARK) as { value?: string } | undefined;
    expect(wm?.value).toBeTruthy();
  });

  it('db 不可用 ⇒ 全 0 不抛', () => {
    const result = backfillEchoRefs({ db: () => undefined, refs: { upsert: () => false }, resolve: () => [], logger });
    expect(result).toEqual({ sessions: 0, steps: 0, records: 0, skipped: false });
  });
});
