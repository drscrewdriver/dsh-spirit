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
- **卡是否还作数，看会话日志而不是猜**：注入行要真进日志才算生效；压缩/清空会把"已发过"的凭据重置，
  否则就是"压缩一次，角色再也没情绪了"——而且不报错。
- **库坏了不等于没情绪**：`node:sqlite` 不可用就退内存镜像，本轮状态照常出卡，只停历史与跨会话。

## 想验证它到底有没有用

`情绪·旁路` 不是"关掉"，是**照常记录与派生、只断注入出口**——这才是归因要的对照组：
两边条目库与档位相同，唯一差别是卡进不进上下文。可看的客观量：

- `cacheReadTokens`（尾部追加 vs 写进系统提示：实测推导约差 150:1）
- 注入轮次 / 旁路轮次 / 生效确认数（设置页「手记」分节直接显示）
- 用户纠正率、回复长度

## 配置

键名与默认值的唯一事实源是 [`src/contract.ts`](src/contract.ts)（部署面契约，不可更名）。
常用项：`card.maxBytes`、`card.recentK`、`card.crossSessionM`、`recall.halfLifeMs`、`recall.timeoutMs`、
`tier.stepCap`、`tier.staleAfterMs`、`journal.retentionDays`、`drsc.enabled`。
每项在 [`cordis.patch.yml`](cordis.patch.yml) 的注释里都有一行说明。

数据目录：`$DSH_HOME/spirit`（`spirit.db` / `persona.json` / `persona-history.jsonl` / `session-modes.json` / `archive/`）。

热改路径：`live.*` 节标了 `.volatile()`，改 `cordis.patch.yml` 不重启即生效；会话级开关走输入栏 pill。
（0.2.0-rc.2 的 web 壳子不渲染 volatile 自动表单，所以这些键不在设置页上。）

## 已知边界（v0.1）

- 不做长期情绪检索、图谱、矛盾裁决、人设自动演化（那是记忆引擎与 soul 的地盘）
- 中性轮默认不记（`salience.neutral = 0`），否则库会退化成逐轮流水账
- 真机 web 冒烟已过（宿主 0.2.0-rc.2，隔离 `DSH_HOME`）：宿主半装载、面板六端点（含 403/404/405 三面防线）、
  pill 三态写盘与重启读回、设置页「手记」分节渲染与导出落盘均逐项验过；
  **注入端到端已验**（用本地 mock provider 跑真回合，直接取宿主发出的请求体）：卡在消息轨末块、
  同会话跨轮只留一张（`snapshot` 取代语义）、同档不重发、`/compact` 后重新出卡、生效确认链闭合；
  **仍未验**：旁路 A/B 的成本对照（`cacheReadTokens` 需真 provider 与长会话）、0.1.x 上的 web 渲染与压缩行为
- 无 webServer 的宿主线（headless）已验：不崩、人格区与尾部注入同样生效，只是面板路由不挂载
  （可选服务走作域注入，不进顶层 `inject`）
- 跳线抽检：`0.2.1-rc.1`（已声明线）headless 真回合同样通过；`0.1.7-rc.2` 默认被 `peerDependencies`
  门拒载并自动回滚（要拿 `allow-version --accept-risk` 才装得上）——所以声明只收已验的 0.2.x 六线

## 工程

`npm run check` = typecheck（3 套配置）→ lint → vitest → build → **dist 冒烟**。
最后一层是刻意的：单测跑 `src/`，宿主装的是 `dist/`，中间那道缝（client bundle 包装、
`__ModuleLoader__` 的 id 必须等于包名）只有直接 import 产物才照得出来。

MIT License.
