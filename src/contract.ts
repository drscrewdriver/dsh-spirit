/**
 * dsh-spirit 命名与配置契约 —— **Phase 0 冻结点**。
 *
 * 键名、默认值、取值范围是**部署面契约**（`cordis.patch.yml` 按"键按行整体替换、不深合并"
 * 覆盖），不可更名、不可改语义。运行时可热更的键集中在 `live` 节，其余键改动需重启。
 *
 * `tests/contract-keys.test.ts` 逐腿核对：defaults ⇄ schema ⇄ settings 面 ⇄ runner ⇄
 * stats ⇄ client。少一腿即红——历史上姊妹包正是靠这一份测试挡住了"用户已存值被静默丢弃"。
 */

import type { Lane, SpiritVerdict, TriggerKind, WarmthTier } from './types.js';

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
  // v0.7 注入回响面（对表 prime-memory 的 memory 激活槽位）：每轮注入/跳过快照
  'inject-echo',
  // v0.8.6 回响分层检索：时间段 → 关键词 →（最后）语义向量
  'echo-search',
  // v0.8.8 回响引用列表（旧名，一版别名）
  'echo-refs',
  // v0.8.11 回响记录（记录持 echo-<uuid>；echo-refs 的正式名）
  'echo-records',
  // v0.8.12 按 echo 号定位记录（翻阅搜索 / 星图定位共用）
  'echo-locate',
  // v0.8.14 全域文本搜索（记录不分类型：任务/交付/体验/记着/目的/实体）
  'spirit-search',
  // v0.8.17 记录详情（搜索命中行内展开）
  'record-detail',
  // v0.8.18 生涯流程三档：按实体查 / 手动刷新
  'entity-digest',
  'distill-digest-run',
  // v0.8.2 回响落档的条目详情（按 sessionId + id 取注入原文）
  'echo-detail',
  // v0.8 模型可写记忆（两本账+日记）与目的层
  'memory-list',
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
  // v0.7 人格预设库（对表 dsh-soul 的人格配置编译器）：预设/激活/作用域绑定/生效解析
  'persona-presets',
  'persona-activate',
  'persona-preset-save',
  'persona-preset-delete',
  'persona-bind',
  'persona-effective',
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
  // v20（B-3）：疑似同一实体的候选（只读）+ 人工别名追加（不合并 id）
  'entity-merge-suggest',
  'entity-alias-add',
  'entity-lookup',
  'task-list',
  'task-detail',
  'ontology-backfill-run',
  'ontology-backfill-status',
  // v0.10 生涯编年（定位重钉）：把「事（交付）/ 感（体验）/ 线（流程档）/ 记着」编到同一条时间轴上。
  // 与 entries-list 的区别是语义而不是分页：那个面是"我记了哪些句子"，这个面是"我是怎么走到这儿的"。
  'chronicle-list',
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
  /** v19 台阶三键（热更）：当下/一周后边界天数 + 两级权重（千分位）。 */
  fadeHotDays?: number;
  fadeColdDays?: number;
  fadeWarmWeight?: number;
  fadeColdWeight?: number;
  feedbackEnabled?: boolean;
  dreamEnabled?: boolean;
  /** 长觉热更开关（v0.3.5）：面板一键开；部署面总闸关时它开了也不跑（双闸取与）。 */
  distillEnabled?: boolean;
  /** 本体层热更开关（v0.5）：面板「本体」开关即此键；=本体采集/抽取总闸。 */
  ontologyEnabled?: boolean;
}

