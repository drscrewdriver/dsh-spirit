# 更新日志

本项目的所有值得记录的变更都写在这里。版本号遵循语义化版本。

## 0.13.6 (2026-11-27)

**设置改值不生效修复：ns 对齐 + volatile 逐键回退 + 消除假成功。**

- ns 错配（首因）：settingsWrite 原回退 dsh-spirit-plugin（cordis 插件名），而宿主 describe/mutate 按 entry.options.id=dsh-spirit 精确匹配，回退常量永不命中，抛 No configurable plugin entry。现改为从 ctx.fiber.entry.options.id 取真实 ns 精确找行；value 的 live 节降为兼容回退；错误信息带 entryId 与已知 ns 列表。
- volatile 形状守卫：整对象 path:[live] 写若被宿主拒（not volatile）自动逐键 path:[live,key] 回退；两种形状都读回校验，失败如实 ok:false。
- 消除假成功：settings-set 的 hotUpdatable 改由真实写通道判定，返回前用 eff() 读回本次 patch，不一致按 update-failed 报；面板写失败回滚旧值，不再先报已保存再被轮询纠正。
- 服务晚到兜底：补 internal/service 重挂取 settings 服务；loader/volatile-update 仅作诊断日志（ref 原地更新，非生效依赖）。
- 抽出 src/settings-write.ts 纯模块；新增 tests/settings-write.test.ts（11 例）与 contract-keys.test.ts volatile 标记门禁；全量 981 测试通过。
- 三处版本同串 0.13.6；不改 entry id / 座位 / pill / 星海 / CSS。

## 0.13.3 (2026-11-26)

**设置卡底栏 Star 快车道：★ 直接打开仓库页（不再只静默收起），隐藏独立成 ×。**

- 新增 `src/client/star-row-copy.ts`（由 `_tools/star-row/sync.mjs` 从 kit 真源生成，禁手改）：GitHub 图标 + owner/repo 链接 ｜ 求星话术 ｜ ★ CTA ｜ × 隐藏。
- **修 S 档旧缺陷**：点 ★ 此前写成 `starDismiss()`，与「别打扰我」合流，仓库页一次都没打开过。现在 ★ 走锚点 click 打开 `REPO_URL`（不写 dismissed），× 才写 `dsh.star.<ns>.dismissed=1` 并收话术与两钮；链接段永留。
- 真源 `STAR:EXTENDED` 段单源维护，A/L 档副本由 sync 整段剥除，已发布 A/L 仓零 diff。
- 文案 10 语按 `documentElement.lang` 前缀自选；样式只走 `--dsw-alias-*` 令牌与 `currentColor`，零硬色。

## 0.13.2 (2026-11-26)

**设置保存修复 + 设置面板 CSS 追平姊妹仓库。**

- **配置保存失败修复**：桌面宿主只给 volatile ref 的 `.get()`、不给 `.update()`，导致 `settings-set` 报 `no-volatile`（面板显示「宿主 volatile 写通道不可用，改值需重启」）。新增 `settings.mutate` 兜底写腿（经 `ctx.inject(['settings'])` 获取服务，以「value 含 live 节」定位自身命名空间，整体 `path:['live']` 写入 + 逐键读回校验，未落地如实报错不谎报成功）；旧宿主 `.update()` 仍优先。`settings-get` 的 `hotUpdatable` 同步反映新通道。
- **设置面板令牌 CSS**：新增 `client/src/theme.ts`（dsw 真实令牌 + 浅/暗双主题 + 幂等注入样式表）与 `client/src/skin.ts`（light/dark/auto 三态，偏好存 localStorage 不进 config）；设置面板与内嵌 LLM 费用提示块的裸内联样式全部改为令牌类，新增皮肤选择器。范围限设置面板，pill/星海不动。
- `tests/fade-legs.test.ts`：新增兜底写腿、读回失败、双通道优先级、hotUpdatable 用例；全量 969 测试通过。
- 三处版本（package.json / dsh.plugin.json / SPIRIT_VERSION）同串 0.13.2。

## 0.12.0 (2026-11-24)

**记忆总闸 + 三态启动挡位 —— 与 prime-memory 同构；出厂默认「关闭」。**

面板设置新增「记忆总闸」复选框（本会话即时开关）+「启动挡位」三态下拉：`跟随上一次` / `强制开启` / `强制关闭`（**本版出厂默认**）。挡位只决定**下次启动**初值，不在读侧折叠——本会话手动开关永远有效；启动期由 `applyBootMode` 把 on/off 初值写回 `enabled` 一次，`last` 不动，写面缺席/抛错静默不阻断启动。

> ⚠️ 行为变更：出厂默认由「跟随上一次」改为「强制关闭」。升级后首启记忆为关；拨到「跟随上一次」或「强制开启」一次即恢复并持久。

- `src/contract.ts`：`SpiritLiveSettings.bootMode` + `SpiritSettingsView.enabled/bootMode`；`SPIRIT_DEFAULTS.live.bootMode='off'`；`SPIRIT_VERSION` 0.11.0→0.12.0。
- `src/config.ts`：schema 增 `bootMode`；`resolveLive` 归一（缺键/非法归 `off`，显式接受合法 `last`）；新增 `applyBootMode` 启动写回；`SCHEMA_FIELD_KEYS` 增 `live.bootMode`。
- `src/rpc.ts`：`settings-get` 回显 `enabled/bootMode`；`settings-set` 收 `enabled`（布尔）与 `bootMode`（三态白名单）。
- `src/index.ts`：启动时 `applyBootMode(config.live)`。
- `client/src/panel.ts`：「记忆总闸」复选框 +「启动挡位」下拉；`client/src/copy.ts` zh/en 文案。
- `tests/boot-mode.test.ts`：10 条行为闸（归一、启动写回、老线冻结值静默、写面抛错吞掉）。
- `dsh.plugin.json`：version 同步 0.12.0。

门禁：typecheck 三工程干净；boot-mode 10/10；全量 vitest 967 passed（99 文件）；eslint 0。

## 0.11.0 (2026-11-24)

**暖记忆（借 fish-memory 的"判断"，从 prime-memory 取料）· 注入面「暖：」段 · 治两个实测缺陷**

- **借什么、不借什么**：fish-memory 的质感不在存储，在它对一条记忆的三个判断——重要度决定降得多慢、
  鲜活度是连续半衰（不是存/删二值）、被想起会强化。spirit 早就有对应机制（`salience`、`recall/fade`、
  `echo_ref`），**缺的只是它们不作用在上游取来的料上**。所以本次只借判断，不借「事实条目 + remember
  工具 + 按 query 召回」那三样（那才是与 fish-memory 撞车的部分，也是 v0.9 的病根）。
