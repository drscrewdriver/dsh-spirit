/**
 * dsh-spirit 命名与配置契约 —— **Phase 0 冻结点**。
 *
 * 键名、默认值、取值范围是**部署面契约**（`cordis.patch.yml` 按"键按行整体替换、不深合并"
 * 覆盖），不可更名、不可改语义。运行时可热更的键集中在 `live` 节，其余键改动需重启。
 *
 * `tests/contract-keys.test.ts` 逐腿核对：defaults ⇄ schema ⇄ settings 面 ⇄ runner ⇄
 * stats ⇄ client。少一腿即红——历史上姊妹包正是靠这一份测试挡住了"用户已存值被静默丢弃"。
 */

import type { Lane, SpiritVerdict, TriggerKind } from './types.js';

// ─────────────────────────────────────────────────────────── 命名（避让表）

/** npm 包名 = 插件名 = client 半 `__ModuleLoader__` 的 id（三者必须同串，不同即整体静默失活）。 */
export const SPIRIT_PACKAGE_NAME = 'dsh-spirit';
/** cordis.patch.yml 里的 entry id（与包名不同是合法的，但一经发布不可改）。 */
export const SPIRIT_ENTRY_ID = 'dsh-spirit';
/** cordis 插件名（`export const name`）。 */
export const SPIRIT_PLUGIN_NAME = 'dsh-spirit-plugin';
/**
 * 注入行署名。宿主按 `source.kind === 'user'` 区分轮次（标题、轮次大纲都按它跳非 user 行），
 * 且同机 dsh-prime-memory 的 L0 只收 `kind === 'user'` ⇒ 本值既是防污染也是防冒充用户轮次。
 */
export const SPIRIT_SOURCE_KIND = 'plugin:spirit';
/** 系统提示区名（`systemPrompt.section`）。同栈重名即 throw，前缀 `spirit:` 为命名空间。 */
export const SPIRIT_SECTION_NAME = 'spirit:persona';
/** 回忆卡 snapshot 的 section 名（进 `source.sections[].name`，UI 归因用）。 */
export const SPIRIT_SLOT_SECTION_NAME = 'spirit:slot';
/**
 * 人格区在系统提示里的位次：升序、小者在前。宿主节表实测
 * `DEPLOYMENT_PERSONA_PREFIX=0 … PLAN_POLICY=500 … FILE_REFERENCE=900 … TOOL_BASH=1000`；
 * 取 20 = 紧随部署人格前缀、早于政策；110/115/120 被宿主 `CONTEXT_ORDERS` 占，510 被姊妹包占。
 */
export const SPIRIT_SECTION_ORDER = 20;
/** RPC/HTTP 路由前缀（`dsh-memory/*` 已被占，本包一律 `dsh-spirit/*`）。 */
export const SPIRIT_RPC_PREFIX = 'dsh-spirit/';
/**
 * HTTP 路由根 —— **host 半注册的前缀与 client 半 fetch 的前缀必须是同一个常量**。
 *
 * 真机实测踩过的坑：这里曾写成 `/${PREFIX.replace(/\/$/, '')}rpc`，尾斜杠被剥掉后
 * 直接粘 `rpc`，路由挂到了 `/dsh-spiritrpc`（宿主返回 404 而不是我们的信封）。
 * 两半各写一份字面量 = 拼错只在真机暴露，所以收成单源 + `tests/gates.test.ts` 对敲。
 */
export const SPIRIT_RPC_ROUTE = `/${SPIRIT_RPC_PREFIX.replace(/\/$/, '')}/rpc`;
/** 工具名前缀（同栈工具重名即 throw）。 */
export const SPIRIT_TOOL_PREFIX = 'spirit_';

// ─────────────────────────────────────────────────────────── RPC 面

export const SPIRIT_OPS = [
  'session-stats',
  'journal-tail',
  'journal-export',
  'persona-get',
  'session-mode',
  'session-mode-get',
  'experience-feedback',
  'settings-get',
  'settings-set',
  // v0.3 记忆星海（只读投影，不开写图面）
  'sea-graph',
  // v0.3 人设管理（复用 PersonaStore.save 的既有写面）
  'persona-preview',
  'persona-set',
  'persona-history',
  'persona-restore',
  // v0.3.1 人设 markdown 备份（导出可读单层 md；导入走 save() 唯一写路径 = 追加新 revision）
  'persona-export-md',
  'persona-import-md',
  // v0.3.2 主人背景档案（双段：prime-memory 同步段 + 主人自述段；ping 为事件接收预备）
  'owner-get',
  'owner-set-self',
  'owner-sync-now',
  'owner-sync-ping',
  // v0.3.3 翻阅 tab（条目管理面：藏起/更正编辑，行永不物理删）+ 做梦（确定性整理 pass）
  'entries-list',
  'entries-hide',
  'entries-unhide',
  'entries-update',
  'dream-run',
  'dream-report',
  // v0.3.5 长觉阶梯：异步归纳 pass（进度/取消/报告）+ 主题分区只读面 + 碰撞人工裁决
  'sleep-run',
  'sleep-status',
  'sleep-cancel',
  'sleep-report',
  'topics-get',
  'insight-resolve',
  // v0.4 事务轨查询面（Phase 5）：时间线（"上周做了什么"）与资源反查（"这件事还牵涉什么"），只读工作记忆
  'timeline-query',
  'resource-lookup',
  // v0.4 长觉模型选择（面板）：枚举宿主供应商/模型 + 当前路由 + 运行时覆盖写
  'distill-models',
  'distill-model-list',
  'distill-model-set',
  // v0.4 本体层查询（Phase D）：评价列表（含 unresolved 悬置池）
  'evaluation-list',
  'entity-graph',
  'entity-lookup',
  'task-list',
  'task-detail',
  'ontology-backfill-run',
  'ontology-backfill-status',
] as const;
export type SpiritOp = (typeof SPIRIT_OPS)[number];

export function rpcPath(op: SpiritOp): string {
  return `${SPIRIT_RPC_PREFIX}${op}`;
}

/**
 * 会话级开关写入面（pill 用）。
 *
 * ⚠️ **读另走 `session-mode-get`**：本端点"两字段都省略"的语义是**清除覆盖、回到跟随全局**，
 * 拿它当读接口会静默把用户的会话设置抹掉（写读同形是最危险的那种 API）。
 */
export interface SpiritSessionModeRequest {
  sessionId: string;
  off?: boolean;
  bypass?: boolean;
}

export interface SpiritSessionModeResult {
  sessionId: string;
  off: boolean;
  bypass: boolean;
  /** 是否已落盘（false = 内存态已生效但文件不可写，重启后会丢）。 */
  persisted: boolean;
}

export interface SpiritJournalTailRequest {
  /** 省略（或空串）⇒ 服务端取**库里**最近一个有条目的会话；设置页分节拿不到会话上下文就靠这条。 */
  sessionId?: string;
  offset?: number;
  limit?: number;
  /** 默认不含被取代项（面板里一段经历只显示当前作数的那条）。 */
  includeSuperseded?: boolean;
}

export interface SpiritExportRequest {
  format?: 'md' | 'jsonl';
  /** 导哪个会话；省略则用服务端知道的最近一个。 */
  sessionId?: string;
  /** 只收导出子目录名（如 `export`）；**不收任意路径**。 */
  dirName?: string;
  dryRun?: boolean;
}

