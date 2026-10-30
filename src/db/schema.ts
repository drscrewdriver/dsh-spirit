/**
 * SQLite schema 单源（v0.1）。
 *
 * 三条例外要先说明，避免后来者以为是"没做完"：
 * 1. **不建 FTS5 虚表**：条目规模就是事件数量级（每轮最多一条，且被 salience 筛掉
 *    一部分），小表打分 + 近因权重足够；等实测不达标再补索引，不预开工。
 * 2. **无 DELETE 路径**：更正走"插新行 + 旧行置 `superseded_by`"，旧行永远读得回来
 *    （可回滚优先）。清理不在本文件，在 `store/journal-retention.ts`，且默认干跑。
 * 3. `ts_ms` 只服务衰减与排序，**禁止**进任何对外文本。
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
     updated_at INTEGER NOT NULL
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