- **为什么不重头采集**：上游 L1 每条都带 `priority`（0-100，实测 70~95 窄带）、`persistence`（永久/临时）、
  `valid_to`（已失效）——那是蒸馏时花的真 token。重算只会得到更好看的第二真源，分歧无从裁决。
  正文所有权、召回、时效判断全留上游；spirit 只持有「我什么时候知道这件事、它在我这儿多暖」。
- **治缺陷 1（半衰基准=窗口）**：初版 `HALF=30 天` 与编年窗口同宽 ⇒ 窗内 `freshness ∈ [0.5,1]`，
  数学上不可能出现 cool/faded。真机 1001 条候选实测 `hot 756 / warm 226 / cool 0 / faded 0`，
  四档两档永不出现。改为**分类基准**：`learned` 3 天 ×(1+2·重要度) ⇒ `321/167/360/134`；
  `bond` 21 天（关系记忆该记得久，同基准会变成 `hot 5/cool 8` 把偏好记成快忘了）⇒ `hot 12/warm 7`。
- **治缺陷 2（learned 无配额）**：真机 learned 单日**峰值 131 条**、中位 23 条，全量入轴＝流水账。
  新增 `learnedPerDay`（默认 5，按温度取最暖）；`bond` 不设配额（实测每天 1–6 条）。
- **注入面「暖：」段（用户指定落点）**：卡片新增一段，每轮 ≤1 条，优先级**最低**（预算紧时第一个让位）。
  三道闸：
  ① `WARM_INJECT_TYPES` 白名单只认 `user_info/user_hobby/user_communication/user_behavior`。
  实测 chat 家族 58 条里 `instruction 15` 是**用户指令**——当回忆每轮重放等于陈旧指令自己复现，
  `persona 8` 属 soul 系列的地盘，`episodic 11` 多数已失效，三者硬排除；
  ② `hitsInjection` + `containsSecret`（上游正文是 LLM 蒸出来的，可能裹挟任何东西）；
  ③ 冷却 24h + 近义去重（Jaccard ≥0.7）。必要性来自实测：19 条干净候选里有 3 条讲同一个偏好
  （11-23 / 11-18 / 11-07 三个措辞版本），不做去重会连着几天端同一句话的不同说法。
- **沉默优先于重提**：近义候选里的旧版本更容易过闸（更长、token 更多），无条件放松等于让 11-07 的
  旧说法盖掉 11-23 的新说法。故只在**连续 7 天一次都没注入过**时才放松近义闸（`WARM_RESURFACE_MS`），
  兜住"新机器只有 3 条候选 ⇒ 一周后功能死掉"。
- **治缺陷 3（暖段从不生效）**：`card.maxBytes` 512 → **640**。48 字暖行（≈150B）在 512 顶下
  带两行近因的卡每次装不下，实测 `used.warm` 恒 undefined——**装配完毕却从不生效且不报错**。
  与 384→512 那次是同一类事故（新段装不进去），理由已写进 contract 默认值注释。
  暖段仍是最先让位的那一段；`warm` 缺省时卡片输出**逐字节不变**（同态铁律有测试守着）。
- **两段式记账**：暖记忆的冷却在 `confirmInjected`（会话日志真看到卡）后才提交——卡被覆盖/取消时
  不该白吃 24h。
- **诊断面**：本轮未带暖记忆时，原因组合变化才打一条 info（`type:instruction×2 too_cold×5` 之类），
  静默不注入最难排查。
- **测试**：新增 `tests/l1-warmth.test.ts`(14) / `tests/warm-pick.test.ts`(15) / chronicle 配额 3 例 /
  slot 暖段 5 例。全链 **955 绿**（存量 918 零回归 + 37 新增），lint/typecheck 绿。
  真机烟测：连跑 5 轮注入 5 条，任意两条最大相似度 0.412（阈值 0.7），过真实守卫后可疑 0 条。

## 0.10.0 (2026-11-23)

**定位重钉：从「记忆库」改成「生平编年」· 编年面（默认）· 治"翻阅只有错误类"**

- **诊断（本机库实测，写进 `docs/positioning.md` 全文）**：v0.9 对外自称"记忆"，但数据层不是记忆——
  ① 全库 22 条体验条目的触发分布是 `tool_failure 14 / recovery 4 / task_close 3 / user_interruption 1`，
  `neutral` 因人格权重 0 永不落库 ⇒ **干活本身从不进库**；
  ② 条目文案是"固定模板 + 人格语气"，跨会话 73 行同句 ⇒ **作为记忆信息量为零**；
  ③ 星海上 139 个"交付物"点全部来自 prime-memory 的 L1 重建（`l1-dlv:`），spirit 自己的抽取轨零产出 ⇒
  **展示的记忆主体内容不归它所有**。
  根因不是"记忆没做好"，而是**把一层情绪原料包装成了记忆产品**；照这个方向加召回，只会和
  fish-memory / agent-soul / prime-memory 正面撞车且撞不赢。
- **新定位**：spirit = **经历层（episodic self）**，只持有一条时间轴，轴上四样东西——
  **事**（交付）/ **感**（体验）/ **线**（生涯流程档里程碑）/ **缘**（因果边 + 主题 + 主人档案）。
  它回答的问题从"这条事实能召回吗"改成"我是怎么走到今天这一步的"。
- **新增编年面（`chronicle-list` + 翻阅默认视图）**：`src/chronicle/build.ts` 是纯函数汇编器
  （只搬不造：不生成任何新句子；重复才报数：`repeat>1` 仅在同日等值重复时给出；事不依赖感：
  只有交付也能读通）。`client/src/sea/sea-chronicle.ts` 按天分段，**事在前、感折叠**，
  7/30/90 天窗口可切，条目可跳星图定位。翻阅 tab 默认面从「条目流」改为「编年」——
  条目流按设计只认摩擦，拿它当默认等于让人一进门先看一串"我又出错了"。
- **排序纪律**：天内先按类别（事 > 里程碑 > 记着 > 感）、同类内按时间倒序。
  这条不是审美：按纯时间排，一条晚上的"我又出错了"就会占住第一屏最上面。
- **测试**：新增 `tests/chronicle.test.ts` 9 例（事不依赖感 / 同日才聚合 / 事压过感 / 窗口外不进轴 /
  里程碑首行进正文 / 记着进轴 / 天倒序 / 正文归一 / 日键形状），全链 918 绿。