export interface SpiritFeedbackRequest {
  /** 条目 id（journal-tail 回给的）。 */
  entryId: string;
  /** -1..5（对齐 prime 反馈域）；-1 = 显式撤销（必须显式动作，不是默认值）。 */
  score: number;
}

/** 面板可调的 volatile 键（六腿的写腿；只收这五键，其余属部署面）。 */
export interface SpiritSettingsRequest {
  fadeEnabled?: boolean;
  fadeHalfLifeMs?: number;
  feedbackEnabled?: boolean;
  dreamEnabled?: boolean;
  /** 长觉热更开关（v0.3.5）：面板一键开；部署面总闸关时它开了也不跑（双闸取与）。 */
  distillEnabled?: boolean;
  /** 本体层热更开关（v0.5）：面板「本体」开关即此键；=本体采集/抽取总闸。 */
  ontologyEnabled?: boolean;
}

export interface SpiritSettingsView {
  fadeEnabled: boolean;
  fadeHalfLifeMs: number;
  feedbackEnabled: boolean;
  dreamEnabled: boolean;
  distillEnabled: boolean;
  /** 本体层总闸（effective）：面板「本体」开关的真实回显。 */
  ontologyEnabled: boolean;
  /** 热更通道是否真能落盘（宿主 volatile 不可写时为 false，面板要如实标重启生效）。 */
  hotUpdatable: boolean;
}

/** 端点 → 请求/响应类型的查表（两端共享的契约单一事实源）。 */
export interface SpiritRequestMap {
  'session-stats': { sessionId?: string };
  'journal-tail': SpiritJournalTailRequest;
  'journal-export': SpiritExportRequest;
  'persona-get': Record<string, never>;
  'session-mode': SpiritSessionModeRequest;
  'session-mode-get': { sessionId: string };
  'experience-feedback': SpiritFeedbackRequest;
  'settings-get': Record<string, never>;
  'settings-set': SpiritSettingsRequest;
  'sea-graph': SpiritSeaRequest;
  'persona-preview': SpiritPersonaPreviewRequest;
  'persona-set': SpiritPersonaSetRequest;
  'persona-history': SpiritPersonaHistoryRequest;
  'persona-restore': SpiritPersonaRestoreRequest;
  'persona-export-md': Record<string, never>;
  'persona-import-md': { text: string };
  'owner-get': Record<string, never>;
  'owner-set-self': SpiritOwnerSetSelfRequest;
  'owner-sync-now': Record<string, never>;
  'owner-sync-ping': { reason?: string };
  // v0.3.3 翻阅 tab + 做梦
  'entries-list': SpiritEntriesListRequest;
  'entries-hide': SpiritEntriesHideRequest;
  'entries-unhide': SpiritEntriesHideRequest;
  'entries-update': SpiritEntriesUpdateRequest;
  'dream-run': Record<string, never>;
  'dream-report': Record<string, never>;
  // v0.3.5 长觉阶梯
  'sleep-run': Record<string, never>;
  'sleep-status': Record<string, never>;
  'sleep-cancel': Record<string, never>;
  'sleep-report': Record<string, never>;
  'topics-get': Record<string, never>;
  'insight-resolve': SpiritInsightResolveRequest;
  // v0.4 事务轨查询面（Phase 5）
  'timeline-query': SpiritTimelineRequest;
  'resource-lookup': SpiritResourceRequest;
  // v0.4 长觉模型选择
  'distill-models': Record<string, never>;
  'distill-model-list': SpiritDistillModelListRequest;
  'distill-model-set': SpiritDistillModelSetRequest;
  // v0.4 本体层查询
  'evaluation-list': SpiritEvaluationListRequest;
  'entity-graph': SpiritEntityGraphRequest;
  'entity-lookup': SpiritEntityLookupRequest;
  'task-list': SpiritTaskListRequest;
  'task-detail': SpiritTaskDetailRequest;
  'ontology-backfill-run': SpiritBackfillRunRequest;
  'ontology-backfill-status': Record<string, never>;
}

export interface SpiritResponseMap {
  'session-stats': SpiritSessionStats;
  'journal-tail': SpiritJournalPage;
  'journal-export': SpiritExportResult;
  'persona-get': SpiritPersonaView;
  'session-mode': SpiritSessionModeResult;
  'session-mode-get': SpiritSessionModeResult;
  'experience-feedback': { entryId: string; score: number; ok: boolean };
  'settings-get': SpiritSettingsView;
  'settings-set': SpiritSettingsView;
  'sea-graph': SpiritSeaGraph;
  'persona-preview': SpiritPersonaPreview;
  'persona-set': SpiritPersonaView;
  'persona-history': SpiritPersonaHistoryPage;
  'persona-restore': SpiritPersonaView;
  'persona-export-md': SpiritPersonaMarkdown;
  'persona-import-md': SpiritPersonaView;
  'owner-get': SpiritOwnerProfile;
  'owner-set-self': SpiritOwnerProfile;
  'owner-sync-now': SpiritOwnerSyncResult;
  'owner-sync-ping': SpiritOwnerPingResult;
  'entries-list': SpiritEntriesListResult;
  'entries-hide': SpiritEntriesHideResult;
  'entries-unhide': SpiritEntriesHideResult;
  'entries-update': SpiritJournalRow;
  'dream-run': SpiritDreamOutcome;
  'dream-report': { report: SpiritDreamReport | null };
  'sleep-run': { accepted: boolean; reason?: string };
  'sleep-status': SpiritSleepStatus;
  'sleep-cancel': { requested: boolean };
  'sleep-report': { report: SpiritSleepReport | null };
  'topics-get': { topics: Array<{ id: string; name: string; origin: string; entries: number; insights: number; insightRows: SpiritInsightView[] }>; conflicts: SpiritInsightView[] };
  'insight-resolve': { resolved: boolean };
  // v0.4 事务轨查询面（Phase 5）
  'timeline-query': SpiritTimelineResult;
  'resource-lookup': SpiritResourceResult;
  // v0.4 长觉模型选择
  'distill-models': SpiritDistillRouteView;
  'distill-model-list': SpiritDistillModelListResult;
  'distill-model-set': SpiritDistillModelSetResult;
  // v0.4 本体层查询
  'evaluation-list': SpiritEvaluationListResult;
  'entity-graph': SpiritEntityGraphResult;
  'entity-lookup': SpiritEntityLookupResult;
  'task-list': SpiritTaskListResult;
  'task-detail': SpiritTaskDetailResult;
  'ontology-backfill-run': SpiritBackfillRunResult;
  'ontology-backfill-status': SpiritBackfillStatus;
}

/** 端点字面量类型（client 与 host 白名单共用）。 */
export type SpiritEndpoint = keyof SpiritRequestMap & string;

/** 当前生效档（面板与 pill 都要读）。 */
export interface SpiritMoodView {
  valence: string;
  arousal: string;
  label: string;
  revision: number;
  /** 档位词以外的行为倾向（面板展开时给）。 */
  tendency: string;
}

