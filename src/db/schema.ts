/**
 * SQLite schema 单源（v0.2 = schema v2）。
 *
 * 三条例外要先说明，避免后来者以为是“没做完”：
 * 1. **不建 FTS5 虚表**：条目规模就是事件数量级（每轮最多一条，且被 salience 筛掉
 *    一部分），小表打分 + 近因权重足够；等实测不达标再补索引，不预开工。
 * 2. **无 DELETE 路径**：更正走“插新行 + 旧行置 `superseded_by`”，旧行永远读得回来
 *    （可回滚优先）。清理不在本文件，在 `store/journal-retention.ts`，且默认干跑。
 * 3. `ts_ms` 只服务衰减与排序，**禁止**进任何对外文本。
 *
 * v2 新增的两处「非 append-only 真源」例外（都在本文件注释定性，gates 的无-UPDATE
 * 断言对它们逐表豁免）：
 * - `experience.feedback_score`：人工反馈列，可覆写（prime recall-usage 同构：只重排
 *   不改写派生分；条目本体 text/salience/gist 仍不可变）。
 * - `action_bias`：**可重算派生缓存**非经历真源（turn/end 冷路径 upsert；append-only
 *   会无界增长且与“短期抑制”的时效语义矛盾）。删光可从 experience 重建。
 */

/** 建表语句按顺序执行（`meta` 先建，版本判定要在建表前后各读一次）。 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS experience (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     workspace_id TEXT NOT NULL,
     turn_seq INTEGER NOT NULL,
     ts_ms INTEGER NOT NULL,
     trigger TEXT NOT NULL,
     notice TEXT NOT NULL,
     reaction TEXT NOT NULL,
     text TEXT NOT NULL,
     fact_json TEXT NOT NULL,
     lane TEXT NOT NULL,
     source_ref TEXT,
     persona_revision INTEGER NOT NULL,
     superseded_by TEXT,
     updated_at INTEGER NOT NULL,
     salience INTEGER NOT NULL DEFAULT 0,
     gist TEXT,
     feedback_score INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS exp_session_ts ON experience (session_id, ts_ms)`,
  `CREATE INDEX IF NOT EXISTS exp_workspace_session ON experience (workspace_id, session_id)`,
  `CREATE INDEX IF NOT EXISTS exp_lane_ts ON experience (lane, ts_ms)`,
  // 取代链反查：这条被谁取代 / 谁取代了这条（不建就是每次全表扫）
  `CREATE INDEX IF NOT EXISTS exp_superseded ON experience (superseded_by)`,
  `CREATE TABLE IF NOT EXISTS experience_cues (
     entry_id TEXT NOT NULL,
     cue TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS cue_entry ON experience_cues (entry_id)`,
  // 检索段的主入口：按 cue 值找条目 id
  `CREATE INDEX IF NOT EXISTS cue_value ON experience_cues (cue)`,
  `CREATE TABLE IF NOT EXISTS mood_state (
     session_id TEXT PRIMARY KEY,
     valence TEXT NOT NULL,
     arousal TEXT NOT NULL,
     label TEXT NOT NULL,
     revision INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // 未竟账（v2）：基元=session（一会话一行，被更晚结算行 supersede）。
  // ⚠️ 禁入 experience：deriveMood 会对条目计权，未竟入账=伪造情绪输入（红线）。
  `CREATE TABLE IF NOT EXISTS session_ledger (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     workspace_id TEXT NOT NULL,
     ts_ms INTEGER NOT NULL,
     turn_seq INTEGER NOT NULL,
     open_band INTEGER NOT NULL,
     in_progress_band INTEGER NOT NULL,
     superseded_by TEXT,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ledger_workspace_ts ON session_ledger (workspace_id, ts_ms)`,
  `CREATE INDEX IF NOT EXISTS ledger_superseded ON session_ledger (superseded_by)`,
  // 条件化 bias（v2）：派生缓存表，允许 upsert（见文件头定性）。
  `CREATE TABLE IF NOT EXISTS action_bias (
     workspace_id TEXT NOT NULL,
     action_key TEXT NOT NULL,
     band INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (workspace_id, action_key)
   )`,
];

/** `meta` 里的 schema 版本键。 */
export const META_KEY_SCHEMA_VERSION = 'db_schema_version';
/** `meta` 里的最小条目数计数键（stats 免扫全表）。 */
export const META_KEY_ENTRY_COUNT = 'entry_count';

/**
 * 执行建表。
 *
 * ⚠️ 这里的 `runDdl` 是 SQLite 语句执行器（`DatabaseSync.exec`），**不是** shell 命令；
 * 语句全部来自本文件的常量数组，无任何用户输入拼接（DDL 不能参数化，所以靠"零插值"保证安全）。
 */
export function applySchema(runDdl: (sql: string) => void): void {
  for (const statement of SCHEMA_STATEMENTS) runDdl(statement);
}