- **文案与清单**：package.json / dsh.plugin.json / README 改用生平编年口径；`locale/zh.json` 与
  `locale/en.json` 的 meta 同步（其余 7 语 meta 仍是旧口径，待人工校对，不影响功能）。
- **不做**（写进 README 反面纪律）：事实召回、人格配置、实时心情状态机、按天八股日记。

## 0.9.2 (2026-11-22)

**语言切换重渲染触发（html lang 订阅面）· 检查先行，按结论接线**

- **缺口（审计结论）**：全仓无任何语言变化观察机制——切语言本身不触发重渲染，各面文案
  跟随全靠自驱轮询或用户交互。输入栏 pill 与星海四面（主面板/翻阅/线索头/人设）在无交互时
  **无限期滞留旧语言**；最痛的形态是启动期冻结：宿主写 `<html lang>` 晚于 client apply
  （entry.ts 头注实测，初始文档 `lang="en"`），zh 用户开屏看到英文 pill，直到点击才自愈。
- **修复**：新增 `client/src/use-html-lang.ts`——MutationObserver 监听 documentElement 的
  `lang` 属性（attributeFilter 只认 lang，单例防重复 observe）+ `useSyncExternalStore` 三参
  形态；`subscribeHtmlLang` 稳定引用防反复重订阅；无 document 环境（node 用例）空订阅不抛。
  真相源保持 html lang 而非宿主 locale 服务——spirit 刻意不声明宿主服务（inject 挂起风险），
  MutationObserver 全宿主可用，多线适配零新依赖。
- **接线（只接审计不达标的 5 面）**：pill / SeaPanel / SeaRecords / SeaTopics / SeaPersona
  各自 `copyOf(useHtmlLang())`，同时治好启动期冻结。达标面不动：设置分节（轮询 ≤5s）、
  做梦 tab（长觉轮询 ≤30s）、slot 标签（thunk 每读现调，宿主 resolveSlotLabel 源码级证实）。
- **守卫**：`tests/client-html-lang.test.ts` 5 例钉死「lang 变化必须通知订阅者 / 观察者只挂
  documentElement 只认 lang / 第二订阅者复用同一观察者 / 退订后不再通知 / 无 document 空订阅」。
  全链 909 tests 绿（904 存量零回归 + 5 新增）。逐面证据表见计划 spirit-locale-rerender findings。

## 0.9.1 (2026-11-16)

**星图 L1 交付入图 · 错误记录降噪（连击冷却 + 跨 workspace 去重）· 交付 id 前缀单源化**

- **交付 id 前缀单源化**：新增 `ontology/delivery-id.ts`，`isDeliveryId()` 同时认会话抽取轨
  `dlv-` 与上游 L1 重建轨 `l1-dlv:`。此前星图投影（`rpc.ts` sea-graph）只按 `startsWith('dlv-')`
  筛，把 `prime/l1-ingest.ts` 重建出的 L1 交付全数挡在图外（用户实报「从 prime-memory 整理出来的
  记忆在星图里无显示」）；回填水位自愈（`backfill.ts`）同口径修正。判定收成一个函数 + 表驱动测试，
  杜绝第三次前缀断裂。
- **错误记录降噪 · 连击冷却**：新增 `capture.cooldownMs`（默认 600000，热更键，钳位 `[0, 3600000]`）。
  同一 workspace 在窗内命中同 `trigger` 的**连击型事件族**（`tool_failure` / `recovery`）只记首条，
  后续跳过落库——治的是"同一个坑每轮刻一道同样的疤"（实测 82 条经历 71 条是失败轮）。判定只看
  `trigger/workspace/ts_ms` 三个结构化字段，不读任何文本（与情绪链路注入红线正交）；`cooldownMs=0`
  退回每轮必记。落库侧加 `exp_workspace_trigger_ts` 索引支撑冷却窗查询。
- **错误记录降噪 · 跨 workspace 去重**：`dreamDuplicateGroups` 分组键从 `(session_id, trigger, text)`
  改为 `(workspace_id, trigger, text)`。真实噪音是跨会话长出来的（同仓反复踩坑、每次换 session_id），
  旧键下本机实测 0 组重复、新键 2 组（73 行同句全在键差里）。仍保留 workspace 维度（跨项目巧合同句
  各记各的），判据依旧等值保守（宁漏不误合并）。存量清理走 `supersede` 通道（可回滚），无物理删。

## 0.9.0 (2026-11-14)

**检索可搜索化（schema v19）· 召回链质量 · 淡出台阶 0-7-30 · 运维闸门 · 实体卫生（schema v20）**

- **FTS5 六类索引（派生缓存）**：新增 `search_doc`（登记表）+ `search_fts`（contentless +
  `contentless_delete=1`，只存 token 串）。体验 / 记着 / 交付 / 任务线 / 实体 / 目的统一进一张索引，
  开库时按分词器戳判定是否全量回填（`search/index.ts`，分批 500 行、单事务、失败回滚）。
- **分词**：`@node-rs/jieba` 进 **optionalDependencies**（未装/无预编译二进制 ⇒ 自动退 CJK 二元组）；
  词元 = jieba 词 ∪ 拉丁词 ∪ CJK 二元组，读写共用同一函数，版本戳 `jieba-v1` / `bigram-v1` 控制重建。
  词级精度由此成立：「车」不会命中「车站」。
- **读侧接线**：`searchLocal`（每轮「想起」段）/ `searchText`（TUI recall）/ `listAdmin`（翻阅搜索）
  与全域搜索（`search/*`）改为 **FTS 优先、LIKE 回落**。FTS 只做候选过滤，可见面过滤与时间排序
  一律回源表（ghost / hidden / 已遗忘搜不出来），排序语义与改前一致。
- **失败了就整链回落**：建表失败（老 SQLite / 无 FTS5）或回填失败 ⇒ 写 meta `search_index_disabled`
  + 本进程负缓存，所有入口退 LIKE；**不做半残索引**（残缺索引会静默漏召回）。
- **召回链 P0**：① 来源判定从白名单改**黑名单**（`recall/query-source.ts`）——第三方 IM 桥不再
  静默失去历史召回；② 短句向前拼上文（≤6 条 / ≤240 字），且 `recallQuery` 与 `newUserText`
  **字段分离**（拼长的串绝不进 quote 与体验正文）；③ 每轮被挡在卡外的条目与原因写入
  `echo_step.rejected_json`（superseded / held / limit / exclude-dup / own-card，纯观测）。
