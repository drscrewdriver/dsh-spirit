/**
 * 做梦 pass（v5）：等值查重合并 + 归档（尊重 dryRun）+ 报告落 meta。
 * 真库夹具（openSpiritDb），降级面单例（db=null）。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SPIRIT_DEFAULTS, type SpiritConfig } from '../src/contract.js';
import { openSpiritDb } from '../src/db/open.js';
import { DreamRunner, DREAM_DEDUP_MS, DREAM_META_KEY } from '../src/dream/dream.js';
import { ExperienceStore } from '../src/store/experience.js';
import { TRIGGER_TOOL_FAILURE } from '../src/types.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
const openDbs: DatabaseSync[] = [];

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-dream-'));
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

function makeStore(): { store: ExperienceStore; db: DatabaseSync } {
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开成功');
  openDbs.push(opened.db);
  return { store: new ExperienceStore({ db: opened.db, logger }), db: opened.db };
}

const DAY_MS = 86_400_000;

function put(store: ExperienceStore, id: string, sessionId: string, text: string, tsMs: number, trigger = TRIGGER_TOOL_FAILURE): void {
  store.append(
    { id, sessionId, workspaceId: 'w1', turnSeq: 1, tsMs, personaRevision: 1 },
    { trigger, notice: 'environment', reaction: 'mild', text, fact: {}, lane: 'live' },
  );
}

function makeRunner(store: ExperienceStore, db: DatabaseSync | null, cfg: SpiritConfig = structuredClone(SPIRIT_DEFAULTS)): DreamRunner {
  return new DreamRunner({ store, db: () => db, dataDir: dir, cfg: () => cfg, logger });
}

describe('做梦 pass', () => {
  it('等值查重合并：同会话同 trigger 同正文 ⇒ 保留最新、旧的进幽灵；报告计数如实', () => {
    const { store, db } = makeStore();
    const now = Date.now();
    put(store, 'a1', 's1', '这条我记了两遍', now - 5 * DAY_MS);
    put(store, 'a2', 's1', '这条我记了两遍', now - 4 * DAY_MS); // 与 a1 等值 ⇒ 应被合并
    put(store, 'b1', 's1', '这条只有一遍', now - 3 * DAY_MS);
    put(store, 'c1', 's2', '这条我记了两遍', now - 2 * DAY_MS); // 跨会话不算重复
    const runner = makeRunner(store, db);
    const out = runner.run();
    expect(out.updated).toBe(true);
    expect(out.report?.mergedPairs).toBe(1);
    expect(out.report?.active).toBe(3);
    expect(out.report?.ghosts).toBe(1);
    // 保留的是较新的 a2，a1 进取代链
    expect(store.byId('a1')?.supersededBy).toBe('a2');
    expect(store.byId('a2')?.supersededBy).toBeUndefined();
    // 报告落 meta 且可读回
    expect(runner.lastReport()?.dreamedAt).toBe(out.report?.dreamedAt);
    expect((db.prepare(`SELECT value FROM meta WHERE key = ?`).get(DREAM_META_KEY) as { value: string }).value).toContain('mergedPairs');
  });

  it('去重窗：60s 内第二次直接跳过（定时器与按钮收敛成一条真跑）', () => {
    const { store, db } = makeStore();
    put(store, 'a1', 's1', '一句话', Date.now());
    const runner = makeRunner(store, db);
    expect(runner.run().updated).toBe(true);
    const second = runner.run();
    expect(second.updated).toBe(false);
    expect(second.reason).toBe('dedup-window');
    expect(DREAM_DEDUP_MS).toBe(60_000);
  });

  it('空库也做得成梦：报告全零在场，不编故事也不报错', () => {
    const { store, db } = makeStore();
    const out = makeRunner(store, db).run();
    expect(out.updated).toBe(true);
    expect(out.report?.active).toBe(0);
    expect(out.report?.mergedPairs).toBe(0);
    expect(out.report?.ghosts).toBe(0);
  });

  it('降级（db=null）不做梦：run 跳过、lastReport 空，不抛', () => {
    const store = new ExperienceStore({ db: null, logger });
    const runner = makeRunner(store, null);
    expect(runner.run()).toEqual({ updated: false, reason: 'degraded' });
    expect(runner.lastReport()).toBeNull();
  });

  it('归档尊重部署面 dryRun：缺省干跑不落盘；显式关干跑后过期会话写进 archive/', () => {
    const { store, db } = makeStore();
    const cfg = structuredClone(SPIRIT_DEFAULTS);
    cfg.journal.retentionDays = 1;
    put(store, 'old1', 's-old', '上周的事', Date.now() - 3 * DAY_MS);
    // 干跑（缺省 true）：报数不落盘
    const dry = makeRunner(store, db, cfg).run();
    expect(dry.report?.archiveDryRun).toBe(true);
    expect(dry.report?.archivedSessions).toBe(1);
    expect(existsSync(join(dir, 'archive'))).toBe(false);
    // 实写：archive/ 出现 jsonl
    cfg.journal.dryRun = false;
    const { store: store2, db: db2 } = { store, db }; // 同一库续跑（去重窗绕开：新建 runner 实例）
    const wet = makeRunner(store2, db2, cfg).run();
    expect(wet.updated).toBe(true); // 新实例不带旧窗
    expect(wet.report?.archiveDryRun).toBe(false);
    expect(wet.report?.archivedSessions).toBe(1);
    expect(readdirSync(join(dir, 'archive')).some((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('坏 meta 不炸面板：lastReport 对缺键/坏 JSON 退 null（读侧宽容，写侧单源）', () => {
    const { store, db } = makeStore();
    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(DREAM_META_KEY, '{not json');
    expect(makeRunner(store, db).lastReport()).toBeNull();
  });
});
