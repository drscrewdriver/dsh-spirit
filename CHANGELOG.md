# 更新日志

本项目的所有值得记录的变更都写在这里。版本号遵循语义化版本。

## Unreleased

### 修正

- **检索有扫描窗（`LOCAL_SCAN_LIMIT` = 5000 行）**：`LIKE '%…%'` 用不上索引、`LIMIT` 只截输出
  不截扫描，而本库 append-only 且只归档不删行 ⇒ 单次检索的成本原本与库总行数成正比。更关键的是
  这条检索**同步**跑在 `agent/pre-step` 上，`recall.timeoutMs` 只包 DRSC 那次异步检索、**管不到
  本地 SQLite**。现改为「先取最近 N 条做候选池，再在其上过滤」：代价有界，行数小于窗时与全表
  逐行等价（有回归用例钉住）。跨会话基调的会话定位同窗。
- **降级表述补全**：内存镜像只在内存（上限 200 条、无回灌库路径）——降级期间记下的条目在重启后
  **不可恢复**。此前对外只说“停历史与跨会话”，读起来像“只是少了历史”。
- **面板显示 DRSC 已投影段数**：`ok` + **0 段** = 「连上了但库里还没有内容」，此前只显示“可用”，
  把静默为空读成了功能正常。不升 `warn`（那会造一屏假故障），只把 0 显示出来；未探到 ⇒ 不显示
  （**未知不当 0**）。

## 0.6.1

- **本体面可搜**（用户点单：本体类为什么不能搜索）：「翻阅 · 本体」的实体/任务线子页新增搜索框（Enter 提交）——实体按名字/别名 LIKE、任务线按标题 LIKE；空词回全量，切子页自动清。反馈面是追加型真源，无搜索词表不提供。
  - 宿主：`entity-graph`/`task-list` 接受 `q`（LIKE 字面量转义，%/_ 不当通配符；ASCII 大小写不敏感）；顺手接上契约里声明了但一直没接线的 `kind` 过滤。
- 接 0.6.0：本体交付点入星海（青绿星，只读）；接 0.5.9：头部刷新接通翻阅面。

## 0.6.0

- **本体交付点入星海**（用户点单：本周/本体的内容不渲染到星海是个问题）：`sea-graph` 现在把本体轨交付（`dlv-` 行，上限 500）作为 `kind:'delivery'` 点合入星图——同图异色（青绿）、同尺度老化、同会话时间邻近自动连线。翻阅面（本周/本体）有的记录，星图上也能看见。
  - 纪律：交付点只读——★反馈仍只写情绪轨（详情卡对 delivery 点隐藏 ★）；写侧 lane 词表不动，`onto` 只在读侧投影；步骤遥测行（tier3）不入图；backfill 行照画（排除只针对注入不针对展示）。
- 接 0.5.9：头部「刷新/⟲」接通翻阅面（按当前视图重取条目/本周/本体）。

## 0.5.9

- **头部「刷新/⟲」接通翻阅面**（用户实报：重建期间这两个按钮对翻阅/本体面没用）：此前它们只重拉星图（sea-graph）/重置图视图。现新增 refreshToken：「刷新」= 重拉星图 + 按当前视图重取（条目流/本周/本体三面）；「⟲」= 重置图视图 + 同样重取。重建跑着时不离开翻阅面也能拉新。

## 0.5.8

空 workspaceId 的**修复链**（用户点单：fallback 是全局，但理论上得先修复到对应范围）：

- 新增 `resolveWorkspaceId`（ontology/workspace.ts）：候选值（在线 header / 回填 DRSC cwd）非空⇒直用；空⇒反查同会话既有记录（txn_entry→experience，取最近非空非全局的 workspace_id）修到对应范围；仍无从可考⇒落 `ws:global` 全局桶。
- 全局桶是**兜底不是首选**：数据照落不丢（写侧闸仍拒空串，纪律不变）；翻阅面全局视图（空 workspaceId 查询）含它，注入读面按工作区过滤——归属范围不确定的历史不漏进无关工作区上下文；全局桶值自身不当反查证据二次传播。
- 接线两处：回填（sessions 无 cwd 时）+ 在线反馈捕获旁路（事件头缺工作区时）。

## 0.5.7

全记忆重建"扫完全程却零记录"的真因修复（真机实锤：水位 132 会话 done、本体表全空）：

- **workspaceId 传空串被 store 闸整批拒收**：回填把每个会话的 workspaceId 写死 `''`，而 `TxnStore.insert` 拒空 workspaceId ⇒ 每条 delivery 都被静默拒，抽取器却仍报 done。现回填透传会话 `cwd`（与在线 `workspaceIdOfAgent` 取 session header.cwd 同源）。
- **零产出不再当成功**：非空批落库 0 条 ⇒ 如实 failed（区分"回包不可解析/截断"与"全数被拒"两类文案）；旧版回包被 max_tokens 截断后解析 0 行也算"成功"，毒水位就是这么来的。
- **输出预算随批扩**：固定 1600 token 管 8 行批必截断；改按单行 700 预算×批长，封顶 8000。
- **水位自愈**：每次重建开场把"done 却库里查无 dlv 行"的毒标记摘掉重进重建——已被旧版误标的 132 个会话不需手动清库即可补回。
- **主键冲突算已记录**：续跑重扫早先已落库的行不再被误判零产出。
- 面板无需操作：重启后再点一次「全记忆重建」即自动自愈重跑。

## 0.5.6

全记忆重建跑真机 130 会话 / 912 轮时在中途挂了（报 `This operation was aborted`）。三个真因一并修：

