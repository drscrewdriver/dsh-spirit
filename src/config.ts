/**
 * 插件配置：Schemastery schema + 数据目录解析。
 *
 * **默认值与取值范围不在本文件重复定义**：默认值一律引用 `SPIRIT_DEFAULTS`，
 * 数值区间一律引用 `SPIRIT_RANGES`（两者单源于 `contract.ts`）。本文件只多一份
 * `SCHEMA_FIELD_KEYS` 键清单，由 `tests/contract-keys.test.ts` 与 defaults 对敲——
 * 少一个键 = 用户已存值被静默丢弃，那是红线。
 *
 * 缺省数据目录：`$DSH_HOME/spirit`（官方 `dshHomePath` 解析，`DSH_HOME` 缺省 `~/.dsh`）。
 */
import Schema from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { SPIRIT_DEFAULTS, SPIRIT_RANGES, type SpiritConfig, type SpiritLiveSettings } from './contract.js';
import {
  AROUSAL_TIERS,
  NOTICE_KINDS,
  REACTION_TIERS,
  SALIENCE_WEIGHTS,
  TRIGGER_KINDS,
  VALENCE_TIERS,
  VOICE_TIERS,
} from './types.js';

/**
 * volatile 引用的本地结构声明——故意不从 cordis 输 `Volatile<T>`。
 *
 * 那个类型别名内部引用了 cosmokit 的私有名（只在 `.pnpm/@deepseek-ai+cosmokit@x`
 * 这种私有目录可寻址），拿它做导出成员标注会让 d.ts 报 TS2742「inferred type cannot
 * be named」，整包 `npm run build` 卡死。本仓只用 `.get()`，结构上兼容宿主真类型。
 */
export interface VolatileRef<T> {
  get(): T;
  /** 宿主 volatile 写通道（schemastery 支持时存在）：settings-set 腿用它热更；缺席 ⇒ 面板如实报“需重启”。 */
  update?(patch: Partial<T>): unknown;
}

/** 显式标注导出面形状，避免 d.ts 里出现不可命名的 schemastery/cosmokit 内部类型。 */
export type ConfigSchema = ((value: unknown) => SpiritConfig) & Record<string, unknown>;

const num = (key: keyof typeof SPIRIT_RANGES, fallback: number) => {
  const [lo, hi] = SPIRIT_RANGES[key] ?? [0, Number.MAX_SAFE_INTEGER];
  return Schema.number().min(lo).max(hi).default(fallback);
};
const bool = (fallback: boolean) => Schema.boolean().default(fallback);
const str = (fallback: string) => Schema.string().default(fallback);

/**
 * 运行时开关节（0.1.7+ 声明式设置面的唯一事实源）。
 *
 * ⚠️ **整个对象标一次 `.volatile()`**，节内不得再标（volatile 嵌套 volatile 会被宿主拒绝）。
 * 探测后再标：`Schema.object(...).volatile()` 只在较新 schemastery 上有；直接调用会让
 * **整插件**在老线 load-failure（不是降级，是起不来）。未标时读侧走兜底：开关仍生效
 * （取宿主注入的冻结值），只是改值需要重启而非热更。
 */
function liveSettingsSchema(): VolatileRef<SpiritLiveSettings> {
  const d = SPIRIT_DEFAULTS.live;
  const node = Schema.object({
    enabled: bool(d.enabled),
    personaEnabled: bool(d.personaEnabled),
    cardEnabled: bool(d.cardEnabled),
    bypass: bool(d.bypass),
    cardMaxBytes: num('card.maxBytes', d.cardMaxBytes),
    recentK: num('card.recentK', d.recentK),
    crossSessionM: num('card.crossSessionM', d.crossSessionM),
    recallTimeoutMs: num('recall.timeoutMs', d.recallTimeoutMs),
    halfLifeMs: num('recall.halfLifeMs', d.halfLifeMs),
    tierStepCap: num('tier.stepCap', d.tierStepCap),
    staleAfterMs: num('tier.staleAfterMs', d.staleAfterMs),
    drscEnabled: bool(d.drscEnabled),
    recallMaxResults: num('recall.maxResults', d.recallMaxResults),
    retentionDays: num('journal.retentionDays', d.retentionDays),
    fadeEnabled: bool(d.fadeEnabled),
    fadeHalfLifeMs: num('recall.fadeHalfLifeMs', d.fadeHalfLifeMs),
    feedbackEnabled: bool(d.feedbackEnabled),
    dreamEnabled: bool(d.dreamEnabled),
    distillEnabled: bool(d.distillEnabled),
    ontologyEnabled: bool(d.ontologyEnabled),
  });
  const maybe = node as unknown as { volatile?: () => unknown };
  return (typeof maybe.volatile === 'function' ? maybe.volatile() : node) as VolatileRef<SpiritLiveSettings>;
}

