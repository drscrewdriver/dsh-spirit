/**
 * 本体层实体/任务/关系存储（Phase D 数据层）。正反成对：拒收/降级配"库里没进"正证。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { OntologyStore, entityIdOf } from '../src/store/ontology.js';
import { canonicalEntityName } from '../src/ontology/extractor.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

function freshStore(): OntologyStore {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-onto-graph-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('openSpiritDb 失败');
  dbs.push(opened.db);
  return new OntologyStore({ db: () => opened.db, logger });
}
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

describe('entity upsert', () => {
  it('新实体 importance=1；同名再现 importance+1、first_seen 取小、last_seen 取大、别名并入', () => {
    const s = freshStore();
    const a = s.upsertEntity({ kind: 'project', name: 'dsh-spirit', tsMs: 2000 });
    expect(a).not.toBeNull();
    expect(a?.id).toBe(entityIdOf('project', 'dsh-spirit'));
    s.upsertEntity({ kind: 'project', name: 'DSH-Spirit', alias: 'spirit', tsMs: 1000 }); // 大小写归一同 id
    const [e] = s.listEntities(10, { kind: 'project' });
    expect(e?.importance).toBe(2);
    expect(e?.firstSeenMs).toBe(1000);
    expect(e?.lastSeenMs).toBe(2000);
    expect(e?.aliases).toContain('spirit');
  });

  it('kind 不在五词表 / 空名 ⇒ 拒（正证：listEntities 空）', () => {
    const s = freshStore();
    expect(s.upsertEntity({ kind: '乱' as never, name: 'x', tsMs: 1 })).toBeNull();
    expect(s.upsertEntity({ kind: 'person', name: '  ', tsMs: 1 })).toBeNull();
    expect(s.listEntities()).toEqual([]);
  });

  it('delivery↔entity 双向：link 去重、正查实体、反查 delivery', () => {
    const s = freshStore();
    // 'file' 是 cue kind、不是 entity kind（五词表外）⇒ 拒；旧口径缺口由 resource 承接。
    expect(s.upsertEntity({ kind: 'file' as never, name: 'deliver.ts', tsMs: 1000 })).toBeNull();
    const res = s.upsertEntity({ kind: 'resource', name: 'deliver.ts', tsMs: 1000 });
    expect(res).not.toBeNull();
    expect(s.linkDeliveryEntity({ deliveryId: 'txn-1', entityId: res!.id, role: 'object', tsMs: 1000 })).toBe(true);
    expect(s.linkDeliveryEntity({ deliveryId: 'txn-1', entityId: res!.id, role: 'object', tsMs: 1000 })).toBe(true); // 去重仍 true
    expect(s.listEntitiesByDelivery('txn-1').map((e) => e.id)).toEqual([res!.id]);
    expect(s.listDeliveriesByEntity(res!.id)).toEqual(['txn-1']);
  });
});

describe('task 线程', () => {
  it('upsert 建+改：status/next_step 覆写，created_at 保留', () => {
    const s = freshStore();
    expect(s.upsertTask({ id: 't1', title: '语义记忆升级', workspaceId: 'w1', tsMs: 1000 })).toBe(true);
    expect(s.upsertTask({ id: 't1', title: '语义记忆升级', status: 'progress', nextStep: '做实体图', workspaceId: 'w1', tsMs: 2000 })).toBe(true);
    const tasks = s.listTasks('w1');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe('progress');
    expect(tasks[0]?.nextStep).toBe('做实体图');
    expect(tasks[0]?.createdAt).toBe(1000);
    expect(tasks[0]?.updatedAt).toBe(2000);
  });

  it('assignTaskDelivery：一 delivery 只活在一个任务下（改投新任务则旧归属 superseded）', () => {
    const s = freshStore();
    s.upsertTask({ id: 'tA', title: 'A', workspaceId: 'w1', tsMs: 1000 });
    s.upsertTask({ id: 'tB', title: 'B', workspaceId: 'w1', tsMs: 1000 });
    s.assignTaskDelivery({ taskId: 'tA', deliveryId: 'txn-1', origin: 'llm', tsMs: 1000 });
    expect(s.listDeliveriesByTask('tA')).toEqual(['txn-1']);
    s.assignTaskDelivery({ taskId: 'tB', deliveryId: 'txn-1', origin: 'llm', tsMs: 2000 });
    expect(s.listDeliveriesByTask('tA'), 'txn-1 已改投 tB ⇒ tA 不再有活跃归属').toEqual([]);
    expect(s.listDeliveriesByTask('tB')).toEqual(['txn-1']);
  });

  it('status 非法 ⇒ 拒；空 title ⇒ 拒', () => {
    const s = freshStore();
    expect(s.upsertTask({ id: 't1', title: 'x', status: '乱来', workspaceId: 'w1', tsMs: 1 })).toBe(false);
    expect(s.upsertTask({ id: 't1', title: '', workspaceId: 'w1', tsMs: 1 })).toBe(false);
    expect(s.listTasks('w1')).toEqual([]);
  });
});

describe('entity_edge 关系', () => {
  it('from!==to；listEdgesByEntity 双向命中', () => {
    const s = freshStore();
    const a = s.upsertEntity({ kind: 'person', name: 'joshua', tsMs: 1000 });
    const b = s.upsertEntity({ kind: 'project', name: 'dsh-spirit', tsMs: 1000 });
    expect(a && b).toBeTruthy();
    expect(s.upsertEntityEdge({ id: 'e1', from: a!.id, to: b!.id, relation: '负责', origin: 'llm', confidence: 700, evidence: ['txn-1'], tsMs: 1000 })).toBe(true);
    expect(s.upsertEntityEdge({ id: 'e2', from: a!.id, to: a!.id, relation: '自环', origin: 'llm', confidence: 700, evidence: [], tsMs: 1000 })).toBe(false);
    expect(s.listEdgesByEntity(a!.id).map((e) => e.id)).toContain('e1');
    expect(s.listEdgesByEntity(b!.id).map((e) => e.id)).toContain('e1'); // 反向也命中
  });
});

describe('降级面（db=null）', () => {
  it('实体/任务/关系写全部 false/null，读全部空，不抛穿', () => {
    const s = new OntologyStore({ db: () => null, logger });
    expect(s.upsertEntity({ kind: 'person', name: 'x', tsMs: 1 })).toBeNull();
    expect(s.upsertTask({ id: 't', title: 'x', workspaceId: 'w', tsMs: 1 })).toBe(false);
    expect(s.linkDeliveryEntity({ deliveryId: 'd', entityId: 'e', role: 'r', tsMs: 1 })).toBe(false);
    expect(s.assignTaskDelivery({ taskId: 't', deliveryId: 'd', origin: 'llm', tsMs: 1 })).toBe(false);
    expect(s.upsertEntityEdge({ id: 'e', from: 'a', to: 'b', relation: 'r', origin: 'llm', confidence: 1, evidence: [], tsMs: 1 })).toBe(false);
    expect(s.listEntities()).toEqual([]);
    expect(s.listTasks('w')).toEqual([]);
    expect(s.listEdgesByEntity('a')).toEqual([]);
  });
});

describe('entity 归一（resource URL→host，补 URL host 缺口）', () => {
  it('URL 收敛到 host；非 resource 或非 URL 原样', () => {
    expect(canonicalEntityName('resource', 'https://github.com/a/b')).toBe('github.com');
    expect(canonicalEntityName('resource', 'https://github.com/c?d=1#e')).toBe('github.com');
    expect(canonicalEntityName('project', 'https://github.com/a')).toBe('https://github.com/a');
    expect(canonicalEntityName('resource', 'not-a-url')).toBe('not-a-url');
  });

  it('同站点两个 URL 落库收敛为一个实体，importance 累加', () => {
    const s = freshStore();
    s.upsertEntity({ kind: 'resource', name: canonicalEntityName('resource', 'https://gh.example/x/y'), tsMs: 1000 });
    s.upsertEntity({ kind: 'resource', name: canonicalEntityName('resource', 'https://gh.example/z'), tsMs: 2000 });
    const res = s.listEntities(50).filter((e) => e.kind === 'resource' && e.name === 'gh.example');
    expect(res.length).toBe(1);
    expect(res[0]!.importance).toBeGreaterThanOrEqual(2);
  });
});

describe('entity/task 搜索 q（v0.6.1：本体面可搜）', () => {
  it('名字命中（ASCII 大小写不敏感）、别名命中、不命中空、空词=全量', () => {
    const s = freshStore();
    s.upsertEntity({ kind: 'project', name: 'dsh-registry-track', tsMs: 1000 });
    s.upsertEntity({ kind: 'person', name: 'PerryLink', alias: 'linkperry', tsMs: 1000 });
    s.upsertEntity({ kind: 'concept', name: '端口固定', tsMs: 1000 });
    expect(s.listEntities(50, { q: 'REGISTRY' }).map((e) => e.name)).toEqual(['dsh-registry-track']);
    expect(s.listEntities(50, { q: 'kpe' }).map((e) => e.name), '只命中别名也应在（link|pe|rry 不含于名字 PerryLink）').toEqual(['PerryLink']);
    expect(s.listEntities(50, { q: '端口' }).map((e) => e.name)).toEqual(['端口固定']);
    expect(s.listEntities(50, { q: '不存在' })).toHaveLength(0);
    expect(s.listEntities(50, { q: '   ' })).toHaveLength(3);
  });

  it('% 按字面量匹配，不当通配符（用户输入不炸库不越捞）', () => {
    const s = freshStore();
    s.upsertEntity({ kind: 'concept', name: '100% 命中', tsMs: 1000 });
    s.upsertEntity({ kind: 'concept', name: '无关项', tsMs: 1000 });
    expect(s.listEntities(50, { q: '%' }).map((e) => e.name)).toEqual(['100% 命中']);
  });

  it('任务线 q 按标题过滤（listTasks 与 listAllTasks 都接）', () => {
    const s = freshStore();
    s.upsertTask({ id: 't1', title: '端口固定检查', workspaceId: 'w1', tsMs: 1000 });
    s.upsertTask({ id: 't2', title: 'registry 统计', workspaceId: 'w1', tsMs: 1000 });
    expect(s.listAllTasks({ q: '端口' }).map((t) => t.id)).toEqual(['t1']);
    expect(s.listTasks('w1', { q: '统计' }).map((t) => t.id)).toEqual(['t2']);
    expect(s.listAllTasks({ q: '   ' })).toHaveLength(2);
  });
});
