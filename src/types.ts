/**
 * dsh-spirit 契约层 —— **Phase 0 冻结点**。
 *
 * 本文件的字面量枚举是三族形状（事件 / 反应 / 档位）的**唯一事实源**：任何模块要取值
 * 一律从这里引，别处再抄一份字面量即门禁红（`tests/enums-single-source.test.ts` 机械核对）。
 * 冻结后改动需回到计划 Phase 0 重跑全链门禁，不允许在实现轨里就地改。
 *
 * 命名常量（插件 id / section 名 / RPC 前缀 / source kind）在 `contract.ts`，
 * 配置键与默认值同样单源于该文件；本文件只管**形状与取值域**。
 */

// augmentation 目标须先进入程序（import 触发解析），否则 declare module 报 TS2664。
// 本文件有顶层 import，故下文可直接引用 `ContextFormed`（无需 `import()` 内联形式）。
import type { ContextFormed } from '@deepseek-ai/dsh-llm';

/**
 * 宿主会话格式 v4（dsh-llm ≥0.1.7-rc.1）的 producer-owned source kind 登记。
 *
 * v4 移除了 `MessageSourceMap` 的 catch-all `plugin` kind（message.d.ts 明言
 * "each producer declares its own `kind` in its own module"），未登记则
 * `createUserMessage({ source })` 在类型层报 TS2345（封闭联合，无 index signature）。
 *
 * 本插件只用一种形状：`{ kind: 'plugin:spirit', form: 'snapshot', sections: [...] }`。
 * 选 `snapshot` 而非自造作废句式的理由（0.2.0-rc.2 实测）：`ContextForm` 里
 * `snapshot` 的定义就是 "Current state, where a later snapshot from the same producer
 * supersedes an earlier one"，且 client 已带 `message.context.snapshot.supersedes`
 * 「取代先前的快照」文案 ⇒ 回忆卡天然只有一条生效，不需要改写历史消息。
 * ⚠️ `form: 'slot'` 不是合法值（六枚联合：instructions|catalog|snapshot|notice|relay|recall）。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:spirit': { kind: 'plugin:spirit' } & ContextFormed;
  }
}

// ─────────────────────────────────────────────────────────── 取值域（单源）

/**
 * 机械事件族：只允许**本地可判**的结构化信号。
 *
 * ⚠️ 红线：新增成员必须能由宿主事件/工具返回值机械判定。**禁止**加入需要读
 * assistant 文本或工具输出内容才能识别的类别——那会把对话内容（含网页抓取、
 * 文件正文）变成情绪诱导面，外部文本就能操纵角色状态。
 *
 * 逐成员含义（已按“可机械判定”重写，与早期设计稿不同）：
 * - `user_interruption`：上一轮未结束就有新的用户消息插进来。**不是**“用户指出了不对”——
 *   那个判定必须读用户文本，正是上面禁止的形状；早先注释写了“宿主可判”是错的
 * - `tool_failure`：本轮有工具调用失败
 * - `recovery`：上轮失败的那个工具，本轮同名调用成功
 * - `task_close`：`todo/write` 快照非空且全部完成（之前并非已全完成）
 * - `long_gap`：轮间隔超过 `capture.gapThresholdMs`
 * - `neutral`：以上都不成立
 */
export const TRIGGER_USER_INTERRUPT = 'user_interruption' as const;
export const TRIGGER_TOOL_FAILURE = 'tool_failure' as const;
export const TRIGGER_RECOVERY = 'recovery' as const;
export const TRIGGER_TASK_CLOSE = 'task_close' as const;
export const TRIGGER_LONG_GAP = 'long_gap' as const;
export const TRIGGER_NEUTRAL = 'neutral' as const;
export const TRIGGER_KINDS = [
  TRIGGER_USER_INTERRUPT,
  TRIGGER_TOOL_FAILURE,
  TRIGGER_RECOVERY,
  TRIGGER_TASK_CLOSE,
  TRIGGER_LONG_GAP,
  TRIGGER_NEUTRAL,
] as const;

export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/**
 * 关注点族（notice）：同一事件里角色**注意到的是哪一面**。
 * 由人格的 `focus` / `salience` 选择，是"人格决定记什么"的落点。
 */
