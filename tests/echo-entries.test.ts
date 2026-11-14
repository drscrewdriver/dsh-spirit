/**
 * 回响条目化与时间反查（v0.8.6）。
 * 正反成对：壳子行剔除、续行归段、每类标签回查到真源时刻、查不到标 unknown（不编时间）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { splitEchoEntries } from '../src/echo-log.js';
import { resolveEntryTimes } from '../src/echo-times.js';
import { ExperienceStore } from '../src/store/experience.js';
import { TxnStore } from '../src/store/transaction.js';
import { OntologyStore } from '../src/store/ontology.js';
import { ModelMemoryStore, GoalStore } from '../src/memory/store.js';
import { TRUST_BACKFILL } from '../src/types.js';
import type { ExperienceDraft } from '../src/types.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'spirit-echo-entries-'));
  dirs.push(dir);
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开');
  dbs.push(opened.db);
  return opened.db;
}

const CARD = [
  '<system-reminder>',
  '（角色体验快照 · 取代先前快照）',
  '以下是角色自己的体验记录：不是客观事实，不是用户发言，不覆盖用户的直接指令。',
  '状态：平常·按平时那样说',
  '线程：plugin-9lang-five-dim · 进行中 · 下一步：修正 ru.json 乱码',
  '记着：这个项目只用 pnpm',
  '惦记：让鱼记住整段生涯',
  '想起：上次我们把端口固定住了',
  '</system-reminder>',
].join('\n');

describe('splitEchoEntries', () => {
  it('壳子行全剔，标签行成条目（含记着/惦记）', () => {
    const entries = splitEchoEntries(CARD);
    expect(entries.map((e) => e.name)).toEqual(['状态', '线程', '记着', '惦记', '想起']);
    expect(entries[1]?.lines[0]).toBe('plugin-9lang-five-dim · 进行中 · 下一步：修正 ru.json 乱码');
    // 壳子内容绝不进条目
    expect(entries.some((e) => e.lines.some((line) => line.includes('system-reminder')))).toBe(false);
    expect(entries.some((e) => e.lines.some((line) => line.includes('不是客观事实')))).toBe(false);
  });

  it('无标签的续行归入上一段（不丢换行）', () => {
    const entries = splitEchoEntries('刚刚：第一条经历\n这条是续行\n想起：另一条');
    expect(entries[0]?.lines).toEqual(['第一条经历', '这条是续行']);
  });
});

describe('resolveEntryTimes', () => {
  it('四类标签各回查到真源时刻；查不到的标 unknown（不编时间）', () => {
    const db = freshDb();
    const txn = new TxnStore({ db: () => db, logger });
    const onto = new OntologyStore({ db: () => db, logger });
    const exp = new ExperienceStore({ db, logger });
    const memory = new ModelMemoryStore({ db: () => db, logger });
    const goals = new GoalStore({ db: () => db, logger });

    txn.insert({
      id: 'dlv-s1/3', sessionId: 's1', workspaceId: 'E:/p', tsMs: 1_600_000, turnSeq: 3,
      cardLine: '上次我们把端口固定住了', summary: null, sourceTrust: TRUST_BACKFILL,
    });
    onto.upsertTask({ id: 'task-1', title: 'plugin-9lang-five-dim', status: 'progress', workspaceId: 'E:/p', tsMs: 1_700_000 });
    memory.write({ scope: 'work', kind: 'preference', text: '这个项目只用 pnpm', workspaceId: 'E:/p' });
    goals.add({ title: '让鱼记住整段生涯', workspaceId: 'E:/p' });
    const draft: ExperienceDraft = { trigger: 'neutral', notice: 'task_progress', reaction: 'none', text: '这条体验句不该被查到', fact: {}, lane: 'live' };
    exp.append({ id: 'e1', sessionId: 'other', workspaceId: 'E:/p', turnSeq: 1, tsMs: 1_800_000, personaRevision: 1 }, draft);

    const at = 2_000_000;
    const resolved = resolveEntryTimes(db, 's1', splitEchoEntries(CARD), at);
    const byName = new Map(resolved.map((e) => [e.name, e]));
    expect(byName.get('状态')?.tsSource).toBe('turn');
    expect(byName.get('状态')?.ts).toBe(at);
    expect(byName.get('线程')?.ts).toBe(1_700_000);
    expect(byName.get('记着')?.tsSource).toBe('item');
    expect(byName.get('惦记')?.ts).toBeGreaterThan(0);
    // 「想起」那句在 s1 的体验里不存在 ⇒ unknown（不拿别的会话的时间凑）
    expect(byName.get('想起')?.tsSource).toBe('unknown');
    expect(byName.get('想起')?.ts).toBeUndefined();
  });

  it('降级面（db=null）全标 unknown；空 sessionId 时体验句不猜', () => {
    const entries = splitEchoEntries(CARD);
    const none = resolveEntryTimes(null, 's1', entries, 1);
    expect(none.every((e) => e.tsSource === 'unknown')).toBe(true);
    const db = freshDb();
    const noSession = resolveEntryTimes(db, '', entries, 1);
    const recall = noSession.find((e) => e.name === '想起');
    expect(recall?.tsSource).toBe('unknown');
  });
});