export const spiritSchema: ConfigSchema = Schema.object({
  enabled: bool(SPIRIT_DEFAULTS.enabled),
  dataDir: str(SPIRIT_DEFAULTS.dataDir),
  persona: Schema.object({
    enabled: bool(SPIRIT_DEFAULTS.persona.enabled),
    budgetBytes: num('persona.budgetBytes', SPIRIT_DEFAULTS.persona.budgetBytes),
  }),
  card: Schema.object({
    maxBytes: num('card.maxBytes', SPIRIT_DEFAULTS.card.maxBytes),
    recentK: num('card.recentK', SPIRIT_DEFAULTS.card.recentK),
    crossSessionM: num('card.crossSessionM', SPIRIT_DEFAULTS.card.crossSessionM),
  }),
  recall: Schema.object({
    timeoutMs: num('recall.timeoutMs', SPIRIT_DEFAULTS.recall.timeoutMs),
    maxResults: num('recall.maxResults', SPIRIT_DEFAULTS.recall.maxResults),
    maxCharsPerEntry: num('recall.maxCharsPerEntry', SPIRIT_DEFAULTS.recall.maxCharsPerEntry),
    halfLifeMs: num('recall.halfLifeMs', SPIRIT_DEFAULTS.recall.halfLifeMs),
    fadeEnabled: bool(SPIRIT_DEFAULTS.recall.fadeEnabled),
    fadeHalfLifeMs: num('recall.fadeHalfLifeMs', SPIRIT_DEFAULTS.recall.fadeHalfLifeMs),
    fadeFullMinScore: num('recall.fadeFullMinScore', SPIRIT_DEFAULTS.recall.fadeFullMinScore),
    fadeGistMinScore: num('recall.fadeGistMinScore', SPIRIT_DEFAULTS.recall.fadeGistMinScore),
    gistMinSalience: num('recall.gistMinSalience', SPIRIT_DEFAULTS.recall.gistMinSalience),
    feedbackEnabled: bool(SPIRIT_DEFAULTS.recall.feedbackEnabled),
  }),
  ledger: Schema.object({
    enabled: bool(SPIRIT_DEFAULTS.ledger.enabled),
    maxAgeMs: num('ledger.maxAgeMs', SPIRIT_DEFAULTS.ledger.maxAgeMs),
  }),
  bias: Schema.object({
    enabled: bool(SPIRIT_DEFAULTS.bias.enabled),
    halfLifeMs: num('bias.halfLifeMs', SPIRIT_DEFAULTS.bias.halfLifeMs),
  }),
  tier: Schema.object({
    stepCap: num('tier.stepCap', SPIRIT_DEFAULTS.tier.stepCap),
    staleAfterMs: num('tier.staleAfterMs', SPIRIT_DEFAULTS.tier.staleAfterMs),
  }),
  journal: Schema.object({
    retentionDays: num('journal.retentionDays', SPIRIT_DEFAULTS.journal.retentionDays),
    dryRun: bool(SPIRIT_DEFAULTS.journal.dryRun),
  }),
  capture: Schema.object({
    userSnippet: bool(SPIRIT_DEFAULTS.capture.userSnippet),
    maxQuoteChars: num('capture.maxQuoteChars', SPIRIT_DEFAULTS.capture.maxQuoteChars),
    gapThresholdMs: num('capture.gapThresholdMs', SPIRIT_DEFAULTS.capture.gapThresholdMs),
  }),
  drsc: Schema.object({
    enabled: bool(SPIRIT_DEFAULTS.drsc.enabled),
    baseUrl: str(SPIRIT_DEFAULTS.drsc.baseUrl),
    probeCacheTtlMs: num('drsc.probeCacheTtlMs', SPIRIT_DEFAULTS.drsc.probeCacheTtlMs),
    timeoutMs: num('drsc.timeoutMs', SPIRIT_DEFAULTS.drsc.timeoutMs),
  }),
  // 星海老化尺度（图上亮度专用，与注入侧的注意力尺度分开；理由见 contract.ts 的注释）
  sea: Schema.object({
    agingHalfLifeMs: num('sea.agingHalfLifeMs', SPIRIT_DEFAULTS.sea.agingHalfLifeMs),
  }),
  // 主人背景档案（同步周期/预算/基址/探测缓存；prime 缺席整节休眠，见 contract.ts owner 注释）
  owner: Schema.object({
    syncIntervalMs: num('owner.syncIntervalMs', SPIRIT_DEFAULTS.owner.syncIntervalMs),
    budgetBytes: num('owner.budgetBytes', SPIRIT_DEFAULTS.owner.budgetBytes),
    baseUrl: str(SPIRIT_DEFAULTS.owner.baseUrl),
    probeCacheTtlMs: num('owner.probeCacheTtlMs', SPIRIT_DEFAULTS.owner.probeCacheTtlMs),
  }),
  // 做梦（v0.3.3）：确定性整理 pass 的开关与节奏；手动按钮不受周期限制，共用去重窗
  dream: Schema.object({
    enabled: bool(SPIRIT_DEFAULTS.dream.enabled),
    intervalMs: num('dream.intervalMs', SPIRIT_DEFAULTS.dream.intervalMs),
  }),
  // 长觉（v0.3.5）：异步 LLM 归纳 pass；缺省关，模型 fail-closed（留空跟宿主默认，配错拒蒸不隐式改选）
  distill: Schema.object({
    enabled: bool(SPIRIT_DEFAULTS.distill.enabled),
    provider: str(SPIRIT_DEFAULTS.distill.provider),
    model: str(SPIRIT_DEFAULTS.distill.model),
    reasoningEffort: str(SPIRIT_DEFAULTS.distill.reasoningEffort),
    intervalMs: num('distill.intervalMs', SPIRIT_DEFAULTS.distill.intervalMs),
    batchMin: num('distill.batchMin', SPIRIT_DEFAULTS.distill.batchMin),
    maxInputChars: num('distill.maxInputChars', SPIRIT_DEFAULTS.distill.maxInputChars),
    maxOutputTokens: num('distill.maxOutputTokens', SPIRIT_DEFAULTS.distill.maxOutputTokens),
    timeoutMs: num('distill.timeoutMs', SPIRIT_DEFAULTS.distill.timeoutMs),
    // 向量能力位（缺省关）；apiKey 属机密：不回读明文、不落日志、不进导出（G24）
    vector: Schema.object({
      enabled: bool(SPIRIT_DEFAULTS.distill.vector.enabled),
      baseUrl: str(SPIRIT_DEFAULTS.distill.vector.baseUrl),
      apiKey: str(SPIRIT_DEFAULTS.distill.vector.apiKey),
      model: str(SPIRIT_DEFAULTS.distill.vector.model),
      dimensions: num('distill.vector.dimensions', SPIRIT_DEFAULTS.distill.vector.dimensions),
    }),
  }),
  // 事务轨（v7）：灰度缺省关；属部署面（不进 volatile/live 节，改值需重启）。
  txn: Schema.object({
    enabled: bool(SPIRIT_DEFAULTS.txn.enabled),
    batchMin: num('txn.batchMin', SPIRIT_DEFAULTS.txn.batchMin),
    maxCardLineChars: num('txn.maxCardLineChars', SPIRIT_DEFAULTS.txn.maxCardLineChars),
    maxSummaryChars: num('txn.maxSummaryChars', SPIRIT_DEFAULTS.txn.maxSummaryChars),
    collectorTimeoutMs: num('txn.collectorTimeoutMs', SPIRIT_DEFAULTS.txn.collectorTimeoutMs),
  }),
  // 本体层（v8）：灰度缺省关；属部署面（不进 volatile/live）。数值子键随 Phase B 采集器补。
  ontology: Schema.object({
    enabled: bool(SPIRIT_DEFAULTS.ontology.enabled),
    backfillEnabled: bool(SPIRIT_DEFAULTS.ontology.backfillEnabled),
  }),
  // 运行时开关：整个 volatile 节，设置页自动成表。
  live: liveSettingsSchema(),
}) as unknown as ConfigSchema;

