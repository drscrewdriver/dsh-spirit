/**
 * 生涯流程预总结（v0.8.18）：L1 只读桥 + 流程性摘要 + 三档落库（week/month/milestone）+ 防失忆。
 * 边界：知识性不落 spirit（只计数）；流程性（work_task/episodic）才进档。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { searchL1Records } from '../src/prime/l1-source.js';
import { classifyL1Type, summarizeProcedural, toSummaryText } from '../src/prime/distill-summary.js';
import { buildDigests, monthKeyOf, readDigests, weekKeyOf, writeDigest } from '../src/prime/distill-digest.js';

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

function freshL1(rows: Array<{ id: string; type: string; content: string; stamp: string; family?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-l1-'));
  dirs.push(dir);
  const file = join(dir, 'memory.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE l1_records (
    record_id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT DEFAULT '', family TEXT NOT NULL DEFAULT 'chat',
    timestamp_start TEXT DEFAULT '', created_time TEXT DEFAULT '', scope TEXT NOT NULL DEFAULT 'global', workspace_id TEXT NOT NULL DEFAULT '',
    repo_key_name TEXT NOT NULL DEFAULT '', repo_key_owner TEXT NOT NULL DEFAULT ''
  )`);
  const insert = db.prepare(`INSERT INTO l1_records (record_id, content, type, family, timestamp_start, created_time) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const row of rows) insert.run(row.id, row.content, row.type, row.family ?? 'work', row.stamp, row.stamp);
  db.close();
  return file;
}

function freshSpirit(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-digest-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  dbs.push(opened.db);
  return opened.db;
}

describe('L1 只读桥', () => {
  it('关键词 / 时间窗 / 上限；缺失库 ⇒ 空', () => {
    const now = new Date().toISOString();
    const file = freshL1([
      { id: 'mem_1', type: 'work_task', content: '11/10 统计报告跨 2 天口径', stamp: now },
      { id: 'mem_2', type: 'work_fact', content: 'bake · 19,913,485 · +6.58%', stamp: now },
      { id: 'mem_3', type: 'work_task', content: '很久以前的任务', stamp: new Date(Date.now() - 30 * 86_400_000).toISOString() },
    ]);
    expect(searchL1Records({ q: 'bake', dbPath: file }).map((hit) => hit.id)).toEqual(['mem_2']);
    expect(searchL1Records({ days: 2, dbPath: file }).length).toBe(2);
    expect(searchL1Records({ days: 0, dbPath: file }).length).toBe(3);
    expect(searchL1Records({ limit: 1, days: 0, dbPath: file }).length).toBe(1);
    expect(searchL1Records({ dbPath: join(tmpdir(), 'no-such-dir', 'x.db') })).toEqual([]);
  });
});

describe('流程性摘要（知识性只计数）', () => {
  it('归类：work_task/episodic 归流程；work_fact 归知识（不摘要）', () => {
    expect(classifyL1Type('work_task')).toBe('procedural');
    expect(classifyL1Type('episodic')).toBe('procedural');
    expect(classifyL1Type('work_fact')).toBe('knowledge');
    expect(classifyL1Type('tool_experience')).toBe('knowledge');
    expect(classifyL1Type('something_new')).toBe('knowledge');
  });

  it('摘要只含流程行；压行截断码点安全', () => {
    const now = new Date().toISOString();
    const file = freshL1([
      { id: 't1', type: 'work_task', content: 'spirit 边界核查：孤立感谢不进 L1', stamp: now },
      { id: 'f1', type: 'work_fact', content: 'bake 快照 19,913,485', stamp: now },
      { id: 't2', type: 'work_task', content: '9语：Tier E 逐仓核对；18/18 推送', stamp: new Date(Date.now() - 86_400_000).toISOString() },
    ]);
    const summary = summarizeProcedural({ days: 7, dbPath: file });
    expect(summary.count).toBe(2);
    expect(summary.knowledgeCount).toBe(1);
    expect(summary.lines.some((line) => line.text.includes('bake'))).toBe(false);
    expect(toSummaryText('· 长文'.repeat(60), 40).length).toBeLessThanOrEqual(40);
  });
});

describe('三档落库（week / month / milestone）', () => {
  it('键：ISO 周 / YYYY-MM', () => {
    const ms = Date.UTC(2026, 10, 11, 12, 0, 0);
    expect(weekKeyOf(ms)).toMatch(/^2026-W\d{2}$/u);
    expect(monthKeyOf(ms)).toBe('2026-11');
  });

  it('buildDigests 写三档；里程碑第二次不增；空摘要不覆盖', () => {
    const spirit = freshSpirit();
    const nowIso = new Date().toISOString();
    const file = freshL1([
      { id: 't1', type: 'work_task', content: '完成 spirit 收口，交付一版', stamp: nowIso },
      { id: 't2', type: 'work_task', content: '9语逐仓核对进行中', stamp: nowIso },
      { id: 'f1', type: 'work_fact', content: 'bake 快照 +6.58%', stamp: nowIso },
    ]);
    const summarize = (opts: { days: number; perBucket: number }) => summarizeProcedural({ ...opts, dbPath: file });
    const first = buildDigests(spirit, summarize, { now: Date.UTC(2026, 10, 11, 12), dbPath: file });
    expect(first.week?.tier).toBe('week');
    expect(first.month?.tier).toBe('month');
    expect(first.milestones).toBe(1);
    expect(first.knowledgeCount).toBe(1);

    const rows = readDigests(spirit, { milestoneLimit: 5 });
    expect(rows.map((row) => row.tier).sort()).toEqual(['milestone', 'month', 'week']);

    // 再跑：里程碑不重复（INSERT OR IGNORE）
    const second = buildDigests(spirit, summarize, { now: Date.UTC(2026, 10, 11, 18), dbPath: file });
    expect(second.milestones).toBe(0);
    expect(readDigests(spirit, { milestoneLimit: 5 }).filter((row) => row.tier === 'milestone').length).toBe(1);

    // 实体串联（v0.8.18）：档文本里出现实体名 ⇒ entities_json 带上 entity id
    spirit.prepare(`INSERT INTO entity (id, kind, name, aliases_json, importance, first_seen_ms, last_seen_ms) VALUES ('ent-x', 'project', 'spirit', '[]', 2, ?, ?)`).run(Date.now(), Date.now());
    spirit.prepare(`INSERT OR IGNORE INTO entity_alias (alias_norm, entity_id, source) VALUES ('spirit', 'ent-x', 'spirit')`).run();
    buildDigests(spirit, summarize, { now: Date.UTC(2026, 10, 11, 20), dbPath: file });
    expect(readDigests(spirit, { tiers: ['week'] })[0]?.entities).toContain('ent-x');

    // 空摘要不覆盖旧档
    expect(writeDigest(spirit, { tier: 'week', periodKey: weekKeyOf(Date.now()), windowDays: 7, summary: { count: 0, lines: [], knowledgeCount: 0, days: 7, available: true } })).toBeUndefined();
    expect(readDigests(spirit, { tiers: ['week'] })[0]?.summary).toContain('9语');
  });

  it('防失忆：删掉 week 后 month/milestone 仍可读', () => {
    const spirit = freshSpirit();
    const nowIso = new Date().toISOString();
    const file = freshL1([{ id: 't1', type: 'work_task', content: '完成某件事，交付', stamp: nowIso }]);
    buildDigests(spirit, (opts) => summarizeProcedural({ ...opts, dbPath: file }), { now: Date.now(), dbPath: file });
    spirit.prepare(`DELETE FROM distill_digest WHERE tier = 'week'`).run();
    const rows = readDigests(spirit, { milestoneLimit: 5 });
    expect(rows.some((row) => row.tier === 'month')).toBe(true);
    expect(rows.some((row) => row.tier === 'milestone')).toBe(true);
  });
});
