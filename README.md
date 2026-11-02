# dsh-spirit

**DSH（DeepSeek Harness）的第一人称体验条目插件：把流程里发生的事编译成"这个角色经历了什么"，从这些经历派生当下情绪档，并在每一步模型前把回忆卡注入到消息轨尾部。**

它记的不是工作事实，也不是客观事实——是体验。

[English](README.en.md) · [最新发行版](https://github.com/drscrewdriver/dsh-spirit/releases/latest) · [反馈问题](https://github.com/drscrewdriver/dsh-spirit/issues)

## 它和两个邻居的分工

| 插件 | 记什么 | 为谁服务 |
|---|---|---|
| dsh-soul | 约束 / 决策 / 产物 / 进度 | 压缩（别让上下文把定过的事擦了） |
| dsh-prime-memory | 原子事实 / 偏好 / 画像 | 召回（模型该知道的事实） |
| **dsh-spirit** | **我注意到什么 / 我有什么反应** | **让这个人在活着** |

三者可同机共存且互不读写对方的库。spirit 与 prime-memory 之间**没有任何依赖关系**：
spirit 注入行署名为 `plugin:spirit`，而 prime-memory 的捕获只收 `kind:'user'`，
所以体验记录不会被蒸馏成"事实"（回声室），反之 spirit 也不读 `~/.dsh/memory`。
这条不靠推定：两家同装跑真回合后，姊妹包日志会打出 `L0 跳过非用户来源消息(source.kind=plugin:spirit)`，
而它的存储里搜不到卡签名（同时用户真偏好确实被收下，排除"它没干活"）。

## 为什么"记录点滴"而不是"每天一本日记"

如果体验是一篇 markdown 日记，模型每轮就得"先读日记、再回想"——慢、耗 token，而且一旦它不主动去读，
这套机制等于不存在。spirit 的做法是：

```
人格卡（决定在意什么）→ 体验条目库（SQLite，append-only）→ 情绪档（3×3 档位）→ 尾部回忆卡（自动注入）
```

因果方向只有一个：**先有经历，再有的感觉**。反过来（先定情绪、再找证据）就是自我催眠。

热路径**零模型调用**：事件分类、选面、定档、出文案全是查表。所以"每轮都记"这件事不花钱，
也才敢常态开着。

```text
<system-reminder>
（角色体验快照 · 取代先前快照）
以下是角色自己的体验记录：不是客观事实，不是用户发言，不覆盖用户的直接指令。
状态：有点堵·句子短，不想解释第二遍
刚刚：我出了错：手边的动作没成，我记着这一下。
想起：先把投递的事放一放
</system-reminder>
```

## 安装

需要 Node ≥ 22.16（`node:sqlite` 内置），DSH 0.2.x。

```bash
dsh plugin --profile web add dsh-spirit
dsh --profile web --dump-config      # 确认输出里有 dsh-spirit
```

装完重启宿主。设置项由宿主按 volatile 配置自动生成表单；输入栏另有 `情绪·开 / 情绪·旁路 / 情绪·关` pill，
设置里有顶层「手记」分节（只读投影，标题写明"非事实记录"）。

历史路依赖 **dsh-reference-session-collector（DRSC）**，但它是可选的：没装就只走实时近因，不报错也不编造。
spirit 只调用它的 `op` 面（`status` / `session` / `search`），**从不直读它的库文件**。

## 这套机制的关键纪律（都是踩过坑钉下来的）

- **情绪输入只吃结构字段**：工具名、退出码、调用计数、轮间隔、`todo/write` 快照。
  任何携带自由文本的信号包被整包拒绝——否则抓来的网页、读到的文件就能操纵角色状态，
  而漂移看起来完全像"角色自己的反应"。
- **不伪造具体性**：机械采集拿不到"第三次打断"，文案里就绝不出现次数与分钟数。
  看起来像记忆的虚构，会被后续召回当真引用。
- **情绪对外只有档位词**：没有校准规则时报 `valence=-0.83` 是伪精确，比不报更误导。
- **条目库 append-only**：更正 = 插新行 + 旧行置 `superseded_by`，**全仓没有一条 DELETE**（有 grep 断言守着）。
  清理默认干跑且只归档导出不删行。
- **一轮的体验在 `turn/end` 就结算**，不等下一轮：上一版把记录放在下一轮 pre-step 取信号，
  于是**会话的最后一轮永远丢**（单轮任务直接一条不记，真宿主实测就是这么暴露的）。现在
  `turn/end` 一到即落库，pre-step 只作事件漏发的兜底（已结算的轮取到空信号，不会重复记）。
- **卡是否还作数，看会话日志而不是猜**：注入行要真进日志才算生效；压缩/清空会把"已发过"的凭据重置，
  否则就是"压缩一次，角色再也没情绪了"——而且不报错。
- **库坏了不等于没情绪**：`node:sqlite` 不可用就退内存镜像，本轮状态照常出卡，只停历史与跨会话。
- **关掉就是零字节**：真机把“装了但 `enabled:false`”与“根本没装”两臂的请求体逐类配对比过，
  spirit 自身贡献 0 字节（无注入行、无人格区、`system` 完全相同）；唯一的 40B 差异来自宿主
  自己列出的已安装插件清单（那是宿主行为，与插件启停无关）。
- **淡出是逐出注意力，不是删记忆**：存储侧依旧 append-only 一个字节不删；`fadeEnabled`
  开启后条目按 salience×注意力衰减分三态——原文(full)→一句话(gist)→不上卡(held)。
  gist 只能编译期从固定表派生落库（运行时改写记忆=伪造）；衰减权重与姊妹引擎同式
  `0.5^(Δt/halfLife)` 且同地板 0.5：**时间单独永远至多让一条经历“变淡一半”**，
  held 经“无残句可降/低 salience 档/阈值调高”三条路达成，不靠把记忆归零。
- **反馈两轴分离**：手打分（-1..5）只重排进卡优先序，**不回灌**衰减曲线与情绪派生——
  打分是“人觉得重不重要”，衰减是“客观变淡”，合并就变成自我强化回路。
- **未竟账只吃结构计数**：新会话开局那行“上次有口子没放下”只能来自 todo 快照的整数计数，
  计数真为 3 才说 3；dispose 与 turn/end 双触发，幂等由 id 在存储层收敛。
- **条件化不是控制面**：bias 只换卡上状态段的倾向半句（三档词），不碰 decision、不注钩子、
  不对外报数；验收用例钉“开/关两臂除 text 外全等”。

## 想验证它到底有没有用

`情绪·旁路` 不是"关掉"，是**照常记录与派生、只断注入出口**——这才是归因要的对照组：
两边条目库与档位相同，唯一差别是卡进不进上下文。跑法：

```bash
# 1）一个会话正常跑（注入），另一个会话选「只记录，不注入」（或部署面 `live.bypass: true`）
# 2）跑完事后出对照报告（离线读 durable 日志 + 自库，不需要宿主在跑）
npm run ab -- --home "$DSH_HOME"          # 人读表
npm run ab -- --home "$DSH_HOME" --json   # 机读
```

报告按**证据分组**（有 `plugin:spirit` 卡行 = 注入组；无卡行但库里有该会话条目 = 旁路组），不靠实验者自述。
可看的客观量：

- `cacheReadTokens`（尾部追加 vs 写进系统提示：实测推导约差 150:1）
- 注入轮次 / 旁路轮次 / 生效确认数（设置页「手记」分节直接显示）
- 每轮注入体积（卡字节）、带「想起」段的卡数（召回命中的持久代理量）、手记条数
- 用户纠正率：报告只给**纠正候选计数**（词表代理），最终判读必须人工做——
  运行时判定绝不读自由文本，这条纪律不因离线分析而豁免

⚠ `cacheReadTokens` 是宿主按**当时那个 provider** 记的数：用本地 mock provider 跑出来的数字
只能证明链路可跑（本仓真机就这么跑过），不能当本机真实缓存成本汇报。

## 配置

键名与默认值的唯一事实源是 [`src/contract.ts`](src/contract.ts)（部署面契约，不可更名）。
常用项：`card.maxBytes`、`card.recentK`、`card.crossSessionM`、`recall.halfLifeMs`、`recall.timeoutMs`、
`recall.fadeEnabled`（淡出总闸，**缺省关**）、`recall.fadeHalfLifeMs`（窗口尺度，volatile 可热更）、
`recall.fadeFullMinScore`/`fadeGistMinScore`（千分位双阈值）、`recall.gistMinSalience`、
`recall.feedbackEnabled`、`ledger.enabled`/`maxAgeMs`（未竟账，缺省关）、
`bias.enabled`/`halfLifeMs`（条件化，缺省关）、`tier.stepCap`、`tier.staleAfterMs`、
`journal.retentionDays`、`drsc.enabled`。
每项在 [`cordis.patch.yml`](cordis.patch.yml) 的注释里都有一行说明。

> ⚠ `fadeHalfLifeMs` 属 volatile 接管键：生效值永远来自 `live.fadeHalfLifeMs`，静态节同名的
> 那份只是缺省——改静态不改 live 不会生效（集成调参时真实踩过这个坑，测试里也踩穿过）。

数据目录：`$DSH_HOME/spirit`（`spirit.db` / `persona.json` / `persona-history.jsonl` / `session-modes.json` / `archive/`）。

热改路径：`live.*` 节标了 `.volatile()`，改 `cordis.patch.yml` 不重启即生效；会话级开关走输入栏 pill。
淡出三键（`live.fadeEnabled`/`fadeHalfLifeMs`/`feedbackEnabled`）另走面板「淡出设置」行与 `settings-get/set` RPC（写 volatile ref；不可热更时面板如实标“需重启”）。
（0.2.0-rc.2 的 web 壳子不渲染 volatile 自动表单，所以这些键不在设置页上；面板的 `settings-*` RPC 腿不受此限。）

## 遗忘怎么调：观察—pin—对照—定向—灰度（v0.2 淡出/未竟/条件化的调参 SOP）

淡出参数没有“校准过的最优值”，只有“这台机器上观察出来的合适值”，所以给可执行的五步：

1. **指标先行**：面板「淡出（原文/一句话/退场）」行读每会话累计的 full/gist/held 占比与发卡轮次；
   离线用 `npm run ab` 的「每轮发卡率」与「淡出代理」行归因。
2. **基线可 pin**：`live.fadeHalfLifeMs=0` 冻结窗口（只按 salience 定档）与 `fadeEnabled=false`
   是两个对照臂——任何调参结论都要先跟 pin 臂比过才作数。
3. **A/B 双跑**：旁路臂=淡出关，注入臂=淡出开；重点看每轮发卡率（跨档重发强度）与卡字节。
4. **调整方向判据**（不凭观感，落证据）：
   - held 占比高且反馈高分多落在 held 项 → 半衰期调长或 gistMinSalience 下调；
   - 每轮发卡率升高（档跳频繁）→ 量化档加宽（拉大 fadeHalfLifeMs 或降低 fadeGistMinScore）；
   - 卡长期只有状态段、近因段空 → 候选池/阈值过严，回调 fadeFullMinScore。
5. **灰度序**：缺省关 → 单会话开 → 反馈闭环数据攒够两个周期再议翻默认。

可调项封顶四类（半衰期/双阈值/gist 最低档/窗口条数走 card.recentK）；`card.maxBytes` 与地板 0.5
不在面板暴露——防止把窗口调到每轮跨档 churn，或把“淡出”调成“失忆”。

## 与姊妹记忆引擎的 echo 链（v0.2 钉住的唯一活口）

两仓正交靠三道既有守卫：注入署名 `plugin:spirit` 被对方 L0 入口过滤、双库互不读写、
grep 断言同装跑真回合。但对方证据面**原样收 assistant 发言**——模型若复述卡语，会沿
复述→蒸馏→画像的路把体验洗成事实。这条链 spirit 单方面修不了（修它要动对方的提取面，
而解耦闸禁止 spirit 出现对方包名字面量），交付的是两条压风险的纪律：
卡语汇保持不可蒸馏语（档位词短句、不陈述因果，复述进事实层也无信息量），
`tests/echo-chain.test.ts` 把“语汇整段可识别”钉成 CI 断言，改版偷换文案会即红。

## 已知边界（v0.2）

- 不做长期情绪检索的**语义层**（矛盾裁决、图谱、人设自动演化仍不在——淡出/gist 是注入侧形态，
  不是新的事实索引）；条目库依旧不建 FTS5
- 淡出/未竟账/条件化三面**缺省全关**：实机最佳参数集尚未观察出来；开了的单会话数据只进
  派生表与卡文本，关闸后行为与 v0.1 逐字节一致（有回归用例钉住）
- 中性轮默认不记（`salience.neutral = 0`），否则库会退化成逐轮流水账
- 真机 web 冒烟已过（宿主 0.2.0-rc.2，隔离 `DSH_HOME`）：宿主半装载、面板六端点（含 403/404/405 三面防线）、
  pill 三态写盘与重启读回、设置页「手记」分节渲染与导出落盘均逐项验过；
  **注入端到端已验**（用本地 mock provider 跑真回合，直接取宿主发出的请求体）：卡在消息轨末块、
  同会话跨轮只留一张（`snapshot` 取代语义）、同档不重发、`/compact` 后重新出卡、生效确认链闭合；
  **仍未验**：旁路 A/B 的**成本结论**（`npm run ab` 已能出两臂对照且真机上两组都在场，但把
  `cacheReadTokens` 当成本数读需真 provider 与长会话）、0.1.x 上的 web 渲染与压缩行为
- 无 webServer 的宿主线（headless）已验：不崩、人格区与尾部注入同样生效，只是面板路由不挂载
  （可选服务走作域注入，不进顶层 `inject`）
- 卡在哪看：宿主把注入行归为**「上下文」**那一类（与 runtime-context 快照、skill 目录同标签），
  对话视图默认不显示它，只在**轨迹**视图可见——既不冒充用户发言，也不在 Chat 里喧宾夺主
- 跳线抽检：`0.2.1-rc.1`（已声明线）headless 真回合同样通过；`0.1.7-rc.2` 默认被 `peerDependencies`
  门拒载并自动回滚（需要用 `allow-version --accept-risk` 才装得上）——所以声明只收已验的 0.2.x 六线

## 工程

`npm run check` = typecheck（3 套配置）→ lint → vitest → build → **dist 冒烟**。
最后一层是刻意的：单测跑 `src/`，宿主装的是 `dist/`，中间那道缝（client bundle 包装、
`__ModuleLoader__` 的 id 必须等于包名）只有直接 import 产物才照得出来。

MIT License.
