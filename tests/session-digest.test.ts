/**
 * 会话级生涯流程档（v0.8.25）：以会话为单位组织 + 会话内/跨会话去重。
 *
 * 关键口径：
 * - 只收流程性（work_task/episodic），知识性归上游；
 * - 会话内同签名只留一行；跨会话同签名并入首个会话并标 ×N；
 * - 重建幂等（先清 tier='session' 再写）；week/month 以会话档为输入。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { buildDigests, readDigests } from '../src/prime/distill-digest.js';
import { summarizeProcedural } from '../src/prime/distill-summary.js';
import {
  buildSessionDigests,
  normalizeFlowText,
  readSessionDigests,
  summarizeSessionDigests,
} from '../src/prime/session-digest.js';

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

interface Row {
  id: string;
  type: string;
  content: string;
  stamp: string;
  session: string;
  /** 上游 metadata_json（真会话在 dsh_source_anchors 里）。 */
  meta?: string;
}

function freshL1(rows: Row[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-l1-session-'));
  dirs.push(dir);
  const file = join(dir, 'memory.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE l1_records (
    record_id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT DEFAULT '', family TEXT NOT NULL DEFAULT 'work',
    timestamp_start TEXT DEFAULT '', created_time TEXT DEFAULT '', scope TEXT NOT NULL DEFAULT 'global',
    workspace_id TEXT NOT NULL DEFAULT '', repo_key_name TEXT NOT NULL DEFAULT '', repo_key_owner TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT ''
  )`);
  const insert = db.prepare(
    `INSERT INTO l1_records (record_id, content, type, family, timestamp_start, created_time, session_id, metadata_json) VALUES (?, ?, ?, 'work', ?, ?, ?, ?)`,
  );
  for (const row of rows) insert.run(row.id, row.content, row.type, row.stamp, row.stamp, row.session, row.meta ?? '');
  db.close();
  return file;
}

function freshSpirit(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-session-digest-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  dbs.push(opened.db);
  return opened.db;
}

const NOW = new Date('2026-11-11T12:00:00+08:00');

describe('会话级流程档', () => {
  it('会话内重复只留一行，跨会话同文并入首个会话并标 ×N', () => {
    const file = freshL1([
      { id: 'a1', type: 'work_task', content: '补齐 dsh-tidy-display 的 ja/ko 语言文件', stamp: '2026-11-11T04:40:00.000Z', session: 's-a' },
      { id: 'a2', type: 'work_task', content: '补齐 dsh-tidy-display 的 ja/ko 语言文件。', stamp: '2026-11-11T04:41:00.000Z', session: 's-a' },
      { id: 'a3', type: 'work_task', content: '修正 ru.json 乱码，写干净俄文', stamp: '2026-11-11T04:42:00.000Z', session: 's-a' },
      { id: 'b1', type: 'work_task', content: '补齐 dsh-tidy-display 的 ja/ko 语言文件', stamp: '2026-11-10T04:40:00.000Z', session: 's-b' },
      { id: 'b2', type: 'work_task', content: '复扫 22 仓 locale 覆盖', stamp: '2026-11-10T04:45:00.000Z', session: 's-b' },
      { id: 'k1', type: 'work_fact', content: '知识性结论不该进流程档', stamp: '2026-11-11T04:50:00.000Z', session: 's-a' },
    ]);
    const spirit = freshSpirit();
    const stats = buildSessionDigests(spirit, { days: 0, limit: 2000, dbPath: file, now: NOW.getTime() });

    expect(stats.available).toBe(true);
    expect(stats.records).toBe(5); // 知识性被剔除
    expect(stats.sessions).toBe(2);
    expect(stats.unique).toBe(3); // 会话内 1 组重复 + 跨会话 1 次重复
    expect(stats.merged).toBe(2);

    const rows = readSessionDigests(spirit, 10);
    const a = rows.find((row) => row.periodKey === 's-a');
    const b = rows.find((row) => row.periodKey === 's-b');
    expect(a?.summary).toContain('×3'); // 会话内 a1/a2 + 跨会话 b1 共 3 次
    expect(b?.summary).not.toContain('ja/ko'); // 跨会话重复并入 s-a
    expect(b?.summary).toContain('复扫 22 仓');
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(1);
  });

  it('重复重建幂等（先清会话档再写）', () => {
    const file = freshL1([
      { id: 'r1', type: 'work_task', content: '任务甲', stamp: '2026-11-11T01:00:00.000Z', session: 's-1' },
      { id: 'r2', type: 'work_task', content: '任务乙', stamp: '2026-11-11T02:00:00.000Z', session: 's-2' },
    ]);
    const spirit = freshSpirit();
    const first = buildSessionDigests(spirit, { days: 0, dbPath: file, now: NOW.getTime() });
    const second = buildSessionDigests(spirit, { days: 0, dbPath: file, now: NOW.getTime() + 1000 });
    expect(first.sessions).toBe(2);
    expect(second.sessions).toBe(2);
    expect(readSessionDigests(spirit, 50).length).toBe(2);
  });

  it('week/month 以会话档为输入：聚合结果不重复', () => {
    const file = freshL1([
      { id: 'w1', type: 'work_task', content: '同一件事在会话 A 记一次', stamp: '2026-11-11T03:00:00.000Z', session: 's-a' },
      { id: 'w2', type: 'work_task', content: '同一件事在会话 B 再记一次', stamp: '2026-11-10T03:00:00.000Z', session: 's-b' },
    ]);
    const spirit = freshSpirit();
    buildSessionDigests(spirit, { days: 0, dbPath: file, now: NOW.getTime() });
    const sessionSummary = summarizeSessionDigests(spirit, { days: 7, perBucket: 8, now: NOW.getTime() });
    expect(sessionSummary.lines.length).toBe(2); // 文案不同 ⇒ 不算重复
    const build = buildDigests(spirit, (opts) => summarizeProcedural({ ...opts, dbPath: file }), {
      now: NOW.getTime(),
      dbPath: file,
      summarizeSessions: (opts) => summarizeSessionDigests(spirit, { ...opts, now: NOW.getTime() }),
    });
    expect(build.week?.summary.split('\n').length).toBe(2);
    expect(build.week?.summary).toContain('会话');
    expect(readDigests(spirit, { tiers: ['session'], sessionLimit: 10 }).length).toBe(2);
  });

  it('归一化签名能抹掉时间戳/标点差异', () => {
    expect(normalizeFlowText('截至 2026-11-11T04:36:35Z，完成 A 任务。')).toBe(normalizeFlowText('完成A任务'));
  });

  it('同一任务的两种措辞（去套话后高相似）会合并并标 ×2', () => {
    const file = freshL1([
      {
        id: 'n1', type: 'work_task', session: 's-n', stamp: '2026-11-11T02:00:00.000Z',
        content: '任务：将 plugin-9lang-five-dim 的九语描述优化改写为收尾状态。当前状态：已完成。处置口径：从进行中线程改为已收尾。',
      },
      {
        id: 'n2', type: 'work_task', session: 's-n', stamp: '2026-11-11T02:05:00.000Z',
        content: '任务：将 plugin-9lang-five-dim 的九语描述优化改写为收尾状态。当前状态：已完成并彻底关闭。处置口径：从进行中线程改为已收尾。',
      },
    ]);
    const spirit = freshSpirit();
    const stats = buildSessionDigests(spirit, { days: 0, dbPath: file, now: NOW.getTime() });
    expect(stats.unique).toBe(1);
    expect(stats.merged).toBe(1);
    expect(readSessionDigests(spirit, 5)[0]?.summary).toContain('×2');
  });

  it('session_id 列恒为 default 时，从 dsh_source_anchors 取真会话', () => {
    const file = freshL1([
      {
        id: 'm1', type: 'work_task', content: '锚点会话里的任务', stamp: '2026-11-11T02:00:00.000Z', session: 'default',
        meta: JSON.stringify({ dsh_source_anchors: [{ sessionId: 'session-real-1', turn: 3, step: 1 }] }),
      },
      {
        id: 'm2', type: 'work_task', content: '另一个锚点会话', stamp: '2026-11-11T02:10:00.000Z', session: 'default',
        meta: JSON.stringify({ dsh_source_anchors: [{ sessionId: 'session-real-2', turn: 1, step: 1 }] }),
      },
    ]);
    const spirit = freshSpirit();
    const stats = buildSessionDigests(spirit, { days: 0, dbPath: file, now: NOW.getTime() });
    expect(stats.sessions).toBe(2);
    const keys = readSessionDigests(spirit, 10).map((row) => row.periodKey).sort();
    expect(keys).toEqual(['session-real-1', 'session-real-2']);
  });

  it('只有知识性记录时不留会话档', () => {
    const file = freshL1([
      { id: 'k1', type: 'work_fact', content: '只是一条事实', stamp: '2026-11-11T05:00:00.000Z', session: 's-k' },
    ]);
    const spirit = freshSpirit();
    const stats = buildSessionDigests(spirit, { days: 0, dbPath: file, now: NOW.getTime() });
    expect(stats.sessions).toBe(0);
    expect(readSessionDigests(spirit, 10)).toEqual([]);
  });
});