- **实体多名称关联**：`search/entity-alias-search.ts` 三级解析（精确归一化 → 双向包含 → FTS）后，
  展开该实体的**交付与任务线**（命中行带 `via=<entityId>`），上游知识只计数量；`upsertEntity`
  改为增量写 `entity_alias`，新实体立即可按别名搜到。`SpiritSearchHit` 增可选 `via`。
- **已知一次性漂移**：升级首启会全量回填索引（万级库数百毫秒）；「想起」段候选从字面子串变为
  词级命中，个别轮次内容会与旧版不同；召回查询串在短句场景变长（更易命中，属预期）。

### 淡出台阶 0-7-30（同批）

- **尺度换成三段台阶**：`Δt < 7 天 ⇒ 1000` / `< 30 天 ⇒ fadeWarmWeight(750)` / 其余 ⇒
  `fadeColdWeight(500，地板)`。地板**只作用末阶**——旧曲线在 90 分钟 + 地板 0.5 下实际只产出
  「1.0 / 0.5」两档，时间分辨率被抹平。
- **配置**：新增 `recall.fadeHotDays/fadeColdDays/fadeWarmWeight/fadeColdWeight`，四个键都进
  `live.*` volatile 与 `settings-get/set` RPC（面板可热更）；`fadeHalfLifeMs` 保留键名，语义收窄为
  **冻结开关**（`0` = 全阶恒 1000）。钳制：`1 ≤ hot < cold ≤ 365`、`500 ≤ cold ≤ warm ≤ 1000`。
- **已知代价**：升级首日条目会「变清楚」（30 天内的强条目从 gist 回到 full）；第 7/30 天跨档时
  卡文本会变一次（设计使然，一天最多跨一次）。保守臂：`fadeHotDays=0`。
- **面板**：新四键已在 RPC 面可写；面板输入行沿用旧「窗口半衰期」一行的位置，三段台阶的控件
  尚待下一批 UI 改动（服务端已生效）。

### 运维闸门（同批）

- **翻阅游标分页**：`entries-list` 接受 `cursor: {tsMs,id}` 并返回 `nextCursor`；`cursor` 与 `offset`
  同给时以 cursor 为准（老客户端只发 offset 时行为逐字不变）。append-only 库上避免 OFFSET
  随页深线性变慢；降级（内存镜像）面同样支持游标。面板翻页已改游标。
- **工具面边界声明**：`spirit_memory` 描述首句改为「只写生涯账/工作账/日记/对话细节；事实、
  方法论、踩坑、规则一律用上游 `memory_search`/`memory_add`」；`gates.test.ts` 增断言防回退。
- **回声链检测闸**：新增 `npm run echo-gate`（`scripts/echo-gate.mjs`，只读）：读 spirit
  `echo_step(kind='injected')` 的卡首行片段，到上游 `l1_records.content` 里查是否被收成知识；
  干净退 0、命中退 1（打印样本）、无法检查退 2。**不写上游、不改配置**。

### 实体卫生（同批，schema v20）

- **归一化补 NFKC**：`normalizeEntityName` 先做 `normalize('NFKC')`、去零宽字符、分隔符与引号/
  括号统一——「ＤＳＨ」与「dsh」不再各算一条别名。**不做繁简折叠**（大表 + 语义误伤），
  繁简差异交给下面的“疑似同一实体”人工确认。
- **别名重建闸**：`meta.entity_alias_stamp = 'nfkc-v2'`；戳变 ⇒ 删 `source='spirit'` 旧键后重建，
  `source='user'`（人工确认）**永不删**。开库时 `ensureEntityAliases` 自动执行，
  避免“搜得到旧的、搜不到新的”且两边都不报错。
- **疑似同一实体（只读）**：`entity-merge-suggest` 出候选（归一化相等 / 共享上游 id /
  包含且差≤4 / 编辑距离≤1），`entity-alias-add` 确认后**只写** `entity_alias(source='user')`；
  **永不改 entity 行、永不合并 id**。
- **里程碑失效标注（v20）**：`distill_digest.stale_at` 派生列 + `markDigestStale` 三分支
  （引用指向已消失实体 ⇒ 标；指向活实体 ⇒ 不标；无引用行 ⇒ 不标）；**只影响展示，正文一字不改**。
  局限已写进注释：真正的上游退场检测需要上游证据面，本判定只看 spirit 侧引用是否还有活实体支撑。

## 0.8.4-local.28 (2026-11-11)

**流程档改为按会话组织 + 去重；L1 读口带 session 维度**

- **会话级流程档（新 tier=`session`）**：`buildSessionDigests` 先按会话把流程性记录（work_task/episodic）归组，再做两层去重：
  会话内同签名只留一行；跨会话同文/前缀包含（长度比≥0.8）并入首个会话，行尾标 `×N`，
  重复来源记进 `source_ids_json`（流程只记一次，出处不丢）。重建幂等：先清 `tier='session'` 再写。
- **week/month 改以会话档为输入**：先会话去重、再按时间窗压行，避免同一件事把窗口挤满；`buildDigests` 新增可选
  `summarizeSessions`（省略时保持旧逐条摘要，向后兼容）。
- **L1 读口**：`L1RecordRow.sessionId`、`searchL1Records({ sessionId })`、列缺失自动降级；`limit` 封顶由 60 提到 2000——
  重建/摘要不再只吃最新 60 条。
- **触发链**：启动 25s、每日 24h、睡眠 `onComplete`、`distill-digest-run` 手动刷新，现在 `ontology-backfill-run` 重建完也会重算
  会话档（同一条 `alignAndDigest` 链）。日志新增「会话数 / 合并重复数」。
- **面板**：「记着」新增「生涯流程 · 按会话（已去重）」组（`memory-list` 的 distill 现含 session 档，最多 10 条）。

## 0.8.4-local.24 (2026-11-11)

**换源：历史重建改读 L1；睡眠总结 L1；代理可记对话细节**

- **历史重建（全记忆重建）换源**：`ontology-backfill-run` 不再是 DRSC 会话扫描，改由 `L1BackfillRunner` 读上游 L1（蒸馏激活中的记忆）：
  `work_task`→task（完成/交付语义 ⇒ done）、`work_artifact`→交付、`graph_nodes`/repo/workspace→entity；
  随后重算 alias/link/引用；id 由 record_id 派生 ⇒ 重跑幂等；L1 缺失 ⇒ 空结果不报错。
- **睡眠（长觉）总结 L1**：`RuminateRunner` 加 `onComplete`，梦醒后重算三档生涯流程档（周/月/里程碑），失败不影响睡眠结果。
- **代理可记对话细节**：`spirit_memory` 新增 `scope=episode`（`kind=detail`，不自动注入，靠 recall 取）；面板「记着」新增「对话细节」组。

