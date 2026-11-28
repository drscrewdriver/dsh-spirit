/**
 * dsh-spirit 宿主半身入口。
 *
 * 两条总原则写在这里，不散落到各文件：
 * 1. **存储与 DRSC 都是可选的**：库打不开 ⇒ 退内存镜像（卡照出、历史停用）；DRSC 不在 ⇒
 *    历史路停用。两者都不许把异常抛到会话链路上——记忆/情绪是增强能力，
 *    宿主本体必须照常工作。
 * 2. **`inject` 只声明真正硬需要的服务**：声明即等它就绪。这里只等 `systemPrompt`；
 *    可选服务（`webServer` / `agents` / `webStartup`）一律**不**进顶层 inject——
 *    顶层声明会把没这服务的宿主线（headless/tui）整体挂死。面板路由走
 *    `ctx.inject(['webServer'], …)` 作域注入（服务就绪才回调），其余能力走宽容读（`getService`）。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { DatabaseSync } from 'node:sqlite';
import type {} from '@deepseek-ai/dsh-agent'; // agent/created 事件名声明
import type {} from '@deepseek-ai/dsh-session';

import {
  SPIRIT_ENTRY_ID,
  SPIRIT_PLUGIN_NAME,
  type SpiritConfig,
  type SpiritLiveSettings,
} from './contract.js';
import { applyBootMode, effectiveCfg, readLiveRef, resolveDataDir, spiritSchema, type ConfigSchema } from './config.js';
import { entryIdOf as resolveEntryId, writeLiveSettings, type SettingsServiceLike } from './settings-write.js';
import { probeCapabilities, readTrustedHosts, getService } from './capability.js';
import { openSpiritDb } from './db/open.js';
import { decideDegrade } from './db/degrade.js';
import { ExperienceStore } from './store/experience.js';
import { LedgerStore, ledgerLineText } from './store/ledger.js';
import { BiasStore } from './store/bias.js';
import { PersonaStore } from './persona/store.js';
import { SessionModeStore } from './store/session-modes.js';
import { TurnWatcher } from './experience/watcher.js';
import { DrscClient } from './drsc/client.js';
import { DrscProbe } from './drsc/probe.js';
import { PrimeClient } from './prime/client.js';
import { OwnerSyncService } from './prime/sync.js';
import { OwnerProfileStore } from './store/owner.js';
import { DreamRunner } from './dream/dream.js';
import { TopicStore } from './store/topics.js';
import { InsightStore } from './store/insights.js';
import { EdgeStore, heuristicEdges } from './store/edges.js';
import { TxnStore } from './store/transaction.js';
import { OntologyStore } from './store/ontology.js';
import { OntologyWatcher } from './ontology/watcher.js';
import { OntologyExtractor } from './ontology/extractor.js';
import { ingestL1 } from './prime/l1-ingest.js';
import { L1BackfillRunner } from './prime/l1-backfill.js';
import { buildSessionDigests, summarizeSessionDigests } from './prime/session-digest.js';
import { resolveWorkspaceId } from './ontology/workspace.js';
import { TransactionWatcher } from './transaction/watcher.js';
import { TxnCollector } from './transaction/collector.js';
import { RuminateRunner } from './distill/ruminate.js';
import { createLlmChannel, type DistillRoute, type LlmChannel, type LlmRuntimeLike } from './distill/llm.js';
import { readRuntimeRoute, writeRuntimeRoute } from './distill/runtime-route.js';
import { Spirit } from './spirit.js';
import { registerPersonaSection } from './hooks/persona-section.js';
import { PersonaPresetStore } from './persona/presets.js';
import { EchoLog, parseEchoSegments, previewOfEcho, splitEchoEntries } from './echo-log.js';
import { resolveEntryTimes, titleOfEntries } from './echo-times.js';
import { backfillEchoText } from './echo/text-backfill.js';
import { backfillEchoRefs } from './echo/refs-backfill.js';
import { summarizeProcedural } from './prime/distill-summary.js';
import { buildDigests, readDigests } from './prime/distill-digest.js';
import { searchL1Records, loadL1Entities, searchL1WarmRows, type L1WarmthRow } from './prime/l1-source.js';
import { toWarmItems } from './prime/l1-warmth.js';
import { WARM_LOOKBACK_CACHE_MS, WARM_LOOKBACK_DAYS, commitWarmInject, createWarmPickState, pickWarmForCard } from './prime/warm-pick.js';
import { buildEntityAliases, buildEntityLinks, ensureEntityAliases, linkKnowledgeRecords, resolveEntityId } from './prime/entity-align.js';
import { searchAll } from './search/all.js';
import { describeSearchIndex, ensureSearchIndex } from './search/index.js';
import { loadRecordDetail } from './search/detail-records.js';
import { loadExperienceDetail } from './search/detail-exp.js';
import { pickBest } from './recall/txn-score.js';
import { ModelMemoryStore, GoalStore } from './memory/store.js';
import { EchoRefStore } from './store/echo-ref.js';
import { isFlashback, newRecallId, resolveEchoId, echoQueryPrefix, findEchoIdentities } from './echo/identity.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerCardPreStep } from './hooks/card-pre-step.js';
import { registerCardObserve } from './hooks/card-observe.js';
import { registerTxnObserve } from './hooks/txn-observe.js';
import { registerOntologyObserve } from './hooks/ontology-observe.js';
import { registerSelfNameTool } from './tools/selfname.js';
import { registerSpiritRpc } from './rpc.js';
import { registerEchoProjection } from './projection/echo.js';
import { EchoRecallStore } from './store/echo-recall.js';
import { SpiritStats } from './stats.js';
import { registerSpiritCommand } from './tui-command.js';
import { isSubagentAgent, ownerSessionIdOfAgent, sessionIdOfSession, workspaceIdOfAgent } from './util/host-shape.js';

export const name = SPIRIT_PLUGIN_NAME;

/** 只等真正硬依赖的服务；其余走宽容读。 */
export const inject = ['systemPrompt'];

/** 导出名必须是 `Config`：cordis 只读 `plugin.Config`，叫别的名字会被静默忽略。 */
export const Config = spiritSchema as unknown as ConfigSchema;

