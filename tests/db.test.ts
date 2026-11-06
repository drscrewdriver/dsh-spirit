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
import { ExperienceStore } from '../src/store/experience.js';

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
  it('建出 experience / experience_cues / mood_state / meta 与六个索引，并写入版本号', () => {
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('应打开成功');
    const names = tablesOf(opened.db);
    for (const expected of ['experience', 'experience_cues', 'mood_state', 'meta']) {
      expect(names, expected).toContain(expected);
    }
    expect(readStoredVersion(opened.db)).toBe(SPIRIT_DB_SCHEMA_VERSION);
    // v5：翻阅 tab 补了 exp_ts（全库分页）与 exp_trigger_ts（类型筛选）
    expect(names.filter((n) => n.startsWith('exp_'))).toHaveLength(6);
    // 藏起列在新库直接带出（旧库靠 4→5 链步补齐，见下方迁移例）
    const cols = (opened.db.prepare(`PRAGMA table_info(experience)`).all() as Array<{ name: string }>).map((r) => r.name);
    expect(cols).toContain('hidden_at');
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

  // ── v3：人设两表（schema 形状即约束 + 正向迁移链） ──

  it('v3 新库建出 persona_current / persona_revision', () => {
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('应打开成功');
    const names = tablesOf(opened.db);
    expect(names).toContain('persona_current');
    expect(names).toContain('persona_revision');
    opened.db.close();
  });

  it('persona_current 的 CHECK 钉死单行：误插第二行直接 SQL 报错', () => {
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('应打开成功');
    opened.db.prepare(`INSERT INTO persona_current (singleton, revision, card_json, updated_at) VALUES (1, 1, '{}', 1000)`).run();
    // 第二行：singleton 只能给 1，而 1 已被占 ⇒ 主键冲突/CHECK 双保险，必须 throw
    expect(() => opened.db.prepare(`INSERT INTO persona_current (singleton, revision, card_json, updated_at) VALUES (1, 2, '{}', 2000)`).run()).toThrow();
    expect(() => opened.db.prepare(`INSERT INTO persona_current (singleton, revision, card_json, updated_at) VALUES (2, 2, '{}', 2000)`).run()).toThrow();
    opened.db.close();
  });

  it('v2 旧库重开 ⇒ 正向迁移成功：人设两表建出、meta 回写当前版、既有数据不丢', () => {
    const made = openSpiritDb(dir);
    if (!made.ok) throw new Error('应打开成功');
    made.db.prepare(`INSERT INTO experience (id, session_id, workspace_id, turn_seq, ts_ms, trigger, notice, reaction, text, fact_json, lane, persona_revision, updated_at, salience) VALUES ('e1','s1','w1',1,1000,'neutral','task_progress','none','旧行','{}','live',1,1000,0)`).run();
    // 手工把库退回 v2 形状：删两张 v3 新表 + 版本号改 2（模拟老宿主的重开现场）
    made.db.exec('DROP TABLE persona_current');
    made.db.exec('DROP TABLE persona_revision');
    made.db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run('2', META_KEY_SCHEMA_VERSION);
    made.db.close();

    const again = openSpiritDb(dir);
    if (!again.ok) throw new Error('v2 库应能正向迁移打开');
    const names = tablesOf(again.db);
    expect(names).toContain('persona_current');
    expect(names).toContain('persona_revision');
    expect(readStoredVersion(again.db)).toBe(SPIRIT_DB_SCHEMA_VERSION);
    expect((again.db.prepare(`SELECT COUNT(*) AS n FROM experience`).get() as { n: number }).n).toBe(1);
    again.db.close();
  });

  it('planMigration：v2→v6 登记在链上（缺登记就是链断、老库拒读）；当前版自身零步', () => {
    const up = planMigration(2);
    expect(up.ok).toBe(true);
    if (up.ok) expect(up.steps.map((s) => `${s.from}→${s.to}`)).toEqual(['2→3', '3→4', '4→5', '5→6']);
    const same = planMigration(SPIRIT_DB_SCHEMA_VERSION);
    expect(same.ok).toBe(true);
    if (same.ok) expect(same.steps).toHaveLength(0);
  });

  // ── v4：主人背景档案表 ──

  it('v4 新库建出 owner_profile；误插第二行被 CHECK/主键拒', () => {
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('应打开成功');
    expect(tablesOf(opened.db)).toContain('owner_profile');
    opened.db.prepare(`INSERT INTO owner_profile (singleton, sync_text, self_text, sync_meta, revision, updated_at) VALUES (1, '', '', '', 1, 1000)`).run();
    expect(() => opened.db.prepare(`INSERT INTO owner_profile (singleton, sync_text, self_text, sync_meta, revision, updated_at) VALUES (1, 'a', '', '', 1, 1)`).run()).toThrow();
    expect(() => opened.db.prepare(`INSERT INTO owner_profile (singleton, sync_text, self_text, sync_meta, revision, updated_at) VALUES (2, 'b', '', '', 1, 1)`).run()).toThrow();
    opened.db.close();
  });

  it('v3 旧库重开 ⇒ 正向迁移到 v4：owner_profile 建出、meta 回写 4、人设数据不丢', () => {
    const made = openSpiritDb(dir);
    if (!made.ok) throw new Error('应打开成功');
    made.db.prepare(`INSERT INTO persona_current (singleton, revision, card_json, updated_at) VALUES (1, 3, '{"revision":3}', 1000)`).run();
    // 手工退回 v3 形状：删 v4 新表 + 版本号改 3
    made.db.exec('DROP TABLE owner_profile');
    made.db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run('3', META_KEY_SCHEMA_VERSION);
    made.db.close();

    const again = openSpiritDb(dir);
    if (!again.ok) throw new Error('v3 库应能正向迁移打开');
    expect(tablesOf(again.db)).toContain('owner_profile');
    expect(readStoredVersion(again.db)).toBe(SPIRIT_DB_SCHEMA_VERSION);
    expect((again.db.prepare(`SELECT revision FROM persona_current WHERE singleton = 1`).get() as { revision: number }).revision).toBe(3);
    again.db.close();
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

  // ── v5：藏起列（翻阅 tab 管理动作的标记位，行永不物理删） ──

  it('v4 旧库重开 ⇒ 正向迁移到 v5：hidden_at 补齐、既有行原样读回、重复开不炸', () => {
    const made = openSpiritDb(dir);
    if (!made.ok) throw new Error('应打开成功');
    made.db
      .prepare(
        `INSERT INTO experience (id, session_id, workspace_id, turn_seq, ts_ms, trigger, notice, reaction, text, fact_json, lane, persona_revision, updated_at, salience)
         VALUES ('e5','s1','w1',1,1000,'neutral','task_progress','none','藏前写的旧行','{}','live',1,1000,0)`,
      )
      .run();
    // 手工退回 v4 形状：DROP 掉 hidden_at + 版本号改 4（只造 fixture，不碰生产路径）
    made.db.exec('ALTER TABLE experience DROP COLUMN hidden_at');
    made.db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run('4', META_KEY_SCHEMA_VERSION);
    made.db.close();

    const again = openSpiritDb(dir);
    if (!again.ok) throw new Error(`v4 库应能正向迁移打开：${String(again.err)}`);
    expect(readStoredVersion(again.db)).toBe(SPIRIT_DB_SCHEMA_VERSION);
    const row = again.db.prepare(`SELECT text, hidden_at FROM experience WHERE id = 'e5'`).get() as { text: string; hidden_at: number | null };
    expect(row.text).toBe('藏前写的旧行');
    expect(row.hidden_at).toBeNull(); // 老行默认全部「在场」，不被新列误伤
    again.db.close();
    // 再开一次：列已存在 ⇒ 迁移整步跳过，不炸
    const third = openSpiritDb(dir);
    expect(third.ok).toBe(true);
    if (third.ok) third.db.close();
  });

  // ── v6：长觉阶梯五张派生表 ──

  it('v5 老库重开 ⇒ 正向迁移到 v6：五表建出、既有条目原样在场（G21 假空反证）、重复开不炸', () => {
    const made = openSpiritDb(dir);
    if (!made.ok) throw new Error('应打开成功');
    made.db
      .prepare(
        `INSERT INTO experience (id, session_id, workspace_id, turn_seq, ts_ms, trigger, notice, reaction, text, fact_json, lane, persona_revision, updated_at, salience)
         VALUES ('v6e','s1','w1',1,1000,'neutral','task_progress','none','长觉前的旧行','{}','live',1,1000,0)`,
      )
      .run();
    // 手工退回 v5：DROP 五表 + 版本号改 5（只造 fixture）
    for (const t of ['topic', 'experience_topic', 'insight', 'causal_edge', 'sleep_run']) made.db.exec(`DROP TABLE ${t}`);
    made.db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run('5', META_KEY_SCHEMA_VERSION);
    made.db.close();

    const again = openSpiritDb(dir);
    if (!again.ok) throw new Error(`v5 库应能正向迁移打开：${String(again.err)}`);
    expect(readStoredVersion(again.db)).toBe(SPIRIT_DB_SCHEMA_VERSION);
    const names = tablesOf(again.db);
    for (const t of ['topic', 'experience_topic', 'insight', 'causal_edge', 'sleep_run']) expect(names, t).toContain(t);
    // 假空反证：老库升上来后原行仍在 recent() 可见面（REQUIRED_COLUMNS 静默 filter 的教训）
    const store = new ExperienceStore({ db: again.db, logger: { warn: () => {}, info: () => {} } });
    expect(store.recent('s1', 5).map((e) => e.id)).toEqual(['v6e']);
    again.db.close();
    const third = openSpiritDb(dir);
    expect(third.ok).toBe(true);
    if (third.ok) third.db.close();
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

  it('v1 ⇒ 有正向链（1→2→3→4→5→6，带人话 note）', () => {
    const plan = planMigration(1);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.steps.map((s) => `${s.from}→${s.to}`)).toEqual(['1→2', '2→3', '3→4', '4→5', '5→6']);
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
