/**
 * dsh-spirit 命名与配置契约 —— **Phase 0 冻结点**。
 *
 * 键名、默认值、取值范围是**部署面契约**（`cordis.patch.yml` 按"键按行整体替换、不深合并"
 * 覆盖），不可更名、不可改语义。运行时可热更的键集中在 `live` 节，其余键改动需重启。
 *
 * `tests/contract-keys.test.ts` 逐腿核对：defaults ⇄ schema ⇄ settings 面 ⇄ runner ⇄
 * stats ⇄ client。少一腿即红——历史上姊妹包正是靠这一份测试挡住了"用户已存值被静默丢弃"。
 */

import type { SpiritVerdict } from './types.js';

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
  sessionId: string;
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

/** 端点 → 请求/响应类型的查表（两端共享的契约单一事实源）。 */
export interface SpiritRequestMap {
  'session-stats': { sessionId?: string };
  'journal-tail': SpiritJournalTailRequest;
  'journal-export': SpiritExportRequest;
  'persona-get': Record<string, never>;
  'session-mode': SpiritSessionModeRequest;
  'session-mode-get': { sessionId: string };
}

export interface SpiritResponseMap {
  'session-stats': SpiritSessionStats;
  'journal-tail': SpiritJournalPage;
  'journal-export': SpiritExportResult;
  'persona-get': SpiritPersonaView;
  'session-mode': SpiritSessionModeResult;
  'session-mode-get': SpiritSessionModeResult;
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
  /** 存储降级为真时 ⇒ 不落库不检索，只走实时近因。 */
  degraded: boolean;
  /** 当前档位（无会话运行态时为 null）。 */
  mood: SpiritMoodView | null;
  /** 会话级覆盖现状。 */
  mode: { off: boolean; bypass: boolean };
}

/** 手记分页视图（读库投影；库是真源，不是文档）。 */
export interface SpiritJournalPage {
  sessionId: string;
  /** 返回给面板的条目（体验句 + 结构化事实分列）。 */
  rows: Array<{
    id: string;
    tsMs: number;
    turnSeq: number;
    trigger: string;
    notice: string;
    reaction: string;
    text: string;
    lane: string;
    sourceRef: string | null;
  }>;
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

/** 人格读面（写面不在 v0.1，故只 get）。 */
export interface SpiritPersonaView {
  id: string;
  revision: number;
  name: string;
  voice: string;
  salience: Record<string, number>;
  focus: string[];
  values: string[];
  boundaries: string[];
  /** 当前会被注入系统提示的原文（与注入同源，可核对）。 */
  projectedText: string;
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
}

/**
 * 默认值单源。取值理由（都是经验缺省，非校准结论，可在设置页改）：
 * - `card.maxBytes=384`：状态 1 行 + 近因 ≤2 行 + 想起 ≤1 条 + 首轮基调 ≤1 行的实测够用宽度；
 *   每轮一条 ~384B 在 100 轮长会话里是万级 token 的**增量**，不触发前缀重算。
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
  card: { maxBytes: 384, recentK: 2, crossSessionM: 4 },
  recall: { timeoutMs: 800, maxResults: SPIRIT_DEFAULTS_RECALL_MAX, maxCharsPerEntry: 120, halfLifeMs: 5_400_000 },
  tier: { stepCap: 1, staleAfterMs: 600_000 },
  journal: { retentionDays: SPIRIT_DEFAULTS_RETENTION_DAYS, dryRun: true },
  capture: { userSnippet: false, maxQuoteChars: 160, gapThresholdMs: 180_000 },
  drsc: { enabled: true, baseUrl: '', probeCacheTtlMs: 15_000, timeoutMs: 5_000 },
  live: {
    enabled: true,
    personaEnabled: true,
    cardEnabled: true,
    bypass: false,
    cardMaxBytes: 384,
    recentK: 2,
    crossSessionM: 4,
    recallTimeoutMs: 800,
    halfLifeMs: 5_400_000,
    tierStepCap: 1,
    staleAfterMs: 600_000,
    drscEnabled: true,
    recallMaxResults: SPIRIT_DEFAULTS_RECALL_MAX,
    retentionDays: SPIRIT_DEFAULTS_RETENTION_DAYS,
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
  'tier.stepCap': [1, 2],
  'tier.staleAfterMs': [0, 86_400_000],
  'journal.retentionDays': [0, 3_650],
  'capture.maxQuoteChars': [0, 400],
  'capture.gapThresholdMs': [10_000, 3_600_000],
  'drsc.probeCacheTtlMs': [1_000, 600_000],
  'drsc.timeoutMs': [200, 20_000],
};

// ─────────────────────────────────────────────────────────── 版本与文件

/** SQLite schema 版本；跨版本打开明确拒绝，不静默改库。 */
export const SPIRIT_DB_SCHEMA_VERSION = 1;
/** `persona.json` 文件形状版本。 */
export const SPIRIT_PERSONA_FILE_VERSION = 1;
/** `session-modes.json` 文件形状版本。 */
export const SPIRIT_MODES_FILE_VERSION = 1;
/** 插件版本（与 package.json / dsh.plugin.json 同串，由门禁核对）。 */
export const SPIRIT_VERSION = '0.1.0';