## 0.8.4-local.23 (2026-11-11)

- **修上游 400（invalid schema for function spirit_goal）**：`tools/memory.ts` 之前用的是本地 identity `defineTool`，把裸字段表直接发给上游；
  改为宿主 `@deepseek-ai/dsh-tools` 的 `defineTool`（自动包成 `{type:'object', properties, required}`）。
- `spirit_memory` / `spirit_goal` 的 `action` 标为 `required: true`（schema 更严）；新增回归断言：注册对象的 `parameters.type === 'object'`、`action` 在 required 里。

## 0.8.4-local.22 (2026-11-11)

**路由修正：时间性问题走 `spirit_history`，别再拿关键词 recall 硬捣**（用户实报：问「一周做了什么」先去启动 spirit 的错误入口）：

- **新工具 `spirit_history`**：专职时间性查询（默认近 7 天；>7 天加近 30 天档；始终带里程碑），**不占 memory_search 每轮配额**；
  `days/q/limit` 三个参数，q 可省略（时间性问题本来就没关键词）。
- **提示词写清分工**：`spirit_history` 描述里直接写明“事实/方法论/踩坑/项目规则 → 上游 memory_search；写记忆 → spirit_memory write；关键词找自写记忆 → spirit_memory recall”；
  `spirit_memory` 描述同步改成路由口径，不再让人误以为它能只看关键词。
- **`spirit_memory action=recent`**：旧入口也支持时间性查询（与 spirit_history 同一套选档逻辑）。

## 0.8.4-local.21 (2026-11-11)

- **面板「关联实体」**：记着页三档组头下方显示该档串到的实体名（`memory-list.distill[].entityNames` 从 entity 表反查），实体串联在面上可读。

## 0.8.4-local.20 (2026-11-11)

- **按实体查询严格化**：`entity-digest` 未对齐实体 ⇒ 空（不再拿“全部档”冒充）；week/month/里程碑都写入 `entities_json`（别名索引一次加载，200 条生成降到 **33.9ms**）。

## 0.8.4-local.19 (2026-11-11)

- **回响面接流程档**：回响页在 pinned 生涯补充下方展示「生涯流程（近 7 天 · 预总结）」前 3 行（不抢 pinned 位）。
- **记着页「刷新流程档」按钮**：手动触发 `distill-digest-run` 并重新拉取三档（幂等，里程碑不重复）。
- **README**：补「生涯流程档」段（三档/知识性归上游/实体对齐/边界收口）。

## 0.8.4-local.18 (2026-11-11)

**生涯流程档：从上游 L1 预总结（三档）+ 实体双向对齐**（用户口径：知识性归上游，流程性归 spirit；先不失忆）：

- **开口子（边界经用户授权）**：只允许 `src/prime/l1-source.ts` 只读上游记忆库 `l1_records`/`graph_nodes`；门禁 task_7.3 改为“收口允许 + 正向断言”（仅该文件可出现库路径/表名）。
- **三档防失忆**：`distill_digest` 三档——`week`（近 7 天，ISO 周）/`month`（近 30 天，YYYY-MM）/`milestone`（done/交付语义，近 90 天，**只增不改**，按上游 record_id 去重）；摘要为空不覆盖旧档，上游不可用保留旧档；启动 25s + 每日 + 手动刷新（`distill-digest-run`）。
- **知识性零正文**：`work_fact/work_method/踩坑/决定/规范` 一律不落正文，只建 `entity_record_ref`（实体→上游 record_id）；查询引导 `memory_search`。
- **实体双向对齐**：`entity_alias`（spirit 名/别名归一）+ `entity_upstream_link`（上游 graph_node/repo_key/workspace）；**只建链接不新建/不合并实体**；`spirit_memory recall entity=<名>` 可按实体取三档流程行 + 知识引用计数。
- **schema v18**：`distill_digest` 重建为 `(category,tier,period_key)` 主键，新增实体三表；迁移 `17→18` 幂等回填。
- **面板**：记着页三档分组（近 7 天/近 30 天/里程碑）；空档显示（空）。

## 0.8.4-local.17 (2026-11-11)

- **搜索结果行内展开详情**（用户要求：条目展示对了，但要看详细内容）：每条命中多一个「展开/收起」，
  新端点 `record-detail` 按类型给明细（不跳页）：
  - 任务线：状态 / 下一步 / 记录时间 / **交付列表**（最多 6 条，只算未取代的归属）/ 工作区；
  - 交付：摘要 / 记录时间 / 会话 / 来源；
  - 体验：一句话残句 / 情绪三连 / 在意度 / 来源 / 时间 / 会话；
  - 记着：账本+类型 / 是否钉住 / 时间；目的：状态 / 为什么 / 时间；实体：类型 / 在意度 / 别名 / 时间。
  详情按需取、取过缓存；找不到如实说「这条记录不在了」。体验轨与本体轨分两个读面文件，继续守 TA.6(b)。

## 0.8.4-local.16 (2026-11-11)

- **号查不到时继续走文本搜**：以前只要是“像 echo 号”的输入就停在注册表空结果（碎片号尤其明显），
  现在 `id` 命中才用号模式；号查不到 ⇒ 自动回落到全域文本搜，短片段/写错号都能看到真实命中或诚实的空结果。

## 0.8.4-local.15 (2026-11-11)

- **星图定位支持“有号无星”的任务记录**（用户实报：`echo-4238aab1f51a` 定位失败）：
  任务线/记着/目的本身不是星点，以前只回一句“没找到”。现在 `echo-locate` 每条命中附带
  `starEchoIds`（交付/体验=自身；**任务线=它的交付点**；无星点类=空），星海定位按此
  顺着找到对应星点并弹出卡片；实在无星点才如实提示「这条记录本身没有星点……可在翻阅里打开」。
- **星海定位框支持模糊/文本**：输入不是 echo 号（或号命中但无星点）⇒ 自动回落全域文本搜，
  取第一条带星点的命中定位——不必先猜是哪个类型。

## 0.8.4-local.14 (2026-11-11)

- **按 echo 号搜索修好（不是正则，是归一化）**：展示短号去连字符、库里存带连字符的全号，
  直接前缀 LIKE 会在 UUID 第 8 位跨连字符时全部落空（用户实报：星图卡片上看得见的号搜不到）。
  改为两侧都 `REPLACE(echo_id,'-','')` 后比前缀——短号/全号/去前缀三种输入都能命中。
