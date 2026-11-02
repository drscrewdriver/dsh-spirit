/**
 * 迁移登记处 + 正向执行（v1→v2）。
 *
 * 纪律（对齐姊妹包的版本闸口径：宁可拒读，不可静默丢数据）：
 * - 迁移只做**加法**（ADD COLUMN），从不改列型、从不 DROP、从不 DELETE；
 *   v1 行在新列上取 DEFAULT/NULL，读侧必须把「无 salience/gist/feedback」当合法形状。
 * - `PRAGMA table_info` 先查后加：`openSpiritDb` 会先跑迁移再跑幂等建表，重复列不能成为炸点；
 *   反过来全新库由 SCHEMA_STATEMENTS 直接带列建出，迁移整步跳过。
 * - 只允许向前迁移，禁止降级（降级会静默丢新列的数据）。
 */

import type { DatabaseSync } from 'node:sqlite';

import { SPIRIT_DB_SCHEMA_VERSION } from '../contract.js';

/** `from → to` 的单步正向迁移（to = from + 1，链条不允许跳号）。 */
export interface MigrationStep {
  readonly from: number;
  readonly to: number;
  /** 一句人话说明这步改什么，日志与面板都要能看懂。 */
  readonly note: string;
  /** 对库做实际加法变更（必须幂等：列已存在即跳过）。 */
  run: (db: DatabaseSync) => void;
}

function existingColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return new Set(rows.map((r) => r.name ?? ''));
  } catch {
    return new Set();
  }
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (existingColumns(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export const MIGRATIONS: readonly MigrationStep[] = [
  {
    from: 1,
    to: 2,
    note: 'experience 加淡出原料列：salience / gist / feedback_score（全部加法，v1 行取默认）',
    run: (db) => {
      // 淡出原料：salience 是既有的编译期属性（v1 只进打分不落库），v2 落库供窗口回涨复原；
      // gist 编译期派生（禁运行时造句）；feedback_score 人工反馈列（覆写豁免定性见 schema.ts 头注）。
      addColumnIfMissing(db, 'experience', 'salience', 'salience INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'experience', 'gist', 'gist TEXT');
      addColumnIfMissing(db, 'experience', 'feedback_score', 'feedback_score INTEGER');
      // session_ledger / action_bias 是整表新增——交给 SCHEMA_STATEMENTS 的 IF NOT EXISTS，
      // 这里不重复建（同一语句跑两遍是噪音不是保险）。
    },
  },
];

/**
 * 判断能否从 `stored` 升到本包版本。
 *
 * @returns `ok:true` 时 `steps` 为待执行序列（可能为空）；`ok:false` 时调用方**必须拒读**，
 *          不允许"先按现有表凑合读"——那正是丢数据的开始。
 */
export function planMigration(stored: number): { ok: true; steps: MigrationStep[] } | { ok: false; reason: string } {
  if (stored === SPIRIT_DB_SCHEMA_VERSION) return { ok: true, steps: [] };
  // 先看方向：高于本包 ⇒ 该升级插件，而不是找迁移路径
  if (stored > SPIRIT_DB_SCHEMA_VERSION) {
    return { ok: false, reason: `库版本 ${stored} 高于本插件支持的 ${SPIRIT_DB_SCHEMA_VERSION}：请升级插件` };
  }
  // 低于本包 ⇒ 只允许向前逐跳，链断即拒读（不猜、不凑合读）
  const chain: MigrationStep[] = [];
  let cursor = stored;
  for (;;) {
    const next = MIGRATIONS.find((step) => step.from === cursor);
    if (next === undefined) {
      return { ok: false, reason: `库版本 ${stored} 没有可达 ${SPIRIT_DB_SCHEMA_VERSION} 的迁移路径：拒绝按现有表凑合读（那正是丢数据的开始）` };
    }
    chain.push(next);
    cursor = next.to;
    if (cursor === SPIRIT_DB_SCHEMA_VERSION) return { ok: true, steps: chain };
    if (cursor > SPIRIT_DB_SCHEMA_VERSION) {
      return { ok: false, reason: `迁移链会越过本插件支持的 ${SPIRIT_DB_SCHEMA_VERSION}：拒执行` };
    }
  }
}

/** 按序执行计划（调用方先过 planMigration 的方向闸；这里只管执行）。 */
export function runMigration(db: DatabaseSync, steps: readonly MigrationStep[]): void {
  for (const step of steps) step.run(db);
}
