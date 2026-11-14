/**
 * 检索索引（v19）回归：分词精度、FTS 回环、回填幂等、失败回落。
 *
 * 这些用例不依赖 `@node-rs/jieba` 是否安装：需要"词级"语义时用 `__setCutForTest` 注入假切词器，
 * 否则跑真实装配（大多数机器上是 bigram 回退），两条路都必须成立。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import {
  ensureSearchFtsTable,
  indexDoc,
  markSearchIndexUnusable,
  queryDocs,
  searchIndexStats,
  searchIndexUsable,
} from '../src/search/fts.js';
import { ensureSearchIndex } from '../src/search/index.js';
import { buildMatchQuery, tokenize, tokenizeForIndex } from '../src/search/tokens.js';
import { __setCutForTest, tokenizerStamp } from '../src/search/tokenizer.js';
import { searchExperiences } from '../src/search/experience-search.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-fts-'));
});
afterEach(() => {
  __setCutForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

function openDb(): DatabaseSync {
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应可打开');
  return opened.db;
}

function insertExperience(db: DatabaseSync, id: string, text: string, ts: number): void {
  db.prepare(
    `INSERT INTO experience (id, session_id, workspace_id, turn_seq, ts_ms, trigger, notice, reaction,
       text, fact_json, lane, source_ref, persona_revision, updated_at, gist, salience)
     VALUES (?, 's1', 'w1', 1, ?, 't', 'n', 'r', ?, '{}', 'live', NULL, 1, ?, NULL, 1)`,
  ).run(id, ts, text, ts);
}

describe('分词（词元 ∪ 二元组）', () => {
  it('词级精度：注入「车站」词元后，单字「车」不在 token 列表里', () => {
    __setCutForTest(() => ['车站']);
    const tokens = tokenize('车站的雨棚');
    expect(tokens).toContain('车站');
    expect(tokens).not.toContain('车');
  });

  it('子词召回：二元组保证「副屏」能命中', () => {
    __setCutForTest(() => ['气泡', '副屏', '问题']);
    expect(tokenizeForIndex('上次那个气泡副屏的问题修好了吗')).toContain('副屏');
  });

  it('全虚词查询仍有 MATCH 表达式（不给零结果）', () => {
    __setCutForTest(() => ['你', '在', '吗']);
    expect(buildMatchQuery('你 在 吗')).not.toBeNull();
  });

  it('空串 / 纯标点 ⇒ 不产生 MATCH', () => {
    expect(buildMatchQuery('   ')).toBeNull();
    expect(buildMatchQuery('！？。')).toBeNull();
  });
});

describe('FTS 回环', () => {
  it('建表后 index → query 命中；重建一条后旧 token 不再命中', () => {
    const db = openDb();
    expect(ensureSearchFtsTable(db)).toBe(true);
    indexDoc(db, 'experience', 'e1', 100, '上次那个气泡副屏的问题修好了吗');
    expect(queryDocs(db, '副屏', { kinds: ['experience'] }).map((h) => h.refId)).toEqual(['e1']);
    expect(queryDocs(db, '不存在的事情', { kinds: ['experience'] })).toEqual([]);
    // 内容变更 ⇒ 旧 token 失效
    indexDoc(db, 'experience', 'e1', 100, '换成别的内容了');
    expect(queryDocs(db, '副屏', { kinds: ['experience'] })).toEqual([]);
    db.close();
  });

  it('判死后整链不可用（调用方回落 LIKE）', () => {
    const db = openDb();
    ensureSearchFtsTable(db);
    expect(searchIndexUsable(db)).toBe(true);
    markSearchIndexUnusable(db, '测试判死');
    expect(searchIndexUsable(db)).toBe(false);
    db.close();
  });
});

describe('回填与戳', () => {
  it('首次回填六类；二次调用幂等（不再写）', () => {
    const db = openDb();
    insertExperience(db, 'x1', '气泡副屏的问题修好了', 1000);
    insertExperience(db, 'x2', '车站的雨棚坏了', 2000);
    db.prepare(`INSERT INTO model_memory (id, scope, kind, text, workspace_id, session_id, pinned, created_at, updated_at, forgotten_at)
      VALUES ('mm-1', 'life', 'bond', '约定每周日看电影', '', '', 0, 1, 1, NULL)`).run();
    db.prepare(`INSERT INTO task (id, title, status, next_step, workspace_id, created_at, updated_at)
      VALUES ('k1', '修投递脚本', 'open', NULL, 'w1', 1, 1)`).run();
    db.prepare(`INSERT INTO txn_entry (id, session_id, workspace_id, ts_ms, turn_seq, card_line, summary, gist_key, semantic_json, source_trust, topic_id, created_at, salience_tier)
      VALUES ('t1', 's1', 'w1', 1, 1, '把投递脚本改好了', NULL, NULL, NULL, 'structure_signal', NULL, 1, 2)`).run();
    db.prepare(`INSERT INTO entity (id, kind, name, aliases_json, importance, first_seen_ms, last_seen_ms)
      VALUES ('ent-proj:linkperry', 'project', 'linkperry', '["kpe"]', 1, 1, 1)`).run();
    db.prepare(`INSERT INTO goal (id, title, status, why, workspace_id, created_at, updated_at, done_at)
      VALUES ('g1', '把插件发布出去', 'open', '想让它被用起来', '', 1, 1, NULL)`).run();

    const first = ensureSearchIndex(db);
    expect(first.state).toBe('rebuilt');
    // 2 experience + 1 memory + 1 task + 1 delivery + 1 entity + 1 goal
    expect(first.docs).toBe(7);
    expect(searchIndexStats(db).docs).toBe(7);
    expect(searchIndexStats(db).stamp).toBe(tokenizerStamp());

    const second = ensureSearchIndex(db);
    expect(second.state).toBe('ok');
    db.close();
  });

  it('无索引时 searchExperiences 回落 LIKE（功能不消失）', () => {
    const db = openDb();
    insertExperience(db, 'x1', '上次那个气泡副屏的问题修好了吗', 1000);
    markSearchIndexUnusable(db, '模拟 FTS 不可用');
    const hits = searchExperiences(db, '副屏');
    expect(hits.map((h) => h.id)).toEqual(['x1']);
    db.close();
  });
});