- **超时预算错乘**：本体抽取误用 `txn.collectorTimeoutMs`（30s）——一批要读十几轮正文、吐十几行 JSON，大模型上稳定撑爆。改取 `max(distill.timeoutMs, 180s)`（本体是冷路径，不影响每轮热路）。
- **abort 原文没法看**：超时自杀抛的是 DOMException(`This operation was aborted`)，面板上等于没说。现换成可读的：`llm 超时被中止（180s，模型 xxx，已收 N 字）`。
- **一粒老鼠屎坏一锅**：原来一批/一个会话出错就整次重建中止。现在：
  - 抽取器失败**自动对半拆批重试**（8→4→2→1），把坏轮隔离到最小批，好轮照常落库；配置类错误（无路由/忙）不拆。
  - 回填单会话失败**不中断**，继续跑后面的；失败会话不标 done ⇒ 再点一次只补它们（已完成的不重做）。
  - 每会话都刷水位（断点续跑），批从 16 轮缩到 8 轮（单次更快、更不容易撞超时）。
  - 面板 done 阶段显示「部分会话未完成 N · 再点一次可续跑」，不再把部分失败伪装成完成。

## 0.5.5

- **全记忆重建升成异步任务 + 进度条 + 批次进度管理**（照长觉 sleep-run/sleep-status 范式，对齐 prime-memory）：不再一个哑的「正在重建…」。
  - `ontology-backfill-run` 改为**立即受理**（返回 accepted），新增 `ontology-backfill-status` 轮询面（phase：scanning/extracting/done/failed + totalSessions/doneSessions/totalTurns/doneTurns）。
  - 「做梦」页重建块：轮询 1.5s 一轮，画**进度条**（doneSessions/totalSessions）+ 会话/轮次计数；失败直接显真实原因。
- 后端 `BackfillRunner`：`start()` 异步受理 + `status()` 进度快照；同步占 running 防连点双跑。

## 0.5.4

- **全记忆重建失败不再只说 degraded**：抽取器 `runInner` 的异常现在 `logger.warn` 落日志（此前只塞内存 status），`BackfillRunner` 把 `status.error` 原文上浮到 `SpiritBackfillRunResult.error`，面板直接显示真正原因（路由/超时/解析/忙）。
- **修掉误报 degraded 的真因之一**：`processBatch` 遇到直播抽取正在跑（`this.running`）时**等它结束**（≤ 60s）再上批，而不是立刻返回一个非 done 状态被判成 degraded。

## 0.5.3

- **「全记忆重建」入口移到「做梦」页**（用户点名：它属记忆蒸馏，应与长觉同居）：放在长觉块/上次长觉下方，与蒸馏同区；撤掉 0.5.2 放错的设置页入口。
- 「翻阅·本体」里的「回填历史」保留作上下文次级入口。

## 0.5.2