export async function apply(ctx: Context, config: SpiritConfig): Promise<void> {
  const logger = {
    info: (message: string) => ctx.logger.info(message),
    warn: (message: string) => ctx.logger.warn(message),
    error: (message: string) => ctx.logger.error(message),
  };
  const caps = probeCapabilities(ctx);
  const cfg = (): SpiritConfig => config;
  const live = (): SpiritLiveSettings => readLiveRef(config.live);
  // 启动挡位（三态 on/off/last）：控制新会话默认档位（而非系统级 enabled）。
  // 异步、失败不阻断启动。需要 modes 就绪后才调用（见下方）。
  /** 已合并 live 兜底的生效视图（任何读开关的地方都只能拿这个，不能拿 `cfg()`）。 */
  const eff = (): SpiritConfig => effectiveCfg(config, live());

  const dataDir = resolveDataDir(config);
  const opened = openSpiritDb(dataDir);
  let db: DatabaseSync | null = null;
  if (opened.ok) {
    db = opened.db;
  } else {
    const decision = decideDegrade(opened.err);
    logger.warn(`[spirit] 存储降级（${decision.reason}）`);
  }

  // v19 检索索引：开库即对齐（表空 / 分词器戳变 ⇒ 全量回填；失败只降到 LIKE，不阻开库）。
  // 这里而不是 open.ts：回填需要 logger 把“降级/耗时”说清楚，而 openSpiritDb 是无日志的纯函数面。
  if (db !== null) {
    const index = ensureSearchIndex(db, { warn: (message) => logger.warn(message) });
    logger.info(`[spirit] 检索索引：${describeSearchIndex(index)}`);
    // B-3：归一化算法换代（NFKC）后别名表必须重建，否则“搜得到旧的、搜不到新的”且两边都不报错
    const alias = ensureEntityAliases(db, { warn: (message) => logger.warn(message) });
    if (alias.rebuilt) logger.info(`[spirit] 别名表已按新归一化重建（${alias.aliases} 条）`);
  }

  const personas = new PersonaStore({ dataDir, logger, db });
  // v0.7 人格预设库：文件型（激活=走 personas.save 写入；作用域覆盖=只读投影）
  const personaPresets = new PersonaPresetStore({ dataDir, logger });
  // v0.7 注入回响面：进程内环形缓冲（观测面，不落库）
  const echoLog = new EchoLog();
  // v0.8.2 回响落档（v10 两表）：侧栏「本会话回响段」的持久面——重启不归零。
  // 与 EchoLog 并存不互冒充：星海「翻阅→回响」仍读进程内实时快照（RPC），侧栏读这张表。
  const echoRecall = new EchoRecallStore({ db: () => db ?? undefined, logger });
  // v0.8.8 回响引用（echo-id ≡ memid）：每条被想起的记忆一行，跨轮合并 times
  const echoRefs = new EchoRefStore({ db: () => db ?? undefined, logger });

  // ── 暖记忆注入（v0.11）的跨轮状态与上游取料缓存 ──
  //
  // 为什么要缓存：`agent/pre-step` 每个 agent 每轮都会问一次，而 `searchL1WarmRows`
  // 要开上游库（文件 I/O + SQL）。同一轮多个 agent（子代理并存）不去重就会开 N 次库。
  // 缓存窗 60s：上游蒸馏本身是分钟级批量，秒级新鲜度没有意义。
  const warmState = createWarmPickState();
  let warmCacheAt = 0;
  let warmCacheRows: Awaited<ReturnType<typeof loadWarmRows>> = { rows: [], items: [] };
  /**
   * 上次挑失败的原因（诊断面：**静默不注入最难排查**）。
   *
   * 不落库、不进注入：只在原因组合变化时打一条 warn。这样"这几天怎么没有暖记忆"
   * 在日志里答得上来，而不是要靠猜（白名单挡了？太冷？全在冷却？）。
   */
  let lastWarmRejected: Record<string, number> = {};

  /** 开关：走生效配置的 ontology 闸（暖记忆属"上游知识面"，与本体层同生共死）。 */
  const warmPickEnabled = (): boolean => eff().enabled && eff().live.cardEnabled;

  /** 只在"原因组合变了"时打一条 warn（每轮都打会把日志冲成龙卷风）。 */
  const noteWarmRejected = (rejected: Record<string, number>): void => {
    const signature = Object.keys(rejected).sort().join(',');
    const previous = Object.keys(lastWarmRejected).sort().join(',');
    lastWarmRejected = rejected;
    if (signature === previous || signature === '') return;
    logger.info(`[spirit] 暖记忆本轮未带（${Object.entries(rejected).map(([k, v]) => `${k}×${v}`).join(' ')}）`);
  };

  const loadWarmRows = (): { rows: L1WarmthRow[]; items: ReturnType<typeof toWarmItems> } => {
    // 被想起次数：从自己的 echo_ref 取（不是上游召回账——那是它的账）
    const recallHits = new Map<string, number>();
    if (db !== null) {
      try {
        for (const row of echoRefs.list({ limit: 200, order: 'recall' }).rows) recallHits.set(row.memId, row.times);
      } catch {
        /* 引用表读不到 ⇒ 只是少了"热"这一项，不阻断 */
      }
    }
    const rows = searchL1WarmRows({ days: WARM_LOOKBACK_DAYS, limit: 2000 });
    const items = toWarmItems(rows, {
      now: Date.now(),
      recallHitsOf: (l1Id) => recallHits.get(`l1-dlv:${l1Id}`) ?? recallHits.get(`l1-task:${l1Id}`) ?? 0,
    });
    return { rows, items };
  };

  const warmCache = (now: number): { rows: L1WarmthRow[]; items: ReturnType<typeof toWarmItems> } => {
    if (now - warmCacheAt < WARM_LOOKBACK_CACHE_MS) return warmCacheRows;
    warmCacheAt = now;
    try {
      warmCacheRows = loadWarmRows();
    } catch (err) {
      logger.warn(`[spirit] 暖记忆取料失败，本轮不带：${err instanceof Error ? err.message : String(err)}`);
      warmCacheRows = { rows: [], items: [] };
    }
    return warmCacheRows;
  };
  // v0.8 模型可写记忆（两本账+日记）与目的层
  const modelMemory = new ModelMemoryStore({ db: () => db, logger });
  const goals = new GoalStore({ db: () => db, logger });
  const modes = new SessionModeStore({ dataDir, logger });
  // 启动挡位：滑块控制新会话默认 off 状态（而非系统级 enabled）。
  void applyBootMode(config.live, modes);
  const store = new ExperienceStore({ db, logger });
  // v0.2 两张新面：未竟账（append-only 真源）与条件化（派生缓存，定性见 store/bias.ts）
  const ledger = new LedgerStore({ db, logger });
  const bias = new BiasStore({ db, logger });
  const watcher = new TurnWatcher({
    // 用 getter 而不是快照值：阈值可在设置页热更，构造期定值会让人以为改了不生效
    get gapThresholdMs() {
      return cfg().capture.gapThresholdMs;
    },
  });

  /**
   * 宿主 webServer 端口（面板路由挂载时回填）。DRSC 缺省基址靠它：collector 的 API
   * 与面板同源同端口，而 `dsh web` 端口是挑的（真宿主本次在 3080）。
   */
  let webPort: number | undefined;
  const client = config.drsc.enabled
    ? new DrscClient({
        baseUrl: config.drsc.baseUrl,
        timeoutMs: config.drsc.timeoutMs,
        trustedHosts: () => readTrustedHosts(ctx),
        localPort: () => webPort,
      })
    : undefined;
  const probe = client
    ? new DrscProbe({ client, enabled: () => cfg().drsc.enabled && live().drscEnabled, ttlMs: () => cfg().drsc.probeCacheTtlMs })
    : undefined;

  // 主人背景档案（v0.3.2）：DB 权威 + prime-memory 同步。基址跟 webPort 同源（真宿主实测：
  // 端口是挑的）；prime 未装 ⇒ 探测失败 ⇒ 同步跳过，功能整体休眠不报错。
  const ownerStore = new OwnerProfileStore({ dataDir, logger, db });
  const primeClient = new PrimeClient({
    baseUrl: config.owner.baseUrl,
    trustedHosts: () => readTrustedHosts(ctx),
    localPort: () => webPort,
  });
  const ownerSync = new OwnerSyncService({ client: primeClient, store: ownerStore, cfg: eff, logger });

  // 做梦（v0.3.3）：确定性本地整理 pass，零模型零 DRSC 依赖；db 取用现走闭包（降级面每轮现判）
  const dream = new DreamRunner({ store, db: () => db, dataDir, cfg: eff, logger });

  // 长觉阶梯（v0.3.5）：派生层三 store + 异步归纳 Runner。llm 通道是域注入晚到的（slot 可变），
  // 缺席时 runner 自带 supported:false 降级信封——长觉整条休眠不报错（照 owner/prime 先例）。
  const topics = new TopicStore({ db: () => db, logger });
  const insights = new InsightStore({ db: () => db, logger });
  const edges = new EdgeStore({ db: () => db, logger });
  let llmChannel: LlmChannel | undefined;
  /** 宿主 llm 运行时引用（供面板枚举供应商/模型；与 llmChannel 分开，stream 缺席时枚举面仍可用）。 */
  let llmRuntime: LlmRuntimeLike | undefined;
  /**
   * 宿主 settings 服务引用（域注入晚到，v0.13.2）：桌面宿主只给 volatile ref 的 `.get()`，
   * 配置写回走这里的 `settings.mutate`。缺席时 settingsWrite 返回 ok:false，rpc 如实报错。
   * 不进顶层 inject——没这服务的宿主线（tui/headless）不能因此挂死。
   */
  let settingsSvc: SettingsServiceLike | undefined;
  /**
   * 真实 entry id —— 宿主 describe() 的 ns 与 mutate 都按 `entry.options.id` 精确匹配。
   * 优先取运行时 fiber 上的 id（loader 可能改过 namespace），再退编译期 entry id，
   * 最后才退 cordis 插件名（老宿主线兼容）。发布后常量不可改，只读不写。
   */
  const entryIdOf = (): string => resolveEntryId(
    (ctx as unknown as { fiber?: { entry?: { options?: { id?: unknown } } } }).fiber?.entry?.options?.id,
    SPIRIT_ENTRY_ID,
    SPIRIT_PLUGIN_NAME,
  );
  const attachSettings = (scope: Context): void => {
    const svc = scope.get?.('settings') as SettingsServiceLike | undefined;
    if (svc !== undefined && typeof svc.mutate === 'function' && typeof svc.describe === 'function') settingsSvc = svc;
  };
  ;(ctx as unknown as { inject?: (deps: string[], cb: (scope: Context) => void) => void }).inject?.(['settings'], attachSettings);
  // 服务晚到/换实例时补取（照 prime-memory 的 internal/service 重挂先例）。
  ctx.on('internal/service', (name: string) => { if (name === 'settings') attachSettings(ctx); });
  (ctx.on as unknown as (ev: string, cb: (paths: unknown) => void) => void)('loader/volatile-update', (paths: unknown) => {
    ctx.logger.debug?.(`[spirit] volatile 更新 entry=${entryIdOf()} paths=${JSON.stringify(paths)}`);
  });
  const settingsWrite = async (patch: Partial<SpiritLiveSettings>): Promise<{ ok: boolean; error?: string }> =>
    writeLiveSettings({ svc: settingsSvc, entryId: entryIdOf(), patch });
  const readHostDefault = (): DistillRoute | undefined => {
    // agentDefaultModel 是可选服务，缺失时不得抛错（fail-closed 会拒蒸，不隐式猜模型）
    const svc = getService(ctx, 'agentDefaultModel') as { model?: { provider?: unknown; id?: unknown } } | undefined;
    const provider = typeof svc?.model?.provider === 'string' ? svc.model.provider : '';
    const model = typeof svc?.model?.id === 'string' ? svc.model.id : '';
    return provider !== '' && model !== '' ? { provider, model } : undefined;
  };
  /** 蒸馏默认路由：运行时覆盖（面板选的）优先于宿主默认。配合 resolveDistillRoute 的“cfg.pin > defaultModel”形成 pin>覆盖>默认 三级。 */
  const distillDefaultModel = (): DistillRoute | undefined => readRuntimeRoute(db) ?? readHostDefault();
  const sleep = new RuminateRunner({
    db: () => db,
    store,
    topics,
    insights,
    edges,
    channel: () => llmChannel,
    defaultModel: distillDefaultModel,
    cfg: eff,
    logger,
    // 事务轨混喂（Phase 4）：card_line 当归纳背景。惰性闭包——构造时 txnStore 尚未建（下一行），
    // 但只在长觉 run 时调用，届时已就绪。关轨 ⇒ 空数组（长觉照旧只吃体验条目）。
    recentTxnForPrompt: () => (eff().txn.enabled ? txnStore.listRecent(12).map((t) => t.cardLine) : []),
    // 睡眠完成后总结 L1 → 生涯流程档（v0.8.24）：长觉跑完顺手刷三档，失败不影响睡眠结果
    onComplete: () => { alignAndDigest(); },
  });
  // 事务轨（Phase 3）：与情绪轨并行的第二条线。采集是旁路（见 hooks/txn-observe.ts），跑模型只由
  // 攒批触发——绝不进 pre-step 串行链，也绝不每轮同步调用；关时整条休眠（零落库）。
  // 路由单源：txn 节没有自己的 provider/model 键，走同一条 distill 路由（照 collector 头注口径）。
  const txnStore = new TxnStore({ db: () => db, logger });
  // 本体层（Phase B）：evaluation 存储（tier1 反馈/互动）；entity/task/relation 读写随 Phase D 补。
  const ontologyStore = new OntologyStore({ db: () => db, logger });
  const ontologyWatcher = new OntologyWatcher();
  const ontologyExtractor = new OntologyExtractor({ db: () => db, txnStore, store: ontologyStore, channel: () => llmChannel, defaultModel: distillDefaultModel, cfg: eff, logger });
  // 历史重建（v0.8.24）：不再扫会话（DRSC），改读上游 L1（蒸馏激活中的记忆）重建本体/交付/实体。
  // v0.8.25：重建完顺便重算会话流程档（与定时/睡眠同一条 alignAndDigest 链）。
  const backfillRunner = new L1BackfillRunner({
    run: (dryRun) => {
      if (dryRun) return { total: 0, tasks: 0, deliveries: 0, entities: 0, links: 0, refs: 0, knowledge: 0 };
      const result = ingestL1({ db: () => db, ontology: ontologyStore, txn: txnStore, logger }, { days: 0, limit: 2000 });
      try {
        alignAndDigest();
      } catch (err) {
        logger.warn(`重建后流程档重算失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
      }
      return result;
    },
    logger,
  });
  const txnWatcher = new TransactionWatcher();
  const txnCollector = new TxnCollector({ db: () => db, store: txnStore, channel: () => llmChannel, defaultModel: distillDefaultModel, cfg: eff, logger });
  // ⚠️ 域注入不是顶层 inject：没 llm 服务的宿主线（tui/headless）上顶层声明会把整插件挂死
  ctx.inject(['llm'], (scope) => {
    const llm = scope.get('llm') as LlmRuntimeLike | undefined;
    if (llm === undefined) return;
    // 先存运行时引用：listProviders/listModels 与 stream 是不同能力，stream 缺席不该抹掉枚举面
    llmRuntime = llm;
    if (typeof llm.stream !== 'function') return;
    llmChannel = createLlmChannel({ llm: () => llm, defaultModel: readHostDefault, logger });
  });

  const stats = new SpiritStats();

  // ── dsh-tui 终端面：`/spirit` ──────────────────────────────────────────
  // TUI 不加载星海面板/pill，也调不到插件 RPC → 记忆在终端里不可见。
  // 命令层只读：experience 表计数/最近条目/LIKE 召回，不新增写入路径。
  ;(ctx as unknown as {
    inject?: (deps: string[], cb: (scope: Context) => void) => void
  }).inject?.(['commands'], (scope) => {
    // 取数一律走 ExperienceStore（listRecent / searchText / countVisible）：
    // 本体层隔离闸要求「读 experience 的文件不得也读本体表」，所以这段 SQL 住在
    // store/experience.ts，index.ts 只做映射与排版。
    const toRow = (entry: { tsMs?: number; lane?: string; trigger?: string; text?: string }) => ({
      ts_ms: entry.tsMs,
      lane: entry.lane,
      trigger: entry.trigger,
      text: String(entry.text ?? '').slice(0, 140),
    })
    registerSpiritCommand(scope, {
      status: () => {
        const latest = stats.latest()
        // 两条分支都赋值的确定性写法（不带无用的初始值）
        let ledger: number
        try {
          const row = db?.prepare('SELECT COUNT(*) AS c FROM session_ledger').get() as { c?: number } | undefined
          ledger = typeof row?.c === 'number' ? row.c : 0
        } catch { ledger = 0 }
        return {
          db: db !== null,
          entries: store.countVisible(),
          ledger,
          latest,
          session: latest === null
            ? null
            : (stats.snapshot(latest.agentId, { off: false, bypass: false }) as unknown as Record<string, unknown> | null),
        }
      },
      recent: (limit) => store.listRecent(limit).map(toRow),
      recall: (query, limit) => store.searchText(query, limit).map(toRow),
      // 本体实体与交付：读侧只投影，不写（本体层隔离闸只管 experience 同文件读写面）。
      entity: (query, limit) => {
        try {
          return (db?.prepare(
            'SELECT id, kind, name, importance, last_seen_ms FROM entity WHERE name LIKE ? ORDER BY importance DESC, last_seen_ms DESC LIMIT ?',
          ).all(`%${query}%`, limit) ?? []) as Array<{ id?: string; kind?: string; name?: string; importance?: number; last_seen_ms?: number }>
        } catch { return [] }
      },
      txn: (limit) => {
        try {
          return (db?.prepare(
            'SELECT ts_ms, summary, card_line, source_trust FROM txn_entry ORDER BY ts_ms DESC LIMIT ?',
          ).all(limit) ?? []) as Array<{ ts_ms?: number; summary?: string; card_line?: string; source_trust?: string }>
        } catch { return [] }
      },
      // 回响投影：与星海/侧栏同源的 summary()，只读。
      echo: () => {
        const latest = stats.latest()
        const sessionId = latest?.sessionId ?? store.latestSessionId()
        if (sessionId === '') return { total: 0, segments: [] as Array<[string, number]>, steps: 0 }
        try {
          const summary = echoRecall.summary(sessionId, 20, 5) as unknown as {
            total?: number
            segments?: Array<{ segment?: string; name?: string; count?: number }>
            steps?: unknown[]
          }
          const segments = (summary.segments ?? []).map((entry) => [
            String(entry.segment ?? entry.name ?? ''),
            Number(entry.count ?? 0),
          ] as [string, number])
          return { total: Number(summary.total ?? 0), segments, steps: (summary.steps ?? []).length, sessionId }
        } catch { return { total: 0, segments: [] as Array<[string, number]>, steps: 0 } }
      },
    })
  })
  const spirit = new Spirit(
    {
      cfg,
      live,
      store,
      watcher,
      modes,
      history: { store, ...(client ? { client } : {}), ...(probe ? { probe } : {}) },
      logger,
      recentEntries: (sessionId, k) => store.recent(sessionId, k),
      // 事务轨注入面（Phase 4）：关轨 ⇒ undefined（卡不带事务段、指纹不变，零副作用）；
      // 开轨只读最近一条 card_line（绝不读 summary——那是衍生物，禁入注入）。
      // 交付卡行改用规则打分选优（v0.7）：同档内“更有分量”的交付胜最新一条；窗口 12 条内取分，
      // 规则确定性可重算，不落库——同分仍以新者胜（时间序不变）。
      recentTxnCardLine: (sessionId) => {
        if (!eff().txn.enabled) return undefined;
        const window = txnStore.listRecent(12, { sessionId, excludeBackfill: true });
        return pickBest(window, { now: Date.now() })?.cardLine;
      },
      // 本体层注入读面（Phase C）：只给稳定 gist（kind+锁定交付 card_line / 活跃任务行），不含 id/ts/原文；关轨⇒undefined。
      recentFeedbackLine: (sessionId) => {
        if (!eff().ontology.enabled) return undefined;
        const e = ontologyStore.listRecentEvaluations(1, { sessionId, excludeUnresolved: true })[0];
        if (e === undefined || e.deliveryId === null) return undefined;
        const label = e.kind === 'positive' ? '认可' : e.kind === 'negative' ? '不满' : e.kind === 'directive' ? '指示' : '追问';
        const delivery = txnStore.getByIds([e.deliveryId])[0];
        return delivery !== undefined ? `${label}：${delivery.cardLine}` : label;
      },
      recentThreadLine: (workspaceId) => {
        if (!eff().ontology.enabled) return undefined;
        const active = ontologyStore.listTasks(workspaceId, { limit: 5 }).find((t) => t.status !== 'done');
        if (active === undefined) return undefined;
        const word = active.status === 'progress' ? '进行中' : active.status === 'stalled' ? '卡住' : '刚起';
        return active.nextStep !== undefined ? `${active.title} · ${word} · 下一步：${active.nextStep}` : `${active.title} · ${word}`;
      },
      // 记着/惦记（v0.8）：模型主动写的长期工作记忆（本区+全局）与目的层 open 目标
      workMemoryLine: (workspaceId) => {
        const rows = modelMemory.pinnedWork(workspaceId, 2);
        return rows.length === 0 ? undefined : rows.map((row) => row.text).join('；');
      },
      goalLine: (workspaceId) => {
        const rows = goals.openFor(workspaceId, 3);
        return rows.length === 0 ? undefined : rows.map((goal) => goal.title).join('；');
      },
      // 暖记忆（v0.11）：每轮最多一条「关于这个人」的上游记忆。
      //
      // 三条纪律在这里兑现：
      // 1. 上游没装/表不在 ⇒ undefined，卡里整段不出现（不报错、不留空壳行）；
      // 2. 只读：searchL1WarmRows 是本仓唯一的上游消费面；
      // 3. 挑选逻辑全在 prime/warm-pick.ts（白名单/安全闸/冷却/近义），这里只持有跨轮状态。
      warmLine: (_agentId, _sessionId, _workspaceId, now) => {
        if (!warmPickEnabled()) return undefined;
        const cached = warmCache(now);
        const picked = pickWarmForCard({ rows: cached.rows, items: cached.items, state: warmState, now, ...(warmState.lastAnyAt === undefined ? {} : { lastAnyAt: warmState.lastAnyAt }) });
        noteWarmRejected(picked.rejected);
        return picked.item ?? undefined;
      },
      onWarmCommitted: (_agentId, warmId, now) => {
        // 只有卡真进了会话日志才走到这里（confirmInjected），所以冷却不会被白吃
        const cached = warmCache(now);
        const hit = cached.items.find((item) => item.id === warmId);
        commitWarmInject(warmState, { id: warmId, text: hit?.text ?? '' }, now);
      },
      previousEntries: (workspaceId, sessionId, m) => store.previousSessionEntries(workspaceId, sessionId, m),
      // 刀3：新会话首轮带出一行未竟账（过期/无账/关闸 ⇒ undefined，整行不出现）
      ledgerLine: (workspaceId, excludeSessionId, now) =>
        eff().ledger.enabled ? ledgerLineText(ledger.latestFor(workspaceId, excludeSessionId, now, eff().ledger.maxAgeMs)) : undefined,
      // 刀4：pre-step 只做 O(1) 主键查表（闸由 readBias 每轮现判，半衰期在 store.read 里量化）
      biasBand: (workspaceId, actionKey, now) => bias.read(workspaceId, actionKey, now, eff().bias.halfLifeMs),
      onBiasUpsert: (workspaceId, actionKey, band, now) => bias.upsert(workspaceId, actionKey, band, now),
      onLedgerSettle: (row) => ledger.append({ id: `l-${row.sessionId}-${row.turnSeq}`, ...row }),
      onFadeStats: (agentId, fadeStats) => stats.noteFade(agentId, fadeStats),
      onConfirmed: (agentId) => stats.noteConfirmed(agentId),
    },
    personas.current(),
  );

  // DRSC 探测结论：面板要如实显示。探测本身有 TTL 缓存，不在每轮路径上打网络。
  const drscVerdict = () => (probe === undefined ? ('skipped' as const) : probe.lastVerdict());

  ctx.on('agent/created', () => {
    // 人格可能由用户在运行期改：每轮现取，不留旧 salience
    spirit.persona = personas.current();
    return undefined;
  });

  // v0.13.7 放出闸：modes 与 isSubagent 与回忆卡同源同函数（index.ts:205 已构造 modes，此处在其后，顺序安全）
  registerPersonaSection(ctx, { personas, presets: personaPresets, owner: ownerStore, eff, caps, logger, modes, isSubagent: isSubagentAgent,
    // 生涯账：pinned 的心理话/约定进人格区（全局，不按工作区分账）
    lifeMemory: () => {
      const rows = modelMemory.pinnedLife(3);
      return rows.length === 0 ? '' : `心里记着：${rows.map((row) => row.text).join('；')}`;
    } });
  registerCardObserve(ctx, { spirit, logger });
  // 事务轨：旁路观察 + 入队，不挂进 pre-step 串行链。关时根本不注册（零副作用纪律）——
  // 与"关时零落库"的灰度承诺成对：不注册 ⇒ 不采集 ⇒ 不入队 ⇒ countAll() 恒为 0。
  if (config.txn.enabled) registerTxnObserve(ctx, { watcher: txnWatcher, collector: txnCollector, cfg: eff, logger });
  // 本体层反馈捕获（tier1）：旁路、不跑 LLM、确定性。关时根本不注册（零副作用纪律）——
  // 不注册 ⇒ 不落 evaluation ⇒ countEvaluations() 恒 0。
  if (config.ontology.enabled) registerOntologyObserve(ctx, { store: ontologyStore, txnStore, watcher: ontologyWatcher, extractor: ontologyExtractor, cfg: eff, logger, resolveWorkspace: (sessionId, candidate) => resolveWorkspaceId(db, sessionId, candidate) });
  // 自称工具（v0.3.4）：模型可自己增删自称列表（人设面唯一对模型开放的写字段）；
  // 部署总闸关 ⇒ 根本不注册（关闸时模型看不见这个工具，零副作用纪律）。
  if (config.enabled) registerSelfNameTool(ctx, { personas, logger });
  // v0.8 模型可写记忆工具（两本账+日记）与目的层工具：部署总闸关 ⇒ 不注册（零副作用纪律）
  if (config.enabled) registerMemoryTools(ctx, { memory: modelMemory, goals, logger, digests: () => readDigests(db, { milestoneLimit: 3 }) });
  registerSpiritRpc(ctx, {
    spirit,
    stats,
    store,
    modes,
    personas,
    presets: personaPresets,
    echo: echoLog,
    // 条目化 + 时间反查（v0.8.6）：切段后按真源表回查条目时刻（降级面全标 unknown）
    echoEntries: ({ sessionId, text, at }) => resolveEntryTimes(db, sessionId, splitEchoEntries(text), at),
    echoRefs,
    // 读面取号（v0.8.11）：星图点/翻阅行都要带 "记录时间 + echo id"
    echoIdOf: (kind: string, memId: string) => resolveEchoId(db, kind, memId),
    // 按 echo 号定位（v0.8.12）：注册表找身份 → echo_ref 补标题/记录时间/最近回响号（跨会话取最新）
    echoLocate: (q: string) => {
      if (db === null || echoQueryPrefix(q) === undefined) return { idQuery: false, hits: [] };
      // 星点可达性（v0.8.15）：交付/体验自身就是星点；任务线→取它的交付点；记着/目的/实体无星点。
      const starEchoIdsOf = (kind: string, memId: string, echoId: string): string[] => {
        if (kind === 'delivery' || kind === 'experience') return [echoId];
        if (kind === 'task') {
          try {
            return ontologyStore
              .listDeliveriesByTask(memId)
              .slice(0, 5)
              .map((id) => resolveEchoId(db, 'delivery', id))
              .filter((value): value is string => typeof value === 'string');
          } catch {
            return [];
          }
        }
        return [];
      };
      const hits = findEchoIdentities(db, q).map((hit) => {
        const ref = db!
          .prepare(`SELECT session_id, title, record_ts, last_echo_step_id FROM echo_ref WHERE ref_id = ? ORDER BY last_ts DESC LIMIT 1`)
          .get(hit.echoId) as { session_id?: string; title?: string; record_ts?: number; last_echo_step_id?: string } | undefined;
        return {
          echoId: hit.echoId,
          kind: hit.kind,
          memId: hit.memId,
          title: ref?.title !== undefined && ref.title !== '' ? ref.title : hit.memId,
          recordTs: Number(ref?.record_ts ?? 0) || 0,
          sessionId: ref?.session_id ?? '',
          lastRecallId: ref?.last_echo_step_id ?? '',
          starEchoIds: starEchoIdsOf(hit.kind, hit.memId, hit.echoId),
        };
      });
      return { idQuery: true, hits };
    },
    // 全域搜索（v0.8.14）：任务/交付/体验/记着/目的/实体一起搜，不让类型挡住命中
    searchAll: (q: string, limit: number) => searchAll(db, q, limit),
    // 记录详情（v0.8.17）：体验轨与本体轨分开读，继续守 TA.6(b)
    recordDetail: (kind: string, id: string) =>
      (kind === 'experience' ? loadExperienceDetail(db, id) : loadRecordDetail(db, kind as 'task' | 'delivery' | 'memory' | 'goal' | 'entity', id)),
    echoRecall,
    memory: modelMemory,
    distillDigest: () => readDigests(db, { milestoneLimit: 5, tiers: ['session', 'week', 'month', 'milestone'], sessionLimit: 10 }),
    entityNamesOf: (ids: string[]) => {
      if (db === null || ids.length === 0) return [];
      try {
        const get = db.prepare(`SELECT name FROM entity WHERE id = ?`);
        return ids.map((id) => (get.get(id) as { name?: string } | undefined)?.name ?? '').filter((name) => name !== '');
      } catch {
        return [];
      }
    },
    entityDigest: (entity: string, limit?: number) => {
      const entityId = resolveEntityId(db, entity);
      const rows = readDigests(db, { milestoneLimit: limit ?? 5 });
      // 严格按实体过滤：未对齐 ⇒ 空（不拿“全部档”冒充该实体）
      const digests = entityId === undefined
        ? []
        : rows
          .filter((row) => (row.entities ?? []).includes(entityId))
          .map((row) => ({
            tier: row.tier,
            periodKey: row.periodKey,
            generatedAt: row.generatedAt,
            count: row.count,
            lines: row.summary.split('\n').filter((line) => line.trim() !== ''),
          }));
      let knowledgeRefs = 0;
      if (entityId !== undefined) {
        try {
          const hit = db?.prepare(`SELECT COUNT(*) AS c FROM entity_record_ref WHERE entity_id = ?`).get(entityId) as { c?: number } | undefined;
          knowledgeRefs = Number(hit?.c ?? 0);
        } catch {
          knowledgeRefs = 0;
        }
      }
      return { entity, ...(entityId === undefined ? {} : { entityId }), digests, knowledgeRefs };
    },
    runDistillDigest: () => alignAndDigest(),
    // 编年暖通路（v0.10）：上游 L1 取料 → 温度（priority + 自身引用计数）。
    //
    // 三条纪律都在这里兑现：
    // 1. 上游没装/表不在 ⇒ 空数组，编年只剩自家那三路（不报错、不假装）；
    // 2. 只读，不写上游、不缓存正文（真源永远在上游）；
    // 3. 走 l1-source 这个唯一消费面，路径/schema 字样不扩散到第二个文件（门禁 7.3）。
    learnedSource: ({ days, limit }) => {
      // 被想起次数：从自己的 echo_ref 取（不是上游的召回账——那是它的账，拿来当"我记得"就是第二真源）
      const recallHits = new Map<string, number>();
      if (db !== null) {
        try {
          for (const row of echoRefs.list({ limit: 200, order: 'recall' }).rows) {
            recallHits.set(row.memId, row.times);
          }
        } catch {
          /* 引用表读不到 ⇒ 温度只是少了"热"这一项，不阻断编年 */
        }
      }
      const rows = searchL1WarmRows({ days, limit });
      return toWarmItems(rows, {
        now: Date.now(),
        recallHitsOf: (l1Id) => recallHits.get(`l1-dlv:${l1Id}`) ?? recallHits.get(`l1-task:${l1Id}`) ?? 0,
      }).map((item) => ({
        kind: item.kind === 'bond' ? 'bond' as const : 'learned' as const,
        id: item.id,
        tsMs: item.tsMs,
        text: item.text,
        warmth: item.tier,
        ...(item.expired ? { expired: true } : {}),
        ...(item.recallHits > 0 ? { recalled: item.recallHits } : {}),
      }));
    },
    goals,
    dataDir,
    cfg,
    eff,
    drscVerdict,
    owner: { store: ownerStore, sync: ownerSync },
    dream,
    ladder: { sleep, topics, insights, edges },
    // 事务轨查询面（Phase 5）：只读 store，始终注入（关轨时表为空 ⇒ 返回空数组，非 unavailable）。
    txn: txnStore,
    // 本体层查询面（Phase D）：evaluation-list 只读；始终注入（关时表空⇒空数组）。
    ontology: ontologyStore,
    // 历史回填触发面（Phase E）：ontology-backfill-run 用；始终注入（闸在 runner 内现判）。
    backfill: backfillRunner,
    // 长觉模型选择面（面板切蒸馏模型）：三级路由 + 宿主枚举。db 每轮现读（降级面每轮现判）。
    distillRoute: {
      deployPin: () => {
        const p = eff().distill.provider.trim();
        const m = eff().distill.model.trim();
        return p !== '' && m !== '' ? { provider: p, model: m } : null;
      },
      runtimeOverride: () => readRuntimeRoute(db) ?? null,
      hostDefault: () => readHostDefault() ?? null,
      setRuntimeOverride: (route) => writeRuntimeRoute(db, route),
      providers: () => (typeof llmRuntime?.listProviders === 'function' ? llmRuntime.listProviders() : []),
      models: async (provider) => {
        if (typeof llmRuntime?.listModels !== 'function') return [];
        const lm = llmRuntime.listModels.bind(llmRuntime);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const list = await Promise.race([
            lm(provider),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('模型列表查询超时')), 8_000);
            }),
          ]);
          return list.map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id }));
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
      enumerationSupported: () => typeof llmRuntime?.listProviders === 'function' || typeof llmRuntime?.listModels === 'function',
    },
    logger,
    // config.live 就是 volatile ref（带 .get()，新宿主还带 .update()）；原样递出去，不预先解包
    liveRaw: () => config.live as unknown as { get(): SpiritLiveSettings; update?: (patch: Partial<SpiritLiveSettings>) => unknown },
    // 兜底写腿（v0.13.2）：宿主 volatile ref 无 .update() 时经 settings.mutate 落盘
    settingsWrite,
    onWebServerReady: (port) => {
      webPort = port;
    },
  });
  // 回响服务端投影（v0.8.1 / v0.8.2 换源）：侧栏「回响」页签的读面。
  // 读 v10 落档表（echo_recall / echo_step），所以重启后仍在；state 只带 {sessionId, token}。
  registerEchoProjection(ctx, echoRecall, echoRefs);
  registerCardPreStep(ctx, {
    spirit,
    logger,
    ownerOf: (agent) => ownerSessionIdOfAgent(agent) || String((agent as { id?: unknown }).id ?? ''),
    isSubagent: isSubagentAgent,
    sessionIdOf: (agent) => sessionIdOfSession((agent as { session?: unknown }).session) || String((agent as { id?: unknown }).id ?? ''),
    workspaceIdOf: workspaceIdOfAgent,
    isAborted: (payload) => (payload as { signal?: { aborted?: boolean } }).signal?.aborted === true,
    afterOutcome: (input, outcome) => {
      const diag = spirit.diagOf(input.agentId);
      // 段数与判定取自同一次探测结果（一次取值）：分两次调用可能落到不同缓存轮次，
      // 面板就会出现「可用 · 12 段」而判定其实是上一轮的。
      const segments = probe?.lastSegments();
      stats.note({
        agentId: input.agentId,
        sessionId: input.sessionId,
        now: input.now,
        outcome,
        recallHits: diag.recallHits,
        entryCount: diag.entryCount,
        mood: diag.mood,
        drscVerdict: drscVerdict(),
        ...(segments === undefined ? {} : { drscSegments: segments }),
        degraded: !store.persistent,
        ...(diag.tendency !== undefined ? { tendency: diag.tendency } : {}),
      });
      // 回响面（v0.7）：注入/跳过都留一条快照——"这轮为什么没卡"正是最难查的那类
      if (outcome.kind === 'injected') {
        echoLog.record({ at: input.now, agentId: input.agentId, sessionId: input.sessionId, workspaceId: input.workspaceId, kind: 'injected', fingerprint: outcome.fingerprint, text: outcome.text });
      } else {
        echoLog.record({ at: input.now, agentId: input.agentId, sessionId: input.sessionId, workspaceId: input.workspaceId, kind: 'skipped', reason: String(outcome.reason) });
      }
      // 回响落档（v10 / v14）：与上面同一处写，避免两条写路径各自算账；失败只 warn，不影响注入。
      // 注入轮额外算一遍条目（时间 + memid 引用）——标题内容优先，侧栏不再拿 `echo-<ts>` 当条目名。
      const echoEntries = outcome.kind === 'injected' ? resolveEntryTimes(db, input.sessionId, splitEchoEntries(outcome.text), input.now) : [];
      // 回响事件号（v16）：一轮注入一个 recall-<uuid>；命中旧记录（>7d）打 flashback 标。
      const recallId = newRecallId();
      const oldestRefTs = echoEntries
        .filter((entry) => entry.ref !== undefined)
        .map((entry) => entry.ts ?? 0)
        .filter((ts) => ts > 0)
        .sort((a, b) => a - b)[0];
      const flashback = isFlashback(oldestRefTs, input.now);
      echoRecall.record({
        sessionId: input.sessionId,
        agentId: input.agentId,
        at: input.now,
        id: recallId,
        kind: outcome.kind === 'injected' ? 'injected' : 'skipped',
        reason: String(outcome.reason),
        flashback,
        ...(outcome.kind === 'injected'
          ? {
              fingerprint: outcome.fingerprint,
              segments: parseEchoSegments(outcome.text),
              excerpts: outcome.recalled ?? [],
              // 侧栏列表只要一行（兼容旧数据）：挑分段行连成一句（剔除 <system-reminder> 壳子）。
              preview: previewOfEcho(outcome.text),
              // 内容优先标题（v0.8.7）：线程任务名 > 反馈 > 交付句 > …；找不到才空串（读侧退到 preview）。
              title: titleOfEntries(echoEntries),
              // memid 引用：每条回响挂回具体记忆条目（任务/交付/体验/记忆/目标），供侧栏/星图定位。
              refs: echoEntries.flatMap((entry) => (entry.ref === undefined ? [] : [entry.ref])),
              // 查看原文用：整张卡落库（侧栏只显示 title，全文由 echo-detail 按编号取）。
              text: outcome.text,
              // P0：负样本落档（纯观测列）
              rejected: outcome.rejected ?? [],
            }
          : {}),
      });
      // 回响记录（v16）：只收**记忆类且有 ref** 的条目——语气/状态不产生记录行；
      // echo 号由 identity 注册表领（一记录一号，跨会话稳定）；lastRecallId 指本轮事件。
      if (outcome.kind === 'injected') {
        for (const entry of echoEntries) {
          if (entry.ref === undefined) continue;
          const echoId = resolveEchoId(db, entry.ref.kind, entry.ref.id);
          if (echoId === undefined) continue;
          echoRefs.upsert({
            sessionId: input.sessionId,
            echoId,
            kind: entry.ref.kind,
            memId: entry.ref.id,
            title: titleOfEntries([entry]),
            at: input.now,
            recordTs: entry.ts ?? input.now,
            lastRecallId: recallId,
          });
        }
      }
    },
  });

  // 回响原文回填（v0.8.3）：v12 之前落的行只有摘要没原文，原文还在 DRSC 会话日志里。
  // 启动后错峰跑一次（近 7 天），补完就不再跑；扫描/库缺席 ⇒ 直接休眠，不影响启动。
  const runEchoTextBackfill = (): void => {
    const timer = setTimeout(() => {
      void backfillEchoText({
        store: echoRecall,
        scan: () => (client === undefined ? undefined : { sessionAll: (sessionId) => client.sessionAll(sessionId) }),
        logger,
      }).catch((err: unknown) => {
        logger.warn(`回响原文回填失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
      });
    }, 8_000);
    // 不把进程/preview 挂住：回填只是锦上添花，随时可以没跑完就被关掉。
    (timer as { unref?: () => void }).unref?.();
  };
  runEchoTextBackfill();

  // 回响引用回填（v0.8.8）：历史 echo_step 有原文的轮次解析成引用行（水位幂等，只跑一次）。
  // 排在正文回填之后：正文回填会把 v11 的行补上 text，引用回填才能解析到条目。
  const runEchoRefsBackfill = (): void => {
    const timer = setTimeout(() => {
      try {
        const result = backfillEchoRefs({
          db: () => db ?? undefined,
          refs: echoRefs,
          resolve: (sessionId, text, at) => resolveEntryTimes(db, sessionId, splitEchoEntries(text), at),
          logger,
        });
        if (!result.skipped) logger.info(`回响记录回填：会话 ${result.sessions} · 轮次 ${result.steps} · 记录 ${result.records}`);
      } catch (err) {
        logger.warn(`回响引用回填失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
      }
    }, 20_000);
    (timer as { unref?: () => void }).unref?.();
  };
  runEchoRefsBackfill();

  // 生涯流程预总结（v0.8.18）：启动后错峰一次（读上游 L1 的流程性记录 → 三档落 spirit 库）。
  // 知识性归上游：这里只取 work_task/episodic，知识行只建 entity_record_ref（不存正文）。
  const alignAndDigest = (): { week: number; month: number; milestones: number; weekCount: number; knowledgeCount: number; entities: number; links: number; sessions: number; merged: number } => {
    // v0.8.25：先按会话重组流程档（会话内 + 跨会话去重），week/month 再基于会话档聚合。
    const session = buildSessionDigests(db, { days: 0, limit: 2000 });
    const build = buildDigests(db, (opts) => summarizeProcedural(opts), {
      summarizeSessions: (opts) => summarizeSessionDigests(db, opts),
    });
    const aliases = buildEntityAliases(db);
    const align = buildEntityLinks(db, loadL1Entities());
    const refs = linkKnowledgeRecords(db, searchL1Records({ days: 30, limit: 200 }));
    return {
      week: build.week === undefined ? 0 : 1,
      month: build.month === undefined ? 0 : 1,
      milestones: build.milestones,
      weekCount: build.weekCount,
      knowledgeCount: build.knowledgeCount,
      entities: aliases,
      links: align.links + refs,
      sessions: session.sessions,
      merged: session.merged,
    };
  };
  const runProceduralDigest = (): void => {
    const timer = setTimeout(() => {
      try {
        const result = alignAndDigest();
        if (result.weekCount > 0 || result.milestones > 0) {
          logger.info(`生涯流程档：会话 ${result.sessions}（合并重复 ${result.merged}）· week ${result.weekCount} 条 · 里程碑新增 ${result.milestones} · 知识性 ${result.knowledgeCount} 条归上游 · 对齐 alias ${result.entities}/link ${result.links}`);
        }
      } catch (err) {
        logger.warn(`生涯流程预总结失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
      }
    }, 25_000);
    (timer as { unref?: () => void }).unref?.();
  };
  runProceduralDigest();

  // 每日重算（v0.8.18）：流程档滚动窗口需要每天推进；失败只告警不阻断。
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        const result = alignAndDigest();
        if (result.weekCount > 0) logger.info(`生涯流程档（日更）：week ${result.weekCount} · 里程碑新增 ${result.milestones}`);
      } catch (err) {
        logger.warn(`生涯流程档日更失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
      }
    }, 24 * 60 * 60 * 1000);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  });

  ctx.on('agent/disposed', (payload) => {
    const id = (payload as { agent?: { id?: unknown } }).agent?.id;
    if (typeof id === 'string') stats.release(id);
    return undefined;
  });

  /**
   * 低频同步定时器（缺省日级）：首跑带 0–10min 抖动防整点风暴，周期每轮现读配置。
   * handler 不 await 会话链路（同步是后台冷路径）；disposer 挂 fiber，热重载不留旧定时器。
   */
  ctx.effect(() => {
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const kickoff = setTimeout(() => {
      if (stopped) return;
      void ownerSync.sync();
      interval = setInterval(() => void ownerSync.sync(), eff().owner.syncIntervalMs);
    }, Math.floor(Math.random() * 600_000));
    return () => {
      stopped = true;
      clearTimeout(kickoff);
      if (interval !== undefined) clearInterval(interval);
    };
  });

  /**
   * 做梦定时器（v0.3.3，缺省日级）：owner 同款骨架——抖动 kick + 周期现读 eff() + disposer。
   * enabled=false 整条不挂（零副作用纪律）；kick/interval 回调内每轮现读 eff().dream.enabled
   * ——live 热更闸翻转不需要重挂 effect（关闸后空转，开闸后恢复）；去重窗在 DreamRunner 内部。
   */
  ctx.effect(() => {
    if (!eff().dream.enabled) return () => undefined;
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const kickoff = setTimeout(() => {
      if (stopped) return;
      dream.run();
      interval = setInterval(() => {
        dream.run();
      }, eff().dream.intervalMs);
    }, Math.floor(Math.random() * 600_000));
    return () => {
      stopped = true;
      clearTimeout(kickoff);
      if (interval !== undefined) clearInterval(interval);
    };
  });

  /**
   * 主题骨架启动回填（v0.3.5，零模型确定性动作）：cues×trigger 聚桶即时可分区，
   * 长觉关着也有主题（降级人格不破）。冷路径：延迟几秒跑，不卡 boot；幂等（assign 同题 no-op）。
   */
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
        const recent = store.listRecent(500);
        topics.heuristicBackfill(recent.map((entry) => ({ id: entry.id, trigger: entry.trigger, cues: store.cuesFor([entry.id]).get(entry.id) ?? [] })), Date.now());
        edges.backfillHeuristic(heuristicEdges(recent), Date.now());
      } catch (err) {
        logger.warn(`[spirit] 主题骨架回填失败（不影响记录与注入）：${err instanceof Error ? err.message : String(err)}`);
      }
    }, 5_000);
    return () => clearTimeout(timer);
  });

  /**
   * 长觉定时器（v0.3.5，缺省 6h）：同款骨架——抖动 kick + 周期现读 + disposer。
   * enabled（双闸后视图）关 ⇒ 整条不挂；run() 自身还有去重窗/退避/unsupported 多重闸。
   */
  ctx.effect(() => {
    if (!eff().distill.enabled) return () => undefined;
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const kickoff = setTimeout(() => {
      if (stopped) return;
      sleep.run();
      interval = setInterval(() => {
        sleep.run();
      }, eff().distill.intervalMs);
    }, Math.floor(Math.random() * 600_000));
    return () => {
      stopped = true;
      clearTimeout(kickoff);
      if (interval !== undefined) clearInterval(interval);
    };
  });

  logger.info(
    `[spirit] 已装载 entry=${SPIRIT_ENTRY_ID} 存储=${db ? 'sqlite' : '内存降级'} 历史路=${client ? '开（待探测）' : '关'} section=${caps.systemPromptSection ? '可用' : '不可用'}`,
  );
}

