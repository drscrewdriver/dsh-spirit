/**
 * SQLite schema 单源（v0.3.5 = schema v6：长觉阶梯五张派生表；v7 = 事务轨两张表；v8 = 本体层：扩 txn_entry 为 delivery + 六张实体/关系/任务/评价表）。
 *
 * 三条例外要先说明，避免后来者以为是“没做完”：
 * 1. **FTS5 虚表不进本数组**（v19 调整，原为“不建 FTS5”）：条目规模与检索需求都变了，
 *    `search_doc` 索引登记表在这里，而 `search_fts` 虚表由 `search/fts.ts` 运行时在
 *    try/catch 里创建。理由：`applySchema` 逐条 `exec` 且**无错误隔离**——一条建表失败会让
 *    整库开不起来（openSpiritDb 返回 ok:false ⇒ 全插件降级内存镜像）。FTS5 与
 *    `contentless_delete` 依赖 SQLite 版本，属于“增强能力”：建不出来应当只失去检索质量。
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
  // 冷却窗（v0.9.1）：MAX(ts_ms) by workspace_id + trigger + ts_ms 界——前导列是 workspace_id，
  // exp_trigger_ts（trigger 前导）覆盖不到这个形状；同「暴露即补索引」纪律上线。
  `CREATE INDEX IF NOT EXISTS exp_workspace_trigger_ts ON experience (workspace_id, trigger, ts_ms)`,
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
  // ── 事务轨（v7）：txn_entry + txn_cues ──
  // 定性：`txn_entry` 属**工作记忆真源域**（与 experience 同级），不是派生缓存——它承载
  // "发生了什么具体事"。但 `summary` 列是 LLM 衍生物，G15 纪律要求 summary 禁入
  // deriveMood / recent() / 注入指纹；只有 `card_line` 段允许进注入卡（独立于情绪段）。
  // cues 只允许 basename / entity / 资源 token（禁全路径：spirit 自己产的细节不带目录）。
  `CREATE TABLE IF NOT EXISTS txn_entry (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     workspace_id TEXT NOT NULL,
     ts_ms INTEGER NOT NULL,
     turn_seq INTEGER NOT NULL,
     card_line TEXT NOT NULL,
     summary TEXT,
     gist_key TEXT,
     semantic_json TEXT,
     source_trust TEXT NOT NULL,
     topic_id TEXT,
     created_at INTEGER NOT NULL,
     -- v8 本体层：txn_entry 升格为 delivery（有内容的交付）。更正靠插新行+旧行置 superseded_by（补上此前缺口）；
     -- salience_tier 1反馈/2轮次总结/3步骤/4被掩埋思考（缺省 2）；turn_start/end_ms 圈定交付跨的轮次区间。
     superseded_by TEXT,
     salience_tier INTEGER NOT NULL DEFAULT 2,
     turn_start_ms INTEGER,
     turn_end_ms INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS txn_ts ON txn_entry (ts_ms)`,
  // 读侧默认只取未取代行（timelineQuery/listRecent 都带 `superseded_by IS NULL`）：部分索引让
  // "取活跃 + 时间序"直接吃索引，不靠 txn_ts 命中后再逐行残差过滤（满载下会擦超预算）。
  `CREATE INDEX IF NOT EXISTS txn_active_ts ON txn_entry (ts_ms) WHERE superseded_by IS NULL`,
  `CREATE INDEX IF NOT EXISTS txn_workspace_ts ON txn_entry (workspace_id, ts_ms)`,
  // 注入热路径：listRecent(1, {sessionId}) 每轮 pre-step 都走（开轨后）——无 session 索引会
  // 随本表只增不删单调全表扫（perf-txn 闸实测 p95 秒级）。(session_id, ts_ms) 让 WHERE+ORDER 都吃索引。
  `CREATE INDEX IF NOT EXISTS txn_session_ts ON txn_entry (session_id, ts_ms)`,
  `CREATE INDEX IF NOT EXISTS txn_topic ON txn_entry (topic_id)`,
  `CREATE TABLE IF NOT EXISTS txn_cues (
     txn_id TEXT NOT NULL,
     cue TEXT NOT NULL,
     kind TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS txn_cue_value ON txn_cues (cue)`,
  // 每个读方法都靠 cuesFor 逐行补 cue（`WHERE txn_id = ?`）：无此索引则是 N+1 全表扫
  //（timelineQuery 返 200 行 ⇒ 200×整表，perf-txn 闸实测 4.8s）。等值命中走它降到 O(log n)。
  `CREATE INDEX IF NOT EXISTS txn_cue_txn ON txn_cues (txn_id)`,
  // ── 本体层（v8）：实体注册表 + 关系 + 任务线程 + 评价锚定 ──
  // 定性：entity/entity_edge/task/task_delivery = **可重算派生缓存**（允许整表重算，防笛卡尔无界增长）；
  // evaluation = 工作记忆真源域（append + supersede，同 delivery）。均禁入 store.recent()/deriveMood/注入指纹。
  `CREATE TABLE IF NOT EXISTS entity (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     name TEXT NOT NULL,
     aliases_json TEXT NOT NULL DEFAULT '[]',
     importance INTEGER NOT NULL DEFAULT 0,
     first_seen_ms INTEGER NOT NULL,
     last_seen_ms INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS entity_kind ON entity (kind, last_seen_ms)`,
  `CREATE INDEX IF NOT EXISTS entity_name ON entity (name)`,
  `CREATE TABLE IF NOT EXISTS delivery_entity (
     delivery_id TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     role TEXT NOT NULL,
     ts_ms INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS de_entity ON delivery_entity (entity_id, ts_ms)`,
  `CREATE INDEX IF NOT EXISTS de_delivery ON delivery_entity (delivery_id)`,
  `CREATE TABLE IF NOT EXISTS entity_edge (
     id TEXT PRIMARY KEY,
     from_entity TEXT NOT NULL,
     to_entity TEXT NOT NULL,
     relation TEXT NOT NULL,
     origin TEXT NOT NULL DEFAULT 'heuristic',
     evidence_json TEXT NOT NULL DEFAULT '[]',
     confidence INTEGER NOT NULL DEFAULT 500,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS entity_edge_from ON entity_edge (from_entity)`,
  `CREATE INDEX IF NOT EXISTS entity_edge_to ON entity_edge (to_entity)`,
  `CREATE TABLE IF NOT EXISTS task (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'open',
     next_step TEXT,
     workspace_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS task_workspace_status ON task (workspace_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS task_delivery (
     task_id TEXT NOT NULL,
     delivery_id TEXT NOT NULL,
     origin TEXT NOT NULL DEFAULT 'heuristic',
     superseded_at INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS td_task ON task_delivery (task_id, superseded_at)`,
  `CREATE INDEX IF NOT EXISTS td_delivery ON task_delivery (delivery_id)`,
  `CREATE TABLE IF NOT EXISTS evaluation (
     id TEXT PRIMARY KEY,
     delivery_id TEXT,
     kind TEXT NOT NULL,
     anchor_mode TEXT NOT NULL,
     anchor_confidence INTEGER NOT NULL DEFAULT 0,
     user_line TEXT,
     source_trust TEXT NOT NULL,
     session_id TEXT NOT NULL,
     workspace_id TEXT NOT NULL,
     ts_ms INTEGER NOT NULL,
     superseded_by TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS eval_delivery ON evaluation (delivery_id)`,
  `CREATE INDEX IF NOT EXISTS eval_ts ON evaluation (ts_ms)`,
  `CREATE INDEX IF NOT EXISTS eval_workspace_ts ON evaluation (workspace_id, ts_ms)`,
  `CREATE INDEX IF NOT EXISTS eval_superseded ON evaluation (superseded_by)`,
  // ── v9：模型可写记忆（两本账 + 日记追加）与目的层 ──
  // scope：life（生涯/人格面：心里话、约定）/ work（长期工作：事实/决定/偏好/约定）/ diary（日记，追加型、不自动注入）
  `CREATE TABLE IF NOT EXISTS model_memory (
     id TEXT PRIMARY KEY,
     scope TEXT NOT NULL,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     workspace_id TEXT NOT NULL DEFAULT '',
     session_id TEXT NOT NULL DEFAULT '',
     pinned INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     forgotten_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS mm_scope_updated ON model_memory (scope, updated_at)`,
  `CREATE INDEX IF NOT EXISTS mm_ws_updated ON model_memory (workspace_id, updated_at)`,
  // 目的层：惦记的事（open/done/dropped）；workspace_id 空 = 跨工作区
  `CREATE TABLE IF NOT EXISTS goal (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'open',
     why TEXT NOT NULL DEFAULT '',
     workspace_id TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     done_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS goal_status_updated ON goal (status, updated_at)`,
  // ── v10：回响落档（注入决策 + 被召回的回响段）──
  // 为什么要库：回响在侧栏是「本会话的回响段」，重启不能归零；而进程内 EchoLog 只适合当观测灯。
  // echo_step：每轮 one 行（注入/跳过 + 门名 + 指纹 + 分段计数），留着回答「这一轮为什么没卡」。
  // v14 补两列：title（内容优先的标题，如线程任务名）+ refs_json（memid 引用）——
  // 注意：注释只能写在模板串外（SQL 里的 `//` 不是注释，会把建表弄坏）。
  `CREATE TABLE IF NOT EXISTS echo_step (
     session_id TEXT NOT NULL,
     ts_ms INTEGER NOT NULL,
     agent_id TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL,
     reason TEXT NOT NULL DEFAULT '',
     fingerprint TEXT NOT NULL DEFAULT '',
     segments_json TEXT NOT NULL DEFAULT '[]',
     preview TEXT NOT NULL DEFAULT '',
     id TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL DEFAULT '',
     title TEXT NOT NULL DEFAULT '',
     refs_json TEXT NOT NULL DEFAULT '[]',
     flashback INTEGER NOT NULL DEFAULT 0,
     -- v19：召回负样本观测列（P0）。旧库靠迁移链 ALTER 补列，全新库直接带列建出。
     rejected_json TEXT NOT NULL DEFAULT '[]',
     PRIMARY KEY (session_id, ts_ms)
   )`,
  `CREATE INDEX IF NOT EXISTS echo_step_session ON echo_step (session_id, ts_ms DESC)`,
  // echo_recall：本会话被「想起」的段落（同句去重，times 累计）——侧栏要展示的就是它。
  `CREATE TABLE IF NOT EXISTS echo_recall (
     session_id TEXT NOT NULL,
     excerpt TEXT NOT NULL,
     first_ts INTEGER NOT NULL,
     last_ts INTEGER NOT NULL,
     times INTEGER NOT NULL DEFAULT 1,
     agent_id TEXT NOT NULL DEFAULT '',
     PRIMARY KEY (session_id, excerpt)
   )`,
  `CREATE INDEX IF NOT EXISTS echo_recall_session ON echo_recall (session_id, last_ts DESC)`,
  // ── v13：回响条目时间反查用的两条索引 ──
  // 回响页要把「线程：X」「事务：<card_line>」这类行回查到真源时刻；没索引就是全表扫（perf 闸会追）。
  // 这两条会同时落进 V7/V8 子集（按表名筛），无害：子集全部 IF NOT EXISTS 幂等，多跑一次不报错。
  `CREATE INDEX IF NOT EXISTS txn_card_line ON txn_entry (card_line)`,
  `CREATE INDEX IF NOT EXISTS task_title ON task (title)`,
  // ── v15：回响引用记录（echo-id ≡ memid） ──
  // echo_step = 每轮观测（为什么没卡/原文卡）；echo_ref = 每条"被想起的记忆"一行（跨轮合并）：
  // ref_id 是映射编号 `echo:<kind>:<id>`，能直接解回真源主键。两个生命周期不同，不合并。
  `CREATE TABLE IF NOT EXISTS echo_ref (
     session_id TEXT NOT NULL,
     ref_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     mem_id TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     times INTEGER NOT NULL DEFAULT 1,
     first_ts INTEGER NOT NULL,
     last_ts INTEGER NOT NULL,
     last_echo_step_id TEXT NOT NULL DEFAULT '',
     record_ts INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (session_id, ref_id)
   )`,
  `CREATE INDEX IF NOT EXISTS echo_ref_session_last ON echo_ref (session_id, last_ts DESC)`,
  `CREATE INDEX IF NOT EXISTS echo_ref_mem ON echo_ref (mem_id)`,
  // ── v16：编号注册表（记录持 echo-<uuid>，一记录一号，避免重复） ──
  `CREATE TABLE IF NOT EXISTS echo_identity (
     echo_id TEXT NOT NULL PRIMARY KEY,
     kind TEXT NOT NULL,
     mem_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (kind, mem_id)
   )`,
  // ── v17/v18：生涯预总结档（上游 L1 只作输入；spirit 自存流程档，运行时不再依赖上游） ──
  `CREATE TABLE IF NOT EXISTS distill_digest (
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
     -- v20：里程碑失效标注（派生、可重算；NULL = 无证据/仍有效，只影响展示）
     stale_at INTEGER,
     PRIMARY KEY (category, tier, period_key)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS distill_digest_tier ON distill_digest (category, tier, period_key)`,
  // ── v18：实体双向对齐（spirit entity ↔ 上游 graph_node/repo/workspace；知识性只存引用） ──
  `CREATE TABLE IF NOT EXISTS entity_alias (
     alias_norm TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     source TEXT NOT NULL DEFAULT 'spirit',
     PRIMARY KEY (alias_norm, entity_id)
   )`,
  `CREATE TABLE IF NOT EXISTS entity_upstream_link (
     entity_id TEXT NOT NULL,
     upstream_kind TEXT NOT NULL,
     upstream_id TEXT NOT NULL,
     confidence REAL NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (entity_id, upstream_kind, upstream_id)
   )`,
  `CREATE TABLE IF NOT EXISTS entity_record_ref (
     entity_id TEXT NOT NULL,
     upstream_record_id TEXT NOT NULL,
     l1_type TEXT NOT NULL,
     ts_ms INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (entity_id, upstream_record_id)
   )`,
  // ── v19：检索索引登记表（派生缓存域）──
  // 定性：与 `entry_vector` / `action_bias` / `topic` 同族——可删可重建、删光可再生、
  // 绝不进 recent()/deriveMood/注入指纹。真源仍是 experience/model_memory/txn_entry/
  // task/entity/goal；`doc_rowid` 与 `search_fts.rowid` 一一对应。
  // FTS 虚表不在这里（见文件头第 1 条例外）；`echo_step.rejected_json` 是 v19 的加列，
  // 由迁移链执行（CREATE 语句带新列只对全新库生效）。
  `CREATE TABLE IF NOT EXISTS search_doc (
     doc_rowid INTEGER PRIMARY KEY,
     doc_key TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL,
     ref_id TEXT NOT NULL,
     ts_ms INTEGER NOT NULL,
     text_hash TEXT NOT NULL,
     stamp TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS search_doc_kind ON search_doc (kind, ts_ms)`,
];

/**
 * v7 新增语句子集（迁移链步 6→7 执行的就是这份）：从主数组里筛，不抄第二份字面量，
 * 单源仍是 `SCHEMA_STATEMENTS`。
 */
