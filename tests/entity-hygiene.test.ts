/**
 * 实体卫生（B-3 / schema v20）：归一化 NFKC、别名重建闸、疑似同一实体候选、
 * 人工别名落点、里程碑 stale 三分支。
 *
 * 纪律：**只提示不合并**——`entity` 行与 id 集合在任何路径下都不变。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SPIRIT_DB_SCHEMA_VERSION } from '../src/contract.js';
import { openSpiritDb, readStoredVersion } from '../src/db/open.js';
import { META_KEY_ALIAS_STAMP } from '../src/db/schema.js';
import { ENTITY_NORMALIZE_STAMP, ensureEntityAliases, normalizeEntityName } from '../src/prime/entity-align.js';
import { markDigestStale } from '../src/prime/distill-digest.js';
import { OntologyStore } from '../src/store/ontology.js';

const logger = { info: (_message: string) => undefined, warn: (_message: string) => undefined };
/** 打开过的库：Windows 下不 close 就删不掉（unlink EBUSY）。 */
const openedDbs: DatabaseSync[] = [];
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-hygiene-'));
});
afterEach(() => {
  for (const db of openedDbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function openDb(): DatabaseSync {
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应可打开');
  openedDbs.push(opened.db);
  return opened.db;
}

function seedEntity(db: DatabaseSync, id: string, name: string, aliases: string[] = []): void {
  db.prepare(`INSERT INTO entity (id, kind, name, aliases_json, importance, first_seen_ms, last_seen_ms)
    VALUES (?, 'project', ?, ?, 1, 1, 1)`).run(id, name, JSON.stringify(aliases));
}

describe('归一化（NFKC）', () => {
  it('全角 / 空格 / 标点归一一致', () => {
    expect(normalizeEntityName('ＤＳＨ')).toBe('dsh');
    expect(normalizeEntityName(' D S H ')).toBe('dsh');
    expect(normalizeEntityName('dsh-spirit')).toBe('dshspirit');
  });

  it('去零宽字符', () => {
    expect(normalizeEntityName('ds\u200bh')).toBe('dsh');
  });

  it('不做繁简折叠（交给人工候选）', () => {
    expect(normalizeEntityName('發')).not.toBe(normalizeEntityName('发'));
  });
});

describe('别名重建闸（alias_stamp）', () => {
  it('戳变 ⇒ 重建 spirit 键；user 键保留；二次调用幂等', () => {
    const db = openDb();
    seedEntity(db, 'ent-a', 'LinkPerry', ['kpe']);
    db.prepare(`INSERT OR IGNORE INTO entity_alias (alias_norm, entity_id, source) VALUES ('旧算法键', 'ent-a', 'spirit')`).run();
    db.prepare(`INSERT OR IGNORE INTO entity_alias (alias_norm, entity_id, source) VALUES ('人工确认', 'ent-a', 'user')`).run();
    // 模拟旧算法戳（缺键也走同一路径）
    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(META_KEY_ALIAS_STAMP, 'legacy-v1');

    const first = ensureEntityAliases(db, { warn: (m) => logger.warn(m) });
    expect(first.rebuilt).toBe(true);
    const rows = db.prepare(`SELECT alias_norm, source FROM entity_alias ORDER BY alias_norm`).all() as Array<{ alias_norm: string; source: string }>;
    expect(rows.some((row) => row.alias_norm === '旧算法键')).toBe(false);
    expect(rows.some((row) => row.alias_norm === '人工确认' && row.source === 'user')).toBe(true);
    expect(rows.some((row) => row.alias_norm === 'linkperry')).toBe(true);
    expect(rows.some((row) => row.alias_norm === 'kpe')).toBe(true);

    const second = ensureEntityAliases(db);
    expect(second.rebuilt).toBe(false);
    expect(ENTITY_NORMALIZE_STAMP).toBe('nfkc-v2');
  });
});

describe('疑似同一实体（只读候选）', () => {
  it('包含关系 / 归一化相等 / 共享上游 都出候选；无关不出', () => {
    const db = openDb();
    seedEntity(db, 'ent-spirit', 'spirit');
    seedEntity(db, 'ent-dsh-spirit', 'dsh-spirit');
    seedEntity(db, 'ent-dup', 'LinkPerry');
    seedEntity(db, 'ent-dup2', 'linkperry');
    seedEntity(db, 'ent-a', 'alpha');
    seedEntity(db, 'ent-b', 'beta');
    db.prepare(`INSERT INTO entity_upstream_link (entity_id, upstream_kind, upstream_id, confidence, created_at) VALUES ('ent-a', 'repo_key', 'shared-repo', 1, 1)`).run();
    db.prepare(`INSERT INTO entity_upstream_link (entity_id, upstream_kind, upstream_id, confidence, created_at) VALUES ('ent-b', 'repo_key', 'shared-repo', 1, 1)`).run();

    const store = new OntologyStore({ db: () => db, logger });
    const out = store.suggestEntityMerges(50);
    const pairs = out.map((s) => `${s.a}|${s.b}|${s.reason}`);
    expect(pairs).toContain('ent-spirit|ent-dsh-spirit|contains');
    expect(pairs.some((p) => p.includes('normalized-equal'))).toBe(true);
    expect(pairs).toContain('ent-a|ent-b|shared-upstream');
    // 上游知识不参与判定，也不会把无关实体连起来
    expect(out.every((s) => s.score > 0)).toBe(true);
  });

  it('确认候选只写 user 别名：entity 行数与 id 集合不变', () => {
    const db = openDb();
    seedEntity(db, 'ent-a', 'alpha');
    seedEntity(db, 'ent-b', 'beta');
    const before = db.prepare(`SELECT id FROM entity ORDER BY id`).all() as Array<{ id: string }>;
    const store = new OntologyStore({ db: () => db, logger });
    expect(store.addUserAlias('ent-a', 'ＡＬＰＨＡ')).toBe(true);
    const after = db.prepare(`SELECT id FROM entity ORDER BY id`).all() as Array<{ id: string }>;
    expect(after).toEqual(before);
    const alias = db.prepare(`SELECT alias_norm, source FROM entity_alias WHERE entity_id = 'ent-a'`).get() as { alias_norm: string; source: string };
    expect(alias).toEqual({ alias_norm: 'alpha', source: 'user' });
  });
});

describe('里程碑 stale（v20，只影响展示）', () => {
  function insertMilestone(db: DatabaseSync, periodKey: string, sourceIds: string[], summary = '里程碑正文'): void {
    db.prepare(`INSERT OR REPLACE INTO distill_digest
      (category, tier, period_key, window_days, generated_at, period_start, period_end, count, summary, source_ids_json, entities_json)
      VALUES ('procedural', 'milestone', ?, 90, 1, '', '', ?, ?, ?, '[]')`)
      .run(periodKey, sourceIds.length, summary, JSON.stringify(sourceIds));
  }

  it('三分支：引用指向已消失实体 ⇒ 标；指向活实体 ⇒ 不标；无引用行 ⇒ 不标', () => {
    const db = openDb();
    seedEntity(db, 'ent-live', 'alive');
    insertMilestone(db, 'gone', ['rec-gone']);
    insertMilestone(db, 'alive', ['rec-alive']);
    insertMilestone(db, 'unknown', ['rec-unknown']);
    // gone：引用行存在但实体已被删（simulate 退场）
    db.prepare(`INSERT INTO entity_record_ref (entity_id, upstream_record_id, l1_type, ts_ms) VALUES ('ent-deleted', 'rec-gone', 'work_fact', 1)`).run();
    // alive：引用行 + 活实体
    db.prepare(`INSERT INTO entity_record_ref (entity_id, upstream_record_id, l1_type, ts_ms) VALUES ('ent-live', 'rec-alive', 'work_fact', 1)`).run();
    // unknown：没有任何引用行

    const result = markDigestStale(db, { now: 9_000 });
    expect(result.marked).toBe(1);
    const rows = db.prepare(`SELECT period_key, stale_at, summary FROM distill_digest ORDER BY period_key`).all() as Array<{ period_key: string; stale_at: number | null; summary: string }>;
    const byKey = new Map(rows.map((row) => [row.period_key, row]));
    expect(byKey.get('gone')?.stale_at).toBe(9_000);
    expect(byKey.get('alive')?.stale_at ?? null).toBeNull();
    expect(byKey.get('unknown')?.stale_at ?? null).toBeNull();
    // 正文一字不改
    expect(byKey.get('gone')?.summary).toBe('里程碑正文');
  });
});

describe('schema v20', () => {
  it('新库版本为 20 且 distill_digest 有 stale_at 列', () => {
    const db = openDb();
    expect(readStoredVersion(db)).toBe(SPIRIT_DB_SCHEMA_VERSION);
    const cols = db.prepare(`PRAGMA table_info(distill_digest)`).all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('stale_at');
  });
});