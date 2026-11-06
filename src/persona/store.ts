/**
 * 人格卡的持久化：**SQLite 为权威**（`persona_current` 单行 + `persona_revision` 全量历史），
 * 每次成功保存后自动写单层人话备份 `persona.md`（主人可读可改可恢复，见 persona/markdown.ts）。
 *
 * 三条不变式：
 * 1. **旧版永不静默覆盖**：写入前把当前生效卡追加进历史（表或 jsonl）——
 *    "人设改坏了"有明确的后退回填路径，而不是靠主人回忆原文重写。
 * 2. **备份滞后于权威可接受，反之不可**：md 写失败只 warn，不回滚已提交的 DB 事务。
 * 3. **DB 缺席时退回文件路径**（与体验库同一条降级纪律）：persona.json/jsonl 原样可用，
 *    插件不能因为 SQLite 打不开就连人设都丢。
 *
 * revision 单调递增，作为稳定区文本的缓存键（revision 未变 ⇒ 不重算，node 0 不动）。
 * 读侧宽容、写侧严格：读坏了退默认人格，写入形状不合法直接拒。
 */

import { closeSync, openSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { SPIRIT_PERSONA_FILE_VERSION } from '../contract.js';
import type { PersonaCard } from '../types.js';
import { readJsonTolerant, withFileLock, writeEnvelopedJson, appendLine } from '../store/json-file.js';
import { renderPersonaMarkdown } from './markdown.js';
import { DEFAULT_PERSONA, validatePersona, sanitizePersona } from './types.js';

export interface MinimalLogger {
  info(message: string): void;
  warn(message: string): void;
}

export const PERSONA_FILE = 'persona.json';
export const PERSONA_HISTORY_FILE = 'persona-history.jsonl';
/** 人设的 markdown 备份（每次成功 save 后重写；也是 import-md 恢复的参考格式）。 */
export const PERSONA_MARKDOWN_FILE = 'persona.md';
/** 历史只读尾部这么多字节（仅 jsonl 降级路径用；DB 路径全量可查）：人手改不了几百次，
 * 但“不会很大”不是不加上界的理由。 */
const HISTORY_TAIL_BYTES = 256 * 1_024;
/** 一次最多回给面板多少条历史。 */
export const PERSONA_HISTORY_MAX = 200;

export class PersonaStore {
  private cached?: PersonaCard;

  constructor(private readonly deps: { dataDir: string; logger: MinimalLogger; db?: DatabaseSync | null }) {}

  private get filePath(): string {
    return join(this.deps.dataDir, PERSONA_FILE);
  }

  private get historyPath(): string {
    return join(this.deps.dataDir, PERSONA_HISTORY_FILE);
  }

  private get markdownPath(): string {
    return join(this.deps.dataDir, PERSONA_MARKDOWN_FILE);
  }

  /** 当前生效卡（带缓存）。DB 在 ⇒ 表为权威（空表时先从文件迁入）；DB 缺席 ⇒ 现行 JSON 路径。 */
  current(): PersonaCard {
    if (this.cached !== undefined) return this.cached;
    const db = this.deps.db ?? null;
    if (db !== null) {
      const row = db.prepare(`SELECT card_json FROM persona_current WHERE singleton = 1`).get() as { card_json?: string } | undefined;
      if (row?.card_json !== undefined) {
        this.cached = this.parseRow(row.card_json);
        return this.cached;
      }
      // 空表：先试文件迁移（升级现场），没文件可迁也落一行初始卡——否则每次读都重跑迁移探测
      const migrated = this.migrateFromFiles();
      const card = migrated ?? { ...DEFAULT_PERSONA };
      db.prepare(`INSERT OR IGNORE INTO persona_current (singleton, revision, card_json, updated_at) VALUES (1, ?, ?, ?)`)
        .run(card.revision, JSON.stringify(card), Date.now());
      this.cached = card;
      return card;
    }
    const result = readJsonTolerant<PersonaCard>(this.filePath, SPIRIT_PERSONA_FILE_VERSION);
    if (!result.ok) {
      if (result.reason !== 'missing') {
        this.deps.logger.warn(`[spirit] persona.json 不可用（${result.reason}），本次退回内置默认人格`);
      }
      this.cached = { ...DEFAULT_PERSONA };
      return this.cached;
    }
    const { persona, fellBack } = sanitizePersona(result.value);
    if (fellBack) this.deps.logger.warn('[spirit] persona.json 形状不符，已退回默认人格（请检查字段名）');
    this.cached = persona;
    return persona;
  }

  /** 行里的 JSON 坏了退默认（与文件读侧同口径）：一张坏行不该把会话拖停。 */
  private parseRow(cardJson: string): PersonaCard {
    try {
      return sanitizePersona(JSON.parse(cardJson) as unknown).persona;
    } catch {
      this.deps.logger.warn('[spirit] persona_current 行解析失败，本次退回内置默认人格');
      return { ...DEFAULT_PERSONA };
    }
  }

  /**
   * 一次性文件→DB 迁移（升级现场）：当前卡进 `persona_current`，jsonl 尾窗历史进
   * `persona_revision`。**原文件一律不动**——它们是天然事故现场，插件不删用户文件。
   *
   * @returns 迁入的当前卡；没 json 可读 ⇒ undefined（调用方落初始默认行）
   */
  private migrateFromFiles(): PersonaCard | undefined {
    const db = this.deps.db;
    if (db === undefined || db === null) return undefined;
    const result = readJsonTolerant<PersonaCard>(this.filePath, SPIRIT_PERSONA_FILE_VERSION);
    if (!result.ok) {
      if (result.reason !== 'missing') this.deps.logger.warn(`[spirit] 迁移时 persona.json 不可用（${result.reason}），落初始默认卡`);
      return undefined;
    }
    const card = sanitizePersona(result.value).persona;
    const now = Date.now();
    // 历史逐条进表：坏行跳过（与 history() 同口径）；OR IGNORE 防与当前卡 revision 撞车
    const insert = db.prepare(`INSERT OR IGNORE INTO persona_revision (revision, card_json, ts_ms) VALUES (?, ?, ?)`);
    let moved = 0;
    for (const line of (this.readHistoryTail() ?? '').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const old = sanitizePersona(JSON.parse(trimmed) as unknown).persona;
        insert.run(old.revision, JSON.stringify(old), now);
        moved += 1;
      } catch {
        /* 坏行跳过：读回一半历史比读不出来更没用 */
      }
    }
    db.prepare(`INSERT OR IGNORE INTO persona_current (singleton, revision, card_json, updated_at) VALUES (1, ?, ?, ?)`)
      .run(card.revision, JSON.stringify(card), now);
    this.deps.logger.info(`[spirit] 人设已从文件迁入数据库（当前卡 rev${card.revision}，历史 ${moved} 条）；原文件保留不动`);
    return card;
  }

  /** 原子写 markdown 备份（tmp+rename）：失败只 warn——备份可滞后，权威不能跟丢。 */
  private writeMarkdownBackup(card: PersonaCard): void {
    try {
      const tmp = `${this.markdownPath}.tmp`;
      writeFileSync(tmp, renderPersonaMarkdown(card), 'utf8');
      renameSync(tmp, this.markdownPath);
    } catch (err) {
      this.deps.logger.warn(`[spirit] persona.md 备份写入失败（DB 已提交，不回滚）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 写入新卡。
   *
   * @param raw 待写形状（未校验；调用方可能是 RPC/文件/测试）
   * @returns 拒绝时给出原因，**不抛**——人设写坏了不该让会话中断
   */
  save(raw: unknown): { ok: true; persona: PersonaCard } | { ok: false; reason: string } {
    const checked = validatePersona(raw);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const previous = this.current();
    const next: PersonaCard = {
      ...checked.persona,
      // revision 只由本层推进：调用方给的值一律取 max(prev+1, 给定值)，防止外部回退它
      revision: Math.max(previous.revision + 1, checked.persona.revision),
    };
    const db = this.deps.db ?? null;
    if (db !== null) {
      // 事务：旧版进历史 + 新版占当前位，两步要么都成要么都不成（只成一半就是丢数据）。
      // 不走 withFileLock：SQLite 的单写者 + WAL 就是这里的锁，文件锁反而是第二套并发协议。
      try {
        db.exec('BEGIN');
        try {
          db.prepare(`INSERT OR IGNORE INTO persona_revision (revision, card_json, ts_ms) VALUES (?, ?, ?)`)
            .run(previous.revision, JSON.stringify(previous), Date.now());
          db.prepare(`INSERT INTO persona_current (singleton, revision, card_json, updated_at) VALUES (1, ?, ?, ?)
            ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision, card_json = excluded.card_json, updated_at = excluded.updated_at`)
            .run(next.revision, JSON.stringify(next), Date.now());
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      } catch (err) {
        return { ok: false, reason: `人设写入数据库失败（已回滚，未提交）：${err instanceof Error ? err.message : String(err)}` };
      }
      this.cached = next;
      this.writeMarkdownBackup(next);
      this.deps.logger.info(`[spirit] 人格已更新至 revision ${next.revision}，旧版已进 persona_revision`);
      return { ok: true, persona: next };
    }
    const done = withFileLock(this.deps.dataDir, 'persona', () => {
      // 旧版先进历史，再覆盖当前：顺序反了就没有回退点
      appendLine(this.historyPath, JSON.stringify(previous));
      writeEnvelopedJson(this.filePath, SPIRIT_PERSONA_FILE_VERSION, next);
      this.cached = next;
      return next;
    });
    if (done === undefined) return { ok: false, reason: '人格文件被占用，本次未写入（可稍后重试）' };
    this.writeMarkdownBackup(done);
    this.deps.logger.info(`[spirit] 人格已更新至 revision ${done.revision}，旧版已留档`);
    return { ok: true, persona: done };
  }

  /** 丢弃缓存（文件被外部编辑后强制重读）。 */
  invalidate(): void {
    this.cached = undefined;
  }

  /**
   * 读历史文件尾部窗口（不存在/不可读 ⇒ null）。
   *
   * 单独一个私有方法是为了让 `history()` 只剩解析：读失败与解析失败是两回事，
   * 前者要报（除 ENOENT），后者逐行静默跳过。
   */
  private readHistoryTail(): string | null {
    try {
      const stat = statSync(this.historyPath);
      const from = Math.max(0, stat.size - HISTORY_TAIL_BYTES);
      const fd = openSync(this.historyPath, 'r');
      let text = '';
      try {
        const buffer = Buffer.alloc(stat.size - from);
        readSync(fd, buffer, 0, buffer.length, from);
        text = buffer.toString('utf8');
      } finally {
        closeSync(fd);
      }
      // 尾部读取会把首行切一截，丢掉到第一个换行符为止
      return from > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } catch (err) {
      const code = (err as { code?: string }).code;
      // 没历史文件是正常初态，不是故障；其它错（权限/磁盘）才留一行痕迹
      if (code !== 'ENOENT') this.deps.logger.warn(`[spirit] 人设历史不可读：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * 读历史卡（**倒序**，最新在前）。DB 在 ⇒ 全量可查；DB 缺席 ⇒ jsonl 尾部窗口原样。
   *
   * 文件路径只读 `HISTORY_TAIL_BYTES`：面板只要“最近几版”；从中间切开的半行会被
   * JSON.parse 拒掉，那正是“坏行跳过”而不是“坏一行全盘皆输”。
   */
  history(limit: number): PersonaCard[] {
    const size = Math.max(1, Math.min(PERSONA_HISTORY_MAX, Math.floor(Number.isFinite(limit) ? limit : 1)));
    const db = this.deps.db ?? null;
    if (db !== null) {
      const rows = db.prepare(`SELECT card_json FROM persona_revision ORDER BY revision DESC LIMIT ?`).all(size) as Array<{ card_json: string }>;
      return rows.map((row) => this.parseRow(row.card_json));
    }
    const text = this.readHistoryTail();
    if (text === null) return [];
    // 256KB 窗口内直接 split/reverse：逐字节反向扫游标看着省，实际是最容易错位的写法
    const out: PersonaCard[] = [];
    for (const line of text.split('\n').reverse()) {
      if (out.length >= size) break;
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        out.push(sanitizePersona(JSON.parse(trimmed) as unknown).persona);
      } catch {
        /* 坏行跳过（包括尾部读取切出来的半行）：读回一半历史比读不出来更没用 */
      }
    }
    return out;
  }

  /**
   * 按 revision 找历史卡（回退用）。
   *
   * DB 路径全量可查；文件路径只在尾部窗口内找（超出窗口的老版本仍在文件里，
   * 但面板不提供“从任意古老版本回退”这个能力，YAGNI）。
   */
  findRevision(revision: number): PersonaCard | undefined {
    const db = this.deps.db ?? null;
    if (db !== null) {
      const row = db.prepare(`SELECT card_json FROM persona_revision WHERE revision = ?`).get(revision) as { card_json?: string } | undefined;
      if (row?.card_json === undefined) return undefined;
      return this.parseRow(row.card_json);
    }
    return this.history(PERSONA_HISTORY_MAX).find((card) => card.revision === revision);
  }
}