/** 会话信息区数据（纯内存注册表读，零文件 I/O；与 client 共享同一形状）。 */
export interface SpiritSessionStats {
  sessionId: string;
  /** 本会话已落库的体验条目数。 */
  entryCount: number;
  /** 当前档位词（**不是数值**）。 */
  moodLabel: string;
  valence: string;
  arousal: string;
  /** 本轮进卡的字节数。 */
  lastCardBytes: number;
  /** 结局计数：注入 / 旁路 / 关闭。 */
  injectedTurns: number;
  bypassedTurns: number;
  offTurns: number;
  /** 注入后在会话日志里真看到同一行的次数（A/B 报告的唯一硬口）。 */
  confirmedTurns: number;
  /** 检索段命中条数（本轮）。 */
  lastRecallHits: number;
  updatedAt: number;
  /** DRSC 探测判定；`skipped` = 未安装（中性，不是故障）。 */
  drscVerdict: SpiritVerdict;
  /**
   * DRSC 已投影的 segment 数（探测结论的附带量；未探到 ⇒ 缺省）。
   *
   * 为何单独一个字段：`ok` + **0 段** = 「连上了但库里还没有内容」，这是最容易被读成
   * "功能正常"的静默为空。不把它升成 `warn`（那会造成一屏假故障），只在面板把 0 显示
   * 出来——用户自己就能判断是刚装还是扫错了目录。
   */
  drscSegments?: number;
  /** 存储降级为真时 ⇒ 不落库不检索，只走实时近因。 */
  degraded: boolean;
  /** 当前档位（无会话运行态时为 null）。 */
  mood: SpiritMoodView | null;
  /** 会话级覆盖现状。 */
  mode: { off: boolean; bypass: boolean };
  /**
   * v0.2 淡出计数族（调参 SOP 的指标腿；累计整数，未启用淡出时全 0/缺省）：
   * full/gist/held = 历轮形态分布累加；pool = 候选池累加；churn = 发卡轮次（重发强度代理）。
   */
  fade?: { full: number; gist: number; held: number; marked: number; pool: number; churn: number };
}

/** 手记行形状（journal-tail 与翻阅 tab 的 entries-list 共用同一投影：搜索/浏览回同形，不分两套字段）。 */
export interface SpiritJournalRow {
  id: string;
  tsMs: number;
  turnSeq: number;
  trigger: string;
  notice: string;
  reaction: string;
  text: string;
  lane: string;
  sourceRef: string | null;
  /** v0.2：一句话压缩残句（旧行/缺格 = null）。 */
  gist: string | null;
  /** v0.2：人格在意度 0..2（v1 旧行 = null，不假装知道旧权重）。 */
  salience: number | null;
  /** v0.2：人工反馈 -1..5（未打分 = null，保持原序）。 */
  feedbackScore: number | null;
  /** v0.3：勾起线索（≤4 条）：手记条目从“一句话”变成“带证据面的卡片”（对照 prime-memory explorer 的结构层）。 */
  cues: string[];
  /** v0.3：所属会话（翻阅 tab 跨会话列表要显示来源；journal-tail 单会话视图里恒等于页会话）。 */
  sessionId?: string;
  /** v0.3.3：被谁取代（未取代 = null；翻阅 tab 的幽灵行才带得出解释）。 */
  supersededBy?: string | null;
  /** v0.3.3：藏起时间（未藏 = null）。 */
  hiddenAt?: number | null;
}

/** 手记分页视图（读库投影；库是真源，不是文档）。 */
export interface SpiritJournalPage {
  sessionId: string;
  /** 返回给面板的条目（体验句 + 结构化事实分列）。 */
  rows: SpiritJournalRow[];
  total: number;
  offset: number;
  limit: number;
}

/** 导出结果（只收目录名与分页参数，**不收任意路径**）。 */
export interface SpiritExportResult {
  dirName: string;
  /** 实际写到（或干跑将写到）的文件名。 */
  fileName: string;
  format: 'md' | 'jsonl';
  sessionId: string;
  written: number;
  dryRun: boolean;
}

/** 淡出档位（图上就是“亮度等级”的离散档；与注入侧同一公式同一阈值）。 */
export type SpiritSeaTier = 'full' | 'gist' | 'held';

/**
 * 记忆星海（v0.3）：**只读投影**，不是可查询图谱。
 *
 * 点的坐标（x/y/z）不在契约里：语义（归属轴 `axis`、老化 `freshness`）由 host 算，
 * 几何由 client 的 layout 算——换主题/换布局不需要重取数据。
 */
/** 星海投影层 lane（v0.6）：写侧 Lane 词表不变，onto 只存在于读侧投影（交付点）。 */
export type SpiritSeaLane = Lane | 'onto';

export interface SpiritSeaPoint {
  id: string;
  /** 毫秒时间戳；只用于布局与详情，不进任何对外文本。 */
  t: number;
  sessionId: string;
  turnSeq: number;
  /**
   * 点源（v0.6）：情绪轨体验条目 vs 本体轨交付。缺省 experience（旧数据不破）；
   * delivery 点只读展示——★反馈仍只对 experience 有效（写词表不动）。
   */
  kind?: 'experience' | 'delivery';
  trigger: TriggerKind;
  /** 投影层 lane：写侧词表（live/drsc）+ 本体交付的只读投影值 onto。 */
  lane: SpiritSeaLane;
  /** 体验句（已按 `SEA_POINT_TEXT_MAX` 截断）。 */
  text: string;
  /** 一句话残句（v1 旧行没有 ⇒ null）。 */
  gist: string | null;
  /** 人格在意度 0..2（v1 旧行 = 0，不假装知道旧权重）。 */
  salience: number;
  /** 老化权重 0..1（无 0.5 地板；亮度直接用它）。 */
  freshness: number;
  /**
   * 亮度等级（淡出档位）：`full` 实星 / `gist` 半亮 / `held` 暗星。
   *
   * 连续 `freshness` 负责“同一档内部的渐变”，离散 `tier` 负责“能不能发光”：
   * 光晕强度由它门控，否则极老但相关的条目会被当成“没记住”。
   */
  tier: SpiritSeaTier;
  /** 归属轴 −1..+1：−1 = 关于她自己，+1 = 关于主人。 */
  axis: number;
  /** 人工反馈 −1..5；未打分 = null。 */
  feedback: number | null;
  /** 勾起线索（≤4 条）：详情卡的“证据面” chips（与手记同源，来自 experience_cues）。 */
  cues: string[];
  /**
   * 幽灵点：本条已被更正（`superseded_by` 非空）。
   *
   * 星海**故意**把它画出来：append-only + 只标记不删是本插件的根纪律，
   * 图上只留新行就等于把“我记错过、后来改了”这条事实规掉。
   * 渲染上它不发光、降亮度，只能被点中看原文。
   */
  superseded: boolean;
}

/** 边：四类都**可解释**（共享 cue / 时间邻近 / 取代链 / 因果），不随机连。 */
export interface SpiritSeaEdge {
  a: string;
  b: string;
  score: number;
  /** 'causal'（v0.3.5）：长觉/启发式因果边，label 带关系词；截断优先级 causal > cue > time。 */
  kind: 'cue' | 'time' | 'supersede' | 'causal';
  /** 关系词（因果边专用：导致/因为/修复了/取代或 LLM 新词）。 */
  label?: string;
}

