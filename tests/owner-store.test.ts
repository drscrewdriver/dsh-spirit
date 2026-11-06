/**
 * 主人档案存储门禁：双段互不覆盖、乐观并发、md 双节落盘、降级路径。
 *
 * 交叉断言是本文件的中心——"同步抹掉自述"与"手改抹掉同步"都是整对象覆写的
 * 经典事故，两条各堵一次。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { OwnerProfileStore, OWNER_MARKDOWN_FILE, OWNER_SELF_TEXT_MAX } from '../src/store/owner.js';
import { composeOwnerText } from '../src/persona/render.js';

const warns: string[] = [];
const logger = { info: () => {}, warn: (m: string) => void warns.push(m) };

let dir = '';
let db: DatabaseSync | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-owner-'));
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('应打开库成功');
  db = opened.db;
  warns.length = 0;
});
afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('OwnerProfileStore（DB 路径）', () => {
  it('首次 get 落初始行（空档案、revision 1），二次读不再插行', () => {
    const store = new OwnerProfileStore({ dataDir: dir, logger, db });
    const first = store.get();
    expect(first).toEqual({ syncText: '', selfText: '', syncMeta: { syncedAt: null, sourceNodes: 0, degraded: false }, revision: 1 });
    store.get();
    const rows = (db!.prepare(`SELECT COUNT(*) AS n FROM owner_profile`).get() as { n: number }).n;
    expect(rows).toBe(1);
  });

  it('setSync 不动 revision、不碰自述段；md 双节落盘', () => {
    const store = new OwnerProfileStore({ dataDir: dir, logger, db });
    store.setSelf('我是程序员，养了一只鱼', 1);
    const before = store.get();
    const row = store.setSync('小鱼: 主人的代号\n字节: 供职公司', { syncedAt: 1_760_000_000_000, sourceNodes: 2, degraded: false });
    expect(row.selfText).toBe(before.selfText); // 同步不抹自述
    expect(row.revision).toBe(before.revision); // 同步不动编辑锚
    const md = readFileSync(join(dir, OWNER_MARKDOWN_FILE), 'utf8');
    expect(md).toContain('## 同步段');
    expect(md).toContain('## 主人自述');
    expect(md).toContain('我是程序员，养了一只鱼');
    expect(md).toContain('小鱼: 主人的代号');
  });

  it('setSelf：expectedRevision 冲突拒写不盘；成功则 revision+1 且同步段原样', () => {
    const store = new OwnerProfileStore({ dataDir: dir, logger, db });
    store.setSync('同步清单第一行', { syncedAt: 1, sourceNodes: 1, degraded: false });
    const conflict = store.setSelf('别人的写入', 99);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toContain('刷新');
    expect(store.get().selfText).toBe('');
    const saved = store.setSelf('我的写入', 1);
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.row.revision).toBe(2);
      expect(saved.row.syncText).toBe('同步清单第一行'); // 手改不抹同步
    }
  });

  it('自述超长截到 OWNER_SELF_TEXT_MAX（人手写也有顶）', () => {
    const store = new OwnerProfileStore({ dataDir: dir, logger, db });
    const saved = store.setSelf('长'.repeat(OWNER_SELF_TEXT_MAX + 500), 1);
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.row.selfText.length).toBe(OWNER_SELF_TEXT_MAX);
  });

  it('md 写失败只 warn 不回滚：owner.md 被目录占位 ⇒ setSync 仍落库', () => {
    mkdirSync(join(dir, OWNER_MARKDOWN_FILE));
    const store = new OwnerProfileStore({ dataDir: dir, logger, db });
    const row = store.setSync('权威已写', { syncedAt: 2, sourceNodes: 1, degraded: false });
    expect(row.syncText).toBe('权威已写');
    expect(warns.some((w) => w.includes('owner.md'))).toBe(true);
  });
});

describe('OwnerProfileStore（db=null 降级路径）', () => {
  it('信封路径可用：get 初始、setSelf 乐观并发、setSync 交叉不覆盖', () => {
    const store = new OwnerProfileStore({ dataDir: dir, logger });
    expect(store.get().revision).toBe(1);
    store.setSync('文件路同步', { syncedAt: 3, sourceNodes: 1, degraded: true });
    const saved = store.setSelf('文件路自述', 1);
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.row.syncText).toBe('文件路同步');
    expect(store.get().selfText).toBe('文件路自述');
    // 降级路径也落 md 备份（与 DB 路径同纪律）
    expect(readFileSync(join(dir, OWNER_MARKDOWN_FILE), 'utf8')).toContain('文件路自述');
  });

  it('坏 owner.json 退空档案不炸（读侧宽容）', () => {
    const store = new OwnerProfileStore({ dataDir: dir, logger });
    store.setSelf('先写一版', 1);
    writeFileSync(join(dir, 'owner.json'), '{', 'utf8');
    const fresh = new OwnerProfileStore({ dataDir: dir, logger });
    expect(fresh.get().selfText).toBe('');
  });
});

describe('composeOwnerText（注入稳定区）', () => {
  it('两段皆空 ⇒ 空串物理离场；只有同步段也不拼 [主人] 占位行', () => {
    expect(composeOwnerText({ selfText: '', syncText: '   ' }, 400)).toBe('');
    const onlySync = composeOwnerText({ selfText: '', syncText: '小鱼: 代号' }, 400);
    expect(onlySync).toBe('[主人的背景(同步)] 小鱼: 代号');
  });

  it('自述优先、同步段在后；同一档案两次渲染字节全等（纯函数）', () => {
    const profile = { selfText: '我是程序员', syncText: '小鱼: 代号' };
    const a = composeOwnerText(profile, 400);
    expect(a).toBe('[主人] 我是程序员\n[主人的背景(同步)] 小鱼: 代号');
    expect(composeOwnerText(profile, 400)).toBe(a);
  });

  it('预算截在整行边界：装不下同步行就整行消失，不留半句', () => {
    const text = composeOwnerText({ selfText: '我是程序员', syncText: '一条很长的同步清单内容足够超预算' }, 24);
    expect(text).toBe('[主人] 我是程序员');
  });
});