/**
 * schema 实际声明的**点分键清单**（与 `SPIRIT_DEFAULTS` 展平后逐一对敲）。
 * 新增配置键必须同时出现在这里与 defaults，否则 contract-keys 门禁红。
 */
export const SCHEMA_FIELD_KEYS: readonly string[] = [
  'enabled',
  'dataDir',
  'persona.enabled',
  'persona.budgetBytes',
  'card.maxBytes',
  'card.recentK',
  'card.crossSessionM',
  'recall.timeoutMs',
  'recall.maxResults',
  'recall.maxCharsPerEntry',
  'recall.halfLifeMs',
  'recall.fadeEnabled',
  'recall.fadeHalfLifeMs',
  'recall.fadeFullMinScore',
  'recall.fadeGistMinScore',
  'recall.gistMinSalience',
  'recall.feedbackEnabled',
  'ledger.enabled',
  'ledger.maxAgeMs',
  'bias.enabled',
  'bias.halfLifeMs',
  'tier.stepCap',
  'tier.staleAfterMs',
  'journal.retentionDays',
  'journal.dryRun',
  'capture.userSnippet',
  'capture.maxQuoteChars',
  'capture.gapThresholdMs',
  'drsc.enabled',
  'drsc.baseUrl',
  'drsc.probeCacheTtlMs',
  'sea.agingHalfLifeMs',
  'owner.syncIntervalMs',
  'owner.budgetBytes',
  'owner.baseUrl',
  'owner.probeCacheTtlMs',
  'dream.enabled',
  'dream.intervalMs',
  'distill.enabled',
  'distill.provider',
  'distill.model',
  'distill.reasoningEffort',
  'distill.intervalMs',
  'distill.batchMin',
  'distill.maxInputChars',
  'distill.maxOutputTokens',
  'distill.timeoutMs',
  'distill.vector.enabled',
  'distill.vector.baseUrl',
  'distill.vector.apiKey',
  'distill.vector.model',
  'distill.vector.dimensions',
  'drsc.timeoutMs',
  'txn.enabled',
  'txn.batchMin',
  'txn.maxCardLineChars',
  'txn.maxSummaryChars',
  'txn.collectorTimeoutMs',
  'ontology.enabled',
  'ontology.backfillEnabled',
  'live.enabled',
  'live.personaEnabled',
  'live.cardEnabled',
  'live.bypass',
  'live.cardMaxBytes',
  'live.recentK',
  'live.crossSessionM',
  'live.recallTimeoutMs',
  'live.halfLifeMs',
  'live.tierStepCap',
  'live.staleAfterMs',
  'live.drscEnabled',
  'live.recallMaxResults',
  'live.retentionDays',
  'live.fadeEnabled',
  'live.fadeHalfLifeMs',
  'live.feedbackEnabled',
  'live.dreamEnabled',
  'live.distillEnabled',
  'live.ontologyEnabled',
];