- **搜索打通（v0.8.14 全域）**：翻阅两处搜索框统一走同一套：先试号（注册表），不是号就跨类型搜
  任务/交付/体验/记着/目的/实体（新端点 `spirit-search`，体验轨单独文件守法 TA.6(b) 门禁），
  命中块带 kind + 标题 + echo 号 + 时间 + 「打开」/「星图定位」；不再“因为当前分页的类型搜不到”。
- **星海设置行只在星海显示**：辉光/组织星盘/高质量辉光/只看本轮/主题/范围/echo 定位等，
  切到人设/翻阅/做梦时不再顶在页头（用户实报：翻阅页像误入另一个视图）。

## 0.8.4-local.13 (2026-11-11)

- 搜索框加稳定标记（`data-spirit="onto-search-input"` / `"entries-search-input"` / `"sea-locate-input"`）：
  真机验证与后续 e2e 用稳定选择器定位（合成 input 事件驱动不了受控框，真实键盘注入需要可寻址的锚点）。

## 0.8.4-local.12 (2026-11-11)

**用 echo 号搜索记录 + 星图定位**（用户实报：目前还无法使用 id 搜索条目和定位星图）：

- **新端点 `echo-locate`**：`echo-xxxx` / 短码 / 全 UUID / 去前缀都能查——注册表 `echo_identity` 前缀匹配（不扫汇总表），再回 `echo_ref` 补标题、记录时间、最近回响号；不是号查询 ⇒ `idQuery:false`，调用方继续文本搜。
- **翻阅搜索接入**：本体搜索与条目流搜索先试号查询，号命中则在列表上方出「按 echo 号找到的记录」块（kind + 标题 + echo 短号 + 记录时间 + 「打开」+「星图定位」）；号查询不再拿号去拼文本 LIKE（避免“这个搜索词没有命中”的假空态）。
- **星图定位**：星海头部新增 echo 号输入框 + 「定位」；`seaIntent` 支持 `focusEchoId`，星图就位后按短号/全号匹配星点并选中（弹详情卡）；找不到时如实提示，不假装成功。

## 0.8.4-local.11 (2026-11-11)

**编号模型 v2：记录持 echo 号、回响持 recall 号**（用户口径：这些记录有 echo 号，回响记录有 recall/flashback 号；UUID 级别避免重复）。

- **身份层** `src/echo/identity.ts`：`echo-<uuid>` 由注册表 `echo_identity(kind, mem_id UNIQUE)` 保证“一记录一号”（跨会话/重启同号，不重生）；`recall-<uuid>` 一轮注入一个；短号 = UUID 前 12 位，全号进 tooltip。
- **schema v15→v16**：新增 `echo_identity`；`echo_ref.record_ts`（记录自身时间）、`echo_step.flashback`；迁移把旧 `echo:<kind>:<id>` → echo UUID、旧 `echo-<ts>` → recall UUID（幂等、不重生）。
- **读面**：`echo-records`（旧名 echo-refs 保留一版）；`inject-echo` 返回 `records[] + recall{recallId,at,flashback} + tone`；**星图点/条目流/任务线/本周/记着/目的 全部下发 `echoId`**。
- **UI**：星图详情卡与翻阅各列表显示 `记录时间 + echo-xxxx`；回响面新增 `recall-xxxx · 时间 [FLASHBACK]` 事件头，记录行带 echo 短号。
- **回填**：水位 `echo.records.v2`，按注册表领号；重跑合并不重生。

## 0.8.4-local.10 (2026-11-11)

回响面渲染**组件化**（可测）：`EchoToneBar` / `EchoRefsList` 抽到 `client/src/sea/echo-refs-list.ts`，sea-records 只负责取数与回调。新增元素树渲染测试（`tests/sea-echo-rows.test.ts`）：钉住行文字（`plugin-9lang-five-dim ×3`）、`data-spirit="echo-ref-title"`、tooltip 里的 `echo:<kind>:<id>`、原文展开/「早期落档」话术、空态文案；语气栏钉住徽标与状态/开场各一行。行为与 local.9 一致，只是把「只能靠肉眼」的部分变成可断言。

## 0.8.4-local.9 (2026-11-11)

补齐回响引用面的**可点、可测、可量**：

- **点行定位真源**：引用行标题变成按钮，点击按 kind 跳到对应视图（task/delivery → 本体任务线；memory/goal → 记着；experience → 条目流；未知 kind → 条目流）。原来只有「原文」，用户看得到引用却走不到那条记忆。
- **纯函数抽离 + 单测**：新增 `client/src/sea/echo-view.ts`（`echoRefLabel`/`echoToneLines`/`echoRefTarget`），测试直接钉「行文字是什么、语气几行、点开去哪」——行文字绝不含 `echo:` 编号。
- **规模闸**：`tests/perf-echo-ref.test.ts` 在 1 万行 echo_ref 上钉 50ms 预算——实测会话列表 ~4ms、关键词 0.17ms、跨会话 4.27ms。

## 0.8.4-local.8 (2026-11-11)

回响升级为**记忆引用模型**（echo-id ≡ memid）：回响不再只是"每轮注入观测"，而是"想起过哪些记忆条目"；语气/状态单独成栏。

- **新表 `echo_ref`（schema v14→v15）**：一行 = 一条被想起的记忆，`ref_id = echo:<kind>:<id>`（映射编号，可解回 memid）；同一记忆跨轮召回合并（`times` 累计、`first/last_ts` 包络、`last_echo_step_id` 指最近那轮原文）。索引 `(session_id,last_ts)` + `(mem_id)`。`echo_step` 保留为轮次观测（为什么没卡/原文卡/语气来源）。
- **写入链**：注入轮解析出的条目里，只收**记忆类且有 ref**（线程/反馈/事务/记着/惦记/刚刚/想起）→ `EchoRefStore.upsert`；状态/开场不产生引用行。
- **读面**：新 op `echo-refs`（sessionId/kind/q/时间窗/limit + tone）；`inject-echo` 附带 `refs` 与 `tone`；投影 `spiritEcho` 升 **v6**（`refs[]` + `tone?`，新增字段存在才校验，老帧不破）。
- **回响页（星海）**：主列表改引用行——kind 徽标 + 内容标题 + `×N` + 时间 + 「原文」（按 lastEchoStepId 取注入卡）；顶部独立「此刻/语气」栏（标特殊格式·非引用）；轮次观测折叠保留。
- **回填**：`echo-refs-backfill` 启动错峰 20s 跑一次，仅扫近 7 天且有 text 的轮次，水位 `echo.refs.backfilled` 幂等（无 text 不猜）。
- 清场：撤销了在途的 `echo_recall.echo_id` 残留列（版本未登记、形状不一致）。