export const NOTICE_SELF_MISTAKE = 'self_mistake' as const;
export const NOTICE_USER_STATE = 'user_state' as const;
export const NOTICE_TASK_PROGRESS = 'task_progress' as const;
export const NOTICE_TASK_STALL = 'task_stall' as const;
export const NOTICE_BEING_IGNORED = 'being_ignored' as const;
export const NOTICE_BEING_ACKNOWLEDGED = 'being_acknowledged' as const;
export const NOTICE_ENVIRONMENT = 'environment' as const;
export const NOTICE_KINDS = [
  NOTICE_SELF_MISTAKE,
  NOTICE_USER_STATE,
  NOTICE_TASK_PROGRESS,
  NOTICE_TASK_STALL,
  NOTICE_BEING_IGNORED,
  NOTICE_BEING_ACKNOWLEDGED,
  NOTICE_ENVIRONMENT,
] as const;

export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** 反应强度档位（枚举，非数值）。命名单例先行定义、再组成取值域，代码里引用单例即不写新字面量。 */
export const REACTION_NONE = 'none' as const;
export const REACTION_MILD = 'mild' as const;
export const REACTION_STRONG = 'strong' as const;
export const REACTION_TIERS = [REACTION_NONE, REACTION_MILD, REACTION_STRONG] as const;
export type ReactionTier = (typeof REACTION_TIERS)[number];

/** 效价档位（枚举，非数值）。 */
export const VALENCE_NEG = 'neg' as const;
export const VALENCE_MID = 'mid' as const;
export const VALENCE_PLUS = 'plus' as const;
export const VALENCE_TIERS = [VALENCE_NEG, VALENCE_MID, VALENCE_PLUS] as const;
export type ValenceTier = (typeof VALENCE_TIERS)[number];

/** 唤起档位（枚举，非数值）。 */
export const AROUSAL_LOW = 'low' as const;
export const AROUSAL_NORMAL = 'normal' as const;
export const AROUSAL_HIGH = 'high' as const;
export const AROUSAL_TIERS = [AROUSAL_LOW, AROUSAL_NORMAL, AROUSAL_HIGH] as const;
export type ArousalTier = (typeof AROUSAL_TIERS)[number];

/** 语气档（查表文案的第三个键）。 */
export const VOICE_PLAIN = 'plain' as const;
export const VOICE_TERSE = 'terse' as const;
export const VOICE_WARM = 'warm' as const;
// 语气扩列（v0.3.6 用户点名：三档偏少）——新档只进枚举与词表，全链自动传导
// （面板 select 列 VOICE_TIERS、md 反查表由两者派生、稳定区 [语气] 行读 VOICE_WORDS）。
export const VOICE_LIVELY = 'lively' as const;
export const VOICE_HUSH = 'hush' as const;
export const VOICE_BLUNT = 'blunt' as const;
export const VOICE_POETIC = 'poetic' as const;
export const VOICE_TIERS = [VOICE_PLAIN, VOICE_TERSE, VOICE_WARM, VOICE_LIVELY, VOICE_HUSH, VOICE_BLUNT, VOICE_POETIC] as const;
export type VoiceTier = (typeof VOICE_TIERS)[number];

/**
 * salience 权重三值：
 * - `0` 不在意 ⇒ **不产生条目**（"不记什么"也是人格）
 * - `1` 在意 ⇒ 记一行
 * - `2` 很在意 ⇒ 多带一句注意到的细节
 */
export const SALIENCE_WEIGHTS = [0, 1, 2] as const;
export type SalienceWeight = (typeof SALIENCE_WEIGHTS)[number];

/** 条目来源路：实时钩子 vs DRSC 历史投影。 */
export const LANE_LIVE = 'live' as const;
export const LANE_DRSC = 'drsc' as const;
export const LANES = [LANE_LIVE, LANE_DRSC] as const;
export type Lane = (typeof LANES)[number];

/**
 * 来源可信度四档（v7 事务轨三档 + v8 回填档，单源在此）。
 *
 * 语义采集必须带来源标记，因为"这条从哪来"决定它能不能进注入卡：
 * - `user_explicit`：主人显命名过的实体/意图 ⇒ 允许直接进卡
 * - `structure_signal`：纯结构量派生（basename/计数/词表档位）⇒ 无自由文本，可进卡
 * - `derived_summary`：LLM 批蒸产物 ⇒ **禁入 recent()/deriveMood/注入指纹**（G15 同族纪律）
 * - `backfill`：历史会话回填产物 ⇒ **绝不进注入读面**（只进翻阅/timeline/resource-lookup）；
 *   历史正文未经当时语境校准，回流当前上下文风险高于在线采集，故单列一档并默认排除。
 * 与注入署名 `SPIRIT_SOURCE_KIND` 解耦：本值只说"从哪来"，不改署名（防冒充用户轮次）。
 */