/** 数值键区间表覆盖检查用的键集（`num()` 引用的键必须都在 SPIRIT_RANGES 里）。 */
export const RANGE_KEYS = Object.keys(SPIRIT_RANGES);

/** 人格文件的枚举域（写入前校验用，单源仍来自 types.ts）。 */
export const PERSONA_ENUMS = {
  triggers: TRIGGER_KINDS,
  notices: NOTICE_KINDS,
  reactions: REACTION_TIERS,
  valences: VALENCE_TIERS,
  arousals: AROUSAL_TIERS,
  voices: VOICE_TIERS,
  saliences: SALIENCE_WEIGHTS,
} as const;

/**
 * 读 live 节的当前值，两种形状都得接：
 * - 新 schemastery：`liveSettingsSchema()` 成功标了 `.volatile()`，宿主给 `Volatile<T>`（有 `.get()`）；
 * - 老 schemastery：探测不标时宿主直接给配置对象本体——没有 `.get()`，当成冻结快照读。
 * 不兼容后者就是在老线把加载期崩换成运行期崩（`ref.get is not a function`）。
 */
export function readLiveRef(ref: unknown): SpiritLiveSettings {
  const maybe = ref as { get?: () => SpiritLiveSettings } | null | undefined;
  const raw = typeof maybe?.get === 'function' ? maybe.get() : (maybe as SpiritLiveSettings | null | undefined);
  return resolveLive(raw);
}

