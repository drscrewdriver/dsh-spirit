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

  it('v0.1 不建 FTS5 虚表（不预开工，这条断言挡住"顺手加个索引"的提前投资）', () => {
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

  it('库内版本低于本包且无迁移路径 ⇒ 同样拒读，不"凑合读"', () => {
    const first = openSpiritDb(dir);
    if (!first.ok) throw new Error('应打开成功');
    first.db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run('0', META_KEY_SCHEMA_VERSION);
    first.db.close();
    const again = openSpiritDb(dir);
    expect(again.ok).toBe(false);
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

  it('v0.1 无迁移表 ⇒ 其它版本一律拒读，并说明是降级还是无路径', () => {
    const higher = planMigration(SPIRIT_DB_SCHEMA_VERSION + 1);
    expect(higher.ok).toBe(false);
    const lower = planMigration(0);
    expect(lower.ok).toBe(false);
    if (!higher.ok) expect(higher.reason).toContain('高于本插件');
    if (!lower.ok) expect(lower.reason).toContain('没有可达');
  });
});