export interface SpiritSettingsView {
  /** 主闸当前生效值（本会话手动开关的真实回显）。 */
  enabled: boolean;
  /** 启动挡位：on/off/last（只决定下次启动初值）。 */
  bootMode: 'on' | 'off' | 'last';
  fadeEnabled: boolean;
  fadeHalfLifeMs: number;
  fadeHotDays: number;
  fadeColdDays: number;
  fadeWarmWeight: number;
  fadeColdWeight: number;
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
  'persona-presets': Record<string, never>;
  'persona-activate': SpiritPersonaActivateRequest;
  'persona-preset-save': SpiritPersonaPresetSaveRequest;
  'persona-preset-delete': SpiritPersonaPresetDeleteRequest;
  'persona-bind': SpiritPersonaBindRequest;
  'persona-effective': SpiritPersonaEffectiveRequest;
  'inject-echo': SpiritInjectEchoRequest;
  'echo-search': SpiritEchoSearchRequest;
  'echo-refs': SpiritEchoRefsRequest;
  'echo-records': SpiritEchoRefsRequest;
  'echo-locate': SpiritEchoLocateRequest;
  'spirit-search': SpiritSearchAllRequest;
  'record-detail': SpiritRecordDetailRequest;
  'entity-digest': SpiritEntityDigestRequest;
  'distill-digest-run': Record<string, never>;
  'echo-detail': SpiritEchoDetailRequest;
  'memory-list': SpiritMemoryListRequest;
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
  'entity-merge-suggest': SpiritEntityMergeSuggestRequest;
  'entity-alias-add': SpiritEntityAliasAddRequest;
  'entity-lookup': SpiritEntityLookupRequest;
  'task-list': SpiritTaskListRequest;
  'task-detail': SpiritTaskDetailRequest;
  'ontology-backfill-run': SpiritBackfillRunRequest;
  'ontology-backfill-status': Record<string, never>;
  'chronicle-list': SpiritChronicleRequest;
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
  'persona-presets': SpiritPersonaPresetsView;
  'persona-activate': SpiritPersonaActivateResult;
  'persona-preset-save': SpiritPersonaPresetSaveResult;
  'persona-preset-delete': SpiritPersonaPresetDeleteResult;
  'persona-bind': SpiritPersonaBindResult;
  'persona-effective': SpiritPersonaEffectiveResult;
  'inject-echo': SpiritInjectEchoResult;
  'echo-search': SpiritEchoSearchResult;
  'echo-refs': SpiritEchoRefsResult;
  'echo-records': SpiritEchoRefsResult;
  'echo-locate': SpiritEchoLocateResult;
  'spirit-search': SpiritSearchAllResult;
  'record-detail': SpiritRecordDetailResult;
  'entity-digest': SpiritEntityDigestResult;
  'distill-digest-run': SpiritDistillRunResult;
  'echo-detail': SpiritEchoDetailResult;
  'memory-list': SpiritMemoryListResult;
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
  'entity-merge-suggest': SpiritEntityMergeSuggestResult;
  'entity-alias-add': SpiritEntityAliasAddResult;
  'entity-lookup': SpiritEntityLookupResult;
  'task-list': SpiritTaskListResult;
  'task-detail': SpiritTaskDetailResult;
  'ontology-backfill-run': SpiritBackfillRunResult;
  'ontology-backfill-status': SpiritBackfillStatus;
  'chronicle-list': SpiritChronicleResult;
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
  /** v0.8.11：记录号 `echo-<uuid>`（体验条目也是一条记录；旧行缺省）。 */
  echoId?: string;
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
  /** v0.8.11：记录号 `echo-<uuid>`（星点对应的体验/交付记录；旧数据缺省）。 */
  echoId?: string;
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

// ── v0.7 人格预设库（对表 dsh-soul 的人格配置编译器）──

/** 预设库视图：预设清单 + 激活 + 作用域绑定 + 审计尾部（面板一屏拉齐）。 */
export interface SpiritPersonaPresetsView {
  activeId: string;
  activeName: string;
  presets: Array<{ id: string; name: string; builtin: boolean; revision: number }>;
  /** workspaceId → presetId。 */
  workspaces: Record<string, string>;
  /** sessionId → 临时覆盖（ 30 天回收，面板展示时已过滤）。 */
  sessions: Array<{ sessionId: string; presetId: string; at: number }>;
  audit: Array<{ at: number; action: string; detail: string }>;
}

export interface SpiritPersonaActivateRequest {
  presetId: string;
}

export interface SpiritPersonaActivateResult {
  ok: boolean;
  reason?: string;
  /** 激活成功后人设已写入的视图（可直接渲染）。 */
  persona?: SpiritPersonaView;
}

export interface SpiritPersonaPresetSaveRequest {
  name: string;
}

export interface SpiritPersonaPresetSaveResult {
  ok: boolean;
  reason?: string;
  presetId?: string;
}

export interface SpiritPersonaPresetDeleteRequest {
  presetId: string;
}

export interface SpiritPersonaPresetDeleteResult {
  ok: boolean;
  reason?: string;
}

export interface SpiritPersonaBindRequest {
  scope: 'workspace' | 'session';
  workspaceId?: string;
  sessionId?: string;
  /** null/省略 = 解绑（回到上一级）。 */
  presetId?: string | null;
}

export interface SpiritPersonaBindResult {
  ok: boolean;
  reason?: string;
}

export interface SpiritPersonaEffectiveRequest {
  workspaceId?: string;
  sessionId?: string;
}

// ── v0.7 注入回响面（inject-echo；对表 prime-memory 的 memory 激活槽位）──
export interface SpiritEchoSegment {
  name: string;
  lines: number;
}

/**
 * 一个分段条目（v0.8.6）：回响页的渲染单元——标签 + 内容行 + 条目自身的时间。
 *
 * 用户实报：贴整张卡原文等于没观测，要的是「线程：plugin-9lang-five-dim」这种条目，
 * 并且能回答“这条对应的时间”：tsSource='turn' 表示本轮时刻（状态/开场），
 * 'item' 表示从真源表反查到的条目时刻（任务/交付/体验/记忆/目标），
 * 'unknown' 表示行内内容在库里找不着（不编时间）。
 */
export interface SpiritEchoEntry {
  name: string;
  lines: string[];
  ts?: number;
  tsSource?: 'turn' | 'item' | 'unknown';
  /** 这条目指向的真源记录（memid）：侧栏/星图用它把回响挂回具体记忆条目。 */
  ref?: SpiritEchoRef;
}

/** 回响条目指向的真源（memid）：kind 定表，id 定行，label 是给人看的一句。 */
export interface SpiritEchoRef {
  kind: 'task' | 'delivery' | 'experience' | 'memory' | 'goal';
  id: string;
  label: string;
}

/** 一轮 pre-step 的注入/跳过快照（进程内环形缓冲，最新在前回给面板）。 */
export interface SpiritEchoSnapshot {
  at: number;
  agentId: string;
  sessionId: string;
  workspaceId: string;
  kind: 'injected' | 'skipped';
  /**
   * 数据源（v0.8.5）：live=进程内实时缓冲；persisted=内存空时回退读落档表（重启后仍在）。
   * 旧消费方当缺省=live；面板用它标「落档回看」，不把重启回退冒充实时。
   */
  origin?: 'live' | 'persisted';
  /** 落档行的编号（echo-&lt;ts&gt;，供 echo-detail 取全文）；live 行为省略。 */
  recallId?: string;
  /** skipped 时的门名（no-new-user / duplicate-fingerprint …）；injected 为空串。 */
  reason: string;
  fingerprint: string;
  /** 注入卡全文（skipped 为空串）。 */
  text: string;
  bytes: number;
  segments: SpiritEchoSegment[];
  /** 分段条目（v0.8.6）：已剔壳子行，带条目对应时间；旧消费方可忽略。 */
  entries?: SpiritEchoEntry[];
}

/** sessionId 空 = 跨会话最近若干轮。 */
export interface SpiritInjectEchoRequest {
  sessionId?: string;
  limit?: number;
}

export interface SpiritInjectEchoResult {
  items: SpiritEchoSnapshot[];
  /** 缓冲区当前总条数（不只本次返回的）。 */
  total: number;
  /** 本会话的记录聚合（v0.8.11）：每行 = 一条被想起的记录（echo-<uuid>）。 */
  records?: SpiritEchoRecordRow[];
  /** 最近一次回响事件（recall-<uuid>）：回响面按事件分组时用。 */
  recall?: SpiritEchoRecallInfo;
  /** 语气/状态（特殊格式·非引用）：最近一条含状态/开场的轮次。 */
  tone?: SpiritEchoTone;
}

/** 一次回响事件（v0.8.11）：`recall-<uuid>`，一轮注入一个。 */
export interface SpiritEchoRecallInfo {
  recallId: string;
  at: number;
  /** 命中记录里有 >7 天的旧事 ⇒ true。 */
  flashback: boolean;
}

/**
 * 一条回响记录（v0.8.11）：`echoId = echo-<uuid>` **属于记录本身**（progress/done 卡片），
 * 同一记录跨会话/重启同号；`times` 为被想起次数；`lastRecallId` 指向最近一次回响事件。
 */
export interface SpiritEchoRecordRow {
  echoId: string;
  sessionId: string;
  kind: string;
  memId: string;
  title: string;
  times: number;
  /** 记录自身时间（星图/翻阅展示"记录时间"）。 */
  recordTs: number;
  firstTs: number;
  lastTs: number;
  lastRecallId: string;
}

/** 旧名保留一版（老消费方编译不破）；新代码用 SpiritEchoRecordRow。 */
export type SpiritEchoRefRow = SpiritEchoRecordRow;

/** 按 echo 号定位（v0.8.12）：短号/全号/去前缀都可；翻阅搜索与星图定位共用。 */
export interface SpiritEchoLocateRequest {
  q: string;
}

/** 命中的一条记录（跨会话：同一记录可能多会话被想起）。 */
export interface SpiritEchoLocateHit {
  echoId: string;
  kind: string;
  memId: string;
  title: string;
  /** 记录自身时间（无聚合行时退 0）。 */
  recordTs: number;
  /** 聚合行所在会话（无则空）。 */
  sessionId: string;
  /** 最近一次回响事件号（供原文）。 */
  lastRecallId: string;
  /** 可定位的星点 echo 号（v0.8.15）：交付/体验=自身；任务=其交付点；无星点类=空。 */
  starEchoIds?: string[];
}

export interface SpiritEchoLocateResult {
  /** 是否像 echo 号查询（false ⇒ 调用方走普通文本搜索）。 */
  idQuery: boolean;
  hits: SpiritEchoLocateHit[];
}

/** 全域搜索（v0.8.14）：按文本搜所有记录类型，不让“类型”挡住已经存在的东西。 */
export interface SpiritSearchAllRequest {
  q: string;
  limit?: number;
}

export interface SpiritSearchHit {
  kind: 'task' | 'delivery' | 'experience' | 'memory' | 'goal' | 'entity';
  id: string;
  /** 记录的 echo 号（星图定位用）。 */
  echoId?: string;
  title: string;
  ts: number;
  /**
   * 经实体别名关联命中的实体 id（v19）：本条不是直接命中搜索词，
   * 而是“这个词指的是某个实体，而这条记录属于它”。直接命中时缺省。
   */
  via?: string;
}

export interface SpiritSearchAllResult {
  hits: SpiritSearchHit[];
}

/** 记录详情（v0.8.17）：搜索命中行内展开用，不跳页。 */
export interface SpiritRecordDetailRequest {
  kind: 'task' | 'delivery' | 'experience' | 'memory' | 'goal' | 'entity';
  id: string;
}

export interface SpiritRecordDetailResult {
  kind: string;
  id: string;
  echoId?: string;
  title: string;
  /** 明细行（按阅读顺序；空行不出现）。 */
  lines: string[];
  /** 记录时间。 */
  ts: number;
}
/** 语气/状态行（不属于记忆引用）。 */
export interface SpiritEchoTone {
  at: number;
  state?: string;
  opening?: string;
}

export interface SpiritEchoRefsRequest {
  sessionId?: string;
  /** task|delivery|experience|memory|goal；省略 = 全部。 */
  kind?: string;
  /** 标题或 memid 的关键词（LIKE 字面量）。 */
  q?: string;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
}

export interface SpiritEchoRefsResult {
  /** v0.8.11 正式字段。 */
  records: SpiritEchoRecordRow[];
  /** 旧名别名（一版兼容）：内容同 records。 */
  refs: SpiritEchoRecordRow[];
  total: number;
  /** 语气/状态（特殊格式·非引用）：sessionId 空 = 跨会话最近一条。 */
  tone?: SpiritEchoTone;
}

/**
 * 回响分层检索（v0.8.6）：时间段 → 关键词 → 语义向量（最后一级，未配嵌入 ⇒ vector='unavailable'）。
 * 命中层级回在 tier；不跳级也不假装命中。
 */
export interface SpiritEchoSearchRequest {
  sessionId?: string;
  workspaceId?: string;
  /** 时间窗（含头含尾，毫秒）。 */
  sinceMs?: number;
  untilMs?: number;
  /** 关键词（LIKE 包含匹配，%/_ 按字面量）。 */
  q?: string;
  limit?: number;
}

export interface SpiritEchoSearchResult {
  items: SpiritEchoSnapshot[];
  /** 本次实际命中的层级：time（只按时间段）/ keyword（时间窗内或全库关键词命中）/ none。 */
  tier: 'time' | 'keyword' | 'none';
  /** 向量层可用性（未配嵌入通道 ⇒ 'unavailable'；不假装能兜底）。 */
  vector: 'available' | 'unavailable';
  /** 落档表内参检总条数（与 items 条数不同：items 已被 limit 钳）。 */
  scanned: number;
}

/** v0.8.2：按编号读一条回响的注入原文。 */
export interface SpiritEchoDetailRequest {
  sessionId: string;
  /** `echo-<ts_ms>`（列表里显示的编号）。 */
  id: string;
}

export interface SpiritEchoDetailItem {
  id: string;
  at: number;
  kind: 'injected' | 'skipped';
  reason: string;
  fingerprint: string;
  preview: string;
  /** 当时注入的卡全文；旧版落档没有存过 ⇒ 空串（读侧当“无原文”）。 */
  text: string;
}

export interface SpiritEchoDetailResult {
  /** 找不到 ⇒ undefined（消费方展示“该条目已不在”）。 */
  item?: SpiritEchoDetailItem;
}

export interface SpiritPersonaEffectiveResult {
  /** session > workspace > active > current（非覆盖层）。 */
  source: 'session' | 'workspace' | 'active' | 'current';
  presetId?: string;
  presetName?: string;
  revision: number;
  name: string;
  voice: string;
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
  /** 偏移分页（旧口径）：与 `cursor` 同时给时以 cursor 为准。 */
  offset?: number;
  /**
   * 游标分页（v19）：上一页最后一行的 `(ts_ms, id)`。
   * append-only 库上 OFFSET 随页深线性变慢，游标能直接吃 `exp_ts` 索引。
   */
  cursor?: { tsMs: number; id: string };
  limit?: number;
}

export interface SpiritEntriesListResult {
  rows: SpiritJournalRow[];
  /** wanted=limit+1 探界，不做全表 COUNT（本库只增不删，COUNT(*) 是每次扫）。 */
  hasMore: boolean;
  /** 搜索候选池被扫描窗吃满 ⇒ 更早的可能没勾起（诚实截断，不假装是全）。 */
  truncated: boolean;
  offset: number;
  /** 下一页游标（v19）：`hasMore=true` 时给出，缺省表示到底或本路未用游标。 */
  nextCursor?: { tsMs: number; id: string };
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
  /** v0.8.11：记录号 `echo-<uuid>`（交付也是一条记录；旧行缺省）。 */
  echoId?: string;
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

/** 疑似同一实体的候选（只读；结构同步 `store/ontology.EntityMergeSuggestion`）。 */
export interface SpiritEntityMergeSuggestion {
  a: string;
  b: string;
  left: string;
  right: string;
  reason: 'normalized-equal' | 'shared-upstream' | 'contains' | 'near-spelling';
  score: number;
}

export interface SpiritEntityMergeSuggestRequest {
  limit?: number;
}

export interface SpiritEntityMergeSuggestResult {
  suggestions: SpiritEntityMergeSuggestion[];
}

/** 人工别名追加：**只写 entity_alias(source='user')**，不合并 id、不改 entity 行。 */
export interface SpiritEntityAliasAddRequest {
  entityId: string;
  alias: string;
}

export interface SpiritEntityAliasAddResult {
  ok: boolean;
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
  /** v0.8.11：记录号 `echo-<uuid>`（任务线就是 progress/done 卡片本身）。 */
  echoId?: string;
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
     * 注意力衰减半衰期（ms）——**v19 起语义收窄为冻结开关**：
     * `0` = 全阶恒 1.000（不淡）；`>0` = 启用 0-7-30 台阶（具体尺度见下面四个键）。
     * 保留键名与面板位置，避免已有配置/面板控件跳变。
     */
    fadeHalfLifeMs: number;
    /** 台阶一「当下」的边界（天）：Δ t 小于它 ⇒ 权重 1000（默认 7）。`0` = 直接进「一周后」阶。 */
    fadeHotDays: number;
    /** 台阶二「一周后」的边界（天）：Δt 落在这里 ⇒ 权重 `fadeWarmWeight`；否则进末阶（默认 30）。 */
    fadeColdDays: number;
    /** 台阶二权重（千分位，默认 750，钳制 500..1000）。 */
    fadeWarmWeight: number;
    /** 末阶权重（千分位，默认 500 = 地板；钳制 500..1000，且不得大于 warm）。 */
    fadeColdWeight: number;
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
    /**
     * 连击型事件族（tool_failure / recovery）的同工作区记录冷却窗（v0.9.1）。
     *
     * 症状：同一个坑反复踩时每轮都记一句同样的话——实测 82 条经历里 71 条是失败轮，
     * 同句等值重复 40+31 条，星图被自己的试错刷屏。窗内同 workspace 同 trigger 只记首条，
     * 后续轮跳过落库（人格仍在"记着这一下"，只是不必重复刻同一道疤）。
     * 0 ⇒ 关闭冷却（退回每轮必记）。判定只看 trigger/workspace/ts_ms 三个结构化字段，
     * 不读任何文本——情绪与记录链路的注入红线（experience/events.ts）不因本键松动。
     */
    cooldownMs: number;
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
  /**
   * 启动挡位（三态，设置面可见）：`on` = 每次启动强制开；`off` = 每次启动强制关（出厂默认）；
   * `last` = 跟随上一次运行时的 `enabled`。只决定**下次启动**初值。
   */
  bootMode: 'on' | 'off' | 'last';
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
  /** v19：半衰期语义收窄为冻结开关（0 = 全阶恒 1.000） */
  fadeHalfLifeMs: number;
  /** v19 台阶三键（热更）：当下边界 / 一周后边界 / 两级权重（千分位）。 */
  fadeHotDays: number;
  fadeColdDays: number;
  fadeWarmWeight: number;
  fadeColdWeight: number;
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
 * - `card.maxBytes=640`：状态 1 行 + 近因 ≤2 行 + 想起 ≤1 条 + 暖 1 行 + 首轮基调 ≤1 行的实测够用宽度。
 *   ⚠ 两次上调都是同一类事故，理由必须一起看：
 *   **384 → 512**（v0.1）：极端负面档会多带一行「非医疗声明」，而声明**不允许被预算掉**
 *   （那是防误导的硬线）。实测那张卡长到 328B，在 384 顶下只剩 56B，装不下一行近因（141B）
 *   ⇒ 越是该说"刚刚发生了什么"的档，近因段越被挤掉。512 让「状态 + 声明 + 一行近因 + 一行想起」
 *   同时装下（实测 469B）。
 *   **512 → 640**（v0.11）：加「暖：」段（上游来的一条"关于这个人"，成本口 48 字 ≈150B）后，
 *   在 512 顶下带两行近因的卡**每次都装不下**——实测渲染结果是 `used.warm` 永远 undefined，
 *   功能装配完毕却从不生效，且不报错。640 让「状态 + 声明 + 两行近因 + 一行暖」装下（实测 553B）。
 *   ⚠ 暖段仍是**最先让位**的那一段（填装顺序最后），所以预算紧时它丢、状态段与声明永不丢；
 *   这条不因为顶变大而改变。
 *   成本口径：每轮一条 ~640B 在 100 轮长会话里是万级 token 的**增量**，不触发前缀重算。
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
  card: { maxBytes: 640, recentK: 2, crossSessionM: 4 },
  recall: {
    timeoutMs: 800,
    maxResults: SPIRIT_DEFAULTS_RECALL_MAX,
    maxCharsPerEntry: 120,
    halfLifeMs: 5_400_000,
    fadeEnabled: false,
    // v19 台阶：0-7-30。fadeHalfLifeMs 只作冻结开关（>0 = 启用台阶）
    fadeHalfLifeMs: 5_400_000,
    fadeHotDays: 7,
    fadeColdDays: 30,
    fadeWarmWeight: 750,
    fadeColdWeight: 500,
    fadeFullMinScore: 550,
    fadeGistMinScore: 250,
    gistMinSalience: 1,
    feedbackEnabled: true,
  },
  ledger: { enabled: false, maxAgeMs: 604_800_000 },
  bias: { enabled: false, halfLifeMs: 5_400_000 },
  tier: { stepCap: 1, staleAfterMs: 600_000 },
  journal: { retentionDays: SPIRIT_DEFAULTS_RETENTION_DAYS, dryRun: true },
  capture: { userSnippet: false, maxQuoteChars: 160, gapThresholdMs: 180_000, cooldownMs: 600_000 },
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
    bootMode: 'last',
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
    fadeHotDays: 7,
    fadeColdDays: 30,
    fadeWarmWeight: 750,
    fadeColdWeight: 500,
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
  'recall.fadeHotDays': [0, 365],
  'recall.fadeColdDays': [1, 365],
  'recall.fadeWarmWeight': [500, 1_000],
  'recall.fadeColdWeight': [500, 1_000],
  'recall.fadeFullMinScore': [0, 1_000],
  'recall.fadeGistMinScore': [0, 1_000],
  'recall.gistMinSalience': [0, 2],
  'tier.stepCap': [1, 2],
  'tier.staleAfterMs': [0, 86_400_000],
  'journal.retentionDays': [0, 3_650],
  'capture.maxQuoteChars': [0, 400],
  'capture.gapThresholdMs': [10_000, 3_600_000],
  'capture.cooldownMs': [0, 3_600_000],
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

// ── v0.8 模型可写记忆（两本账 + 日记）与目的层 ──

/** 记忆范围：life=生涯/人格面（心里话、约定）；work=长期工作；diary=日记；episode=对话细节（v0.8.24，代理自记、不自动注入）。 */
export const SPIRIT_MEMORY_SCOPES = ['life', 'work', 'diary', 'episode'] as const;
export type SpiritMemoryScope = (typeof SPIRIT_MEMORY_SCOPES)[number];
/** 各范围允许的 kind（越界拒写；kind 是给主人看的分类，不参与注入决策）。 */
export const SPIRIT_MEMORY_KINDS: Record<SpiritMemoryScope, readonly string[]> = {
  life: ['bond', 'promise'],
  work: ['fact', 'decision', 'preference', 'promise'],
  diary: ['note'],
  // 对话细节（v0.8.24）：主人原话/承诺/关键上下文——模型自记，不自动注入，靠 recall 取
  episode: ['detail'],
};

export interface SpiritMemoryRow {
  id: string;
  /** 写入面只有 life/work/diary；`distill` 是只读投影（v0.8.18，来自蒸馏层 L1）。 */
  scope: SpiritMemoryScope | 'distill';
  kind: string;
  text: string;
  workspaceId: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** v0.8.11：记录号 `echo-<uuid>`（记着/目的也是记录）。 */
  echoId?: string;
  /** 生涯流程档专用（v0.8.18）：该档关联的实体名（面板「关联实体」）。 */
  entityNames?: string[];
}

export interface SpiritGoalRow {
  id: string;
  title: string;
  status: 'open' | 'done' | 'dropped';
  why: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  /** v0.8.11：记录号 `echo-<uuid>`（目的也是一条记录）。 */
  echoId?: string;
}

export interface SpiritMemoryListRequest {
  /** 空 = 全部工作区（面板「记着」页）；非空 = 限定工作区（含全局行）。 */
  workspaceId?: string;
  /** 每本账最多返回多少条（有顶）。 */
  limit?: number;
}

export interface SpiritMemoryListResult {
  life: SpiritMemoryRow[];
  work: SpiritMemoryRow[];
  diary: SpiritMemoryRow[];
  /** 对话细节（v0.8.24）：模型自记的要点，不自动注入。 */
  episode?: SpiritMemoryRow[];
  goals: SpiritGoalRow[];
  /** 蒸馏层 L1 最近投影（v0.8.18）：只读，来源 dsh-prime-memory；没装就空。 */
  distill?: SpiritMemoryRow[];
}

/** 生涯流程预总结档（v0.8.18）：spirit 自存，只含流程性（知识性归上游）。 */
export interface DistillDigestRow {
  category: 'procedural';
  /** 档位：会话 / 7 天 / 30 天 / 里程碑（只增不改）。 */
  tier: 'session' | 'week' | 'month' | 'milestone';
  /** 档键：session=上游会话 id；week=YYYY-Www；month=YYYY-MM；milestone=上游 record_id。 */
  periodKey: string;
  /** 回看窗口（天）；会话档为 0（按会话而非时间窗）。 */
  windowDays: number;
  generatedAt: number;
  /** 会话档的首条日期（YYYY-MM-DD）；week/month/milestone 可省略。 */
  periodStart?: string;
  /** 参与总结的流程性记录数。 */
  count: number;
  /** 多行摘要（每行：日期 · 类型 · 正文；重复合并标 `×N`）。 */
  summary: string;
  /** 关联的 spirit entity id（实体对齐后填充）。 */
  entities?: string[];
  /**
   * 失效标注（v20，仅里程碑档有意义）：非空 = 来源已退场的时间，**只影响展示**，
   * 正文一字不改（避免二次真源）。NULL = 仍有效 / 拿不到证据（保守判 fresh）。
   */
  staleAt?: number;
}

/** 按实体查生涯档（v0.8.18）。 */
export interface SpiritEntityDigestRequest {
  entity: string;
  /** 里程碑上限（默认 5）。 */
  limit?: number;
}

export interface SpiritDigestView {
  tier: string;
  periodKey: string;
  generatedAt: number;
  count: number;
  lines: string[];
}

export interface SpiritEntityDigestResult {
  entity: string;
  entityId?: string;
  digests: SpiritDigestView[];
  /** 上游相关知识条数（只计数；正文用 memory_search）。 */
  knowledgeRefs: number;
}

/** 手动刷新三档（面板按钮）。 */
export interface SpiritDistillRunResult {
  week: number;
  month: number;
  milestones: number;
  weekCount: number;
  knowledgeCount: number;
  entities: number;
  links: number;
  /** 会话档：写入的会话数（v0.8.25）。 */
  sessions?: number;
  /** 会话档：被合并的重复流程行数（v0.8.25）。 */
  merged?: number;
}

// ─────────────────────────────────────────────────────────── 版本与文件

/** SQLite schema 版本；跨版本打开明确拒绝，不静默改库（v1→v2 加列、v2→v3 人设两表、v3→v4 主人档案、v4→v5 藏起列与分页索引、v5→v6 长觉阶梯五表、v6→v7 事务轨两张表、v7→v8 本体层（扩 txn_entry + 六表）、v8→v9 模型可写记忆与目的层、v9→v10 召回回响段落档表、v10→v11 回响条目摘要列、v11→v12 回响条目编号与原文字列、v12→v13 回响条目时间反查索引、v13→v14 回响条目标题与 memid 引用列、v14→v15 回响引用记录 echo_ref、v15→v16 编号重整（echo_identity 注册表 + 记录 echo-<uuid> / 回响 recall-<uuid>），均正向迁移）。 */
export const SPIRIT_DB_SCHEMA_VERSION = 20;
/** `persona.json` 文件形状版本。 */
export const SPIRIT_PERSONA_FILE_VERSION = 1;
/** `owner.json` 文件形状版本（db=null 降级面；与 persona 分键，形状互不牵连）。 */
export const SPIRIT_OWNER_FILE_VERSION = 1;
/** `session-modes.json` 文件形状版本。 */
export const SPIRIT_MODES_FILE_VERSION = 1;
// ─────────────────────────────────────────────────────────── 生涯编年（v0.10）

/**
 * 编年请求。
 *
 * 与 `entries-list` 的差别是**语义**而不是分页：那个面答"我记了哪些句子"，
 * 这个面答"我是怎么走到这儿的"。所以它必须把「事」放在轴上，而不是只有「感」。
 */
export interface SpiritChronicleRequest {
  /** 回看天数，缺省 30，钳 [1, 365]。 */
  days?: number;
  /** 只看某个工作区（会话轨按 workspace 过滤；交付轨同口径）。 */
  workspaceId?: string;
  /** 只看某个会话（优先于 workspaceId）。 */
  sessionId?: string;
  /** 每天最多几条，缺省 40，钳 [1, 200]。 */
  perDay?: number;
  /**
   * `learned` 每天最多几条，缺省 5，钳 [0, 50]。
   *
   * 0 = 关掉「得知」这一路（只看事/感/记着）。留这个参数不是为了好看：
   * 真机 learned 单日峰值 131 条，面板必须能在不重启的情况下把噪音调掉。
   */
  learnedPerDay?: number;
}

/**
 * 轴上的一行是什么。
 *
 * - `work`：事（我做成过什么）
 * - `feel`：感（那一下我的反应）
 * - `note`：我记着的（自己写的两本账）
 * - `milestone`：那一段（时期总结）
 * - `learned`：得知（从上游取来的"关于世界"的经历——事实所有权仍在上游，见 docs/positioning.md）
 * - `bond`：关于这个人（同样来自上游，但是 chat 家族那批"关于她"的记忆）
 */
export type SpiritChronicleKind = 'work' | 'feel' | 'note' | 'milestone' | 'learned' | 'bond';

/**
 * 温度档（v0.10，借 fish-memory 的形）：只说档位词，不报数值。
 *
 * 为什么档位而不给 0.73：与"情绪对外只有档位词"同一条纪律——没有校准规则时的小数是伪精确。
 */
export type SpiritChronicleWarmth = WarmthTier;

/**
 * 编年条目。
 *
 * `repeat` 只在**真的等值重复**时 > 1（同日同句）：机械聚合拿不到"第三次"，
 * 这里也不许编——计数来自库里的行数，不是推测。
 */
export interface SpiritChronicleItem {
  kind: SpiritChronicleKind;
  id: string;
  tsMs: number;
  text: string;
  /** 补充正文（交付的 summary / 时期档其余行）。空 ⇒ 不下发。 */
  detail?: string;
  echoId?: string;
  sessionId?: string;
  repeat: number;
  /**
   * 温度档（仅 `learned` / `bond` 有；其余类别没有"淡出"语义，缺省即不下发）。
   * 档位来自上游 priority + 自己的引用计数，纯查表。
   */
  warmth?: SpiritChronicleWarmth;
  /** 上游已判失效 ⇒ 这是"曾经的看法"（显示成过去时，不删）。 */
  expired?: boolean;
  /** 被想起过几次（> 0 才下发；0 是常态，不占字节）。 */
  recalled?: number;
}

/** 一天。`day` 是本机时区的 YYYY-MM-DD（跨时区不假装统一）。 */
export interface SpiritChronicleDay {
  day: string;
  items: SpiritChronicleItem[];
  counts: Record<SpiritChronicleKind, number>;
}

export interface SpiritChronicleResult {
  days: SpiritChronicleDay[];
  /** 窗口内条目总数（含 repeat 的重复行）。 */
  total: number;
  from: number;
  to: number;
  /** 窗口里一条都没有 ⇒ true（面板说"这段还没留下痕迹"，不编造）。 */
  empty: boolean;
}

/** 插件版本（与 package.json / dsh.plugin.json 同串，由门禁核对）。 */
export const SPIRIT_VERSION = '0.13.3';







