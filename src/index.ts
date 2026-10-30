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
import { probeCapabilities, readTrustedHosts } from './capability.js';
import { openSpiritDb } from './db/open.js';
import { decideDegrade } from './db/degrade.js';
import { ExperienceStore } from './store/experience.js';
import { PersonaStore } from './persona/store.js';
import { SessionModeStore } from './store/session-modes.js';
import { TurnWatcher } from './experience/watcher.js';
import { DrscClient } from './drsc/client.js';
import { DrscProbe } from './drsc/probe.js';
import { Spirit } from './spirit.js';
import { registerPersonaSection } from './hooks/persona-section.js';
import { registerCardPreStep } from './hooks/card-pre-step.js';
import { registerCardObserve } from './hooks/card-observe.js';
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

  const personas = new PersonaStore({ dataDir, logger });
  const modes = new SessionModeStore({ dataDir, logger });
  const store = new ExperienceStore({ db, logger });
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
      previousEntries: (workspaceId, sessionId, m) => store.previousSessionEntries(workspaceId, sessionId, m),
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

  registerPersonaSection(ctx, { personas, eff, caps, logger });
  registerCardObserve(ctx, { spirit, logger });
  registerSpiritRpc(ctx, { spirit, stats, store, modes, personas, dataDir, cfg, drscVerdict, logger, onWebServerReady: (port) => { webPort = port; } });
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
      stats.note({
        agentId: input.agentId,
        sessionId: input.sessionId,
        now: input.now,
        outcome,
        recallHits: diag.recallHits,
        entryCount: diag.entryCount,
        mood: diag.mood,
        drscVerdict: drscVerdict(),
        degraded: !store.persistent,
      });
    },
  });

  ctx.on('agent/disposed', (payload) => {
    const id = (payload as { agent?: { id?: unknown } }).agent?.id;
    if (typeof id === 'string') stats.release(id);
    return undefined;
  });

  logger.info(
    `[spirit] 已装载 entry=${SPIRIT_ENTRY_ID} 存储=${db ? 'sqlite' : '内存降级'} 历史路=${client ? '开（待探测）' : '关'} section=${caps.systemPromptSection ? '可用' : '不可用'}`,
  );
}