export interface SpiritSeaStats {
  /** 窗口内实际返回的点数（含幽灵点）。 */
  loaded: number;
  /** 其中被更正过的幽灵点数（面板要能说出“图上有 N 条已被更正”）。 */
  ghosts: number;
  /** 库内可用条目总数（不分窗口）。 */
  total: number;
  edges: number;
  byTrigger: Record<string, number>;
  byLane: Record<string, number>;
  /** 淡出三档分布（未启用淡出时按 salience 退化为 full/held 两类）。 */
  fade: { full: number; gist: number; held: number };
  /** 当前情绪档词（无运行态时为空串，不编造）。 */
  moodLabel: string;
  span: { from: number; to: number } | null;
  /** 库不可用 → true（图上要单独提示，不与「无条目」合并）。 */
  degraded: boolean;
  /** 本次窗口上限（便于前端显示「已加载 X / 上限 Y」）。 */
  window: number;
}

export interface SpiritSeaGraph {
  points: SpiritSeaPoint[];
  edges: SpiritSeaEdge[];
  stats: SpiritSeaStats;
  /**
   * “刚发生的”条目 id（近因路：该会话最近 `card.recentK` 条）。
   *
   * ⚠️ 它是“当前会进卡的那几条”的**近似**（取库内最近几条，不等价于上一张卡的快照），
   * 图上用它做高亮可以，不得当“实际注入了哪些”的审计结论。
   */
  focusIds: string[];
  /**
   * DRSC 探测判定（v0.3.3 顶栏短提示的数据源）：单源在服务端，
   * 面板不再自己拉 session-stats 猜——星海打开时未必有会话注册表。
   */
  drscVerdict: SpiritVerdict;
}

export interface SpiritSeaRequest {
  /** `all`（缺省）= 全库跨会话；`session` = 只看某一会话。 */
  scope?: 'all' | 'session';
  /** `scope='session'` 时必填；`all` 时忽略。 */
  sessionId?: string;
  /** 窗口大小；缺省与上限都是 `SEA_WINDOW_LIMIT`。 */
  limit?: number;
}

/** 可写的人设字段白名单（id / revision 不接受外部写入）。 */
export interface SpiritPersonaPatch {
  name?: string;
  /** 昵称序列（大名之外的批量称呼，去重保序、单条 ≤24 字、最多 8 个）。 */
  aliases?: string[];
  /** 自称序列（我/本鱼/鱼鱼…）：主人可改，模型也能经 spirit_selfname 工具自己增删。 */
  selfNames?: string[];
  voice?: string;
  salience?: Record<string, number>;
  focus?: string[];
  values?: string[];
  boundaries?: string[];
}

export interface SpiritPersonaPreviewRequest {
  patch: SpiritPersonaPatch;
}

export interface SpiritPersonaPreview {
  /** 保存后会注入系统提示的原文（与 `composePersonaText` 同源）。 */
  projectedText: string;
  bytes: number;
  budgetBytes: number;
  overBudget: boolean;
}

export interface SpiritPersonaSetRequest {
  /** 乐观并发：与当前 revision 不等即拒绝（不静默覆盖别人的修改）。 */
  expectedRevision: number;
  patch: SpiritPersonaPatch;
}

export interface SpiritPersonaHistoryRequest {
  limit?: number;
}

export interface SpiritPersonaHistoryItem {
  revision: number;
  name: string;
  voice: string;
}

export interface SpiritPersonaHistoryPage {
  current: number;
  items: SpiritPersonaHistoryItem[];
}

export interface SpiritPersonaRestoreRequest {
  /** 回到哪一版（以**新 revision** 落库，历史不动）。 */
  revision: number;
}

/** 人格读面（写面不在 v0.1，故只 get；v0.3 起写面经 `persona-set` 接出）。 */
export interface SpiritPersonaView {
  id: string;
  revision: number;
  name: string;
  aliases: string[];
  selfNames: string[];
  voice: string;
  salience: Record<string, number>;
  focus: string[];
  values: string[];
  boundaries: string[];
  /** 当前会被注入系统提示的原文（与注入同源，可核对）。 */
  projectedText: string;
}

/**
 * 人设的 markdown 备份（单层纯人话，文件本身就是恢复源）。
 *
 * `revision` 在导出时是当前版本号；导入时**一律不采信**（由 store 推进）——
 * 外部给什么都不收，与 `persona-set` 的 `expectedRevision` 同纪律。
 */
export interface SpiritPersonaMarkdown {
  text: string;
  revision: number;
}

/**
 * 主人背景档案（双段）：同步段来自 prime-memory 图谱投影（整段覆盖），
 * 自述段主人手写（同步永不触碰）。`primeStatus` 是探测实态，不是缓存意图。
 */
export interface SpiritOwnerProfile {
  syncText: string;
  selfText: string;
  syncMeta: { syncedAt: number | null; sourceNodes: number; degraded: boolean };
  /** 面板编辑的乐观并发锚（只随自述段推进；同步落库不碰它）。 */
  revision: number;
  primeStatus: 'available' | 'absent' | 'graph-off';
}

export interface SpiritOwnerSetSelfRequest {
  text: string;
  expectedRevision: number;
}

export interface SpiritOwnerSyncResult {
  ok: boolean;
  /** false = 去重窗命中或源缺席（都不是错误，但面板要能说出口）。 */
  updated: boolean;
  reason?: string;
}

export interface SpiritOwnerPingResult {
  accepted: boolean;
}

// ─────────────────────────────────────────────────────── 翻阅 tab 与做梦（v0.3.3）

/** 翻阅查询：全库跨会话筛选 + 服务端分页（行形状与 journal-tail 同一投影）。 */
export interface SpiritEntriesListRequest {
  query?: string;
  trigger?: string;
  lane?: string;
  /** true ⇒ 只看被标过在意的（feedback_score >= 0）。 */
  marked?: boolean;
  /** 默认不含幽灵；true ⇒ 连被取代的历史版本一起列。 */
  includeGhosts?: boolean;
  /** 「藏起来的回忆」视图：只看藏起的（恢复入口在这里）。 */
  hiddenOnly?: boolean;
  sessionId?: string;
  offset?: number;
  limit?: number;
}

export interface SpiritEntriesListResult {
  rows: SpiritJournalRow[];
  /** wanted=limit+1 探界，不做全表 COUNT（本库只增不删，COUNT(*) 是每次扫）。 */
  hasMore: boolean;
  /** 搜索候选池被扫描窗吃满 ⇒ 更早的可能没勾起（诚实截断，不假装是全）。 */
  truncated: boolean;
  offset: number;
  /** 首屏（offset===0）下发枚举 slug 目录：client 拿自己的 label 单源翻译，不手抄枚举。 */
  catalogs?: { triggers: string[]; lanes: string[] };
}

export interface SpiritEntriesHideRequest {
  /** 批量上界 200（超出服务端截断不报错，scale-ledger F1：没有上界的批是债）。 */
  ids: string[];
}

export interface SpiritEntriesHideResult {
  changed: number;
}

/** 更正式编辑：只收正文/残句/在意度三字段，其余列不开放（trigger/notice 是编译期真相）。 */
export interface SpiritEntriesUpdateRequest {
  entryId: string;
  text?: string;
  gist?: string;
  salience?: number;
}

