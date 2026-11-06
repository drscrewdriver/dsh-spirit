/**
 * SQLite schema 单源（v0.3.5 = schema v6：长觉阶梯五张派生表）。
 *
 * 三条例外要先说明，避免后来者以为是“没做完”：
 * 1. **不建 FTS5 虚表**：条目规模就是事件数量级（每轮最多一条，且被 salience 筛掉
 *    一部分），小表打分 + 近因权重足够；等实测不达标再补索引，不预开工。
 * 2. **无 DELETE 路径**：更正走“插新行 + 旧行置 `superseded_by`”，旧行永远读得回来
 *    （可回滚优先）。清理不在本文件，在 `store/journal-retention.ts`，且默认干跑。
 * 3. `ts_ms` 只服务衰减与排序，**禁止**进任何对外文本。
 *
 * v2 新增的非 append-only 真源例外（gates 的 UPDATE-experience 列白名单实闸逐列放行，
 * 见 tests/gates.test.ts「写面收敛与风格纪律实闸」；白名单外的列被 UPDATE 即红）：
 * - `experience.feedback_score`：人工反馈列，可覆写（prime recall-usage 同构：只重排
 *   不改写派生分；条目本体 text/salience/gist 仍不可变）。
 * - `experience.hidden_at`（v5）：「藏起来」标记列，可覆写可清空（翻阅 tab 的管理动作；
 *   行永不物理删，红线闸不变）。
 * - `action_bias`：**可重算派生缓存**非经历真源（turn/end 冷路径 upsert；append-only
 *   会无界增长且与“短期抑制”的时效语义矛盾）。删光可从 experience 重建。
 * - `persona_current`（v3）：**当前生效卡的换代位**，CHECK(singleton=1) 钉死单行——
 *   形状即约束，误插第二行直接 SQL 报错，比“读第一行”的隐式约定诚实。
 *   `persona_revision`（v3）严格 append-only：save 前旧卡入表，无 UPDATE/DELETE 路径。
 * - `owner_profile`（v4）：主人背景档案单行表（同 persona_current 豁免定性：双段各自
 *   可覆写，但写路径分离——setSync 只动 sync_text、setSelf 只动 self_text，互不抹段）。
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
     feedback_score INTEGER,
     hidden_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS exp_session_ts ON experience (session_id, ts_ms)`,
  `CREATE INDEX IF NOT EXISTS exp_workspace_session ON experience (workspace_id, session_id)`,
  `CREATE INDEX IF NOT EXISTS exp_lane_ts ON experience (lane, ts_ms)`,
  // 取代链反查：这条被谁取代 / 谁取代了这条（不建就是每次全表扫）
  `CREATE INDEX IF NOT EXISTS exp_superseded ON experience (superseded_by)`,
  // 翻阅 tab（v5）：全库按时间分页的主查询形状（ORDER BY ts_ms DESC LIMIT/OFFSET），
  // 本库只增不删，不补这张索引这条查询会随使用时长单调变慢。
  `CREATE INDEX IF NOT EXISTS exp_ts ON experience (ts_ms)`,
  // 筛选器暴露的维度配齐索引才上线（Agent B 裁决：暴露即补索引，不做无索引版本）
  `CREATE INDEX IF NOT EXISTS exp_trigger_ts ON experience (trigger, ts_ms)`,
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
  // 人设（v3）：当前卡单行表 + append-only 全量历史（替代 persona.json/jsonl 的写面；
  // 文件路径保留为 db=null 降级面与首次迁移源，见 persona/store.ts）。
  `CREATE TABLE IF NOT EXISTS persona_current (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     revision INTEGER NOT NULL,
     card_json TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS persona_revision (
     revision INTEGER PRIMARY KEY,
     card_json TEXT NOT NULL,
     ts_ms INTEGER NOT NULL
   )`,
  // 主人背景档案（v4）：双段各列分写（同步段机器覆盖、自述段主人手写）；sync_meta 的
  // 时间只进面板状态行，禁入注入文本（稳定区纪律）。
  `CREATE TABLE IF NOT EXISTS owner_profile (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     sync_text TEXT NOT NULL DEFAULT '',
     self_text TEXT NOT NULL DEFAULT '',
     sync_meta TEXT NOT NULL DEFAULT '',
     revision INTEGER NOT NULL DEFAULT 1,
     updated_at INTEGER NOT NULL
   )`,
  // ── 长觉阶梯（v6）：主题分区 + 蒸馏记忆 + 因果边 + 长觉任务态 ──
  // 定性（五表同一口径）：**可重算派生缓存，非经历真源**（action_bias 同构）——
  // 允许 REPLACE/DELETE（整表重算），但绝不进 recent()/deriveMood/注入（G15 实闸）。
  // 主题分区：确定性骨架（heuristic）与长觉归题（distilled）两源同表；改判写新关联行非 UPDATE 真源。
  `CREATE TABLE IF NOT EXISTS topic (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     origin TEXT NOT NULL DEFAULT 'heuristic',
     status TEXT NOT NULL DEFAULT 'active',
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS experience_topic (
     topic_id TEXT NOT NULL,
     entry_id TEXT NOT NULL,
     origin TEXT NOT NULL DEFAULT 'heuristic',
     superseded_at INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS topic_entry ON experience_topic (entry_id, superseded_at)`,
  `CREATE INDEX IF NOT EXISTS topic_topic ON experience_topic (topic_id)`,
  // 蒸馏记忆：≤120 字的主题级洞察；status 四态（active/conflict/stale/superseded）；
  // conflict 双留等人工裁决，机器绝不自动删（evidence_json 指回体验条目 id 数组）。
  `CREATE TABLE IF NOT EXISTS insight (
     id TEXT PRIMARY KEY,
     topic_id TEXT NOT NULL,
     text TEXT NOT NULL,
     evidence_json TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'active',
     superseded_by TEXT,
     source_run TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS insight_topic_status ON insight (topic_id, status)`,
  // 因果边：启发式打底 + LLM 投影双源同表；relation 是开放词表（只钳长度不白名单），
  // 因果四词单源见 types.ts SPIRIT_CAUSAL_RELATIONS。
  `CREATE TABLE IF NOT EXISTS causal_edge (
     id TEXT PRIMARY KEY,
     from_entry TEXT NOT NULL,
     to_entry TEXT NOT NULL,
     relation TEXT NOT NULL,
     origin TEXT NOT NULL DEFAULT 'heuristic',
     evidence_json TEXT NOT NULL DEFAULT '[]',
     confidence INTEGER NOT NULL DEFAULT 500,
     source_run TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS edge_from ON causal_edge (from_entry)`,
  `CREATE INDEX IF NOT EXISTS edge_to ON causal_edge (to_entry)`,
  // 长觉任务态：进度/取消/失败回执（面板轮询面，不进注入）。
  `CREATE TABLE IF NOT EXISTS sleep_run (
     id TEXT PRIMARY KEY,
     started_at INTEGER NOT NULL,
     finished_at INTEGER,
     phase TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '',
     error TEXT NOT NULL DEFAULT '',
     model TEXT NOT NULL DEFAULT '',
     stats_json TEXT NOT NULL DEFAULT '{}'
   )`,
  // 向量能力位（缺省关）：BLOB 存 Float32Array（包体闸锁死 sqlite-vec，零新依赖）；
  // 可再生物化：删光不丢信息，source_hash 对账防文本变更后陈旧向量（关闸期条目重开必补）。
  `CREATE TABLE IF NOT EXISTS entry_vector (
     entry_id TEXT PRIMARY KEY,
     dim INTEGER NOT NULL,
     source_hash TEXT NOT NULL,
     vec BLOB NOT NULL,
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
