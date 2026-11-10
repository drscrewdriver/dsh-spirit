/**
 * 模型可写记忆（v0.8）：两本账（life/work）+ 日记 + 目的层。
 * 正反成对：kind 越界拒写、含密拒写、遗忘不进读面、工作区隔离、pinned 才进注入面。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { SPIRIT_RPC_PREFIX } from '../src/contract.js';
import { openSpiritDb } from '../src/db/open.js';
import { GoalStore, ModelMemoryStore } from '../src/memory/store.js';
import { handleEndpoint, type RpcDeps } from '../src/rpc.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
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

function fresh(): { db: DatabaseSync; memory: ModelMemoryStore; goals: GoalStore } {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-mm-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  dbs.push(opened.db);
  return {
    db: opened.db,
    memory: new ModelMemoryStore({ db: () => opened.db, logger }),
    goals: new GoalStore({ db: () => opened.db, logger }),
  };
}

describe('ModelMemoryStore', () => {
  it('scope/kind 越界拒写；含密拒写；正常写成功', () => {
    const { memory } = fresh();
    expect(memory.write({ scope: 'life', kind: 'fact', text: '越界 kind' }).ok, 'life 只收 bond/promise').toBe(false);
    expect(memory.write({ scope: 'work', kind: 'bond', text: '越界 kind' }).ok, 'work 不收 bond').toBe(false);
    expect(memory.write({ scope: 'life', kind: 'promise', text: '密钥是 sk-abcdefghijklmnopqrstuvwxyz1234' }).ok, '含密拒写').toBe(false);
    const ok = memory.write({ scope: 'life', kind: 'promise', text: '周五前把星海搜索修好' });
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.row.scope).toBe('life');
  });

  it('同 scope 同文幂等（不发散重复行）；跨 scope 分账', () => {
    const { memory } = fresh();
    const a = memory.write({ scope: 'life', kind: 'bond', text: '喜欢安静地陪着干活' });
    const b = memory.write({ scope: 'life', kind: 'bond', text: '喜欢安静地陪着干活' });
    expect(a.ok && b.ok && a.row.id === b.row.id).toBe(true);
    expect(memory.recent({ scope: 'life' }).length).toBe(1);
    memory.write({ scope: 'work', kind: 'fact', text: '喜欢安静地陪着干活' });
    expect(memory.recent({ scope: 'work' }).length, '同文跨账不合并').toBe(1);
  });

  it('pinned 才进注入面；遗忘后读面消失（不物理删）', () => {
    const { memory } = fresh();
    const life = memory.write({ scope: 'life', kind: 'promise', text: '答应过不擅自推送远程' });
    const work = memory.write({ scope: 'work', kind: 'decision', text: '本体层缺省开启', workspaceId: 'E:/proj' });
    expect(life.ok && work.ok).toBe(true);
    if (!life.ok || !work.ok) return;
    expect(memory.pinnedLife(3)).toHaveLength(0);
    expect(memory.pin(life.row.id, true)).toBe(true);
    expect(memory.pin(work.row.id, true)).toBe(true);
    expect(memory.pinnedLife(3).map((r) => r.text)).toEqual(['答应过不擅自推送远程']);
    expect(memory.pinnedWork('E:/proj', 2).map((r) => r.text)).toEqual(['本体层缺省开启']);
    expect(memory.pinnedWork('E:/other', 2), '别的工作区看不到（全局行除外）').toHaveLength(0);

    expect(memory.forget(work.row.id)).toBe(true);
    expect(memory.pinnedWork('E:/proj', 2)).toHaveLength(0);
    expect(memory.recent({ scope: 'work', workspaceId: 'E:/proj' })).toHaveLength(0);
  });

  it('工作区隔离：本区 + 全局行可见；跨区互不可见', () => {
    const { memory } = fresh();
    memory.write({ scope: 'work', kind: 'preference', text: '全局偏好', workspaceId: '' });
    memory.write({ scope: 'work', kind: 'preference', text: 'A 区偏好', workspaceId: 'A' });
    memory.write({ scope: 'work', kind: 'preference', text: 'B 区偏好', workspaceId: 'B' });
    const a = memory.recent({ scope: 'work', workspaceId: 'A' }).map((r) => r.text).sort();
    expect(a).toEqual(['A 区偏好', '全局偏好']);
    expect(memory.recent({ scope: 'work' }).length, '面板不带工作区 = 全量').toBe(3);
  });

  it('日记：不自动注入（pinnedLife/pinnedWork 都不含）；recall 按词可取', () => {
    const { memory } = fresh();
    memory.write({ scope: 'diary', kind: 'note', text: '今天把端口漂移修好了，心情不错' });
    expect(memory.pinnedLife(5)).toHaveLength(0);
    expect(memory.pinnedWork('', 5)).toHaveLength(0);
    expect(memory.diary(10)).toHaveLength(1);
    expect(memory.search('端口', { scope: 'diary' }).map((r) => r.text)).toEqual(['今天把端口漂移修好了，心情不错']);
  });
});

describe('GoalStore（目的层）', () => {
  it('add → openFor 可见；done 后不再惦记；同标的重开会复用', () => {
    const { goals } = fresh();
    const added = goals.add({ title: '让鱼记住整段生涯', why: '主人点名的长期方向', workspaceId: 'E:/proj' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(goals.openFor('E:/proj', 3).map((g) => g.title)).toEqual(['让鱼记住整段生涯']);
    expect(goals.setStatus(added.row.id, 'done')).toBe(true);
    expect(goals.openFor('E:/proj', 3)).toHaveLength(0);
    const reopened = goals.add({ title: '让鱼记住整段生涯', workspaceId: 'E:/proj' });
    expect(reopened.ok && reopened.row.id === added.row.id, '同 id 复用').toBe(true);
    expect(goals.openFor('E:/proj', 3)).toHaveLength(1);
    expect(goals.openFor('E:/other', 3), '别的工作区不可见').toHaveLength(0);
  });
});

describe('memory-list RPC', () => {
  it('未装配 ⇒ unavailable；装配后四本账 + goals 齐', async () => {
    const bare = { logger } as unknown as RpcDeps;
    const missing = await handleEndpoint(`${SPIRIT_RPC_PREFIX}memory-list`, {}, bare);
    expect(missing.ok).toBe(false);

    const { memory, goals } = fresh();
    memory.write({ scope: 'life', kind: 'bond', text: '心里话一条' });
    memory.write({ scope: 'work', kind: 'fact', text: '工作事实一条', workspaceId: 'A' });
    memory.write({ scope: 'diary', kind: 'note', text: '日记一条' });
    goals.add({ title: '目标一条', workspaceId: 'A' });
    const deps = { logger, memory, goals } as unknown as RpcDeps;
    const result = await handleEndpoint(`${SPIRIT_RPC_PREFIX}memory-list`, {}, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.value as { life: unknown[]; work: unknown[]; diary: unknown[]; goals: unknown[] };
    expect(view.life).toHaveLength(1);
    expect(view.work).toHaveLength(1);
    expect(view.diary).toHaveLength(1);
    expect(view.goals).toHaveLength(1);
  });
});