/** 梦境报告（确定性整理 pass 的读数；只进面板，禁进注入文本与系统提示）。 */
export interface SpiritDreamReport {
  dreamedAt: number;
  mergedPairs: number;
  archivedSessions: number;
  archivedEntries: number;
  archiveDryRun: boolean;
  active: number;
  ghosts: number;
  marked: number;
  tierFull: number;
  tierGist: number;
  tierHeld: number;
}

export interface SpiritDreamOutcome {
  updated: boolean;
  reason?: 'dedup-window' | 'running' | 'degraded' | 'failed' | 'disabled';
  report?: SpiritDreamReport | null;
}

// ─────────────────────────────────────────────────────── 长觉阶梯（v0.3.5）

/** 长觉任务阶段（对外可见枚举；拟人语域：没有「批处理/管道」）。 */
export const SLEEP_PHASES = ['idle', 'collecting', 'distilling', 'deduping', 'persisting', 'done', 'failed', 'cancelled'] as const;
export type SleepPhase = (typeof SLEEP_PHASES)[number];

/** 一次长觉的产出读数（只进面板，禁进注入——与梦境报告同处置）。 */
export interface SpiritSleepReport {
  finishedAt: number;
  /** 本次实际使用的模型（回显事实，不粉饰；fail-closed 解析失败时根本不会有报告）。 */
  model: string;
  entriesScanned: number;
  topicsTouched: number;
  insightsCreated: number;
  edgesCreated: number;
  conflictsMarked: number;
  /** 碰撞判定为重复而被丢弃的新洞察数（旧行永远在场，丢弃的只是提案）。 */
  duplicatesDropped: number;
}

/** sleep-status 响应：带降级信封（llm 缺席/未装配是 supported:false 的绿路径，不是故障）。 */
export interface SpiritSleepStatus {
  supported: boolean;
  running: boolean;
  phase: SleepPhase;
  detail: string;
  cancelRequested: boolean;
  startedAt: number;
  finishedAt: number;
  error: string;
  lastReport: SpiritSleepReport | null;
}

/** 洞察的对外视图（主题视图卡片与冲突清单共用；evidence 回指工作记忆条目）。 */
export interface SpiritInsightView {
  id: string;
  topicId: string;
  text: string;
  status: string;
  evidenceIds: string[];
  createdAt: number;
}

/** 碰撞人工裁决请求：「信这条」= keep 胜方、supersede 败方；机器不自动删的纪律在人机上同样成立。 */
export interface SpiritInsightResolveRequest {
  winnerId: string;
  loserId: string;
}

// ─────────────────────────────────────────────────────────── 事务轨查询面（Phase 5）

/**
 * 事务行投影（timeline-query / resource-lookup 共用）：工作记忆的可读形状。
 * 与注入卡不同，本面是只读面板——`summary` 可随详情下发（面板不是 system prompt 注入路），
 * 但仍只取语义安全子集（topics/cues 都是 basename/主题，不带目录）。
 */
export interface SpiritTxnRow {
  id: string;
  sessionId: string;
  workspaceId: string;
  tsMs: number;
  turnSeq: number;
  cardLine: string;
  gistKey?: string;
  summary?: string;
  sourceTrust: string;
  topics: string[];
  cues: string[];
}

export interface SpiritTimelineRequest {
  /** 显式区间（含两端，ms）；from/to 同时给定时优先，忽略 days。 */
  from?: number;
  to?: number;
  /** 近 N 天（服务端按当前时刻算 from）；缺省 7，钳 [1,365]。 */
  days?: number;
  workspaceId?: string;
  limit?: number;
}

export interface SpiritTimelineResult {
  rows: SpiritTxnRow[];
  from: number;
  to: number;
}

export interface SpiritResourceRequest {
  /** 资源键（basename/人名/工具名）；服务端按写入侧同口径归一后**等值**反查。 */
  cue: string;
  limit?: number;
}

export interface SpiritResourceResult {
  hits: Array<{ row: SpiritTxnRow; matchedCue: string; matchedKind: string }>;
}

// ─────────────────────────────────────────────────────────── 长觉模型选择（面板）

/**
 * 当前蒸馏路由视图（distill-models 返回）：优先级 部署面 pin > 运行时覆盖 > 宿主默认。
 * `effective` 为本次真会用到的路由；三者都拿不到⇒ null（fail-closed，长觉会拒蒸）。
 */
export interface SpiritDistillRouteView {
  effective: { provider: string; model: string; source: 'deployPinned' | 'runtimeOverride' | 'hostDefault' } | null;
  /** 部署面 cfg.distill.provider+model 双齐 ⇒ true（此时选择器应禁用，pin 赢了）。 */
  pinned: boolean;
  runtimeOverride: { provider: string; model: string } | null;
  hostDefault: { provider: string; model: string } | null;
  /** 宿主供应商目录（listProviders）；枚举面缺席⇒空数组且 enumerationSupported=false。 */
  providers: Array<{ id: string; name: string }>;
  /** 宿主 llm 是否暴露 listProviders/listModels（老宿主线可能无）。 */
  enumerationSupported: boolean;
}

export interface SpiritDistillModelListRequest {
  provider: string;
}

export interface SpiritDistillModelListResult {
  provider: string;
  models: Array<{ id: string; name: string }>;
}

/** 写运行时覆盖：给 provider+model ⇒ 设覆盖；clear=true ⇒ 清除回宿主默认。 */
export interface SpiritDistillModelSetRequest {
  provider?: string;
  model?: string;
  clear?: boolean;
}

export interface SpiritDistillModelSetResult {
  ok: boolean;
  /** 拒写原因：pinned（部署面锁路）/ half-config（provider+model 不成对）/ degraded（库不可用存不了）。 */
  reason?: 'pinned' | 'half-config' | 'degraded';
  /** 写后（无论成败）的最新路由视图，面板据此一次重绘。 */
  route: SpiritDistillRouteView;
}

// ─────────────────────────────────────────────────────────── 本体层查询（Phase D）

/** 评价行投影（evaluation-list）：只读面板用；deliveryId=null 即悬置池待人工指认。 */
export interface SpiritEvaluationRow {
  id: string;
  deliveryId: string | null;
  kind: string;
  anchorMode: string;
  anchorConfidence: number;
  userLine?: string;
  tsMs: number;
}
export interface SpiritEvaluationListRequest {
  workspaceId?: string;
  /** 含 unresolved 悬置池（缺省只列已锚定的活跃行）。 */
  includeUnresolved?: boolean;
  limit?: number;
}
export interface SpiritEvaluationListResult {
  rows: SpiritEvaluationRow[];
}

