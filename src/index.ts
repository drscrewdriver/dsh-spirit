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
import { effectiveCfg, readLiveRef, resolveDataDir, spiritSchema, type ConfigSchema } from './config.js';
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
import { BackfillRunner, type BackfillScan } from './ontology/backfill.js';
import { resolveWorkspaceId } from './ontology/workspace.js';
import { TransactionWatcher } from './transaction/watcher.js';
import { TxnCollector } from './transaction/collector.js';
import { RuminateRunner } from './distill/ruminate.js';
import { createLlmChannel, type DistillRoute, type LlmChannel, type LlmRuntimeLike } from './distill/llm.js';
import { readRuntimeRoute, writeRuntimeRoute } from './distill/runtime-route.js';
import { Spirit } from './spirit.js';
import { registerPersonaSection } from './hooks/persona-section.js';
import { PersonaPresetStore } from './persona/presets.js';
import { EchoLog } from './echo-log.js';
import { pickBest } from './recall/txn-score.js';
import { ModelMemoryStore, GoalStore } from './memory/store.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerCardPreStep } from './hooks/card-pre-step.js';
import { registerCardObserve } from './hooks/card-observe.js';
import { registerTxnObserve } from './hooks/txn-observe.js';
import { registerOntologyObserve } from './hooks/ontology-observe.js';
import { registerSelfNameTool } from './tools/selfname.js';
import { registerSpiritRpc } from './rpc.js';
import { SpiritStats } from './stats.js';
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

  const personas = new PersonaStore({ dataDir, logger, db });
  // v0.7 人格预设库：文件型（激活=走 personas.save 写入；作用域覆盖=只读投影）
  const personaPresets = new PersonaPresetStore({ dataDir, logger });
  // v0.7 注入回响面：进程内环形缓冲（观测面，不落库）
  const echoLog = new EchoLog();
  // v0.8 模型可写记忆（两本账+日记）与目的层
  const modelMemory = new ModelMemoryStore({ db: () => db, logger });
  const goals = new GoalStore({ db: () => db, logger });
  const modes = new SessionModeStore({ dataDir, logger });
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
  });
  // 事务轨（Phase 3）：与情绪轨并行的第二条线。采集是旁路（见 hooks/txn-observe.ts），跑模型只由
  // 攒批触发——绝不进 pre-step 串行链，也绝不每轮同步调用；关时整条休眠（零落库）。
  // 路由单源：txn 节没有自己的 provider/model 键，走同一条 distill 路由（照 collector 头注口径）。
  const txnStore = new TxnStore({ db: () => db, logger });
  // 本体层（Phase B）：evaluation 存储（tier1 反馈/互动）；entity/task/relation 读写随 Phase D 补。
  const ontologyStore = new OntologyStore({ db: () => db, logger });
  const ontologyWatcher = new OntologyWatcher();
  const ontologyExtractor = new OntologyExtractor({ db: () => db, txnStore, store: ontologyStore, channel: () => llmChannel, defaultModel: distillDefaultModel, cfg: eff, logger });
  // 历史回填（Phase E）：扫既有会话经 DRSC API（不直读其 db）；无 DRSC ⇒ scan undefined ⇒ 回填拒。
  const backfillRunner = new BackfillRunner({
    db: () => db,
    scan: (): BackfillScan | undefined => (client === undefined ? undefined : { sessions: (offset, limit) => client.listSessions(offset, limit), sessionAll: (sessionId) => client.sessionAll(sessionId) }),
    extractor: ontologyExtractor,
    cfg: eff,
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

  registerPersonaSection(ctx, { personas, presets: personaPresets, owner: ownerStore, eff, caps, logger,
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
  if (config.enabled) registerMemoryTools(ctx, { memory: modelMemory, goals, logger });
  registerSpiritRpc(ctx, {
    spirit,
    stats,
    store,
    modes,
    personas,
    presets: personaPresets,
    echo: echoLog,
    memory: modelMemory,
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
    onWebServerReady: (port) => {
      webPort = port;
    },
  });
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
    },
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
