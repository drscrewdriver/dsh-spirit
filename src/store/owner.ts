/**
 * 主人背景档案的持久化：**SQLite `owner_profile` 单行表为权威**，
 * 每次成功写入后原子落 `owner.md`（双节人话备份）。
 *
 * 三条不变式：
 * 1. **双段写路径分离**：`setSync()` 只动 sync_text/sync_meta，`setSelf()` 只动
 *    self_text/revision——同一行两列各自 UPDATE，绝不做"整档案对象覆写"，
 *    否则面板改自述与定时同步并发时会互相抹段（persona-set 的 patch 白名单是同课）。
 * 2. **乐观并发只跟自述段走**：`revision` 是面板编辑锚；同步落库**不推进它**——
 *    否则主人正在打字，一次后台同步就会把他的 expectedRevision 凭空作废。
 * 3. **备份滞后于权威可接受**：md 写失败只 warn，不回滚已提交的 DB 行（同 persona.md 纪律）。
 *
 * `db=null` ⇒ 退回 `owner.json` 信封（与 persona 旧路径同口径的降级面），
 * 插件不能因为 SQLite 打不开就连主人是谁都忘了。
 */

import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { SPIRIT_OWNER_FILE_VERSION } from '../contract.js';
import { readJsonTolerant, withFileLock, writeEnvelopedJson } from './json-file.js';
import type { MinimalLogger } from '../persona/store.js';

export const OWNER_FILE = 'owner.json';
export const OWNER_MARKDOWN_FILE = 'owner.md';
/** 自述段字符顶：人手写的背景不该无限长（超了截断，注入预算另有独立的字节顶）。 */
export const OWNER_SELF_TEXT_MAX = 2_000;

export interface OwnerSyncMeta {
  syncedAt: number | null;
  sourceNodes: number;
  degraded: boolean;
}

export interface OwnerProfileRow {
  syncText: string;
  selfText: string;
  syncMeta: OwnerSyncMeta;
  revision: number;
}

const EMPTY_ROW: OwnerProfileRow = {
  syncText: '',
  selfText: '',
  syncMeta: { syncedAt: null, sourceNodes: 0, degraded: false },
  revision: 1,
};

/** 信封/行 → 合法档案（读侧宽容：坏字段退空值，不炸读路径）。 */
function sanitizeRow(raw: unknown): OwnerProfileRow {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_ROW, syncMeta: { ...EMPTY_ROW.syncMeta } };
  const value = raw as Record<string, unknown>;
  const metaRaw = typeof value['syncMeta'] === 'object' && value['syncMeta'] !== null ? (value['syncMeta'] as Record<string, unknown>) : {};
  const syncedAt = typeof metaRaw['syncedAt'] === 'number' && Number.isFinite(metaRaw['syncedAt']) ? metaRaw['syncedAt'] : null;
  return {
    syncText: typeof value['syncText'] === 'string' ? value['syncText'] : '',
    selfText: typeof value['selfText'] === 'string' ? value['selfText'].slice(0, OWNER_SELF_TEXT_MAX) : '',
    syncMeta: {
      syncedAt,
      sourceNodes: typeof metaRaw['sourceNodes'] === 'number' ? Math.max(0, Math.floor(metaRaw['sourceNodes'])) : 0,
      degraded: metaRaw['degraded'] === true,
    },
    revision: typeof value['revision'] === 'number' && value['revision'] >= 1 ? Math.floor(value['revision']) : 1,
  };
}

export class OwnerProfileStore {
  private cached?: OwnerProfileRow;

  constructor(private readonly deps: { dataDir: string; logger: MinimalLogger; db?: DatabaseSync | null }) {}

  private get filePath(): string {
    return join(this.deps.dataDir, OWNER_FILE);
  }

  private get markdownPath(): string {
    return join(this.deps.dataDir, OWNER_MARKDOWN_FILE);
  }

  /** 当前档案；空表落初始行（此后读不再重跑插入探测）。 */
  get(): OwnerProfileRow {
    if (this.cached !== undefined) return this.cached;
    const db = this.deps.db ?? null;
    if (db !== null) {
      const row = db.prepare(`SELECT sync_text, self_text, sync_meta, revision FROM owner_profile WHERE singleton = 1`).get() as
        | { sync_text: string; self_text: string; sync_meta: string; revision: number }
        | undefined;
      if (row !== undefined) {
        this.cached = this.fromColumns(row);
        return this.cached;
      }
      db.prepare(`INSERT OR IGNORE INTO owner_profile (singleton, sync_text, self_text, sync_meta, revision, updated_at) VALUES (1, '', '', '', 1, ?)`)
        .run(Date.now());
      this.cached = { ...EMPTY_ROW, syncMeta: { ...EMPTY_ROW.syncMeta } };
      return this.cached;
    }
    const result = readJsonTolerant<unknown>(this.filePath, SPIRIT_OWNER_FILE_VERSION);
    if (!result.ok) {
      if (result.reason !== 'missing') this.deps.logger.warn(`[spirit] owner.json 不可用（${result.reason}），本次按空档案处理`);
      this.cached = { ...EMPTY_ROW, syncMeta: { ...EMPTY_ROW.syncMeta } };
      return this.cached;
    }
    this.cached = sanitizeRow(result.value);
    return this.cached;
  }