/** 实体图（entity-graph）：按重要度取前 N 实体 + 其间关系边（星海本体层投影）。 */
export interface SpiritEntityNode {
  id: string;
  kind: string;
  name: string;
  importance: number;
}
export interface SpiritEntityEdgeView {
  id: string;
  from: string;
  to: string;
  relation: string;
  confidence: number;
}
export interface SpiritEntityGraphRequest {
  limit?: number;
  kind?: string;
  /** 搜索词（v0.6.1）：名字/别名 LIKE 包含匹配；空串=不过滤。 */
  q?: string;
}
export interface SpiritEntityGraphResult {
  nodes: SpiritEntityNode[];
  edges: SpiritEntityEdgeView[];
}
export interface SpiritEntityLookupRequest {
  entityId?: string;
  /** 按实体名等值反查（写入侧同一归一口径）。 */
  name?: string;
  workspaceId?: string;
  limit?: number;
}
export interface SpiritEntityLookupResult {
  entity: SpiritEntityNode | null;
  deliveries: SpiritTxnRow[];
}
export interface SpiritTaskRow {
  id: string;
  title: string;
  status: string;
  nextStep?: string;
  updatedAt: number;
}
export interface SpiritTaskListRequest {
  workspaceId: string;
  status?: string;
  limit?: number;
  /** 搜索词（v0.6.1）：任务线标题 LIKE 包含匹配。 */
  q?: string;
}
export interface SpiritTaskListResult {
  tasks: SpiritTaskRow[];
}
export interface SpiritTaskDetailRequest {
  taskId: string;
}
export interface SpiritTaskDetailResult {
  task: SpiritTaskRow | null;
  deliveries: SpiritTxnRow[];
}

/** 历史回填/全记忆重建触发（异步）：立即受理，进度走 ontology-backfill-status 轮询。 */
export interface SpiritBackfillRunRequest {
  dryRun?: boolean;
}
export interface SpiritBackfillRunResult {
  accepted: boolean;
  reason?: 'running' | 'disabled' | 'no-scan';
}

/**
 * 全记忆重建进度（轮询面，照长觉 sleep-status 范式）：phase + 批进度计数，面板据此画进度条。
 * scan 完才知道总量（totalSessions/totalTurns），extracting 阶段按会话累加 done*。
 */
export interface SpiritBackfillStatus {
  running: boolean;
  phase: 'idle' | 'scanning' | 'extracting' | 'done' | 'failed';
  dryRun: boolean;
  totalSessions: number;
  doneSessions: number;
  totalTurns: number;
  doneTurns: number;
  /** 抽取失败的会话数（不标 done ⇒ 再点重建会续跑它们；done 阶段 >0 时面板提醒）。 */
  failedSessions: number;
  lastError: string;
  startedAt: number;
  finishedAt: number;
}

// ─────────────────────────────────────────────────────────── 配置（单源）

/** 配置形状：与 `src/config.ts` 的 schema 一键一对齐。 */
export interface SpiritConfig {
  /** 部署总上限；false ⇒ 零注册零副作用（物理离场）。 */
  enabled: boolean;
  /** 留空 = `$DSH_HOME/spirit`。无法定位 home 目录时明确拒绝，不猜。 */
  dataDir: string;
  persona: {
    enabled: boolean;
    /** 人格区进系统提示的字节顶（超限按优先级截到整行）。 */
    budgetBytes: number;
  };
  card: {
    /** 回忆卡总顶。 */
    maxBytes: number;
    /** 「刚刚」段最多几条。 */
    recentK: number;
    /** 新会话首轮读上一会话几条；0 = 关闭跨会话基调。 */
    crossSessionM: number;
  };
  recall: {
    /** 检索段预算；超时只丢该段，不拖慢对话。 */
    timeoutMs: number;
    maxResults: number;
    /** 单条体验进卡的最大字符数。 */
    maxCharsPerEntry: number;
    /** 条目近因半衰期（ms）。 */
    halfLifeMs: number;
    /**
     * 滑窗淡出总闸（v0.2 新能力，缺省**关**：关=注入行为与 v0.1 逐字节一致，灰度闸）。
     * 开=条目按 salience×注意力衰减分档：full 原文 / gist 一句话 / held 不上卡。
     */
    fadeEnabled: boolean;
    /**
     * 注意力衰减半衰期（ms）——淡出档位的 Δt 尺度，与 `halfLifeMs`（排序用）解耦。
     * 缺省取情绪尺度（小时，见 decay.ts 注：与 prime 记忆面的“天”同式不同尺）；
     * 面板可调（调参 SOP 见 README：held 占比过高→拉长；重发率升高→加宽量化档）。
     */
    fadeHalfLifeMs: number;
    /** full 档分数地板（**千分位**整数，550=0.55；m = (salience/2)×注意力衰减；反馈只重排不回灌 m）。 */
    fadeFullMinScore: number;
    /** gist 档分数地板（千分位，250=0.25；低于 gist 地板 ⇒ held 不上卡）。 */
    fadeGistMinScore: number;
    /** gist 档的最低 salience（弱条目不派生 gist，直接 held，宁缺毋造）。 */
    gistMinSalience: number;
    /** 人工反馈重排总闸（移植 prime recall-usage：-1..5 手打只重排，**不回灌派生分**）。 */
    feedbackEnabled: boolean;
  };
  /** 未竟账（v0.2）：会话收尾的结构计数，新会话开局带出一行；缺省关（灰度）。 */
  ledger: {
    enabled: boolean;
    /** 账行过期后不再带出（ms）。0 = 永不过期（配合有顶 GC，默认给顶）。 */
    maxAgeMs: number;
  };
  /** 条件化 bias（v0.2）：强负体验给同类动作短期抑制（三档词）；缺省关（灰度）。 */
  bias: {
    enabled: boolean;
    /** bias 半衰期（ms）：派生缓存表的过期尺度。 */
    halfLifeMs: number;
  };
  tier: {
    /** 单轮最多跨几格（防人格抽动）。 */
    stepCap: number;
    /** 越此无新条目 ⇒ 退中性档（防把几天前的感觉当现在）。 */
    staleAfterMs: number;
  };
  journal: {
    /** 条目保留天数；0 = 永久。 */
    retentionDays: number;
    /** **默认干跑**：清理必须先算不动文件。 */
    dryRun: boolean;
  };
  capture: {
    /** 用户原文摘录默认不入库（隐私 + 提示注入面）。 */
    userSnippet: boolean;
    /** 开启入库时的最大字符数。 */
    maxQuoteChars: number;
    /** `long_gap` 判定阈值。 */
    gapThresholdMs: number;
  };
  drsc: {
    /** 历史路总开关；未装 ⇒ 整段省略，不影响近因路。 */
    enabled: boolean;
    /** 显式基址；留空走宿主 trustedHosts → `http://127.0.0.1:8080`。 */
    baseUrl: string;
    /** 探测结果缓存时长，避免每轮打一次 status。 */
    probeCacheTtlMs: number;
    /** 单请求超时。 */
    timeoutMs: number;
  };
  /**
   * 星海的**老化尺度**（v0.3 新键）。与 `recall.fadeHalfLifeMs` 故意分开：
   *
   * 后者是“注意力窗口”尺度（小时），用来决定“这条还上不上卡”；而星海要展示的
   * 是一段一段经历**在半年里怎么沉下去**。拿小时尺度去算跨月的库，结果是全图
   * freshness≈0 ⇒ 所有点都是暗星（真浏览器实测到过：1000 点 0/0/1000）。
   * 所以图上亮度用天尺度，而 `tier` 仍用注入侧的小时尺度（两者语义不同）。
   */
  sea: {
    /** 星海亮度半衰期（ms）；0 = 关闭老化（全部按最新亮度画）。 */
    agingHalfLifeMs: number;
  };
  /**
   * 主人背景档案（v0.3.2）。同步链对 prime-memory 是**纯消费方**：
   * 未装/未启图 ⇒ 探测失败 ⇒ 同步跳过且不清旧段，功能整体休眠不报错。
   */
  owner: {
    /** 定时同步周期（ms）；面板「立即同步」与 ping 不受此限，但共用去重窗。 */
    syncIntervalMs: number;
    /** 主人段进系统提示的字节顶；**独立于 persona.budgetBytes**（人格预算不该被档案挤占）。 */
    budgetBytes: number;
    /** 显式基址；留空走 trustedHosts → 宿主 webServer 端口 → 8080（同 DRSC 口径）。 */
    baseUrl: string;
    /** 探测结果缓存 TTL；缺席判定的新鲜度就靠它。 */
    probeCacheTtlMs: number;
  };
  /**
   * 做梦（v0.3.3）：确定性本地整理 pass（查重合并+归档+报告），零模型调用、零 DRSC 依赖。
   * 缺省日级（与 owner 同步同拍：白天随时打盹，晚上睡长觉）；手动按钮与定时器共用去重窗。
   */
  dream: {
    enabled: boolean;
    intervalMs: number;
  };
  /**
   * 长觉（v0.3.5）：异步 LLM 归纳 pass（归题/洞察/因果边/碰撞判定）。
   * 缺省关（新能力灰度 + 花真 token）；模型 fail-closed：显式配了就用，留空跟宿主默认，
   * 两者都拿不到 ⇒ 拒蒸不隐式改选（G13）。向量能力位缺省关（实测不达标才补，同不建 FTS5 决策法）。
   */
  distill: {
    enabled: boolean;
    provider: string;
    model: string;
    reasoningEffort: string;
    intervalMs: number;
    batchMin: number;
    maxInputChars: number;
    maxOutputTokens: number;
    timeoutMs: number;
    vector: {
      enabled: boolean;
      baseUrl: string;
      apiKey: string;
      model: string;
      dimensions: number;
    };
  };
  /**
   * 事务轨（v7）：结构信号 + 意图 bit + 异步批摘要，与情绪轨物理隔离。
   * 缺省关（灰度）：关时零采集、零建表行、零注入。属**部署面**（不进 live，改动需重启）。
   */
  txn: {
    enabled: boolean;
    /** 攒够几条信号才出一次批（"12-24 条一批"的口径下限）。 */
    batchMin: number;
    /** card_line 的最大字符数（进注入卡的那一行）。 */
    maxCardLineChars: number;
    /** summary 的最大字符数（只进翻阅/详情/长觉原料；禁入指纹，G15）。 */
    maxSummaryChars: number;
    /** 采集链单次超时：对话延迟比"少一条回忆"贵，与 recall.timeoutMs 同族语义。 */
    collectorTimeoutMs: number;
  };
  /**
   * 本体层（v8）：语义抽取（反馈/轮次总结/实体/任务线程）。缺省关（灰度）：关时零采集零注入零回填。
   * 属**部署面**（不进 live，改值需重启）。数值子键（batchMin/entityCap 等）随采集器在 Phase B 补。
   */
  ontology: {
    /** 总闸：关 ⇒ OntologyExtractor 不跑、本体表零落库。 */
    enabled: boolean;
    /** 历史回填总闸（缺省关）：需显式开 + 一次性动作；前置脱敏/来源过滤/更正通道未齐时不得开。 */
    backfillEnabled: boolean;
  };
  /**
   * 运行时可热更的开关节（整个对象标一次 `.volatile()`，⚠️ 节内不得再标——
   * volatile 嵌套 volatile 会被宿主拒绝）。
   */
  live: SpiritLiveSettings;
}

