/**
 * 实体双向对齐（v0.8.18）：归一化 + alias 建表 + 上游链接 + 知识引用（只存 id 不存正文）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import {
  buildEntityAliases,
  buildEntityLinks,
  lastPathSegment,
  linkKnowledgeRecords,
  matchEntitiesInText,
  normalizeEntityName,
  resolveEntityId,
} from '../src/prime/entity-align.js';

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

function freshSpirit(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-align-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  dbs.push(opened.db);
  return opened.db;
}

function seedEntity(db: DatabaseSync, id: string, name: string, aliases: string[]): void {
  db.prepare(
    `INSERT INTO entity (id, kind, name, aliases_json, importance, first_seen_ms, last_seen_ms) VALUES (?, 'project', ?, ?, 2, ?, ?)`,
  ).run(id, name, JSON.stringify(aliases), Date.now(), Date.now());
}

describe('归一化', () => {
  it('大小写/空白/连字符/括号/路径末段', () => {
    expect(normalizeEntityName('  DSH-Spirit ')).toBe('dshspirit');
    expect(normalizeEntityName('dsh_spirit（主仓）')).toBe('dshspirit主仓');
    expect(lastPathSegment('E:\\test\\rewrite-agently')).toBe('rewrite-agently');
    expect(lastPathSegment('owner/repo')).toBe('repo');
  });
});

describe('alias 与上游链接', () => {
  it('spirit 实体 → alias；上游 graph_node/repo 精确匹配建链接；未命中不建实体', () => {
    const db = freshSpirit();
    seedEntity(db, 'ent-spirit', 'dsh-spirit', ['记忆体', 'echo engine']);
    const aliases = buildEntityAliases(db);
    expect(aliases).toBeGreaterThanOrEqual(3);
    expect(resolveEntityId(db, 'DSH Spirit')).toBe('ent-spirit');
    expect(resolveEntityId(db, '记忆体')).toBe('ent-spirit');

    const upstream = [
      { name: 'dsh-spirit', aliases: [], repoKey: '', workspaceId: '' },
      { name: 'unknown-thing', aliases: ['nope'], repoKey: '', workspaceId: '' },
      { name: 'rewrite-agently', aliases: [], repoKey: 'E:/test/rewrite-agently', workspaceId: 'E:/test/rewrite-agently' },
    ];
    const result = buildEntityLinks(db, upstream, 1_700_000_000_000);
    expect(result.links).toBeGreaterThanOrEqual(1);
    expect(result.unmatched).toBeGreaterThanOrEqual(1);
    const links = db.prepare(`SELECT upstream_kind, upstream_id FROM entity_upstream_link ORDER BY upstream_kind`).all() as Array<Record<string, unknown>>;
    expect(links.length).toBeGreaterThanOrEqual(1);
    // 未命中的上游实体不得在 spirit 里新建实体
    expect((db.prepare(`SELECT COUNT(*) AS c FROM entity`).get() as { c?: number }).c).toBe(1);
  });

  it('知识性记录 → entity_record_ref（只有 id/type/ts，无正文）；流程性不写 ref', () => {
    const db = freshSpirit();
    seedEntity(db, 'ent-spirit', 'dsh-spirit', []);
    buildEntityAliases(db);
    const inserted = linkKnowledgeRecords(db, [
      { id: 'mem_know', type: 'work_fact', family: 'work', content: 'dsh-spirit 的 schema 到 v18 了', tsMs: 1_700_000_000_000, sessionId: 's-1' },
      { id: 'mem_flow', type: 'work_task', family: 'work', content: 'dsh-spirit 本周在做生涯档', tsMs: 1_700_000_000_000, sessionId: 's-1' },
    ]);
    expect(inserted).toBe(1);
    const refs = db.prepare(`SELECT upstream_record_id, l1_type FROM entity_record_ref`).all() as Array<Record<string, unknown>>;
    expect(refs.map((row) => row['upstream_record_id'])).toEqual(['mem_know']);
    expect(matchEntitiesInText(db, '关于 DSH-Spirit 的事')).toEqual(['ent-spirit']);
  });
});