export const V7_TXN_STATEMENTS: readonly string[] = SCHEMA_STATEMENTS.filter((statement) =>
  /txn_entry|txn_cues/u.test(statement),
);

/**
 * v8 新增语句子集（迁移链步 7→8 执行）：六张本体表的建表+索引。单源仍是主数组，不抄第二份。
 * 注意：txn_entry 的三个新列不在这里（CREATE 语句带新列只对全新库生效），老库靠 migrate 的 addColumnIfMissing。
 */
export const V8_ONTOLOGY_STATEMENTS: readonly string[] = SCHEMA_STATEMENTS.filter((statement) =>
  /entity|task|evaluation/u.test(statement),
);

/** v16 新增语句子集（迁移链步 15→16 执行）：编号注册表 echo_identity。 */
export const V16_ECHO_IDENTITY_STATEMENTS: readonly string[] = SCHEMA_STATEMENTS.filter((statement) =>
  /echo_identity/u.test(statement),
);

/** v17 新增语句子集（迁移链步 16→17 执行）：生涯预总结档 distill_digest。 */
export const V17_DIGEST_STATEMENTS: readonly string[] = SCHEMA_STATEMENTS.filter((statement) =>
  /distill_digest/u.test(statement),
);

/** v18 新增语句子集（迁移链步 17→18 执行）：三档列/索引 + 实体对齐三表。 */
export const V18_DIGEST_STATEMENTS: readonly string[] = SCHEMA_STATEMENTS.filter((statement) =>
  /distill_digest_tier|entity_alias|entity_upstream_link|entity_record_ref/u.test(statement),
);

