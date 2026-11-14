/**
 * 实体多名称关联搜索（v19）：别名三级解析 + 关联展开 + 去重。
 *
 * 不依赖 FTS（第③级自然返回空）：①②级走 `entity_alias`，是本模块的主要价值面。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { searchAll } from '../src/search/all.js';
import { linkedEntityRecords, resolveEntityIds } from '../src/search/entity-alias-search.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-ent-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openDb(): DatabaseSync {
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应可打开');
  return opened.db;
}

function seed(db: DatabaseSync): void {
  db.prepare(`INSERT INTO entity (id, kind, name, aliases_json, importance, first_seen_ms, last_seen_ms)
    VALUES ('ent-project:linkperry', 'project', 'linkperry', '["kpe","dsh-kpe"]', 5, 1, 9)`).run();
  db.prepare(`INSERT INTO entity (id, kind, name, aliases_json, importance, first_seen_ms, last_seen_ms)
    VALUES ('ent-org:腾讯', 'org', '腾讯', '["鹅厂"]', 3, 1, 9)`).run();
  // 归一化别名（等价于 upsertEntity 增量写 + 回填的产物）
  const alias = db.prepare(`INSERT OR IGNORE INTO entity_alias (alias_norm, entity_id, source) VALUES (?, ?, 'spirit')`);
  for (const [norm, id] of [
    ['linkperry', 'ent-project:linkperry'],
    ['kpe', 'ent-project:linkperry'],
    ['dsh-kpe', 'ent-project:linkperry'],
    ['腾讯', 'ent-org:腾讯'],
    ['鹅厂', 'ent-org:腾讯'],
  ] as const) alias.run(norm, id);
}

describe('resolveEntityIds（多名称）', () => {
  it('精确（大小写/空白不敏感）', () => {
    const db = openDb();
    seed(db);
    expect(resolveEntityIds(db, ' KPE ')).toEqual(['ent-project:linkperry']);
    db.close();
  });

  it('查询是别名的一部分（kpe → linkperry）', () => {
    const db = openDb();
    seed(db);
    expect(resolveEntityIds(db, 'kpe')).toContain('ent-project:linkperry');
    db.close();
  });

  it('别名是查询的一部分（腾讯云 → 腾讯）', () => {
    const db = openDb();
    seed(db);
    expect(resolveEntityIds(db, '腾讯云')).toContain('ent-org:腾讯');
    db.close();
  });

  it('单字别名不参与反向包含（防吸走一切）', () => {
    const db = openDb();
    db.prepare(`INSERT INTO entity (id, kind, name, aliases_json, importance, first_seen_ms, last_seen_ms)
      VALUES ('ent-x', 'project', 'x', '[]', 1, 1, 1)`).run();
    db.prepare(`INSERT OR IGNORE INTO entity_alias (alias_norm, entity_id, source) VALUES ('腾', 'ent-x', 'spirit')`).run();
    expect(resolveEntityIds(db, '腾讯云')).not.toContain('ent-x');
    db.close();
  });

  it('无关词 ⇒ 空（不瞎认）', () => {
    const db = openDb();
    seed(db);
    expect(resolveEntityIds(db, '今天天气不错')).toEqual([]);
    db.close();
  });
});

describe('关联展开', () => {
  it('实体 → 交付/任务线，命中行带 via', () => {
    const db = openDb();
    seed(db);
    db.prepare(`INSERT INTO txn_entry (id, session_id, workspace_id, ts_ms, turn_seq, card_line, summary, gist_key, semantic_json, source_trust, topic_id, created_at, salience_tier)
      VALUES ('t1', 's1', 'w1', 500, 1, '给 linkperry 加了别名检索', NULL, NULL, NULL, 'structure_signal', NULL, 500, 2)`).run();
    db.prepare(`INSERT INTO delivery_entity (delivery_id, entity_id, role, ts_ms) VALUES ('t1', 'ent-project:linkperry', 'object', 500)`).run();
    db.prepare(`INSERT INTO task (id, title, status, next_step, workspace_id, created_at, updated_at)
      VALUES ('k1', '给 linkperry 补搜索', 'open', NULL, 'w1', 1, 500)`).run();
    db.prepare(`INSERT INTO task_delivery (task_id, delivery_id, origin, superseded_at, created_at)
      VALUES ('k1', 't1', 'heuristic', NULL, 500)`).run();
    db.prepare(`INSERT INTO entity_record_ref (entity_id, upstream_record_id, l1_type, ts_ms)
      VALUES ('ent-project:linkperry', 'rec-1', 'work_fact', 1)`).run();

    const ids = resolveEntityIds(db, 'kpe');
    const linked = linkedEntityRecords(db, ids);
    expect(linked.hits.map((hit) => `${hit.kind}:${hit.id}:${hit.via ?? ''}`)).toEqual(
      expect.arrayContaining(['delivery:t1:ent-project:linkperry', 'task:k1:ent-project:linkperry']),
    );
    // 上游知识只计数，不出现在 hits 里
    expect(linked.upstreamKnowledge).toBe(1);
    expect(linked.hits.some((hit) => hit.id.includes('rec-1'))).toBe(false);
    db.close();
  });

  it('searchAll 去重：同一交付经实体命中与直接命中只出现一次', () => {
    const db = openDb();
    seed(db);
    db.prepare(`INSERT INTO txn_entry (id, session_id, workspace_id, ts_ms, turn_seq, card_line, summary, gist_key, semantic_json, source_trust, topic_id, created_at, salience_tier)
      VALUES ('t1', 's1', 'w1', 500, 1, '给 linkperry 加了别名检索', NULL, NULL, NULL, 'structure_signal', NULL, 500, 2)`).run();
    db.prepare(`INSERT INTO delivery_entity (delivery_id, entity_id, role, ts_ms) VALUES ('t1', 'ent-project:linkperry', 'object', 500)`).run();

    const hits = searchAll(db, 'linkperry', 24);
    const deliveryHits = hits.filter((hit) => hit.kind === 'delivery' && hit.id === 't1');
    expect(deliveryHits).toHaveLength(1);
    db.close();
  });
});