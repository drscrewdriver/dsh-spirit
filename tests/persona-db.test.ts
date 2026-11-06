/**
 * 人设 DB 化门禁（v0.3.1）：SQLite 权威 + markdown 备份 + 文件→DB 一次性迁移。
 *
 * 用真 `openSpiritDb`（v3 建表）而非手搓 DDL：schema 单源改了这里会跟着红，
 * 不会出现"测试绿着但生产建不出表"的分叉。`db=null` 的降级路径由
 * `persona-manage.test.ts` 既有用例守，这里不重复。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { PersonaStore, PERSONA_FILE, PERSONA_HISTORY_FILE, PERSONA_MARKDOWN_FILE } from '../src/persona/store.js';
import { parsePersonaMarkdown } from '../src/persona/markdown.js';
import type { PersonaCard } from '../src/types.js';

const warns: string[] = [];
const logger = { info: () => {}, warn: (m: string) => void warns.push(m) };

let dir = '';
let db: DatabaseSync | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-persona-db-'));
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('应打开库成功');
  db = opened.db;
  warns.length = 0;
});
afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function cardOf(over: Partial<PersonaCard> = {}): PersonaCard {
  return {
    id: 'default',
    revision: 1,
    name: '小鱼',
    aliases: [],
    selfNames: [],
    voice: 'warm',
    salience: { user_interruption: 2, tool_failure: 1, recovery: 2, task_close: 1, long_gap: 1, neutral: 0 },
    focus: ['self_mistake', 'user_state'],
    values: ['不把猜测写成事实'],
    boundaries: [],
    ...over,
  };
}

describe('PersonaStore（DB 权威路径）', () => {
  it('save 落 DB：当前位换代、旧卡进历史、persona.md 同批生成', () => {
    const store = new PersonaStore({ dataDir: dir, logger, db });
    const saved = store.save(cardOf());
    expect(saved.ok).toBe(true);
    // 初始默认卡（rev1）被顶替 ⇒ 应作为一行历史存在
    const historyCount = (db!.prepare(`SELECT COUNT(*) AS n FROM persona_revision`).get() as { n: number }).n;
    expect(historyCount).toBe(1);
    const current = (db!.prepare(`SELECT revision, card_json FROM persona_current WHERE singleton = 1`).get() as { revision: number; card_json: string });
    expect(current.revision).toBe(2);
    expect((JSON.parse(current.card_json) as PersonaCard).name).toBe('小鱼');
    // md 备份：存在、可 parse、名字对、零 slug
    const md = readFileSync(join(dir, PERSONA_MARKDOWN_FILE), 'utf8');
    expect(md).not.toContain('self_mistake');
    const parsed = parsePersonaMarkdown(md);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.persona.name).toBe('小鱼');
  });

  it('连续两次 save：历史恰 +2、revision 单调、面板 history 倒序', () => {
    const store = new PersonaStore({ dataDir: dir, logger, db });
    expect(store.save(cardOf({ name: '第一版' })).ok).toBe(true);
    expect(store.save(cardOf({ name: '第二版' })).ok).toBe(true);
    const current = store.current();
    expect(current.name).toBe('第二版');
    expect(current.revision).toBe(3);
    const names = store.history(10).map((card) => card.name);
    expect(names).toEqual(['第一版', '未命名角色']);
    expect(store.findRevision(2)?.name).toBe('第一版');
  });

  it('空表 + 无文件 ⇒ 落一行初始默认卡（后续读不再重跑迁移探测）', () => {
    const store = new PersonaStore({ dataDir: dir, logger, db });
    const current = store.current();
    expect(current.name).toBe('未命名角色');
    const rows = (db!.prepare(`SELECT COUNT(*) AS n FROM persona_current`).get() as { n: number }).n;
    expect(rows).toBe(1);
  });

  it('json→DB 一次性迁移：文件路径写出的卡与历史，换 DB 后原样读回；原文件不动', () => {
    // 先用 db=null 的文件路径写两版（产生 persona.json + jsonl 各一）
    const fileStore = new PersonaStore({ dataDir: dir, logger });
    expect(fileStore.save(cardOf({ name: '文件版一' })).ok).toBe(true);
    expect(fileStore.save(cardOf({ name: '文件版二' })).ok).toBe(true);
    expect(existsSync(join(dir, PERSONA_FILE))).toBe(true);
    expect(existsSync(join(dir, PERSONA_HISTORY_FILE))).toBe(true);

    // 换 DB 存储读：当前卡是"文件版二"，历史里能找到"文件版一"
    const dbStore = new PersonaStore({ dataDir: dir, logger, db });
    expect(dbStore.current().name).toBe('文件版二');
    expect(dbStore.findRevision(2)?.name).toBe('文件版一');
    // 原文件保留（事故现场不删）
    expect(existsSync(join(dir, PERSONA_FILE))).toBe(true);
    expect(existsSync(join(dir, PERSONA_HISTORY_FILE))).toBe(true);
  });

  it('md 写失败只 warn 不回滚：persona.md 被目录占位 ⇒ save 仍 ok、DB 已提交、留一行警告', () => {
    const store = new PersonaStore({ dataDir: dir, logger, db });
    // 用目录占住备份路径：rename 到目录必失败（EPERM/EISDIR），这正是"备份写不进去"的注入形态
    mkdirSync(join(dir, PERSONA_MARKDOWN_FILE));
    const saved = store.save(cardOf());
    expect(saved.ok).toBe(true);
    expect(store.current().name).toBe('小鱼'); // DB 权威已提交
    expect(warns.some((w) => w.includes('persona.md'))).toBe(true);
    expect(statSync(join(dir, 'spirit.db')).isFile()).toBe(true);
  });

  it('坏 card_json 行退默认不炸（与文件读侧同口径）', () => {
    db!.prepare(`INSERT INTO persona_current (singleton, revision, card_json, updated_at) VALUES (1, 5, '{', 1000)`).run();
    const store = new PersonaStore({ dataDir: dir, logger, db });
    expect(store.current().name).toBe('未命名角色');
    expect(warns.some((w) => w.includes('persona_current'))).toBe(true);
  });
});