## 0.8.4-local.7 (2026-11-11)

回响条目**内容优先 + memid 引用**（用户实报：侧栏条目显示的是 `echo-…127843` 编号，期望的是 `plugin-9lang-five-dim` 这种内容）：

- **内容优先标题**：新增 `titleOfEntries`——标题按 线程（任务名）> 反馈 > 事务（交付句）> 记着 > 惦记 > 刚刚 > 想起 > 状态 > 开场 取；线程取 ` · ` 前那段。落档进 `echo_step.title`（v14 新列）。
- **memid 引用**：每条条目配 `ref {kind,id,label}`（task/delivery/experience/memory/goal），回响从此能挂回具体记忆条目（等价于 memid），而不是只有观测编号。
- **投影 wire 升 v5**：`spiritEcho.steps[]` 增 `title` 与 `refs`（新增字段“存在才校验”，老帧仍合法）；侧栏据此把行文字改成内容名，`echo-<ts>` 退回 tooltip/原文查看。
- **schema v13→v14**：`echo_step` 加 `title`、`refs_json` 两列（老行默认空串/空数组，读侧退到 preview）。
- 提醒：schema 里的注释只能写模板串外——本次踩了一次 `//` 进 CREATE TABLE 导致新库开不起来（已修，db.test 全部回归）。

## 0.8.4-local.6 (2026-11-11)

回响页从“贴整张卡”改成**条目化 + 时间对应 + 分层检索**（用户实报：要的是像 progress 条目那样的东西，不是召回记录也不是卡原文）：

- **条目化**：`splitEchoEntries` 按行首标签切段（词表补上「记着」「惦记」），壳子行（`<system-reminder>`、快照声明、免责声明）全剔；无标签的续行归入上一段。回响页改为逐条渲染（标签徽章 + 内容行 + 时间），旧数据没 entries 才退回原文块。
- **条目对应时间**（`echo-times.ts`）：状态/开场=本轮时刻（tsSource='turn'）；线程→task.updated_at、事务/反馈→txn_entry.ts_ms、刚刚/想起→本会话 experience.ts_ms（前缀匹配）、记着→model_memory.updated_at、惦记→goal.updated_at（tsSource='item'）；**查不到一律标 unknown，不编时间**。
- **分层检索**（新端点 `echo-search`）：第一刀时间段（sinceMs/untilMs）→ 第二刀关键词（LIKE 字面量，% _ 不当通配符）→ 语义向量作为第三级预留（未接嵌入 ⇒ 如实回 `vector:'unavailable'`，不假装兜底）；回 `tier`（time/keyword/none）与 `scanned`。
- **schema v12→v13**：`txn_entry(card_line)` + `task(title)` 两条索引——条目时间反查没索引就是全表扫（perf 闸会追）。
- 契约：`SpiritEchoSnapshot` 加可选 `entries`（带 `ts`/`tsSource`）；旧消费方忽略即可，不破。

## 0.8.4-local.5 (2026-11-11)

- **星海「翻阅→回响」重启后不再空屏**（用户实报：回响页只显“还没有注入快照”）：`inject-echo` 以前只读进程内环形缓冲（重启归零），现加**回退读落档表**：内存空 ⇒ 读 `echo_step` 最近 N 条（带分段计数与卡全文），并标 `origin:'persisted'` + 会话标记，面板用「落档回看」徽标区分，不冒充实时。
  - 两路**不混排**：内存有数据就只用内存（否则同一条会在两处各出现一次，面板无法解释）。
  - `EchoRecallStore` 新增 `recent({sessionId?,limit?})`（sessionId 空=跨会话全局最近）与 `count(sessionId?)`；旧行没存全文的退到 preview 一行摘要。
  - 契约：`SpiritEchoSnapshot` 加 `origin?: 'live'|'persisted'` 与 `recallId?`（供 echo-detail 取全文）；旧消费方当缺省=live，不破。

## 0.8.4-local.4 (2026-11-10)

- **回填顺手补摘要**：`pendingText()` 改成「缺原文**或**缺摘要」都算待补，`setText()` 在写原文时把空 `preview` 一并填上（只填空值）。v10 行原本 `preview=''`，被侧栏当成「无摘要」筛掉——补完摘要后它才重新出现在回响列表里（实测 17:47 那条已回落）。
- 新增 `setPreview()`：已有原文只缺摘要的行只补摘要，不碰正文。

## 0.8.4-local.2..3 (2026-11-10)

- **一周内旧条目回抽原文**：启动后错峰跑一次回填，把近 7 天「只有摘要、没原文」的 `echo_step` 行从 DRSC 会话日志里补回整张卡（`src/echo/text-backfill.ts`）。
  - 匹配优先级：摘要归一化后一致 → 时间最近（摘要对不上放宽到 10 分钟，摘要为空只用 2 分钟）；一张卡只配一条，老条目先补。
  - **忽略空白的比对**：DRSC `redact=1` 会在分段边界插空格（实测 `线程：` 变 `线 程：`），逐字比较会把本该匹配的两卡判成不同人。
  - 纪律：只补空值、不覆盖已有原文；窗口 7 天 / 单次 500 条 / 单会话候选 200 张有顶；扫描或库缺席 ⇒ 整段休眠。
  - 实测（本仓真库）：5 条历史注入行全部补齐原文，重启后仍在。

## 0.8.3-local.1 (2026-11-10)

- **回响条目编号 + 注入原文**：`echo_step` 新增 `id`（`echo-<ts_ms>`，旧行由迁移按 ts 回填）与 `text`（当时注入的整张卡）；新端点 `echo-detail` 按 `sessionId + id` 取原文，严格同会话定位（编号跨会话不通用）。
- `spiritEcho` 帧（`stateVersion: 4`）条目带 `id`，侧栏据此打开原文查看器。
- schema v11→v12：两列加法迁移。

## 0.8.2-local.3 (2026-11-10)

- **回响摘要清洗**：`previewOfEcho()` 只挑分段行（`状态：`/`刚刚：`/`想起：`…）用 ` · ` 连成一句，剔除 `<system-reminder>` 与「（角色体验快照…）」壳子——侧栏第一行不再是一串标签。
- **回响条目列表**：`spiritEcho` 帧补 `steps`（最近 ≤5 轮，含跳过与摘要），`stateVersion: 3`；侧栏因此能逐条列出本会话的回响。

## 0.8.2-local.2 (2026-11-10)

- **schema v10→v11**：`echo_step` 加 `preview` 列（一行摘要，不存整张注入卡）；老库走加法迁移，v10 行取空串。

