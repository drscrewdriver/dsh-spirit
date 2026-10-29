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
 */
export const TRIGGER_KINDS = [
  /** 用户本轮纠正/否定了角色上一轮的做法（宿主可判：用户消息为对上一条 assistant 的否定性指涉）。 */
  'user_correction',
  /** 有工具调用失败。 */
  'tool_failure',
  /** 上一轮失败、本轮同类调用成功（出错后恢复）。 */
  'recovery',
  /** 任务收尾（本轮无待办且出现结项形态）。 */
  'task_close',
  /** 轮间隔超过 `gapThresholdMs`（等待/被晾的体验来源）。 */
  'long_gap',
  /** 中性轮：以上都不成立。 */
  'neutral',
] as const;

export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/**
 * 关注点族（notice）：同一事件里角色**注意到的是哪一面**。
 * 由人格的 `focus` / `salience` 选择，是"人格决定记什么"的落点。
 */
export const NOTICE_KINDS = [
  /** 自己出了错。 */
  'self_mistake',
  /** 用户那边的状态（耐心、认可、沉默）。 */
  'user_state',
  /** 事情在推进。 */
  'task_progress',
  /** 事情卡住了。 */
  'task_stall',
  /** 自己没被搭理。 */
  'being_ignored',
  /** 自己被告知。 */
  'being_acknowledged',
  /** 环境/工具本身不顺。 */
  'environment',
] as const;

export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** 反应强度档位（枚举，非数值）。 */
export const REACTION_TIERS = ['none', 'mild', 'strong'] as const;
export type ReactionTier = (typeof REACTION_TIERS)[number];

/** 效价档位（枚举，非数值）。 */
export const VALENCE_TIERS = ['neg', 'mid', 'plus'] as const;
export type ValenceTier = (typeof VALENCE_TIERS)[number];

/** 唤起档位（枚举，非数值）。 */
export const AROUSAL_TIERS = ['low', 'normal', 'high'] as const;
export type ArousalTier = (typeof AROUSAL_TIERS)[number];

/** 语气档（查表文案的第三个键）。 */
export const VOICE_TIERS = ['plain', 'terse', 'warm'] as const;
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
export const LANES = ['live', 'drsc'] as const;
export type Lane = (typeof LANES)[number];

/**
 * 探测/自检判定四值。`skipped` 是**中性无据**（如 DRSC 未安装），
 * 绝不写成 `warn`——把"无法判定"当"异常"会让用户看到一串假故障。
 */
export const SPIRIT_VERDICTS = ['ok', 'warn', 'fail', 'skipped'] as const;
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
  fact: ExperienceFact;
  lane: Lane;
  /** DRSC 出处锚点（形如 `drsc:<session>:<seq>`），非 DRSC 来源为空。 */
  sourceRef?: string;
  personaRevision: number;
  /** 软更正：指向取代本条的新 id；本条**不删除**。 */
  supersededBy?: string;
  updatedAt: number;
}

/** 人格卡 = 记录的选择器 + 进系统提示的稳定投影源。 */
export interface PersonaCard {
  id: string;
  /** 单调递增；人格区文本以其为缓存键。 */
  revision: number;
  name: string;
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
  userCorrection: boolean;
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
  fact: ExperienceFact;
  lane: Lane;
  sourceRef?: string;
}
