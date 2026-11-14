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
import { randomUUID } from 'node:crypto';

import { SPIRIT_DB_SCHEMA_VERSION } from '../contract.js';
import { V10_ECHO_STATEMENTS, V13_ECHO_TIME_INDEXES, V15_ECHO_REF_STATEMENTS, V16_ECHO_IDENTITY_STATEMENTS, V17_DIGEST_STATEMENTS, V18_DIGEST_STATEMENTS, V19_SEARCH_STATEMENTS, V7_TXN_STATEMENTS, V8_ONTOLOGY_STATEMENTS, V9_MEMORY_STATEMENTS } from './schema.js';

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
  {
    from: 8,
    to: 9,
    note: '模型可写记忆与目的层：model_memory（scope=life/work/diary）+ goal 两张表（整表新增走幂等建表）',
    run: (db) => {
      // 纯加表：显式执行 v9 子集（IF NOT EXISTS 幂等，与 applySchema 同一份语句）
      for (const statement of V9_MEMORY_STATEMENTS) db.exec(statement);
    },
  },
  {
    from: 9,
    to: 10,
    note: '回响落档：echo_step（注入决策）+ echo_recall（被召回的回响段）两张表（整表新增走幂等建表）',
    run: (db) => {
      // 纯加表：显式执行 v10 子集（IF NOT EXISTS 幂等，与 applySchema 同一份语句）。
      // 回响是「本会话的回响段」，重启不能归零；进程内 EchoLog 继续当观测灯，两者不互相冒充。
      for (const statement of V10_ECHO_STATEMENTS) db.exec(statement);
    },
  },
  {
    from: 10,
    to: 11,
    note: '回响条目带摘要：echo_step 加 preview 列（侧栏一行摘要，不存整张注入卡）',
    run: (db) => {
      // 加法列：老库 v10 行取默认空串（读侧当“无摘要”合法形状）。
      addColumnIfMissing(db, 'echo_step', 'preview', "preview TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    from: 11,
    to: 12,
    note: '回响条目给编号与原文：echo_step 加 id / text 两列（旧行按 ts_ms 回填编号，原文留空）',
    run: (db) => {
      // 旧行没有原文可补（当时未存），只能把编号回填上；读侧把空原文当“早期条目（无原文）”。
      addColumnIfMissing(db, 'echo_step', 'id', "id TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'echo_step', 'text', "text TEXT NOT NULL DEFAULT ''");
      db.exec(`UPDATE echo_step SET id = 'echo-' || ts_ms WHERE id = ''`);
    },
  },
  {
    from: 12,
    to: 13,
    note: '回响条目时间反查索引：txn_entry(card_line) + task(title)——回响页把分段行回查到真源时刻，没索引就是全表扫',
    run: (db) => {
      // 纯加索引：IF NOT EXISTS 幂等，与 applySchema 同一份语句。
      for (const statement of V13_ECHO_TIME_INDEXES) db.exec(statement);
    },
  },
  {
    from: 13,
    to: 14,
    note: '回响条目内容优先：echo_step 加 title（如线程任务名）与 refs_json（memid 引用）两列',
    run: (db) => {
      // 加法列：老行取默认空串/空数组（读侧退到 preview，不编造）
      addColumnIfMissing(db, 'echo_step', 'title', "title TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'echo_step', 'refs_json', "refs_json TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    from: 14,
    to: 15,
    note: '回响引用记录：echo_ref 表（echo:<kind>:<id> 映射编号，跨轮合并 times）两索引——echo-id ≡ memid',
    run: (db) => {
      // 纯加表：显式执行 v15 子集（IF NOT EXISTS 幂等，与 applySchema 同一份语句）
      for (const statement of V15_ECHO_REF_STATEMENTS) db.exec(statement);
    },
  },
  {
    from: 15,
    to: 16,
    note: '编号重整：记录持 echo-<uuid>（echo_identity 注册表去重）、回响持 recall-<uuid>；echo_ref 加 record_ts、echo_step 加 flashback；旧行重编号（幂等）',
    run: (db) => {
      addColumnIfMissing(db, 'echo_ref', 'record_ts', 'record_ts INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'echo_step', 'flashback', 'flashback INTEGER NOT NULL DEFAULT 0');
      for (const statement of V16_ECHO_IDENTITY_STATEMENTS) db.exec(statement);

      const claimEchoId = (kind: string, memId: string): string => {
        const found = db.prepare(`SELECT echo_id FROM echo_identity WHERE kind = ? AND mem_id = ? LIMIT 1`).get(kind, memId) as { echo_id?: unknown } | undefined;
        if (typeof found?.echo_id === 'string' && found.echo_id !== '') return found.echo_id;
        const fresh = `echo-${randomUUID()}`;
        db.prepare(
          `INSERT INTO echo_identity (echo_id, kind, mem_id, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(kind, mem_id) DO NOTHING`,
        ).run(fresh, kind, memId, Date.now());
        const after = db.prepare(`SELECT echo_id FROM echo_identity WHERE kind = ? AND mem_id = ? LIMIT 1`).get(kind, memId) as { echo_id?: unknown } | undefined;
        return typeof after?.echo_id === 'string' && after.echo_id !== '' ? after.echo_id : fresh;
      };

      // 1) 旧引用号 echo:<kind>:<id> → echo-<uuid>（同一条记录领同一号）；冲突则删旧行保新行
      const legacyRefs = db.prepare(
        `SELECT session_id, ref_id, kind, mem_id FROM echo_ref WHERE ref_id LIKE 'echo:%'`,
      ).all() as Array<{ session_id?: string; ref_id?: string; kind?: string; mem_id?: string }>;
      for (const row of legacyRefs) {
        const sessionId = String(row.session_id ?? '');
        const oldId = String(row.ref_id ?? '');
        const kind = String(row.kind ?? '');
        const memId = String(row.mem_id ?? '');
        if (sessionId === '' || oldId === '' || kind === '' || memId === '') continue;
        const echoId = claimEchoId(kind, memId);
        try {
          db.prepare(`UPDATE echo_ref SET ref_id = ? WHERE session_id = ? AND ref_id = ?`).run(echoId, sessionId, oldId);
        } catch {
          // 新号行已存在（上次跑到一半）：合并次数/时间包络后删旧行，不丢数据
          const oldRow = db.prepare(
            `SELECT times, first_ts, last_ts FROM echo_ref WHERE session_id = ? AND ref_id = ?`,
          ).get(sessionId, oldId) as { times?: number; first_ts?: number; last_ts?: number } | undefined;
          if (oldRow !== undefined) {
            db.prepare(
              `UPDATE echo_ref SET
                 times = times + ?,
                 first_ts = MIN(first_ts, ?),
                 last_ts = MAX(last_ts, ?)
               WHERE session_id = ? AND ref_id = ?`,
            ).run(Number(oldRow.times) || 1, Number(oldRow.first_ts) || 0, Number(oldRow.last_ts) || 0, sessionId, echoId);
          }
          db.prepare(`DELETE FROM echo_ref WHERE session_id = ? AND ref_id = ?`).run(sessionId, oldId);
        }
      }

      // 2) 旧轮次号 echo-<ts> → recall-<uuid>（逐行一个）；收集映射供第 3 步同步
      const legacySteps = db.prepare(
        `SELECT session_id, ts_ms, id FROM echo_step WHERE id LIKE 'echo-%'`,
      ).all() as Array<{ session_id?: string; ts_ms?: number; id?: string }>;
      const stepMap = new Map<string, string>();
      for (const row of legacySteps) {
        const sessionId = String(row.session_id ?? '');
        const oldId = String(row.id ?? '');
        if (oldId === '') continue;
        const recallId = `recall-${randomUUID()}`;
        db.prepare(`UPDATE echo_step SET id = ? WHERE session_id = ? AND ts_ms = ?`).run(recallId, sessionId, Number(row.ts_ms) || 0);
        stepMap.set(oldId, recallId);
      }
      // 3) 引用行的 last_echo_step_id 同步成 recall 号
      for (const [oldId, recallId] of stepMap) {
        db.prepare(`UPDATE echo_ref SET last_echo_step_id = ? WHERE last_echo_step_id = ?`).run(recallId, oldId);
      }
      // 4) record_ts 补默认（旧行取 first_ts；再不行取 last_ts）
      db.exec(`UPDATE echo_ref SET record_ts = CASE WHEN first_ts > 0 THEN first_ts ELSE last_ts END WHERE record_ts = 0`);
    },
  },
  {
    from: 16,
    to: 17,
    note: '生涯流程预总结档：distill_digest（上游 L1 只作输入，知识性归上游，spirit 只落流程档）',
    run: (db) => {
      // 纯加表：显式执行 v17 子集（IF NOT EXISTS 幂等，与 applySchema 同一份语句）
      for (const statement of V17_DIGEST_STATEMENTS) db.exec(statement);
    },
  },
  {
    from: 17,
    to: 18,
    note: '生涯档三档化（week/month/milestone）+ 实体双向对齐三表；旧档重建为 (category,tier,period_key) 主键并回填 week/ISO 周',
    run: (db) => {
      const isoWeek = (ms: number): string => {
        const date = new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now());
        const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
        const dayNum = target.getUTCDay() === 0 ? 7 : target.getUTCDay();
        target.setUTCDate(target.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
        const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
        return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
      };
      // v17 的主键是 (category, window_days)，三档需要 (category, tier, period_key) ⇒ 重建表
      const legacyRows = db.prepare(`SELECT * FROM distill_digest`).all() as Array<Record<string, unknown>>;
      db.exec(`DROP TABLE IF EXISTS distill_digest_new`);
      db.exec(`CREATE TABLE distill_digest_new (
        category TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'week',
        period_key TEXT NOT NULL DEFAULT '',
        window_days INTEGER NOT NULL,
        generated_at INTEGER NOT NULL,
        period_start TEXT NOT NULL DEFAULT '',
        period_end TEXT NOT NULL DEFAULT '',
        count INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL DEFAULT '',
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        entities_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (category, tier, period_key)
      )`);
      const insert = db.prepare(
        `INSERT OR REPLACE INTO distill_digest_new
         (category, tier, period_key, window_days, generated_at, period_start, period_end, count, summary, source_ids_json, entities_json)
         VALUES (?, 'week', ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
      );
      for (const row of legacyRows) {
        insert.run(
          String(row['category'] ?? 'procedural'),
          isoWeek(Number(row['generated_at']) || Date.now()),
          Number(row['window_days']) || 7,
          Number(row['generated_at']) || Date.now(),
          String(row['period_start'] ?? ''),
          String(row['period_end'] ?? ''),
          Number(row['count']) || 0,
          String(row['summary'] ?? ''),
          String(row['source_ids_json'] ?? '[]'),
        );
      }
      db.exec(`DROP TABLE distill_digest`);
      db.exec(`ALTER TABLE distill_digest_new RENAME TO distill_digest`);
      for (const statement of V18_DIGEST_STATEMENTS) db.exec(statement);
    },
  },
  {
    from: 18,
    to: 19,
    note: '检索索引：search_doc 登记表（FTS 虚表由 search/index.ts 运行时建）+ echo_step 加负样本观测列 rejected_json',
    run: (db) => {
      // 纯加表：显式执行 v19 子集（IF NOT EXISTS 幂等，与 applySchema 同一份语句）。
      // FTS 虚表**不**在这里建：它依赖 SQLite 版本，建不出来只该失去检索质量，
      // 而不是让迁移抛错导致整库拒开（openSpiritDb 会把任何异常判成降级）。
      for (const statement of V19_SEARCH_STATEMENTS) db.exec(statement);
      // 召回负样本观测列（P0）：旧行取默认空数组，读侧当合法形状。
      addColumnIfMissing(db, 'echo_step', 'rejected_json', "rejected_json TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    from: 19,
    to: 20,
    note: '里程碑失效标注：distill_digest 加派生列 stale_at（NULL = 无证据/仍有效；只影响展示）',
    run: (db) => {
      addColumnIfMissing(db, 'distill_digest', 'stale_at', 'stale_at INTEGER');
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
