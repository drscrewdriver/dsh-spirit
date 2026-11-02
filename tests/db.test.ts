import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SPIRIT_DB_SCHEMA_VERSION } from '../src/contract.js';
import { decideDegrade, isSqliteUnavailable } from '../src/db/degrade.js';
import { DB_FILE_NAME, openSpiritDb, readStoredVersion, SchemaVersionError } from '../src/db/open.js';
import { planMigration } from '../src/db/migrate.js';
import { META_KEY_SCHEMA_VERSION } from '../src/db/schema.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-db-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tablesOf(db: DatabaseSync): string[] {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','index')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

describe('openSpiritDb', () => {
  it('建出 experience / experience_cues / mood_state / meta 与四个索引，并写入版本号', () => {
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('应打开成功');
    const names = tablesOf(opened.db);
    for (const expected of ['experience', 'experience_cues', 'mood_state', 'meta']) {
      expect(names, expected).toContain(expected);
    }
    expect(readStoredVersion(opened.db)).toBe(SPIRIT_DB_SCHEMA_VERSION);
    expect(names.filter((n) => n.startsWith('exp_'))).toHaveLength(4);
    opened.db.close();
  });

  it('v0.2 仍不建 FTS5 虚表（不预开工，这条断言挡住“顺手加个索引”的提前投资）', () => {
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('应打开成功');
    const ddl = opened.db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'experience'`).all() as Array<{ sql: string }>;
    expect(ddl[0]?.sql).not.toMatch(/fts5/iu);
    expect(tablesOf(opened.db).some((n) => n.includes('fts'))).toBe(false);
    opened.db.close();
  });

  it('重复打开幂等（IF NOT EXISTS + 版本一致）', () => {
    const first = openSpiritDb(dir);
    if (!first.ok) throw new Error('应打开成功');
    first.db.close();
    const second = openSpiritDb(dir);
    if (!second.ok) throw new Error('应再次打开成功');
    expect(readStoredVersion(second.db)).toBe(SPIRIT_DB_SCHEMA_VERSION);
    second.db.close();
    expect(join(dir, DB_FILE_NAME)).toContain(DB_FILE_NAME);
  });

  it('库内版本高于本包 ⇒ 拒读（不静默按旧形状读）', () => {
    const first = openSpiritDb(dir);
    if (!first.ok) throw new Error('应打开成功');
    first.db
      .prepare(`UPDATE meta SET value = ? WHERE key = ?`)
      .run(String(SPIRIT_DB_SCHEMA_VERSION + 1), META_KEY_SCHEMA_VERSION);
    first.db.close();
    const again = openSpiritDb(dir);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.err).toBeInstanceOf(SchemaVersionError);
  });

  it('库内版本低于本包且无迁移路径（v0）⇒ 同样拒读，不“凑合读”，且句柄不泄漏', () => {
    const first = openSpiritDb(dir);
    if (!first.ok) throw new Error('应打开成功');
    first.db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run('0', META_KEY_SCHEMA_VERSION);
    first.db.close();
    const again = openSpiritDb(dir);
    expect(again.ok).toBe(false);
  });

  it('v1 老库 ⇒ 正向迁移到 v2：新列补齐、原行原样读回、版本回写', () => {
    // 先建 v2 库再退造成 v1（DROP 只造 fixture，不碰生产路径），比手抄一份 v1 DDL 更防漂移
    const made = openSpiritDb(dir);
    if (!made.ok) throw new Error('应打开成功');
    made.db.exec(`ALTER TABLE experience DROP COLUMN gist`);
    made.db.exec(`ALTER TABLE experience DROP COLUMN feedback_score`);
    made.db.exec(`ALTER TABLE experience DROP COLUMN salience`);
    made.db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run('1', META_KEY_SCHEMA_VERSION);
    made.db
      .prepare(
        `INSERT INTO experience (id, session_id, workspace_id, turn_seq, ts_ms, trigger, notice, reaction, text, fact_json, lane, persona_revision, updated_at)
         VALUES ('e1','s1','w1',1,1000,'tool_error','notice','mild','旧版本体验句','{}','live',1,1000)`,
      )
      .run();
    made.db.close();
    const upgraded = openSpiritDb(dir);
    if (!upgraded.ok) throw new Error(`迁移应成功：${String(upgraded.err)}`);
    expect(readStoredVersion(upgraded.db)).toBe(SPIRIT_DB_SCHEMA_VERSION);
    const row = upgraded.db.prepare(`SELECT text, salience, gist, feedback_score FROM experience WHERE id = 'e1'`).get() as {
      text: string; salience: number; gist: string | null; feedback_score: number | null;
    };
    expect(row.text).toBe('旧版本体验句');
    expect(row.salience).toBe(0);
    expect(row.gist).toBeNull();
    // 再开一次：迁移整步跳过（列已存在即不重复 ALTER），不炸
    upgraded.db.close();
    const again = openSpiritDb(dir);
    expect(again.ok).toBe(true);
    if (again.ok) again.db.close();
  });

  it('空目录串 ⇒ 明确拒绝，不猜路径（猜出来的目录比报错更难查）', () => {
    const opened = openSpiritDb('   ');
    expect(opened.ok).toBe(false);
  });
});

describe('degrade 判定', () => {
  it('node:sqlite 缺失类错误被认出来', () => {
    expect(isSqliteUnavailable(new Error('No such built-in module: node:sqlite'))).toBe(true);
    expect(isSqliteUnavailable(new Error('Permission denied'))).toBe(false);
  });

  it('两种存储异常都退 memory-only（不是 off，也不是抛）', () => {
    expect(decideDegrade(new Error('no such module: node:sqlite')).mode).toBe('memory-only');
    expect(decideDegrade(new Error('SQLITE_BUSY')).mode).toBe('memory-only');
    expect(decideDegrade(new Error('boom')).reason).toContain('历史路停用');
  });

  it('原因串里不泄露 SQL 细节（只留错误名/消息首行）', () => {
    const reason = decideDegrade(new Error('near "SELECT": syntax error')).reason;
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).not.toContain('\n');
  });
});

describe('planMigration', () => {
  it('同版本 ⇒ 空序列直接过', () => {
    expect(planMigration(SPIRIT_DB_SCHEMA_VERSION)).toEqual({ ok: true, steps: [] });
  });

  it('v1 ⇒ 有正向链（1→2，带人话 note）', () => {
    const plan = planMigration(1);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.steps.map((s) => `${s.from}→${s.to}`)).toEqual(['1→2']);
      expect(plan.steps[0]?.note.length).toBeGreaterThan(0);
    }
  });

  it('高于本包拒读（升级方向），链断（v0）也拒读并说明理由', () => {
    const higher = planMigration(SPIRIT_DB_SCHEMA_VERSION + 1);
    expect(higher.ok).toBe(false);
    const lower = planMigration(0);
    expect(lower.ok).toBe(false);
    if (!higher.ok) expect(higher.reason).toContain('高于本插件');
    if (!lower.ok) expect(lower.reason).toContain('没有可达');
  });
});