export const TRUST_USER_EXPLICIT = 'user_explicit' as const;
export const TRUST_DERIVED_SUMMARY = 'derived_summary' as const;
export const TRUST_STRUCTURE_SIGNAL = 'structure_signal' as const;
export const TRUST_BACKFILL = 'backfill' as const;
export const SOURCE_TRUST_VALUES = [TRUST_USER_EXPLICIT, TRUST_DERIVED_SUMMARY, TRUST_STRUCTURE_SIGNAL, TRUST_BACKFILL] as const;
export type SourceTrust = (typeof SOURCE_TRUST_VALUES)[number];

/**
 * 本体层词表（v8，单源在此）。
 * - EvalKind：评价/互动档位。positive/negative/directive 直接复用 matchIntent 的 IntentKind；
 *   question（追问）为预留位，待后续检测器接入，当前采集不产出。
 * - AnchorMode：评价锚定方式（显式引用 / 同任务 / 时间邻近 / 悬置）。unresolved = 没找到锚点，不硬绑。
 */
export const EVAL_KINDS = ['positive', 'negative', 'directive', 'question'] as const;
export type EvalKind = (typeof EVAL_KINDS)[number];
export const ANCHOR_MODES = ['explicit', 'task', 'recency', 'unresolved'] as const;
export type AnchorMode = (typeof ANCHOR_MODES)[number];

/**
 * 实体 kind 五词单源（v8 本体层）：比事务轨的 cue 四词（file|person|tool|topic）更细，
 * 顺带补上旧口径缺口（URL host 无 cue kind → resource 承接）。采集侧只产这五个值，不开放词表。
 */
