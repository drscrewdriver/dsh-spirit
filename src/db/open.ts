/**
 * 打开 spirit 自有 SQLite 并落 schema。
 *
 * 版本纪律（跨代次混用是姊妹包明确踩过的坑："旧插件无法打开新 schema，请勿混用版本"）：
 * - 库内版本 **高于** 本包支持的版本 ⇒ 明确抛错拒读。静默按旧形状读会读到不认识的列，
 *   最坏结果是"看起来能用，其实每条都在丢数据"。
 * - 库内版本 **低于** 本包版本且无迁移路径 ⇒ 同样明确抛错（v0.1 只有版本 1，不存在降级迁移）。
 * - 空库 ⇒ 建表并写版本号。
 *
 * 定位失败（拿不到 home 目录）**明确拒绝**，不猜路径——猜出来的目录会把条目写进
 * 一个没人知道的地方，比报错更难查。
 */

import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { SPIRIT_DB_SCHEMA_VERSION } from '../contract.js';
import { applySchema, META_KEY_SCHEMA_VERSION } from './schema.js';

/** 打开结果：`ok:false` 时由调用方走 `decideDegrade` 降级，不抛穿宿主。 */
export type OpenResult = { ok: true; db: DatabaseSync; path: string } | { ok: false; err: unknown };

export const DB_FILE_NAME = 'spirit.db';

/** schema 版本不符（单向拒读，不做静默兼容）。 */
export class SchemaVersionError extends Error {
  constructor(stored: number, supported: number) {
    super(
      stored > supported
        ? `库 schema 版本 ${stored} 高于本插件支持的 ${supported}：请升级插件，拒绝按旧形状读写`
        : `库 schema 版本 ${stored} 低于本插件的 ${supported} 且无迁移路径：v0.1 不提供降级迁移`,
    );
    this.name = 'SchemaVersionError';
  }
}

function readVersion(db: DatabaseSync): number | undefined {
  const row = db
    .prepare(`SELECT value FROM meta WHERE key = ?`)
    .get(META_KEY_SCHEMA_VERSION) as { value?: string } | undefined;
  const raw = row?.value;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function writeVersion(db: DatabaseSync, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(META_KEY_SCHEMA_VERSION, String(version));
}

/**
 * 打开并初始化库。
 *
 * @param dataDir 已解析的数据目录（`resolveDataDir` 的产物）
 */
export function openSpiritDb(dataDir: string): OpenResult {
  if (dataDir.trim() === '') return { ok: false, err: new Error('无法确定 spirit 数据目录，拒绝猜测路径') };
  try {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, DB_FILE_NAME);
    const db = new DatabaseSync(path);
    // WAL：宿主是多会话并发读、单写；journal 默认模式下并发读会撞 BUSY
    db.exec('PRAGMA journal_mode = WAL');
    applySchema((sql) => db.exec(sql));
    const stored = readVersion(db);
    if (stored === undefined) {
      writeVersion(db, SPIRIT_DB_SCHEMA_VERSION);
    } else if (stored !== SPIRIT_DB_SCHEMA_VERSION) {
      db.close();
      return { ok: false, err: new SchemaVersionError(stored, SPIRIT_DB_SCHEMA_VERSION) };
    }
    return { ok: true, db, path };
  } catch (err) {
    return { ok: false, err };
  }
}

/** 读库内已存的 schema 版本（测试与诊断面用；库不可用时返回 undefined）。 */
export function readStoredVersion(db: DatabaseSync): number | undefined {
  return readVersion(db);
}
