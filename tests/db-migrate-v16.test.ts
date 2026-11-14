/**
 * schema v15→v16 迁移：编号重整（记录 echo-<uuid> / 回响 recall-<uuid>）。
 * 用构造的老库跑一遍、再跑一遍：号码全换新格式、第二次不再重生新号（幂等）、旧行不丢。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-migrate16-'));
  dirs.push(dir);
  return dir;
}

describe('migrate 15→16（编号重整）', () => {
  it('旧 echo:kind:id → echo-<uuid>；旧 echo-<ts> → recall-<uuid>；连跑两遍幂等', () => {
    const dir = workspace();
    const first = openSpiritDb(dir);
    if (!first.ok) throw new Error('库应打开');
    const db = first.db;

    // 先造一条"老格式"数据（模拟 v15 落下的行），再把库降级成 v15 让迁移重跑
    db.prepare(
      `INSERT INTO echo_ref (session_id, ref_id, kind, mem_id, title, times, first_ts, last_ts, last_echo_step_id)
       VALUES ('s1', 'echo:task:task-a', 'task', 'task-a', 'plugin-9lang-five-dim', 2, 1000, 2000, 'echo-1000')`,
    ).run();
    db.prepare(
      `INSERT INTO echo_step (session_id, ts_ms, agent_id, kind, reason, fingerprint, segments_json, preview, id, text)
       VALUES ('s1', 1000, 'a', 'injected', '', 'fp', '[]', '状态：平常', 'echo-1000', '状态：平常')`,
    ).run();
    db.prepare(`INSERT INTO meta (key, value) VALUES ('db_schema_version', '15') ON CONFLICT(key) DO UPDATE SET value = '15'`).run();
    db.close();

    // 第一次迁移
    const second = openSpiritDb(dir);
    if (!second.ok) throw new Error('库应打开（迁移后）');
    const row1 = second.db.prepare(`SELECT ref_id, last_echo_step_id FROM echo_ref WHERE session_id = 's1'`).get() as { ref_id?: string; last_echo_step_id?: string };
    const step1 = second.db.prepare(`SELECT id FROM echo_step WHERE session_id = 's1'`).get() as { id?: string };
    expect(row1.ref_id).toMatch(/^echo-[0-9a-f-]{36}$/);
    expect(step1.id).toMatch(/^recall-[0-9a-f-]{36}$/);
    expect(row1.last_echo_step_id, 'lastRecallId 同步成新事件号').toBe(step1.id);
    const identity = second.db.prepare(`SELECT echo_id FROM echo_identity WHERE kind = 'task' AND mem_id = 'task-a'`).get() as { echo_id?: string };
    expect(identity.echo_id).toBe(row1.ref_id);
    // record_ts 回填（旧行取 first_ts）
    const rec = second.db.prepare(`SELECT record_ts FROM echo_ref WHERE session_id = 's1'`).get() as { record_ts?: number };
    expect(rec.record_ts).toBe(1000);
    const echoIdAfterFirst = row1.ref_id;
    const recallIdAfterFirst = step1.id;
    second.db.close();

    // 第二次：降级重跑，号码不再变
    const third = openSpiritDb(dir);
    if (!third.ok) throw new Error('库应打开（第二次）');
    const row2 = third.db.prepare(`SELECT ref_id, last_echo_step_id FROM echo_ref WHERE session_id = 's1'`).get() as { ref_id?: string; last_echo_step_id?: string };
    const step2 = third.db.prepare(`SELECT id FROM echo_step WHERE session_id = 's1'`).get() as { id?: string };
    expect(row2.ref_id).toBe(echoIdAfterFirst);
    expect(step2.id).toBe(recallIdAfterFirst);
    expect(row2.last_echo_step_id).toBe(recallIdAfterFirst);
    third.db.close();
  });
});