export const ENTITY_KINDS = ['person', 'project', 'module', 'concept', 'resource'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * 因果四词单源（v0.3.5 长觉阶梯）：启发式边与 LLM 投影边的 relation 都往这四处归。
 * 词表是开放的（LLM 可提新关系词，只钳长度不白名单），但这四个是「因果」的规范集：
 * 星海截断优先判定与面板图例都读这一处，不各抄第二份（照姊妹包同一教训）。
 */
export const SPIRIT_CAUSAL_RELATIONS = ['导致', '因为', '修复了', '取代'] as const;

/**
 * 探测/自检判定四值。`skipped` 是**中性无据**（如 DRSC 未安装），
 * 绝不写成 `warn`——把"无法判定"当"异常"会让用户看到一串假故障。
 */
export const VERDICT_OK = 'ok' as const;
export const VERDICT_WARN = 'warn' as const;
export const VERDICT_FAIL = 'fail' as const;
export const VERDICT_SKIPPED = 'skipped' as const;
export const SPIRIT_VERDICTS = [VERDICT_OK, VERDICT_WARN, VERDICT_FAIL, VERDICT_SKIPPED] as const;
export type SpiritVerdict = (typeof SPIRIT_VERDICTS)[number];

// ─────────────────────────────────────────────────────────── 形状

/** 结构化事实（可回溯的客观骨架）；与 `text`（体验句）**分列，永不混呈**。 */
export interface ExperienceFact {
  /** 涉及的工具名（有界：最多 3 个）。 */
  tool?: string;
  exitCode?: number;
  /** 涉及文件的 basename（不带目录，避免路径外泄）。 */
  pathBases?: string[];
  /** 本条覆盖的轮次区间 [起, 止]。 */
  turnSpan?: [number, number];
  toolCalls?: number;
  toolFailures?: number;
  /** 本轮新用户消息字符数（不存原文）。 */
  userChars?: number;
  /**
   * 用户原文片段：**仅当 `capture.userSnippet` 显式开启时存在**，且已按
   * `capture.maxQuoteChars` 截断。三条硬约束（红线，不是建议）：
   * - 不参与情绪判定（`compileTurn` 永远看不到它，信号包带自由文本会被整包拒绝）；
   * - **永不进 cues**（否则用户的话会变成检索键，再被“想起”段回灌进提示）；
   * - **永不进卡文本**（卡只说“我怎么经历”，不引用用户原话）。
   */
  quote?: string;
  /** 距上一轮的间隔 ms。 */
  gapMs?: number;
}

/** 一条体验条目（库内真源形状；SQL 列名映射在 `store/experience.ts`）。 */
export interface ExperienceEntry {
  /** 稳定 id；**禁止**用 seq 做身份（replace 会重排 seq）。 */
  id: string;
  sessionId: string;
  /** 与 sessionId 组双键，防同目录第二会话串档。 */
  workspaceId: string;
  turnSeq: number;
  /** 仅用于衰减计算；**禁止**进任何对外文本。 */
  tsMs: number;
  trigger: TriggerKind;
  notice: NoticeKind;
  reaction: ReactionTier;
  /** 查表产出的第一人称体验行。 */
  text: string;
  /**
   * 一句话压缩残句（v0.2 刀1：编译期从 GIST_TABLE 派生，禁运行时改写）。
   * v1 迁移来的旧行没有 ⇒ undefined，淡出时自然退化 held（宁缺毋造）。
   */
  gist?: string;
  fact: ExperienceFact;
  lane: Lane;
  /** DRSC 出处锚点（形如 `drsc:<session>:<seq>`），非 DRSC 来源为空。 */
  sourceRef?: string;
  personaRevision: number;
  /** 软更正：指向取代本条的新 id；本条**不删除**。 */
  supersededBy?: string;
  /**
   * 「藏起来」标记位（v5 翻阅 tab）：非空 ⇒ 退出星海图/注入/手记缺省视图，
   * 行永不物理删，可随时清空再想起（覆写豁免定性见 db/schema.ts 头注）。
   */
  hiddenAt?: number;
  /**
   * 人格在意度 0..2（v0.2 落库；v1 旧行为 0 ⇒ 淡出只走 held 退化路，不假装知道旧权重）。
   * 只服淡出档位；情绪派生仍吃 reaction（derive.ts 的因果方向不变）。
   */
  salience?: number;
  /** 人工反馈 -1..5（v0.2；只重排进卡优先序，**永不**参与 m/衰减/情绪派生）。 */
  feedbackScore?: number;
  updatedAt: number;
}

/** 人格卡 = 记录的选择器 + 进系统提示的稳定投影源。 */
export interface PersonaCard {
  id: string;
  /** 单调递增；人格区文本以其为缓存键。 */
  revision: number;
  name: string;
  /**
   * 昵称序列（v0.3.4）：主人日常怎么喊这条鱼——大名之外的批量别名。
   * 进稳定区（`[昵称]` 行，常用称呼）让模型认得所有叫法；空数组合法（整行物理离场）。
   */
  aliases: string[];
  /**
   * 自称序列（v0.3.4）：这条鱼说话时用什么自称（我/本鱼/鱼鱼…）。
   * 主人可在人设页改，模型也能经 `spirit_selfname` 工具自己增删（累积式自我认同）。
   */
  selfNames: string[];
  voice: VoiceTier;
  /** 触发族 → 在意度。缺键按 `0` 处理（不在意，不记）。 */
  salience: Record<TriggerKind, SalienceWeight>;
  /** 在意面族集合；同事件下决定 `notice` 取哪一面。 */
  focus: NoticeKind[];
  values: string[];
  boundaries: string[];
}

/**
 * 情绪档：3×3 网格上的一格。
 *
 * 对外**只有档位与词**，没有数值——无校准规则的连续值就是伪精确。
 * 派生过程中允许内部计数（见 `slot/derive.ts`），但那些数不出现在卡、面板、导出里。
 */
export interface Mood {
  valence: ValenceTier;
  arousal: ArousalTier;
  /** 档位词（由 `slot/grid.ts` 查表给出）。 */
  label: string;
  /** 档位变更次数（缓存/同态断言用）。 */
  revision: number;
  updatedAt: number;
}

/** 单轮机械信号包（纯函数 `classifyTrigger` 的输入，全部本地可判）。 */
export interface TurnSignals {
  turnSeq: number;
  /** 本轮是否有新的用户来源消息。 */
  hasNewUserMessage: boolean;
  userChars: number;
  toolCalls: number;
  toolFailures: number;
  /** 上轮有失败、本轮同类成功。 */
  recovered: boolean;
  /** 用户纠正（宿主可判形状，见 experience/events.ts）。 */
  userInterruption: boolean;
  /** 距上一轮末的间隔 ms。 */
  gapMs: number;
  /** 本轮是否有结项形态（任务收尾）。 */
  taskClosed: boolean;
  facts: ExperienceFact;
}

/** 待落库的条目草稿（id/ts/personaRevision 由 store 补）。 */
export interface ExperienceDraft {
  trigger: TriggerKind;
  notice: NoticeKind;
  reaction: ReactionTier;
  text: string;
  /** 编译期 gist（GIST_TABLE 派生；缺格时空串，store 按 NULL 落）。 */
  gist?: string;
  /** 编译期人格权重（淡出原料；与 shouldRecord 同源，不在 store 里重算）。 */
  salience?: number;
  fact: ExperienceFact;
  lane: Lane;
  sourceRef?: string;
}