## 0.8.2-local.1 (2026-11-10)

### 新增

- **回响落档（schema v10）**：新增 `echo_step`（每轮注入/跳过 + 门名 + 指纹 + 分段计数）与 `echo_recall`（本会话被「想起」的段落，同句去重、times 累计）。回响从「进程内观测灯」变成**跨重启保留**的本会话记忆面；`EchoLog` 继续当实时快照供星海「翻阅 → 回响」用。
- **`spiritEcho` 投影换源**（`stateVersion: 2`）：view 改为 `{token, total, segments[], lastStep?}`，只含本会话被召回的回响段与上一轮决策；state 只存 `{sessionId, token}`，令牌由库派生（重启仍单调）。
- **深链支持星图**：`dsh-spirit:open-sea` 接受 `{target: 'graph' | 'echo'}`（兼容旧 `{tab:'records', view:'echo'}`）；`graph` 直接切「星海」页签。

### 验证

- 768 测全绿（新增 `echo-recall-store` 8 例、投影重写 10 例、迁移链 9→10 断言）。

## 0.8.1-local.3 (2026-11-10)

### 修复

- **回响深链恒返 `unregistered`**：宿主 0.2.2-rc.1 的严格代理下 `ctx.get('layout')` 拿不到布局服务，`查看 →` 永远打不开星海。改为四路解析（`ctx.inject(['layout'])` 捕获 → `ctx.layout` 属性 → `ctx.get` → `ctx.reflect.get`），并给回执加可选 `detail`（试过哪几路 / 抛了什么）供消费方挂 tooltip。实机回执从 `{ok:false,reason:'unregistered'}` 变为 `{ok:true}`，星海「翻阅 → 回响」真正打开。

## 0.8.1-local.2 (2026-11-10)

### 新增

- **`spiritEcho` 服务端投影**：把每轮 `agent/pre-step` 的注入/跳过快照暴露给侧栏消费方（`dsh-brief-sidebar`）。state 只存 `{sessionId, rev}`（绝不落卡文本），`items` 只含本会话最新 20 条、每条带 160 字 `preview`，`total` 与 `inject-echo` RPC 同口径。`EchoLog` 新增 `revision()` 供 O(1) 判脏。
- **星海回响深链**：监听 `dsh-spirit:open-sea` 事件（不可取消事件的 ack 协议），由面板主人调用 `layout.selectPanel` 并回执；`SeaPanel` 切到 `records` 页签、`SeaRecords` 切到 `echo` 子视图。未挂载 / main key 未注册分别回 `unmounted` / `unregistered`。

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

## 0.8.0

模型可写记忆 + 目的层（user 点单：对标 agent-soul 的 soul_memory，但**两本账必须分清**）：

### 两本账（schema v9：model_memory）
- **生涯账（scope=life）**：心里话、与主人的约定——全局，跟人格连续性走；pinned 以「心里记着：…」进**人格区**（稳定区，不逐轮变）。kind：bond/promise。
- **工作账（scope=work）**：长期工作的事实/决定/偏好/约定——**按工作区隔离**（workspace_id 空=跨区）；pinned 只进对应工作区的**事务卡「记着」段**（最多 2 条）。kind：fact/decision/preference/promise。
- **日记（scope=diary）**：按条追加、**不写 md、不自动注入**；需要时工具 `recall` 按词取（或面板看）——按用户要求不落档，靠回响/检索通道调取。
- 纪律：写前脱敏（含密整条拒）、text 钳 200 字、同 scope 同文幂等（撞 id 只刷时间）、forget 置标记不物理删、kind 越界拒写。

### 目的层（goal）
- 惦记的事（open/done/dropped），按工作区隔离；open 目标以「惦记：…」段进事务卡（最多 3 条）；同标的重开会复用行。

### 工具面（部署总闸关 ⇒ 不注册）
- `spirit_memory`：write/pin/unpin/forget/recall/list（scope 必选，描述里写明两本账边界）。
- `spirit_goal`：add/done/drop/list。

### 观测与面板
- 新端点 `memory-list`（life/work/diary/goals 四组）；翻阅·本体新增「记着」子页；回响页新增「生涯记忆补充（pinned）」段——回响通道能调到生涯记忆。
- 卡新段：「记着」（工作账 pinned）/「惦记」（open 目标），优先级在反馈/线程之后、事务之前；指纹随之扩展（关时逐字节不变）。

### 迁移
- schema v8→v9：两张纯新表（model_memory + goal），老库走迁移链自动建。

## 0.7.0

对表 dsh-soul / dsh-agent-soul 的三项能力补齐（用户点单）：

### 人格配置编译器（对表 dsh-soul）
- **预设库**：5 张内置预设（安静记录者/如实记事/直白工程师/俏皮同伴/诗意守夜人）+ 自建预设（存/删，内置保护）。
- **激活 = 写正式人设**：走 `PersonaStore.save()` 唯一写路径（revision 推进/历史留档/md 重生全继承）；预设库只记 activeId。
- **作用域覆盖（只读投影）**：会话 > 工作区 > 激活 > 当前卡；会话绑定 30 天回收（照 dsh-soul 的 sidecar 纪律）；注入侧按 agent 的 workspace/session 实时解析，缓存键含命中预设 id。
- **审计**：activate/bind/unbind/preset-save/delete 追加 `persona-audit.jsonl`（面板回显尾部 20 条）。
- 面板：人设页新增预设行（选/激活/删/另存）+ 本会话绑定 + 生效来源徽标。
- 六新端点：`persona-presets / persona-activate / persona-preset-save / persona-preset-delete / persona-bind / persona-effective`。

### 注入回响面（对表 prime-memory 的 memory 激活槽位）
- 每轮 pre-step 落一条快照：注入了什么（全文 + 指纹 + 分段行数）或为什么没注入（门名）；进程内环形缓冲 200 条，不落库。
- 新端点 `inject-echo`；翻阅面新增「回响」子视图（时间/注入或跳过/门名/指纹/分段 chips/卡全文）+ 头部刷新接入。

### 规则打分（对表 dsh-agent-soul，叠加在四级 salience 上）
- `recall/txn-score.ts`：档位基底(100/70/40/20) + 来源加分(user_explicit +20) + 结构加分(cue +10/summary +8) + 近因微调(24h 内 ≤ +12) - 噪声罚分(短句 -10)；确定性、零 LLM、可重算不落库。
- 交付卡行从「最新一条」改为「窗口 12 条内取分最高」，同分仍新者胜；注入面仍只读 card_line 不进 summary。

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