/** 运行时热更面（设置表单的唯一来源）。 */
export interface SpiritLiveSettings {
  /** 主闸（与 `enabled` 取与）。 */
  enabled: boolean;
  personaEnabled: boolean;
  cardEnabled: boolean;
  /** **旁路**：条目照常入库、档位照常派生，只是不注入。效果归因与敏感会话用。 */
  bypass: boolean;
  cardMaxBytes: number;
  recentK: number;
  crossSessionM: number;
  recallTimeoutMs: number;
  halfLifeMs: number;
  tierStepCap: number;
  staleAfterMs: number;
  drscEnabled: boolean;
  /** 检索段最多进卡几条（原只在部署面可调，面板调不了——补进 volatile）。 */
  recallMaxResults: number;
  /** 保留天数（同样补进 volatile；0 = 永久）。 */
  retentionDays: number;
  /** 淡出开关与窗口尺度热更（面板六腿的 volatile 腿；阈值属部署面，不热更）。 */
  fadeEnabled: boolean;
  fadeHalfLifeMs: number;
  /** 人工反馈重排热更（只重排不回灌；闸关=卡片序与闸开前一致）。 */
  feedbackEnabled: boolean;
  /** 做梦开关热更（v0.3.4）：关掉后定时器每轮现判直接空转，手动「让鱼睡一觉」也拒——设置面可见即此键。 */
  dreamEnabled: boolean;
  /** 长觉开关热更（v0.3.5 扁平键：嵌套 volatile 会被宿主拒）。关 ⇒ 定时器空转、sleep-run 拒并指路。 */
  distillEnabled: boolean;
  /** 本体层热更开关（v0.5）：默认开；关 ⇒ 本体采集/抽取全停（零落库），面板「本体」开关即此键。 */
  ontologyEnabled: boolean;
}

/**
 * 默认值单源。取值理由（都是经验缺省，非校准结论，可在设置页改）：
 * - `card.maxBytes=512`：状态 1 行 + 近因 ≤2 行 + 想起 ≤1 条 + 首轮基调 ≤1 行的实测够用宽度；
 *   每轮一条 ~512B 在 100 轮长会话里是万级 token 的**增量**，不触发前缀重算。
 *   ⚠ 从 384 上调的真实理由（真宿主量出来的）：极端负面档会多带一行「非医疗声明」，
 *   而声明**不允许被预算掉**（那是防误导的硬线）。实测那张卡长到 328B，在 384 顶下
 *   只剩 56B，装不下一行近因（141B）⇒ 越是该说“刚刚发生了什么”的档，近因段越被挤掉。
 *   512 能让“状态 + 声明 + 一行近因 + 一行想起”同时装下（实测 469B）；
 *   这不是“卡应当更大”，是把缺省提到不会让红线互相撞车的宽度。
 * - `recall.timeoutMs=800`：loopback 上本地库与 DRSC 正常 <10ms，给冷启动留天花板；
 *   超过它就丢检索段——对话延迟比"少一条回忆"贵得多。
 * - `recall.halfLifeMs=5_400_000`（90 分钟）：情绪类状态的量级取"小时"，
 *   不是 prime-memory 记忆面的"天"。
 * - `tier.staleAfterMs=600_000`（10 分钟）：重启恢复时宁可退中性，也不把旧感觉当现在。
 * - `journal.dryRun=true`：唯一不可逆动作默认不执行。
 */
/** live 节与静态节共用的两个默认值（不写第二份字面量）。 */
const SPIRIT_DEFAULTS_RECALL_MAX = 3;
const SPIRIT_DEFAULTS_RETENTION_DAYS = 90;