- **全记忆重建真接线**（0.5.1 的「回填历史」其实没生效的根因）：旧实现走异步 `enqueue`，而抽取器 `QUEUE_MAX≈24` + 5 分钟去重窗会把大批静默丢掉、又把会话误标 done ⇒ 点了也白点。现改为回填直接调 `extractor.processBatch`（绕过队列上限/去重窗/**同步 await** 真落库），逐会话按批结束才标 done；失败不标 done（可续跑，delivery id 主键幂等）。
- **设置页新增「全记忆重建」入口**（面板可见一键）：扫全部历史会话重建本体层，回显已重建/扫会话/入队轮次。此前入口只在「翻阅·本体」深处，用户找不到。

## 0.5.1

本体层**真机可见化**（0.5.0 装了但看不出变化的修复）：

- **本体层缺省开**：`ontology.enabled` 与 `ontology.backfillEnabled` 由 false 改 true（脱敏/来源分级/更正通道三条硬前置已就绪）。此前缺省关 ⇒ 采集/抽取零运行，面板与 0.4.0 毫无差别。
- **面板真开关**：新增 `live.ontologyEnabled`（volatile，缺省开），设置页有「本体层」勾选框——有效 = 静态总闸 ∧ 本键，不再是后台藏着的阻塞默认。
- **历史回填按钮**：「翻阅 · 本体」面新增「回填历史」，一键跑 `ontology-backfill-run(dryRun:false)` 把既往会话扫进本体层，回显扫了多少会话/入队多少轮。
- 面板「本体」面（任务线 / 实体 / 反馈 + 点开看做成）此前已在 0.5.0，但缺省关时是空的，现随总闸开启即长数据。

## 0.5.0

本体层记忆：把 0.4.0 的"事务遥测"升级为"语义本体"——采集对象从"哪个工具报错/哪个 basename"
换成"从做了什么、聊了什么里抽出交付·实体·关系·任务线"，并用**按来源分级信任**取代旧的
"绝不读正文"（用户原文/助手动作可读进脱敏层，工具返回外部正文仍禁入）。**缺省关**（`ontology.enabled=false`）：关时零采集零落库零注入。

### 新增

- **四级 salience 分层**：反馈(tier1) > 轮次总结(tier2) > 步骤(tier3) > 被掩埋思考(tier4)。注入丢尾按此逆序；
  步骤/思考默认不进注入。
- **评价一等记录 + 锚定**：用户"干的不错/不对"等不再只是埋在批里的意图 bit，而是落 `evaluation` 表并**锚定到具体
  delivery**（显式 cue→同任务→时间邻近→仍不确定则落 unresolved 悬置池，绝不硬绑），使"上次夸的那回"可解析。
- **实体注册表 + 关系 + 任务线程**：`entity`（人/项目/模块/概念/资源，五 kind，importance/首末出现/别名）、
  `delivery_entity`、`entity_edge`、`task`+`task_delivery`（status 生命周期 + next_step）。
- **OntologyExtractor**：异步批（寄生 collector/ruminate 节律，严禁每轮同步 LLM）读正文语义→产出
delivery/entities/relations/task；入库前过 secret/PII 脱敏 + INJECTION_PATTERNS。
- **注入三段位**：卡新增 `反馈：` / `线程：` 段 + 保留 `事务（做成）：`，按 salience 逆序丢尾，指纹只吃稳定 gist。
- **查询面**：`evaluation-list` / `entity-graph` / `entity-lookup` / `task-list` / `task-detail`；
  `ontology-backfill-run`（历史回填，缺省 dryRun，产物打 TRUST_BACKFILL 不进注入）。
- **历史回填**：经 DRSC API 扫既有会话（不直读其 db），确定性 id 幂等，backfillEnabled 门控 + secret 脱敏。

### 变更

- **schema v7→v8**：txn_entry 升格 delivery（+superseded_by/salience_tier/turn 区间）+ 六张本体表。
- **旧的"绝不读正文"红线细化**：按来源分级（用户/助手可读进脱敏语义层，工具返回正文仍禁）。

## 0.4.0

语义工作记忆：在此前的"情绪日记"（只记结构信号、不读正文）之外，**并行新增一条事务轨**，
让角色记住"做过什么具体事"——用户态度信号、会话级事务摘要、时间线（上周做了什么）、资源图谱
（这件事牵涉哪些文件/人/工具）。**双轨物理隔离**：情绪轨（`TurnWatcher → deriveMood → 注入`）
一字不改，`deriveMood` / 注入指纹 / 防注入三条红线全部不动；事务条目走独立通道、独立表、
独立注入段位。**缺省关**（`txn.enabled=false`）：关时零采集、零落库、零注入、零副作用。

### 新增

- **存储 schema v6 → v7**：新增两张工作记忆真源表 `txn_entry`（四级形态：`card_line`≤60 字进卡 /
  `summary`~500 字存库衍生物 / `gist_key` / `semantic_json`）与 `txn_cues`（资源键，只存 basename）。
  加法迁移，`IF NOT EXISTS` 幂等；老库重开前向迁移，已有数据不回填（缺列即 null）。
- **事务采集链**：`TransactionWatcher`（与 TurnWatcher 并列 observe 同一事件流，只取 todo 标题 /
  工具 basename / 意图 bit，**绝不吃工具返回正文**）+ `TxnCollector`（turn/end 后异步攒批、
  fire-and-forget 调 LLM 出摘要，复用长觉的退避三件套，**严禁每轮同步 LLM**）。
- **注入卡事务段**：卡新增 `事务：<card_line>` 段（紧跟状态段）。**只有 `card_line` 进卡与进指纹**，
  `summary` 属 LLM 衍生物，与感受句同守 G15——禁入 `deriveMood`、禁入注入、禁入指纹（否则每轮
  唯一 ⇒ churn 100%）。关轨时该段整体省略，输出与旧四段形状逐字节相同。
- **长觉原料混喂**：`card_line` 作为标注上下文喂给归纳 prompt（帮模型理解"最近在推什么事"），
  但事务 id **不进 `batchIds`**——洞察/主题/因果边的证据永远只接地在体验条目上，防派生域被污染。
- **查询面两个只读 RPC op**：`timeline-query`（按时间范围/近 N 天查事务，支持 workspace 过滤）
  与 `resource-lookup`（按 cue basename 等值反查关联事务）。面板「翻阅」tab 新增**「本周」视图**
  调 `timeline-query{days:7}` 渲染事务清单。
- **长觉蒸馏模型可在面板选**：「做梦」tab 的长觉块新增常驻的**当前生效路由**（`provider/model` + 来源）
  与 provider/model 下拉选择（枚举走宿主 `ctx.llm.listProviders/listModels`）。优先级 `部署面 pin >
  运行时覆盖 > 宿主默认`：部署面 `distill.provider/model` 双配即锁路（选择器禁用）；否则面板选的存
  `meta` 作运行时覆盖、下次长觉即用（**热生效不重启**，不动 volatile 六腿配置面）。仍是显式选择，不破
  “绝不隐式改选模型”。新 RPC：`distill-models`/`distill-model-list`/`distill-model-set`。
- **安全实闸**：`source_trust` 三档标记（`user_explicit|derived_summary|structure_signal`）、
  `isSemanticAllowed` 采集边界闸（与 `isStructuredOnly` 并联，任一失败整包拒）、
  `INJECTION_PATTERNS` 落库前黑名单（"ignore previous"/"system:"/"<|"/"覆盖以上"…），
  以及 gates 静态闸确保 `txn_entry` 不出现在情绪派生输入链的任何文件中。

### 修正

- **补两张表的关键索引**（perf 规模闸实测抓出）：`txn_cues(txn_id)` —— 每个读方法逐行补 cue 的
  `cuesFor` 此前是 N+1 全表扫（`timeline-query` 返 200 行 ⇒ 4.8s）；`txn_entry(session_id, ts_ms)` ——
  注入热路径 `listRecent({sessionId})` 此前全表扫。补齐后 60k 行规模闸从 152s 降到 1.7s。

### 变更

- **宿主支持范围改为有界区间**：`engines.dsh` 与 7 个 dsh peer 由逐线枚举改为 `>=0.2.0-rc.1 <0.3.0`（免
  以后每出一条新 rc 线都要改三处声明）。compat 闸不再拒宽 range，改校“整体落在 0.2.x”（含 0.2.0 起点、
  不溢出 0.1.x/0.3.0+）；已在真宿主（0.2.1-rc.5）实装验证该区间正常装载、预发布线不被误拒。

## 0.3.0

记忆星海：把体验库投影成一张能转的三维星图。**只读投影，不是可查询图谱**（不开写图面、
不改 DB schema（仍 v2）、不引入任何渲染库），入口挂在顶部两席位（`sidebar.panellist` + `main`）。

### 新增

- **`sea-graph`（只读）**：`listRecent(limit, { includeSuperseded })` 取全库最近 ≤3000 条（带 `LIMIT`：
  本库只归档不删行，无顶就是随使用时长线性变慢），`src/sea/scene.ts` 纯函数算出点/边/统计。
  边只允许三类且各自分色分线型：共享 cue / 时间邻近 / 取代链；每点 ≤6 边、全图 ≤6000 边。
- **编码规则（一个量只编码一次）**：颜色 = trigger 族（**不随主题变**），亮度 = 老化权重，
  半径 = salience，★ = feedback；`tier`（full/gist/held）与注入侧同公式同阈值，它只门控“能不能发光”。
- **两种组织方式**（面板「组织」切换，存 localStorage）：`双极`（高度 = 归属轴，她 +Y / 主人 −Y，
  两极与主轴真画出来）与 `星盘`（中心 = 她，半径 = 多淡，相位 = 时间次序螺线，差速旋转 + 相位滞后自然成旋臂）。
- **渲染层双后端可插拔**：Canvas2D 为交付下限（光晕走**预渲染 sprite** + `lighter` 叠加，禁止逐帧
  `createRadialGradient`）；WebGL2 为可选加速（≥1500 点自动升，或用户开「高质量辉光」），
  中文标签固定叠 2D 层，`webglcontextlost` 当场回退 2D（切换必须换新 canvas 元素）。
- **人设管理接出已有写面**：`persona-preview`（不写盘）/ `persona-set`（`expectedRevision` 乐观并发）/
  `persona-history` / `persona-restore`（回退也是**追加新 revision**，历史一行不改）；面板内可改
  名字/语气/在意度/在意面，保存前能看见将要注入的原文与字节预算。

### 增补（0.3.0-local.2 / local.3，用户实机反馈后追加）

- **靠近激活闪烁（proximity 场）**：对照姊妹包 prime-memory 的图交互——鼠标拂过一片星时
  半径（90px）内的星逐个拿脉冲辉光（相位用每点 `phase`，不同步闪），而不是只有 16px
  拾取命中的那一颗有反应；纯函数 `proxBoost` 两后端共用，带 4 例单测（含“齐闪像加载
  动画”的反例门禁）。
- **手记改名「灵-鱼的手记」并升级为结构卡片**（对照 prime-memory explorer 的字段分层）：
  徽章行（类型/来源路/在意度/★）→ 正文 → gist 斜体行 → **线索 chips** → 元信息行（轮次·
  时间·在意面）。线索来自 `experience_cues`，`journal-tail` 行与 `sea-graph` 点**同批下发**
  （≤4 条，不给前端二次请求拼证据面）；星海详情卡同样挂线索 chips。在意面徽章单源
  `sea-labels.NOTICE_LABEL`（手记与人设面共用，不给主人看 slug）。

### 增补（0.3.0-local.4，人设进库 + markdown 备份可恢复）

- **人设从纯文件迁进 SQLite（schema v3，正向迁移）**：`persona_current`（单行表，
  `CHECK(singleton=1)` 形状即约束）为权威当前位，`persona_revision` 为 append-only 全量
  历史——历史不再受 256KB 尾窗限制，超窗老版也能按 revision 找回。首次打开时若库里空而
  `persona.json` 存在，自动一次性迁入（原文件不动，留作事故现场）；DB 不可用时退回现行
  文件路径，降级纪律与体验库一致。
- **每次成功保存自动写单层人话备份 `persona.md`**（文件本身就是恢复源，不嵌 JSON 区；
  内容零 slug，在意度/在意面/语气全用面板同串中文，词表漂移由门禁测试钉住）。
  备份写失败只告警不回滚已提交的 DB 事务——备份可滞后，权威不能跟丢。
- **新端点 `persona-export-md` / `persona-import-md`**：人设页新增「markdown 备份」区——
  查看/复制当前备份，粘贴改过的文本二次确认后恢复。恢复走 `save()` 唯一写路径 ⇒
  **追加新 revision，历史一行不改**；解析失败整体拒绝并点名非法词，绝不部分恢复。
- 语气下拉与历史行改显中文（平实/简短/温和，`words.ts` 单源），不再给主人看 slug。

### 增补（0.3.0-local.5 / local.6，主人背景档案：prime-memory 定期同步 + 双段编辑）

- **主人背景档案进库（schema v4，正向迁移）**：`owner_profile` 单行表，**双段写路径分离**——
  同步段（机器投影，整段覆盖）与自述段（主人手写，乐观并发 `expectedRevision`）各列各写，
  互不抹段；每次成功写入原子落 `owner.md`（双节人话备份）。
- **定期同步 prime-memory 的 person 实体**（只读消费，无编译期依赖）：主路径同源 RPC
  `dsh-memory/rpc/graph-preview` 种子榜取 person 清单，再逐 id `graph-node-get` 取全量详情
  （真宿主实测定案：`graph-search` 空 query 永远返空、preview 的 full 块是轻量形状无 facts）；
  渲染成“名称（别名）：facts 摘要”清单（top 8、单条 ≤120 字），**不断言谁是主人**（图上无主人标记）。
  缺席/空图 ⇒ 跳过且**不清旧段**（拿不到源 ≠ 背景消失）。
- **三个触发入口共用 60s 去重窗**：日级定时器（缺省 24h，首跑 0–10min 抖动）、面板「立即同步」、
  `owner-sync-ping`（事件接收预备：prime 侧后续“情景更新推送”打这里，推送只发信号不带数据）。
- **新端点四腿**：`owner-get` / `owner-set-self` / `owner-sync-now` / `owner-sync-ping`；
  人设页新增「主人档案」区（prime 三态状态行 + 同步段只读 + 自述段可编）。
- **注入稳定区新增主人段**（`[主人] 自述` 优先、`[主人的背景(同步)]` 次行）：独立预算键
  `owner.budgetBytes`（缺省 400B，不挤人格区）；两段皆空物理离场；缓存键含同步时刻，
  后台同步的新段不会因 revision 未变而被旧缓存顶掉。
- **prime 未装完全不影响运行**（真宿主对照组实测）：`owner-get` 报 `primeStatus:'absent'`、
  同步 `{updated:false, reason:'prime-absent'}`，无报错无重试风暴；解耦门禁同步演进：
  禁包引用/库直读不变，`dsh-memory/` 端点字面量收口到 `src/prime/client.ts` 单文件。

### 增补（0.3.0-local.10，昵称序列 + 自称序列（模型经 spirit_selfname 工具自改））

- **人设卡加两条序列**：`aliases`（昵称：主人日常怎么喊这条鱼）与 `selfNames`（自称：鱼说话时用什么指代自己），
  去重保序、单条 ≤24 字、列表 ≤8；稳定区新增 `[昵称]`/`[自称]` 两行（名字后、语气前；空 ⇒ 整行物理离场，
  老卡逐字节不变）；markdown 备份新增「昵称/自称」节（round-trip 无损，自由词只套上限不拒收）；
  人设页两条输入行（、/逗号/分号/空白宽进）。
- **`spirit_selfname` 工具（用户点名：自称允许 LLM 自己改）**：模型可增删自称列表（用顺了新自称当场记下）；
  这是人设面**唯一**对模型开放的写字段（名字/语气/在意度/价值/边界不开）；护栏：走 save() 唯一写路径（revision 推进/历史留档/md 重生）、
  累积式无整表覆盖、列表有顶、部署总闸关 ⇒ 不注册。tools 服务缺席的老宿主线自动不挂（作域注入）。

### 增补（0.3.0-local.16，语气扩到七档 + 长文本框自动长高）

- **语气档位 3→7**（用户点名：偏少）：新增 俏皮/安静/直白/诗意 四档，每档有开口词与收尾词（只表态度不表事实）；
  单源传导链验证：面板下拉/md 备份反查/稳定区 [语气] 行全部自动跟进；键集闸改单源比对（以后再扩列不用改闸）。
- **主人档案等同源长文本框自动长高**（用户点名：同步段钉死三行读不了）：六处 textarea 统一换 AutoArea，
  随内容撑开封顶 480px 后内滚；只读同步段（拖拽手柄对只读框不可用）受益最明显。

### 增补（0.3.0-local.12..15，长觉阶梯：主题分区 + 因果边 + LLM 蒸馏反刍 + 碰撞裁决 + 向量能力位）

- **三层记忆（schema v6，五张派生表 + entry_vector）**：工作记忆（experience，一字不动）→ 主题分区
  （topic/experience_topic：cues×trigger 确定性骨架即时回填 + 长觉归题精修，改判写新行）→ 蒸馏记忆
  （insight/causal_edge/sleep_run）。派生定性 action_bias 同构：可整表重算，**绝不进 recent()/deriveMood/注入**
  （G15 结构闸 + 行为例：蒸完整轮后注入指纹逐字不变）。
- **长觉（RuminateRunner，缺省关）**：异步 LLM 归纳 pass——攒批（水位防重蒸）→ 调用#1 归题/洞察/因果提案
  → 调用#2 碰撞去重 → 单事务落库；进度 phase/detail、软取消、退避 120s→15min（配置错误豁免）、去重窗 300s、
  连败 3 park。面板「做梦」tab 长觉块：一键跑 + 进度轮询 + 叫醒 + 上次长觉报告（含实际模型名）。
- **蒸馏模型可选（fail-closed）**：distill.{provider,model,reasoningEffort} 留空跟宿主默认（agentDefaultModel 宽容读），
  显式配了解析不到 ⇒ 拒蒸说人话，**绝不隐式改选**（G13 实闸：代码面不存在退默认分支）；llm 缺席整条休眠（域注入，顶层 inject 不变）。
- **碰撞检查三层（用户点名）**：insight 同题矛盾 ⇒ conflict 双留（机器绝不自动删），翻阅 tab「线索头」视图里
  人工裁决（「信这条」/「都收起来」走 insight-resolve，只改状态位原文永在）；证据条目被藏/取代 ⇒ 读侧 stale 传播（回场自愈）；
  幻觉 id 校验丢弃（evidence 必须 ⊆ 本批）。
- **因果边**：启发式打底（失败→恢复「导致」）+ LLM 投影（四词单源 SPIRIT_CAUSAL_RELATIONS、只钳长度、
  显式陈述才写）；星海 kind 扩 'causal'（橙实线图例在场才显），截断优先级 causal>cue>time（score 1.1 表达，既有边序零回归）。
- **向量能力位（缺省关）**：调研实锤 prime 无可借 embedding 服务——定案为「借档位（embedding-state-get 对齐
  baseURL/模型/维度，key 自持）+ 缺席自启（纯 fetch OpenAI 兼容）+ BLOB+Float32Array 零新依赖」；
  两阶段检索只走冷路径；维度首建锁 meta，不一致显式报错不静默重建；G11 出站收口/G20 出境（prompt 不含用户原文）/
  G24 凭据（apiKey 不回显不落日志）三道新闸落地。
- **新端点六腿**：`sleep-run/status/cancel/report` + `topics-get` + `insight-resolve`；settings 面加 distillEnabled 热更键。
- 对外语域仍是鱼/睡/梦：小盹=确定性整理，长觉=深睡想明白——没有「反刍/蒸馏管道」类机械词（R5 禁词族扩 sleep/topic/causal）。
- 桥 round-29 拓出并修复两枚同源 bug（受理路径自拦双变体）：`run()` 预置 running / 预占去重窗后
  任务体再 precheck 会把自家受理拒掉——受理后专用体 `runAccepted()` 不再重检；回归钉进 distill.test。
  另补报告跨重启可读（status 懒 hydrate 自 meta，宿主重启后面板不致失忆）。

### 增补（0.3.0-local.9，设置面可见性：睡眠开关 + 回响导航）

- **做梦开关进 volatile（六写点全套）**：`live.dreamEnabled`（缺省开）——宿主设置页自动表单与设置卡「睡眠（做梦）」块同时可见可热更；
  双闸取与（部署面总闸 ∧ live 闸），关闸后定时器空转、手动「让鱼睡一觉」拒并指路（reason:'disabled' 说出口）。
- **设置卡新增睡眠块**：自动做梦开关 + 上次梦境读数（时间/合并对数/在场数）+ 回响导航行（条目管理与手动做梦在「记忆星海」的 翻阅/做梦 tab）。

### 增补（0.3.0-local.7 / local.8，翻阅 tab：prime 级条目管理面 + 做梦 + DRSC 缺席提示 + 设置卡瘦身）

- （local.8 重包）round-28 真浏览器拓出★继承假绿：`reviseEntry` 的 INSERT 没带 feedback_score 列，
  ★只在返回对象里、库里新行是 NULL，刷新即蒸发——新增 REVISE_INSERT_SQL（17 列含 feedback_score），
  单测同步补**读回断言**（断返回对象不算数，断库里的行才算数）。

- **星海面板四 tab（星海/人设/翻阅/做梦）**：设置卡的记录检视整体迁到「翻阅」——
  搜索（扫描窗内 LIKE，截断如实报）/ 筛选（类型·来源·★·含更正史·藏起来的）/ 服务端分页
  （limit=50 加载更多，hasMore 探界不做全表 COUNT）/ 就地详情 / 「这条重要」/ 导出入口。
- **藏起来 ⇄ 再想起（schema v5，正向迁移）**：`experience.hidden_at` 标记列——行永不物理删
  （红线闸不变），藏后退出星海图/注入/手记缺省视图，「藏起来的」视图里可恢复。
- **更正式编辑（「理解变了」）**：插新行 + 旧行置 `superseded_by`（与更正同构，不原地改正文）；
  ★ 标记复制进新行，cues 拷贝，`source_ref=rev:<旧 id>`；编辑史以取代链形态在星海自然可见。
  UPDATE 列白名单（superseded_by/updated_at/feedback_score/hidden_at）落成实闸，把 schema
  注释里声称却不存在的那道纸面闸补成了真闸。
- **让鱼做梦（确定性整理 pass，零模型调用）**：等值查重合并 + 归档淡出（尊重部署面 dryRun）
  + 梦境报告（合并/归档/在场/幽灵/★/档位读数）落 meta；「让鱼睡一觉」手动按钮 + 日级定时器
  （owner 同款骨架），三入口共用 60s 去重窗；报告不进系统提示。
- **DRSC 缺席提示（照 prime banner 口径，按 spirit 探测能力封顶两档）**：设置卡 verdict 行下
  warn 态出「影响说明 + 可复制指引」（clipboard 失败退全选，绝不自动执行）；skipped 中性不渲染；
  星海顶栏消息带同位短提示（判定单源在 sea-graph 响应的 drscVerdict 字段）。
- **设置卡瘦身**：只留运行读数 + 淡出表单 + 导出 + 重试，不再逐轮拉条目；UI 可达性实闸
  （settings-set/journal-export/experience-feedback 必须在 client 源码有引用）防「契约在、UI 没了」。
- **拟人化文案纪律（R5）**：新机制文案统一鱼的第一人称行为语言（「藏起来」「再想起」「理解变了」
  「让鱼睡一觉」「鱼梦见了…」），新前缀键（rec/dream/drscHint）禁机械词实闸；词表目录首屏下发，
  client 不手抄枚举。

### 修正

- **图上亮度与注入侧分两把尺**（新键 `sea.agingHalfLifeMs`，缺省 7 天）：拿 1.5h 的注意力窗口算跨月库
  会得到“全图都是暗星”（真浏览器实测 `fade` = 0/0/3000）；`tier` 仍用小时尺度，因为它的语义就是
  “还在不在注意力窗口里”。
- **亮度带基座、暗星有地板**：指数衰减动态范围极大（跨月 ÷ 7 天 ≈ 15 个半衰期），从 0 起算会让
  90% 的点在暗背景上隐形。遗忘是“沉下去”，不是“看不见”。
- **经度不再按类型分扇区**：`axisOf` 已按 trigger 给基值，经度再按 trigger 分角度就是把同一个量画两次
  （同类排成纬线弧带，读图者会把高度误读成类型）；改为 id 哈希铺满整圈 + 正弦弱吸引（线性插值会在
  基准角对面留出一段无点空弧）。

### 性能

真浏览器实测（Canvas2D，单帧 CPU）：300 点 1.29ms、1000 点 5.32ms、3000 点 10.7ms（关边）/ 14.7ms（开边）；
WebGL2 3000 点 4.5–5.1ms（与 2D 同视角对拍验证过色带分群/边网密度逐层一致）。产物增量：`dist/client.js` 24.6KB → 114.8KB（无第三方渲染库，react 仍走 external）。

## 0.2.0

主体性流程记录：**遗忘作为设计**——滑窗淡出、未竟账、条件化、反馈重排，四件全部**缺省关**（灰度闸链：
`live.fadeEnabled` 与各自静态闸取与，关闸后行为与 0.1.x 逐字节一致，有回归用例钉住）。

### 新增

- **滑窗淡出（`recall.fade*`）**：条目按 `m=(salience/2)×注意力权重` 分三态——原文 full / 一句话 gist /
  不上卡 held。权重与姊妹引擎同式 `0.5^(Δt/halfLife)` 同地板 0.5（时间至多让记忆“变淡一半”，
  held 经“无残句/低档/阈值调高”三路达成）；Δt 按半衰期**量化后才进指纹**，档内字节稳定、
  重发只发生在跨档（护住 unchanged 门与“同档同召回⇒字节全等”红线）。gist 编译期从固定表
  `GIST_TABLE` 派生落库（运行时改写记忆=伪造）。
- **DB schema v1→v2**：`experience` 加 `salience`/`gist`/`feedback_score` 三列（全部加法迁移，
  `PRAGMA table_info` 先查后加，幂等）；新表 `session_ledger`（未竟账，基元=session）与
  `action_bias`（条件化，定性为**可重算派生缓存**，豁免无-UPDATE 纪律并在 schema 头注声明）。
- **未竟账（`ledger.*`）**：`agent/disposed` 主触发 + `turn/end` 兑底（顺序：先结算后释放）；
  只吃 todo 快照的结构计数（`watcher.openLoops` 为只读快照——中途读不吃计数，集成调出的真 bug
  已修）；措辞档位化，计数真为 3 才说 3；maxAge 过期不带出，镜像有顶。
- **条件化（`bias.*`）**：强负体验给同名动作短期抑制（三档词：hesitant/guarded），turn/end 冷路径
  upsert、pre-step O(1) 主键查表（禁每轮扫表）；两通道：卡状态段倾向短语覆写（renderCard.tendencyOverride）
  与 derive 乘子（只放大负向条目权重，不跨 reaction 档、不新增输入）；**不碰 decision、不注
  钩子、不对外报数**；验收钉“开/关两臂除 text 外全等”与“缺省乘子集与无乘子逐字一致”。
- **人工反馈重排（`recall.feedbackEnabled`）**：移植姊妹引擎 recall-usage 形态，-1..5 手打
  （面板两键：这条重要/撤销）；**只重排进卡优先序，不回灌衰减曲线与情绪派生**（两轴分离）。
- **echo 链断言（`tests/echo-chain.test.ts` + `src/util/echo-phrases.ts`）**：短语集单源派生自九档
  label/tendency+签名行+gist；CI 档钉“卡语整段可识别”与入口分流规则；真机档（对方 L1 导出面
  不含 spirit 短语）列入发版前置。
- **面板六腿**：淡出开关/窗口尺度经 volatile 接管，新增 rpc `settings-get`/`settings-set`（区间单源 SPIRIT_RANGES；宿主 volatile 写通道不可用时如实报 `no-volatile` 需重启），
  panel 补输入框（开关 + 半衰期分钟）与淡出指标行；手记分页回显 gist/salience/feedback，
  stats 新增淡出计数族（full/gist/held/marked/pool/churn）；`ab-report` 新增每轮发卡率与淡出代理量。
- **调参 SOP**（README）：指标→pin→A/B→方向判据→灰度序；可调项封顶四类，`card.maxBytes` 与
  地板 0.5 不在面板暴露。

### 变更

- `SpiritJournalPage.rows` 新增 `gist`/`salience`/`feedbackScore` 三字段（null 合法，v1 旧行不假装知道）。
- 未竟账/条件化共享 `live.fadeEnabled` 总闸：防止“只开一半”的半新半旧注入形态。

### 未做（有意）

- 冷路径叙事块（模型调用×DRSC 滞后源×画像污染放大三重风险，且依赖 echo 链真机档先落地）。

## 0.1.0

第一个可用版本：**第一人称体验条目库 + 双路即时召回**。

### 新增

- **体验条目库（真源）**：`node:sqlite`（Node 内置，零原生依赖），`experience` / `experience_cues` /
  `mood_state` / `meta` 四表。append-only——更正走"插新行 + 旧行置 `superseded_by`"，
  全仓不存在删除条目的路径（有 grep 断言守着）。条目携带 `lane`（`live` 实时 / `drsc` 历史）
  与 `source_ref`（可回溯到 collector 的 segment）。
- **人格 = 记录的选择器**：`salience` 决定什么事值得记（`0` 就**不记**，"不记什么"也是人格），
  `focus` 决定同一件事记到哪一面（工具失败可以记成"我出了错"，也可以记成"手边的工具不顺"），
  `voice` 决定怎么说。人格区以 `systemPrompt.section`（order 20）进系统提示，以 `revision` 为缓存键。
- **情绪档派生**：条目 → 3×3 档位（效价 × 唤起）。半衰期加权、**单轮跨格上限**（防人格抽动）、
  **陈旧退中性**（重启绝不把三天前的感觉当现在）。对外只有档位词与行为倾向，**没有任何浮点情绪值**。
- **回忆卡走尾部注入**：`agent/pre-step` 返回数组**末尾追加**一条 `user/message`，
  署 `source:{kind:'plugin:spirit', form:'snapshot'}`——`snapshot` 在宿主侧的定义就是
  "同生产者的后续快照取代先前"，所以不需要改写历史、也不需自造作废句式。
  四段（状态 / 刚刚 / 想起 / 开场）按**实际产物字节**逐行判定预算，丢尾顺序固定。
- **双路召回**：路 A 近因（实时钩子，零滞后，常开）；路 B 历史（自家旧条目 + DRSC 检索面，
  带超时预算）。两路**不归并名次**，各占一段——"刚发生"与"被勾起"语义不同。
- **消费 DRSC，不重做已交付能力**：会话枚举、JSONL 解码、turn 切分、中文检索面、
  表面行对账都不自研。只走它的 `op` 面（`status`/`session`/`search`），恒带 `redact=1`，
  `session:null` 当空不当错，**从不直读它的库文件**；未安装则历史路整段省略。
- **观测面**：纯内存统计注册表（注入 / 旁路 / 关闭轮次、卡片字节、检索命中、生效确认）+
  前缀路由 `POST /dsh-spirit/rpc/<method>`（不走 `connection.rpc`，见下方"为什么"）。
  client 半只挂两个座位：输入栏 pill「情绪·开 / 旁路 / 关」与设置里的顶层「手记」只读分节。
- **旁路（bypass）与关闭正交**：旁路照常记录与派生、只断注入出口——这是"入戏感到底是不是
  这套机制带来的"唯一能回答得了的对照组形状。
- **跨会话基调**：新会话首轮读**自家条目**上一会话末尾几条（不查 DRSC，也不读任何人的库）。
- **门禁**：`npm run check` = typecheck（3 套配置）→ lint → vitest → build → **dist 冒烟**；
  另有 `npm run compat` 逐条宿主线双查（`engines.dsh` + `peerDependencies`）。

### 关键判断（以及为什么不是另一种做法）

- **不依赖 prime-memory，也不依赖它的存储**：体验与客观事实是不同语义域。署名 `plugin:spirit`
  让同机 prime-memory 的 L0 捕获（只收 `kind:'user'`）天然不咬，双向解耦。
- **情绪输入只吃结构字段**：任何带自由文本的信号包整包拒绝。否则网页正文/文件内容
  就能操纵角色状态，而漂移看起来完全像角色自己的反应。
- **不伪造具体性**：早期设计稿写过"你第三次打断我时"——机械采集拿不到"第三次"，
  写出来就是编造，且会被后续召回当真引用。
- **注入主路是自动注入，不是工具**：把召回寄托在"模型主动去查"上，就退化成
  "读日记再回想"（dsh-soul 自己承认的失效模式：模型不主动检索时机制等于不存在）。
- **设置表单交给宿主**：0.1.7+ 的 volatile 字段自动成表单，自定义分节只读展示，
  避免出现同一插件两份设置入口。
- **RPC 不走 `connection.rpc`**：那条前缀通道在 webServer 分发层静默 405，`/api` interceptor
  又是单槽会被抢；自有精确前缀路由可共存。

### 修掉的（都是会静默坏的那种）

- `live.bypass`（全局旁路）与 `live.cardEnabled`（卡总闸）**没被编排层读**——设置页的开关是装饰品
- 压缩/清空后不重置"已发过卡"的凭据 ⇒ `unchanged` 门永久阻止重发 = **压缩一次，角色再也没情绪**
- `failedTools` 被每轮 reset 清掉 ⇒ 跨轮的"同名恢复"永远判不出
- `noteInjected` 在无运行态时静默丢弃登记 ⇒ 首张卡指纹永不提交
- 卡片预算用"每行 +1 分隔符"估算，与 `join('\n')` 真实字节不符 ⇒ 丢弃顺序不按设计走
- 条目与 cues 未包成单事务（崩在中间留下指向不存在条目的孤儿 cue）；顺带 2 万条写入 92s → 35s
- 细节文案直接打印 `pathBases` ⇒ 上游传全路径会把目录泄露进卡与库（现归一到 basename）
- `ENOENT` 判定看 `err.name` 而非 `err.code`（把"文件不存在"报成"不可读"，一个不存在的故障）
- 迁移方向判定两分支文案写反；`planMigration` 高于/低于线走向错

### 真机（0.2.0-rc.2 web）照出来的四个缺陷

- **路由根拼错**：`SPIRIT_RPC_ROUTE` 拼成 `/dsh-spiritrpc`，而浏览器半请求 `/dsh-spirit/rpc/…`
  ⇒ 面板拿到的全是宿主 404。现收成 `contract.ts` 单源，两半共引，另加三道闸 + 两项 dist 冒烟
- **可选服务获取方式错**：`ctx.get('webServer')` 在未声明顶层 inject 时被吞，而 `internal/service`
  常规启动不重发 ⇒ 路由永不注册。主路改 `ctx.inject(['webServer'], …)` 作域注入
- **座位标题冻结在默认语言**：client apply 早于宿主写 `<html lang>`，label 传字符串 ⇒ 导航条永久
  英文。改传 thunk（宿主契约：thunk 跟随当前语言）
- **手记与导出依赖内存注册表**：宿主重启后注册表空 ⇒ 手记整块空白、导出报“没有会话可导”，
  而条目全在库里。现按库兜底选会话（`latestSessionId()`），空态文案也不再自相矛盾
- 同时补上“本轮已取消”那道门此前缺的用例

### 真机第二轮（headless 线 + mock provider）照出的三个缺陷

- **会话的最后一轮永不记录**：记录只发生在下一轮 pre-step（在那里取上一轮的信号累加器），
  而 headless 一次任务就是一轮 ⇒ 整条记录轨在真宿主上一条都没落过（此前看到的“手记”全是用
  探针灌进去的）。现改为 `turn/end` 一到即结算落库，pre-step 降为事件漏发的兜底（已结算的轮
  取到空信号，不会重复记）。教训：**单测全绿 + 装机能跑不等于“记录轨真的在写”**
- **召回段重复行**：同一触发器编译出的文案相同，而 `recallHistory` 只在“与近因段不重复”一层
  去重 ⇒ 真机卡里连着两行一模一样的「想起：…」（白占预算、读起来像故障）。现两条腿汇合处统一去重：
  「想起」从 2 行变 1 行，卡字节 374 → 304
- **缺省卡宽与红线撞车**：极端负面档多一行「非医疗声明」（它不允许被预算掉），实测那张卡
  长到 328B，在 `card.maxBytes=384` 下只剩 56B，装不下一行近因（141B）⇒ 越是该说
  “刚刚发生了什么”的档越没有“刚刚”。缺省上调到 **512**（`card.maxBytes` / `live.cardMaxBytes`）；
  真机复验：同一档位下声明 + 近因共存，卡字节 398（旧的 384 顶根本装不下）
- 另：`capture.userSnippet` / `maxQuoteChars` 曾为死键（已实现 `fact.quote`，按码点截断），
  而 `extractCues` 曾允许“显式传入就取前 4 个词”——用户的话会变成检索键再被「想起」段回灌

### 新增面

- `npm run ab`（`scripts/ab-report.mjs`）：离线归因对照。读宿主 durable 日志（多帧 zstd）与只读自库，
  **按证据分两臂**（有 `plugin:spirit` 卡行 = 注入组；无卡行但库有该会话条目 = 旁路组），
  输出轮次 / 回复字符 / `inputTokens` / `cacheReadTokens` / 命中率 / 卡行与字节 / 带「想起」的卡数 /
  手记条数 / 纠正候选。顺带把“跨会话基调（开场）”与“历史召回（想起）”首次在真宿主上取证

### 边界

- `engines.dsh` 只声明 **0.2.x 六线**（`form:'snapshot'`、producer-owned kind、`systemPrompt.section`
  在 0.1.7 之前不存在）。本地宿主树实测：兼容裁决读的是 `peerDependencies`，README 明写
  "不是 `engines.dsh`"——所以两者同写并逐线预检。
- 保留期清理**只归档导出、不删行**（真删需要快照 + 校验 + 回灌三件套，留待 v0.2 且需显式授权）
- 本地 250+ 项单测、dist 冒烟与**真机 web 冒烟**已过（宿主半装载 / 六端点 / pill 写读 / 分节渲染 / 导出落盘）；
  **注入端到端**用本地 mock provider 跑真回合验完（卡在最末块、`snapshot` 跨轮只留一张、同档不重发、
  `/compact` 后重新出卡、生效确认链闭合）；**A/B 成本对照**需真 provider 与长会话，本轮不拿 mock 数字冒充
- 真机又照出两个静默缺陷：人格区因裸读 `config.live`（那是 VolatileRef）而**永远为空**；
  历史路基址不跟宿主端口（非 8080 部署上 `drscVerdict` 永远 `warn`）——两者均已修并加闸
- 0.2.0-rc.2 的 web 壳子**不渲染 volatile 自动表单**（没有任何 client 包读 `autoGenerate`）
  ⇒ `live.*` 热改走部署面，不在设置页上
- 不做：长期情绪检索、图谱、矛盾裁决、人设自动演化、压缩后端接管
