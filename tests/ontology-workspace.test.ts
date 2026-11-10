/**
 * workspaceId 修复链（v0.5.8）：候选 ⇒ 同会话反查（txn_entry→experience）⇒ 全局桶。
 * 正反成对：每级"用得上"配"不该用"（全局桶值不得当证据传播、空会话不抛穿）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { TxnStore } from '../src/store/transaction.js';
import { WORKSPACE_GLOBAL, resolveWorkspaceId } from '../src/ontology/workspace.js';
import { TRUST_USER_EXPLICIT } from '../src/types.js';

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

function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-onto-ws-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  dbs.push(opened.db);
  return opened.db;
}

function seedTxn(db: DatabaseSync, sessionId: string, workspaceId: string, tsMs: number): void {
  const txn = new TxnStore({ db: () => db, logger });
  const got = txn.insert({
    id: `dlv-${sessionId}-${tsMs}`, sessionId, workspaceId, tsMs, turnSeq: 1,
    cardLine: `交付 @${tsMs}`, summary: null, sourceTrust: TRUST_USER_EXPLICIT,
  });
  if (!got.ok) throw new Error(`种子应落库：${got.reason}`);
}

function seedExperience(db: DatabaseSync, sessionId: string, workspaceId: string, tsMs: number): void {
  db.prepare(`INSERT INTO experience (id, session_id, workspace_id, turn_seq, ts_ms, trigger, notice, reaction, text, fact_json, lane, persona_revision, updated_at)
    VALUES (?, ?, ?, 1, ?, 't', 'n', 'r', 'x', '{}', 'hot', 1, ?)`)
    .run(`e-${sessionId}-${tsMs}`, sessionId, workspaceId, tsMs, tsMs);
}

describe('resolveWorkspaceId 修复链', () => {
  it('候选非空 ⇒ 直接用（不查库、不反查）', () => {
    const db = freshDb();
    seedTxn(db, 's1', 'E:/known', 1000);
    expect(resolveWorkspaceId(db, 's1', 'E:/other')).toBe('E:/other');
  });

  it('候选空 ⇒ 反查 txn_entry 修到对应范围（取最近一条）', () => {
    const db = freshDb();
    seedTxn(db, 's1', 'E:/old', 1000);
    seedTxn(db, 's1', 'E:/new', 2000);
    expect(resolveWorkspaceId(db, 's1', '')).toBe('E:/new');
  });

  it('txn_entry 无记录 ⇒ 反查 experience；两者都无 ⇒ 全局桶', () => {
    const db = freshDb();
    seedExperience(db, 's2', 'E:/exp', 1500);
    expect(resolveWorkspaceId(db, 's2', '')).toBe('E:/exp');
    expect(resolveWorkspaceId(db, 's9', '')).toBe(WORKSPACE_GLOBAL);
  });

  it('全局桶值不当证据传播（反查只认非全局的已知范围）；降级面不抛穿', () => {
    const db = freshDb();
    seedTxn(db, 's3', WORKSPACE_GLOBAL, 1000);
    seedExperience(db, 's3', 'E:/real', 900);
    // txn 里只有全局值 ⇒ 不算证据，继续往下修到 experience 的真实范围
    expect(resolveWorkspaceId(db, 's3', '')).toBe('E:/real');
    expect(resolveWorkspaceId(null, 's3', '')).toBe(WORKSPACE_GLOBAL);
    expect(resolveWorkspaceId(db, '', '')).toBe(WORKSPACE_GLOBAL);
  });
});