/**
 * v19 新增语句子集（迁移链步 18→19 执行）：检索索引登记表 `search_doc`。
 * FTS 虚表由 `search/index.ts` 的 `ensureSearchIndex` 在 try/catch 里创建（不在本数组）。
 */
export const V19_SEARCH_STATEMENTS: readonly string[] = SCHEMA_STATEMENTS.filter((statement) =>
  /search_doc/u.test(statement),
);

/** v15 新增语句子集（迁移链步 14→15 执行）：回响引用记录 echo_ref 两索引一表。 */
export const V15_ECHO_REF_STATEMENTS: readonly string[] = SCHEMA_STATEMENTS.filter((statement) =>
  /echo_ref/u.test(statement),
);

/** v13 新增语句子集（迁移链步 12→13 执行）：回响条目时间反查的两条索引。 */
export const V13_ECHO_TIME_INDEXES: readonly string[] = SCHEMA_STATEMENTS.filter((statement) =>
  /txn_card_line|task_title/u.test(statement),
);

/** v9 新增语句子集（迁移链步 8→9 执行）：模型可写记忆 model_memory + 目的层 goal。 */
export const V9_MEMORY_STATEMENTS: readonly string[] = SCHEMA_STATEMENTS.filter((statement) =>
  /model_memory|goal/u.test(statement),
);