  private fromColumns(row: { sync_text: string; self_text: string; sync_meta: string; revision: number }): OwnerProfileRow {
    let meta: OwnerSyncMeta = { syncedAt: null, sourceNodes: 0, degraded: false };
    try {
      meta = sanitizeRow({ syncMeta: JSON.parse(row.sync_meta) as unknown }).syncMeta;
    } catch {
      /* 坏 meta 退空值：状态行少个时间戳，比读不出整份档案便宜 */
    }
    return { syncText: row.sync_text, selfText: row.self_text.slice(0, OWNER_SELF_TEXT_MAX), syncMeta: meta, revision: row.revision };
  }

  /**
   * 手改自述段：`expectedRevision` 不匹配 ⇒ 拒写（静默覆盖别人正在编辑的自述，
   * 和静默覆盖人设一样难查）。成功 ⇒ revision+1。
   */
  setSelf(text: string, expectedRevision: number): { ok: true; row: OwnerProfileRow } | { ok: false; reason: string } {
    const clean = text.trim().slice(0, OWNER_SELF_TEXT_MAX);
    const db = this.deps.db ?? null;
    if (db !== null) {
      // 先保行再写：空表上 UPDATE 永远 0 行，会被当成“revision 冲突”误拒——
      // 首次手改不经过 get 的调用方（RPC 直接 set-self）就是这条的现场。
      this.get();
      const info = db.prepare(`UPDATE owner_profile SET self_text = ?, revision = revision + 1, updated_at = ? WHERE singleton = 1 AND revision = ?`)
        .run(clean, Date.now(), expectedRevision);
      if (info.changes === 0) {
        return { ok: false, reason: `档案已被更新（expectedRevision ${expectedRevision} 不匹配），请刷新后重试` };
      }
      const row = this.readFresh();
      this.writeMarkdown(row);
      return { ok: true, row };
    }
    return withFileLock(this.deps.dataDir, 'owner', () => {
      const current = this.get();
      if (current.revision !== expectedRevision) {
        return { ok: false as const, reason: `档案已被更新（expectedRevision ${expectedRevision} 不匹配），请刷新后重试` };
      }
      const row: OwnerProfileRow = { ...current, selfText: clean, revision: current.revision + 1 };
      writeEnvelopedJson(this.filePath, SPIRIT_OWNER_FILE_VERSION, row);
      this.cached = row;
      this.writeMarkdown(row);
      return { ok: true as const, row };
    }) ?? { ok: false, reason: '档案文件被占用，本次未写入（可稍后重试）' };
  }

  /**
   * 同步落库：只动 sync_text/sync_meta，**不推进 revision**（自述段的编辑锚
   * 不该被后台同步动）。由调用方保证只在"真的取到了新内容"时调用——
   * 缺席/空图走的是"跳过"，不是"写空"。
   */
  setSync(text: string, meta: OwnerSyncMeta): OwnerProfileRow {
    const db = this.deps.db ?? null;
    if (db !== null) {
      this.get(); // 同 setSelf：先保行，空表 UPDATE 会静默丢写入
      db.prepare(`UPDATE owner_profile SET sync_text = ?, sync_meta = ?, updated_at = ? WHERE singleton = 1`)
        .run(text, JSON.stringify(meta), Date.now());
      const row = this.readFresh();
      this.writeMarkdown(row);
      return row;
    }
    const done = withFileLock(this.deps.dataDir, 'owner', () => {
      const row: OwnerProfileRow = { ...this.get(), syncText: text, syncMeta: meta };
      writeEnvelopedJson(this.filePath, SPIRIT_OWNER_FILE_VERSION, row);
      this.cached = row;
      return row;
    });
    const row = done ?? { ...this.get(), syncText: text, syncMeta: meta };
    this.writeMarkdown(row);
    return row;
  }

  /** 缓存失效后从权威重读（写路径完成后拿最新行，而不是拿调用方递来的半成品）。 */
  private readFresh(): OwnerProfileRow {
    this.cached = undefined;
    return this.get();
  }

  /** 双节人话备份：原子写（tmp+rename），失败只 warn。 */
  private writeMarkdown(row: OwnerProfileRow): void {
    const text = [
      '# 主人档案',
      '',
      '## 同步段',
      row.syncText === '' ? '（尚未同步；装好记忆图谱插件后点「立即同步」）' : row.syncText,
      '',
      '## 主人自述',
      row.selfText === '' ? '（空）' : row.selfText,
      '',
    ].join('\n');
    try {
      const tmp = `${this.markdownPath}.tmp`;
      writeFileSync(tmp, text, 'utf8');
      renameSync(tmp, this.markdownPath);
    } catch (err) {
      this.deps.logger.warn(`[spirit] owner.md 备份写入失败（DB 已提交，不回滚）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
