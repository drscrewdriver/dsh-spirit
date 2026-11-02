# 更新日志

本项目的所有值得记录的变更都写在这里。版本号遵循语义化版本。

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
