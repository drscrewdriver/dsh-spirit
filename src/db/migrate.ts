/**
 * 迁移登记处 + 正向执行（v1→v7）。
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
import { V7_TXN_STATEMENTS, V8_ONTOLOGY_STATEMENTS } from './schema.js';

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
  {
    from: 2,
    to: 3,
    note: '人设进库：persona_current / persona_revision 两张新表（整表新增，交给 SCHEMA_STATEMENTS 幂等建表）',
    run: () => {
      // 故意 no-op：v3 只加两张新表，建表由 applySchema 统一做；
      // 这一步的存在是为了版本链不断（缺登记 ⇒ planMigration 链断 ⇒ 老库整体拒读）。
    },
  },
  {
    from: 3,
    to: 4,
    note: '主人背景档案进库：owner_profile 单行表（整表新增，交给 SCHEMA_STATEMENTS 幂等建表）',
    run: () => {
      // 故意 no-op：同 v2→v3 先例——纯加表由幂等建表覆盖，链步只保版本链不断。
    },
  },
  {
    from: 4,
    to: 5,
    note: '翻阅 tab：experience 加藏起标记列 hidden_at（可覆写可清空，行永不物理删；新索引交给幂等建表）',
    run: (db) => {
      addColumnIfMissing(db, 'experience', 'hidden_at', 'hidden_at INTEGER');
      // exp_ts / exp_trigger_ts 是纯加索引：SCHEMA_STATEMENTS 的 IF NOT EXISTS 统一覆盖，
      // 这里不重复建（同 v2→v3 加表先例：链步只保列不缺，索引交给幂等面）。
    },
  },
  {
    from: 5,
    to: 6,
    note: '长觉阶梯：topic/experience_topic/insight/causal_edge/sleep_run 五张派生表（整表新增，交给幂等建表；派生可重建定性见 schema 头注）',
    run: () => {
      // 故意 no-op：同 v2→v3/v3→v4 先例——纯加表由幂等建表覆盖，链步只保版本链不断。
    },
  },
  {
    from: 6,
    to: 7,
    note: '事务轨：txn_entry + txn_cues 两张表（工作记忆真源域，定性见 schema 头注）——本步显式执行 v7 子集，保证老库走迁移路也能建出',
    run: (db) => {
      // 与 applySchema 同一份语句（V7_TXN_STATEMENTS 从主数组筛出），IF NOT EXISTS 幂等：
      // 老库路径 = 迁移先建、建表后到；新库路径 = 建表直接带出。跑两遍不会成炸点。
      for (const statement of V7_TXN_STATEMENTS) db.exec(statement);
    },
  },
  {
    from: 7,
    to: 8,
    note: '本体层：txn_entry 加 delivery 列（superseded_by/salience_tier/turn_start_ms/turn_end_ms）+ entity/delivery_entity/entity_edge/task/task_delivery/evaluation 六表（整表新增走幂等建表）',
    run: (db) => {
      // 老 v7 库：txn_entry 已存在但缺新列 ⇒ addColumnIfMissing 逐列补上（v1 行取 DEFAULT/NULL，读侧当合法形状）；
      // 六张本体表是纯新表 ⇒ 显式执行 V8 子集（IF NOT EXISTS 幂等，与 applySchema 同一份语句）。
      addColumnIfMissing(db, 'txn_entry', 'superseded_by', 'superseded_by TEXT');
      addColumnIfMissing(db, 'txn_entry', 'salience_tier', 'salience_tier INTEGER NOT NULL DEFAULT 2');
      addColumnIfMissing(db, 'txn_entry', 'turn_start_ms', 'turn_start_ms INTEGER');
      addColumnIfMissing(db, 'txn_entry', 'turn_end_ms', 'turn_end_ms INTEGER');
      for (const statement of V8_ONTOLOGY_STATEMENTS) db.exec(statement);
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
