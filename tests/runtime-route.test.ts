/**
 * 蒸馏路由运行时覆盖（distill/runtime-route）：优先级、半配拒、降级休眠、清除。
 *
 * 正反成对：每个"没写进去"的判据都配一条"库里到底存了什么/没存"的正证，防假绿。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { readRuntimeRoute, writeRuntimeRoute, RUNTIME_ROUTE_KEY } from '../src/distill/runtime-route.js';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-runtime-route-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('openSpiritDb 失败');
  dbs.push(opened.db);
  return opened.db;
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

function metaValue(db: DatabaseSync): string {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(RUNTIME_ROUTE_KEY) as { value?: unknown } | undefined;
  return typeof row?.value === 'string' ? row.value : '';
}

describe('runtime-route 读写', () => {
  it('成对写入即可读回；清除后读 undefined（且 meta 键真删掉）', () => {
    const db = freshDb();
    expect(writeRuntimeRoute(db, { provider: 'deepseek-official', model: 'dsv4' })).toBe(true);
    expect(readRuntimeRoute(db)).toEqual({ provider: 'deepseek-official', model: 'dsv4' });
    expect(metaValue(db)).not.toBe('');

    expect(writeRuntimeRoute(db, null)).toBe(true);
    expect(readRuntimeRoute(db)).toBeUndefined();
    expect(metaValue(db), '清除是 DELETE 不是写空串').toBe('');
  });

  it('半配（缺 model）⇒ 写拒 + 读不到（正证：meta 没被写脏）', () => {
    const db = freshDb();
    expect(writeRuntimeRoute(db, { provider: 'p', model: '  ' })).toBe(false);
    expect(readRuntimeRoute(db)).toBeUndefined();
    expect(metaValue(db)).toBe('');
  });

  it('坏 JSON / 空串 / 半配存进 meta ⇒ 读降级 undefined（宁缺毋造，绝不拿半个路由隐式改选）', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(RUNTIME_ROUTE_KEY, '{坏 json');
    expect(readRuntimeRoute(db)).toBeUndefined();
    db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run(JSON.stringify({ provider: 'p' }), RUNTIME_ROUTE_KEY);
    expect(readRuntimeRoute(db), '只有 provider 没 model = 半配').toBeUndefined();
  });

  it('降级面（db=null）⇒ 读 undefined、写 false，不抛穿、不攒内存镜像', () => {
    expect(readRuntimeRoute(null)).toBeUndefined();
    expect(writeRuntimeRoute(null, { provider: 'p', model: 'm' })).toBe(false);
    expect(writeRuntimeRoute(null, null)).toBe(false);
  });
});