export const SPIRIT_DEFAULTS: SpiritConfig = {
  enabled: true,
  dataDir: '',
  persona: { enabled: true, budgetBytes: 700 },
  card: { maxBytes: 512, recentK: 2, crossSessionM: 4 },
  recall: {
    timeoutMs: 800,
    maxResults: SPIRIT_DEFAULTS_RECALL_MAX,
    maxCharsPerEntry: 120,
    halfLifeMs: 5_400_000,
    fadeEnabled: false,
    fadeHalfLifeMs: 5_400_000,
    fadeFullMinScore: 550,
    fadeGistMinScore: 250,
    gistMinSalience: 1,
    feedbackEnabled: true,
  },
  ledger: { enabled: false, maxAgeMs: 604_800_000 },
  bias: { enabled: false, halfLifeMs: 5_400_000 },
  tier: { stepCap: 1, staleAfterMs: 600_000 },
  journal: { retentionDays: SPIRIT_DEFAULTS_RETENTION_DAYS, dryRun: true },
  capture: { userSnippet: false, maxQuoteChars: 160, gapThresholdMs: 180_000 },
  drsc: { enabled: true, baseUrl: '', probeCacheTtlMs: 15_000, timeoutMs: 5_000 },
  // 7 天：缺省下“上周的事”约半亮，“上月的事”接近沉底，与“星海看长时段”的用途对得上。
  sea: { agingHalfLifeMs: 604_800_000 },
  // 同步缺省日级；预算 400B 约容“自述两句 + 同步清单五行”，装不下就截整行（宁缺勿断）。
  owner: { syncIntervalMs: 86_400_000, budgetBytes: 400, baseUrl: '', probeCacheTtlMs: 300_000 },
  dream: { enabled: true, intervalMs: 86_400_000 },
  distill: {
    enabled: false,
    provider: '',
    model: '',
    reasoningEffort: '',
    intervalMs: 21_600_000,
    batchMin: 12,
    maxInputChars: 4_000,
    maxOutputTokens: 2_000,
    timeoutMs: 30_000,
    vector: { enabled: false, baseUrl: '', apiKey: '', model: '', dimensions: 0 },
  },
  txn: {
    enabled: false,
    batchMin: 8,
    maxCardLineChars: 60,
    maxSummaryChars: 500,
    collectorTimeoutMs: 30_000,
  },
  ontology: {
    // v0.5：脱敏/来源分级/更正通道三条硬前置已上线，故缺省开（真机可见）；
    // 关仍可从面板「本体」开关拨掉（live.ontologyEnabled），eff = 本键 ∧ live.ontologyEnabled。
    enabled: true,
    backfillEnabled: true,
  },
  live: {
    enabled: true,
    personaEnabled: true,
    cardEnabled: true,
    bypass: false,
    cardMaxBytes: 512,
    recentK: 2,
    crossSessionM: 4,
    recallTimeoutMs: 800,
    halfLifeMs: 5_400_000,
    tierStepCap: 1,
    staleAfterMs: 600_000,
    drscEnabled: true,
    recallMaxResults: SPIRIT_DEFAULTS_RECALL_MAX,
    retentionDays: SPIRIT_DEFAULTS_RETENTION_DAYS,
    fadeEnabled: false,
    fadeHalfLifeMs: 5_400_000,
    feedbackEnabled: true,
    dreamEnabled: true,
    // 长觉热更开关缺省跟随部署面：没在 config.distill.enabled 显式 opt-in 前，eff = false && true 仍关（灰度不变）；
    // 一旦部署面开了，面板“自动长觉”就是真正的控制线（可拨关），不再被一个面板看不见的默认 false 悄悄堵死。
    distillEnabled: true,
    // 本体层热更开关（v0.5）：默认开，面板可见可拨；eff = ontology.enabled(静态) ∧ 本键。
    ontologyEnabled: true,
  },
};

/** 配置数值键的合法区间（schema 与写入门共用，勿在别处再抄）。 */
export const SPIRIT_RANGES: Record<string, readonly [number, number]> = {
  'persona.budgetBytes': [120, 4_000],
  'card.maxBytes': [96, 2_000],
  'card.recentK': [0, 6],
  'card.crossSessionM': [0, 12],
  'recall.timeoutMs': [0, 10_000],
  'recall.maxResults': [1, 12],
  'recall.maxCharsPerEntry': [40, 400],
  'recall.halfLifeMs': [0, 604_800_000],
  'recall.fadeHalfLifeMs': [0, 2_592_000_000],
  'recall.fadeFullMinScore': [0, 1_000],
  'recall.fadeGistMinScore': [0, 1_000],
  'recall.gistMinSalience': [0, 2],
  'tier.stepCap': [1, 2],
  'tier.staleAfterMs': [0, 86_400_000],
  'journal.retentionDays': [0, 3_650],
  'capture.maxQuoteChars': [0, 400],
  'capture.gapThresholdMs': [10_000, 3_600_000],
  'drsc.probeCacheTtlMs': [1_000, 600_000],
  'drsc.timeoutMs': [200, 20_000],
  'ledger.maxAgeMs': [0, 2_592_000_000],
  'bias.halfLifeMs': [0, 604_800_000],
  'sea.agingHalfLifeMs': [0, 7_776_000_000],
  'owner.syncIntervalMs': [60_000, 604_800_000],
  'owner.budgetBytes': [0, 2_000],
  'owner.probeCacheTtlMs': [1_000, 3_600_000],
  'dream.intervalMs': [60_000, 604_800_000],
  'distill.intervalMs': [300_000, 604_800_000],
  'distill.batchMin': [4, 48],
  'distill.maxInputChars': [800, 32_000],
  'distill.maxOutputTokens': [256, 8_000],
  'distill.timeoutMs': [2_000, 120_000],
  'distill.vector.dimensions': [0, 4096],
  'txn.batchMin': [1, 24],
  'txn.maxCardLineChars': [20, 120],
  'txn.maxSummaryChars': [100, 2_000],
  'txn.collectorTimeoutMs': [2_000, 120_000],
};

/** 单轮淡出形态分布（stats/ab 的计数原料；都是整数计数，无对外数值语义）。 */
export interface FadeStats {
  full: number;
  gist: number;
  held: number;
  pool: number;
  /** 候选池里被人标过“重要”（feedback>0）的条数——反馈分布的累计面。 */
  marked: number;
}

// ─────────────────────────────────────────────────────────── 版本与文件

/** SQLite schema 版本；跨版本打开明确拒绝，不静默改库（v1→v2 加列、v2→v3 人设两表、v3→v4 主人档案、v4→v5 藏起列与分页索引、v5→v6 长觉阶梯五表、v6→v7 事务轨两张表、v7→v8 本体层（扩 txn_entry + 六表），均正向迁移）。 */
export const SPIRIT_DB_SCHEMA_VERSION = 8;
/** `persona.json` 文件形状版本。 */
export const SPIRIT_PERSONA_FILE_VERSION = 1;
/** `owner.json` 文件形状版本（db=null 降级面；与 persona 分键，形状互不牵连）。 */
export const SPIRIT_OWNER_FILE_VERSION = 1;
/** `session-modes.json` 文件形状版本。 */
export const SPIRIT_MODES_FILE_VERSION = 1;
/** 插件版本（与 package.json / dsh.plugin.json 同串，由门禁核对）。 */
export const SPIRIT_VERSION = '0.6.1';




