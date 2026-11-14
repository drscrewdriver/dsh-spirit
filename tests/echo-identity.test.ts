/**
 * 编号身份层（v0.8.11）：记录持 echo-<uuid>、回响持 recall-<uuid>。
 * 正反成对：同记录同号（跨会话）、不同记录不同号、recall 每次新号、短号口径、flashback 判定。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { isFlashback, newRecallId, resolveEchoId, resolveEchoIds, shortEchoId, shortRecallId, echoQueryPrefix, findEchoIdentities } from '../src/echo/identity.js';

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

function fresh(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-identity-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  dbs.push(opened.db);
  return opened.db;
}

describe('resolveEchoId（记录号）', () => {
  it('同一记录永远同号（重复调用/不同会话都是同一个 echo-<uuid>）', () => {
    const db = fresh();
    const first = resolveEchoId(db, 'task', 'task-a');
    expect(first).toMatch(/^echo-[0-9a-f-]{36}$/);
    expect(resolveEchoId(db, 'task', 'task-a')).toBe(first);
    const again = db.prepare(`SELECT echo_id FROM echo_identity WHERE kind = 'task' AND mem_id = 'task-a'`).get() as { echo_id?: string };
    expect(again.echo_id).toBe(first);
    // 不同记录不同号
    expect(resolveEchoId(db, 'task', 'task-b')).not.toBe(first);
    // 同 mem_id 不同 kind 也是不同号（kind 参与身份）
    expect(resolveEchoId(db, 'delivery', 'task-a')).not.toBe(first);
  });

  it('批量取号同条只建一次；缺参/降级面返回 undefined（不编造）', () => {
    const db = fresh();
    const ids = resolveEchoIds(db, [{ kind: 'task', memId: 'x' }, { kind: 'task', memId: 'x' }, { kind: 'goal', memId: 'g' }]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(resolveEchoId(db, 'task', '')).toBeUndefined();
    expect(resolveEchoId(null, 'task', 'x')).toBeUndefined();
  });
});

describe('newRecallId（回响号）', () => {
  it('每次都是新 UUID；1000 次无重复', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const id = newRecallId();
      expect(id).toMatch(/^recall-[0-9a-f-]{36}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(1000);
  });
});

describe('按 echo 号定位（v0.8.12）', () => {
  it('查询归一：echo- 前缀 / 短码 / 全 UUID 都成前缀；文本不当号查', () => {
    expect(echoQueryPrefix('echo-3f9a2b7c1d4e')).toBe('echo-3f9a2b7c1d4e');
    expect(echoQueryPrefix('3f9a2b7c1d4e')).toBe('echo-3f9a2b7c1d4e');
    expect(echoQueryPrefix('3f9a2b7c-1d4e-4a5b')).toBe('echo-3f9a2b7c-1d4e-4a5b');
    expect(echoQueryPrefix('plugin-9lang')).toBeUndefined();
    expect(echoQueryPrefix('  ')).toBeUndefined();
  });

  it('注册表按前缀命中：全号/短号/去前缀都能找到；普通文本与降级面返回空', () => {
    const db = fresh();
    const echoId = resolveEchoId(db, 'task', 'task-a')!;
    const all = findEchoIdentities(db, echoId);
    expect(all).toEqual([{ echoId, kind: 'task', memId: 'task-a' }]);
    // 展示短号是去连字符+前 12 位（会跨过 UUID 第 8 位的连字符）：必须能找回
    const short = echoId.slice('echo-'.length).replaceAll('-', '').slice(0, 12);
    expect(findEchoIdentities(db, short).map((hit) => hit.echoId)).toEqual([echoId]);
    expect(findEchoIdentities(db, 'plugin-9lang')).toEqual([]);
    expect(findEchoIdentities(null, echoId)).toEqual([]);
  });
});

describe('短号与 flashback', () => {
  it('短号 = 前缀 + 去连字符前 12 位；全号保留在参数里', () => {
    const echoId = 'echo-3f9a2b7c-1d4e-4a5b-8c9d-0e1f2a3b4c5d';
    expect(shortEchoId(echoId)).toBe('echo-3f9a2b7c1d4e');
    expect(shortRecallId('recall-3f9a2b7c-1d4e-4a5b-8c9d-0e1f2a3b4c5d')).toBe('recall-3f9a2b7c1d4e');
  });

  it('最早记录早于 7 天 ⇒ flashback；否则不是；缺时间不判定', () => {
    const at = 1_800_000_000_000;
    const day = 86_400_000;
    expect(isFlashback(at - 8 * day, at)).toBe(true);
    expect(isFlashback(at - 6 * day, at)).toBe(false);
    expect(isFlashback(undefined, at)).toBe(false);
    expect(isFlashback(0, at)).toBe(false);
  });
});