/** live 节逐键兜底（缺键 = 用户已存值被静默丢弃那一类问题的读侧对应面）。 */
export function resolveLive(raw: unknown): SpiritLiveSettings {
  const d = SPIRIT_DEFAULTS.live;
  if (typeof raw !== 'object' || raw === null) return { ...d };
  const value = raw as Record<string, unknown>;
  const flag = (key: keyof SpiritLiveSettings, fallback: boolean): boolean =>
    typeof value[key] === 'boolean' ? (value[key] as boolean) : fallback;
  const int = (key: keyof SpiritLiveSettings, fallback: number): number =>
    typeof value[key] === 'number' && Number.isFinite(value[key] as number) ? Math.floor(value[key] as number) : fallback;
  return {
    enabled: flag('enabled', d.enabled),
    personaEnabled: flag('personaEnabled', d.personaEnabled),
    cardEnabled: flag('cardEnabled', d.cardEnabled),
    bypass: flag('bypass', d.bypass),
    cardMaxBytes: int('cardMaxBytes', d.cardMaxBytes),
    recentK: int('recentK', d.recentK),
    crossSessionM: int('crossSessionM', d.crossSessionM),
    recallTimeoutMs: int('recallTimeoutMs', d.recallTimeoutMs),
    halfLifeMs: int('halfLifeMs', d.halfLifeMs),
    tierStepCap: int('tierStepCap', d.tierStepCap),
    staleAfterMs: int('staleAfterMs', d.staleAfterMs),
    drscEnabled: flag('drscEnabled', d.drscEnabled),
    recallMaxResults: int('recallMaxResults', d.recallMaxResults),
    retentionDays: int('retentionDays', d.retentionDays),
    fadeEnabled: flag('fadeEnabled', d.fadeEnabled),
    fadeHalfLifeMs: int('fadeHalfLifeMs', d.fadeHalfLifeMs),
    feedbackEnabled: flag('feedbackEnabled', d.feedbackEnabled),
    dreamEnabled: flag('dreamEnabled', d.dreamEnabled),
    distillEnabled: flag('distillEnabled', d.distillEnabled),
    ontologyEnabled: flag('ontologyEnabled', d.ontologyEnabled),
  };
}

export function resolveDataDir(cfg: SpiritConfig): string {
  if (cfg.dataDir) return cfg.dataDir;
  return dshHomePath('spirit');
}

/**
 * 把 volatile 节与静态默认合成实际生效配置。
 *
 * `live` 节存在即整体接管其覆盖的键；读不到 volatile（老线未标）时用宿主注入的冻结值。
 */
export function effectiveCfg(cfg: SpiritConfig, live?: SpiritLiveSettings): SpiritConfig {
  if (live === undefined) return cfg;
  return {
    ...cfg,
    persona: { ...cfg.persona, enabled: cfg.persona.enabled && live.personaEnabled },
    card: {
      ...cfg.card,
      maxBytes: live.cardEnabled ? live.cardMaxBytes : 0,
      recentK: live.recentK,
      crossSessionM: live.crossSessionM,
    },
    drsc: { ...cfg.drsc, enabled: cfg.drsc.enabled && live.drscEnabled },
    recall: {
      ...cfg.recall,
      timeoutMs: live.recallTimeoutMs,
      halfLifeMs: live.halfLifeMs,
      maxResults: live.recallMaxResults,
      // 淡出开关与窗口尺度走 volatile（面板六腿）；阈值属部署面，不热更。
      fadeEnabled: cfg.recall.fadeEnabled && live.fadeEnabled,
      fadeHalfLifeMs: live.fadeHalfLifeMs,
      feedbackEnabled: cfg.recall.feedbackEnabled && live.feedbackEnabled,
    },
    ledger: { ...cfg.ledger, enabled: cfg.ledger.enabled && live.fadeEnabled },
    bias: { ...cfg.bias, enabled: cfg.bias.enabled && live.fadeEnabled },
    tier: { ...cfg.tier, stepCap: live.tierStepCap, staleAfterMs: live.staleAfterMs },
    journal: { ...cfg.journal, retentionDays: live.retentionDays },
    // 做梦双闸：部署面总闸与 volatile 热更闸取与（照 ledger/bias 先例；关任一 ⇒ 定时器与手动都拒）
    dream: { ...cfg.dream, enabled: cfg.dream.enabled && live.dreamEnabled },
    // 长觉双闸同理：live.distillEnabled 关 ⇒ sleep-run 拒、定时器空转
    distill: { ...cfg.distill, enabled: cfg.distill.enabled && live.distillEnabled },
    // 本体层双闸（v0.5）：静态总闸 ∧ live 热更闸；关任一 ⇒ 采集/抽取全停（零落库）
    ontology: { ...cfg.ontology, enabled: cfg.ontology.enabled && live.ontologyEnabled },
    live,
  };
}