/** v10 新增语句子集（迁移链步 9→10 执行）：回响落档 echo_step + echo_recall。 */
export const V10_ECHO_STATEMENTS: readonly string[] = SCHEMA_STATEMENTS.filter((statement) =>
  /echo_step|echo_recall/u.test(statement),
);

/** `meta` 里的 schema 版本键。 */
export const META_KEY_SCHEMA_VERSION = 'db_schema_version';
/** `meta` 里的最小条目数计数键（stats 免扫全表）。 */
export const META_KEY_ENTRY_COUNT = 'entry_count';
/** `meta` 里构建当前检索索引所用的分词器戳（戳变 ⇒ 全量重建）。 */
export const META_KEY_SEARCH_STAMP = 'search_index_stamp';
/** `meta` 里检索索引回灌完成标志（'1'；半途崩掉时下次开库重跑）。 */
export const META_KEY_SEARCH_BACKFILL = 'search_index_backfill';
/** `meta` 里构建当前别名表所用的归一化算法戳（戳变 ⇒ 重建 entity_alias）。 */
export const META_KEY_ALIAS_STAMP = 'entity_alias_stamp';
/** `meta` 里的检索索引禁用原因（非空 ⇒ 整链回落 LIKE）。 */
export const META_KEY_SEARCH_DISABLED = 'search_index_disabled';

/**
 * 执行建表。
 *
 * ⚠️ 这里的 `runDdl` 是 SQLite 语句执行器（`DatabaseSync.exec`），**不是** shell 命令；
 * 语句全部来自本文件的常量数组，无任何用户输入拼接（DDL 不能参数化，所以靠"零插值"保证安全）。
 */
export function applySchema(runDdl: (sql: string) => void): void {
  for (const statement of SCHEMA_STATEMENTS) runDdl(statement);
}
