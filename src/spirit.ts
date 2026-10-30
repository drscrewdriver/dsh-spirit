/**
 * 编排层：把"记录 → 派生 → 注入"串成一条链，并把所有宿主相关的依赖**参数化**注入。
 *
 * 为什么单独一层（而不是把逻辑写在 `ctx.on(...)` 回调里）：这条链上有 8 道门和一个
 * "要不要重发卡"的判断，它们必须在无宿主的单测里逐条断言。写在回调里就等于
 * 只能靠真机冒烟覆盖——那类判断的错都是静默的（少发一张卡没人报错，只是角色"没入戏"）。
 *
 * 两个容易想反的点：
 * - **旁路（bypass）不旁路记录**：它只断出口。对照组必须与实验组有同一份条目库与同一档位，
 *   否则"入戏感来自卡"这个命题根本没法测。
 * - **档位没跨格就不重发**：每轮都发会让一张卡压一张卡沉进历史（老卡还在上下文里够不着），
 *   既不省钱也自相矛盾。跨格或近因内容变了才值得再发一张。
 */

import { compileTurn } from './experience/compile.js';
import type { TurnWatcher } from './experience/watcher.js';
import { previousTone } from './experience/cross-session.js';
import type { ExperienceStore } from './store/experience.js';
import { recentLines } from './recall/recent.js';
import { recallHistory, queryWorthRecall, type HistoryDeps } from './recall/history.js';
import { deriveMood, moodChanged, withRevisionBump, type MoodConfig } from './slot/derive.js';
import { renderCard } from './slot/render.js';
import type { ExperienceEntry, Mood, PersonaCard } from './types.js';
import type { SpiritConfig, SpiritLiveSettings } from './contract.js';
import { effectiveCfg } from './config.js';

/** pre-step 的宿主侧输入（由 hook 适配器填，编排层不认宿主形状）。 */
export interface PreStepInput {
  agentId: string;
  sessionId: string;
  workspaceId: string;
  /** 档位所有者（子代理沿 parentSession 上溯后的结果）。 */
  ownerId: string;
  isSubagent: boolean;
  /** 本轮新进入的用户消息文本（用于检索查询串；只取首条）。 */
  newUserText: string;
  /** 宿主本轮批准进入的原始消息数组。 */
  messageCount: number;
  /**
   * 当前模型可见表面的节点集（`session.surface.nodes`）。省略 = 拿不到 ⇒ 只做未知处理，
   * 绝不把"读不到"当"不在"（那会把一次形状不识别误判成"卡被推走了"，进而不该重发时重发）。
   */
  surfaceNodes?: ReadonlySet<unknown>;
  now: number;
}

export type PreStepOutcome =
  | { kind: 'passthrough'; reason: Gate }
  | { kind: 'recorded'; reason: Gate }
  | { kind: 'injected'; text: string; bytes: number; fingerprint: string; reason: Gate };

/** 判定链上的门（顺序固定，任一为假即零注入零副作用）。 */
export type Gate =
  | 'cfg-off'
  | 'live-off'
  | 'subagent'
  | 'session-off'
  | 'bypass'
  | 'card-off'
  | 'no-new-user'
  | 'aborted'
  | 'budget'
  | 'unchanged'
  | 'error'
  | 'injected';

export interface SpiritDeps {
  cfg: () => SpiritConfig;
  live: () => SpiritLiveSettings;
  store: ExperienceStore;
  watcher: TurnWatcher;
  modes: { isOff(sessionId: string): boolean; isBypass(sessionId: string): boolean };
  history: HistoryDeps;
  logger: { info(m: string): void; warn(m: string): void };
  /** 取本会话近因条目（注入 store 依赖以便单测替换）。 */
  recentEntries(sessionId: string, k: number): ExperienceEntry[];
  /** 取上一会话末尾条目（跨会话基调）。 */
  previousEntries(workspaceId: string, sessionId: string, m: number): ExperienceEntry[];
  /** 卡被确认生效时的回调（统计面记分子；不在这里做业务判断）。 */
  onConfirmed?(agentId: string): void;
}

interface AgentRuntime {
  mood?: Mood;
  /** **已确认生效**的卡内容指纹（宿主把它落进日志才算生效）。 */
  lastFingerprint?: string;
  /** 已生效卡行在会话日志里的 seq（用来回到表面核它还在不在）。 */
  lastCardSeq?: number;
  /** 在飞卡：messageId → 待提交指纹。未确认就写 lastFingerprint 会造成"卡没进去、但以为发过了"。 */
  pending: Map<string, string>;
  /** 本会话是否已走过一轮（决定要不要给跨会话基调）。 */
  firstTurnDone: boolean;
}

export class Spirit {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly diag = new Map<string, { entryCount: number; recallHits: number; mood: Mood | undefined; outcome: Gate }>();
  /** 本轮检索段实际命中数（供诊断面读）。 */
  private readonly lastRecall = new Map<string, number>();
  /** sessionId → agentId：压缩事件只给会话，而运行态按 agent 计。 */
  private readonly sessionToAgent = new Map<string, string>();
  private readonly deps: SpiritDeps;

  /**
   * 当前生效人格：由 index 注入（编排层不直连人格存储，方便单测替身）。
   * 它同时是记录的选择器与条目文案的语气来源。
   */
  persona: PersonaCard;

  constructor(deps: SpiritDeps, persona: PersonaCard) {
    this.deps = deps;
    this.persona = persona;
  }

  /** 档位与配置快照（含 live 覆盖）。 */
  private eff(): ReturnType<typeof effectiveCfg> {
    return effectiveCfg(this.deps.cfg(), this.deps.live());
  }

  private moodCfg(cfg: ReturnType<Spirit['eff']>): MoodConfig {
    return { halfLifeMs: cfg.recall.halfLifeMs, stepCap: cfg.tier.stepCap, staleAfterMs: cfg.tier.staleAfterMs };
  }

  /**
   * 处理一个 pre-step（对外的唯一入口）。
   *
   * 包一层是为了给统计面留一个**单点**：诊断量在这里统一取，而不是让每个 gate 分支
   * 各自记得上报（漏一个分支就是面板上永久少一类数，且不会报错）。
   * 任何异常都在内部吞掉并返回 passthrough：**一次记录失败不许变成一轮对话失败**。
   */
  async onPreStep(input: PreStepInput): Promise<PreStepOutcome> {
    const outcome = await this.runPreStep(input);
    this.diag.set(input.agentId, {
      entryCount: this.deps.store.count(input.sessionId),
      recallHits: this.lastRecall.get(input.agentId) ?? 0,
      mood: this.runtimes.get(input.agentId)?.mood,
      outcome: outcome.reason,
    });
    return outcome;
  }

  /** 面板读的每轮诊断（没跑过任何一轮 ⇒ 全零形状，不编数据）。 */
  diagOf(agentId: string): { entryCount: number; recallHits: number; mood: Mood | undefined; outcome: Gate } {
    return this.diag.get(agentId) ?? { entryCount: 0, recallHits: 0, mood: undefined, outcome: 'no-new-user' };
  }

  private async runPreStep(input: PreStepInput): Promise<PreStepOutcome> {
    const cfg = this.eff();
    try {
      // ── 门 1/2：部署上限与主闸 ──
      if (!cfg.enabled) return { kind: 'passthrough', reason: 'cfg-off' };
      if (!cfg.live.enabled) return { kind: 'passthrough', reason: 'live-off' };
      // ── 门 3：子代理不注入（人格传染 + 档位还要上溯，收益不明） ──
      if (input.isSubagent) return { kind: 'passthrough', reason: 'subagent' };
      // ── 门 4/5：会话级 off 与旁路（off 优先于 bypass） ──
      if (this.deps.modes.isOff(input.ownerId)) return { kind: 'passthrough', reason: 'session-off' };
      // 旁路两个入口：全局开关（live.bypass，面板与评测用）与会话级覆盖。**两个都得读**：
      // 只读会话级会让设置页那个全局开关成为装饰品（改了不生效，最难查的一类报告）。
      const bypass = cfg.live.bypass || this.deps.modes.isBypass(input.ownerId);
      // 卡总闸：关了就与旁路同处理（照常记录与派生，不出卡）
      if (!cfg.live.cardEnabled) {
        this.recordOnce(input);
        this.runtimes.set(input.agentId, { ...(this.runtimes.get(input.agentId) ?? { pending: new Map<string, string>(), firstTurnDone: false }), firstTurnDone: true });
        return { kind: 'recorded', reason: 'card-off' };
      }
      // ── 门 6：本轮必须有新的用户来源消息（纯工具步不打扰） ──
      if (input.messageCount === 0) return { kind: 'passthrough', reason: 'no-new-user' };

      const runtime: AgentRuntime = this.runtimes.get(input.agentId) ?? { pending: new Map<string, string>(), firstTurnDone: false };
      this.sessionToAgent.set(input.sessionId, input.agentId);
      // 事件会漏（压缩不发事件的那条线是真存在的），所以每轮先对一次表面：
      // 已生效的卡行不在模型可见集里 ⇒ 凭据作废，否则 `unchanged` 门会"永久静默"。
      if (
        runtime.lastCardSeq !== undefined
        && input.surfaceNodes !== undefined
        && !input.surfaceNodes.has(runtime.lastCardSeq)
      ) {
        this.deps.logger.info('[spirit] 卡行已不在模型可见表面上（压缩或改写所致），下轮会重发');
        runtime.lastCardSeq = undefined;
        runtime.lastFingerprint = undefined;
      }
      const signals = this.deps.watcher.takeSignals(input.sessionId, input.now);
      this.record(signals, input, runtime);
      if (bypass) {
        // 旁路：记录与派生都做，只是不出卡——这是归因实验的对照组
        this.runtimes.set(input.agentId, { ...runtime, pending: runtime.pending, firstTurnDone: true });
        return { kind: 'recorded', reason: 'bypass' };
      }

      // ── 派生档位（只吃条目，不吃信号） ──
      const recentK = Math.max(0, Math.floor(cfg.card.recentK));
      const entries = this.deps.recentEntries(input.sessionId, Math.max(recentK + 2, 4));
      const derived = deriveMood(runtime.mood, entries, input.now, this.moodCfg(cfg));
      const mood = withRevisionBump(runtime.mood, derived);
      const changed = moodChanged(runtime.mood, mood);

      // ── 重发判据：档位没动且近因内容没动 ⇒ 沿用上一张 ──
      const recentTexts = recentLines(entries, { now: input.now, halfLifeMs: cfg.recall.halfLifeMs, limit: recentK });
      const fingerprint = `${mood.revision}|${recentTexts.join('#')}`;
      if (!changed && fingerprint === runtime.lastFingerprint) {
        this.runtimes.set(input.agentId, { ...runtime, mood, firstTurnDone: true });
        return { kind: 'passthrough', reason: 'unchanged' };
      }
      // ── 历史路（有预算与超时，拿不到就整段省略） ──
      let recalled: string[] = [];
      if (cfg.recall.maxResults > 0 && queryWorthRecall(input.newUserText)) {
        const result = await recallHistory(
          this.deps.history,
          {
            query: input.newUserText,
            sessionId: undefined, // 检索跨会话，近因段已覆盖本会话
            limit: cfg.recall.maxResults,
            maxCharsPerEntry: cfg.recall.maxCharsPerEntry,
            timeoutMs: cfg.recall.timeoutMs,
            now: input.now,
            exclude: new Set(recentTexts),
          },
        );
        recalled = result.excerpts;
        this.lastRecall.set(input.agentId, result.excerpts.length);
      } else {
        this.lastRecall.set(input.agentId, 0);
      }

      const tone =
        runtime.firstTurnDone || cfg.card.crossSessionM <= 0
          ? undefined
          : previousTone(this.deps.previousEntries(input.workspaceId, input.sessionId, cfg.card.crossSessionM), {
              maxChars: cfg.recall.maxCharsPerEntry,
            });

      const card = renderCard({
        mood,
        recent: recentTexts,
        recalled,
        ...(tone !== undefined && tone !== '' ? { tone } : {}),
        maxBytes: cfg.card.maxBytes,
        maxCharsPerEntry: cfg.recall.maxCharsPerEntry,
      });
      if (card.text === '') {
        this.runtimes.set(input.agentId, { ...runtime, mood, firstTurnDone: true });
        return { kind: 'passthrough', reason: 'budget' };
      }
      this.runtimes.set(input.agentId, { ...runtime, mood, firstTurnDone: true });
      // 指纹**不在此提交**：等宿主把这行落进会话日志（card-observe 观察到同 id 行）才算生效。
      // 现在写 fingerprint 的后果：本轮被取消/覆盖时卡没进上下文，但下轮"以为发过了"不重发。
      return { kind: 'injected', text: card.text, bytes: card.bytes, fingerprint, reason: 'injected' };
    } catch (err) {
      this.deps.logger.warn(`[spirit] pre-step 异常，本轮不注入：${err instanceof Error ? err.message : String(err)}`);
      return { kind: 'passthrough', reason: 'error' };
    }
  }

  /** 卡片总闸关掉时仍要记一轮（与旁路同语义：留数据、断出口）。 */
  private recordOnce(input: PreStepInput): void {
    const signals = this.deps.watcher.takeSignals(input.sessionId, input.now);
    this.record(signals, input, { pending: new Map<string, string>(), firstTurnDone: true });
  }

  /** 编译并落一条体验条目（不记则静默跳过；表缺格等异常走 warn）。 */
  private record(
    signals: ReturnType<SpiritDeps['watcher']['takeSignals']>,
    input: PreStepInput,
    runtime: AgentRuntime,
  ): void {
    const compiled = compileTurn(signals, this.persona, { gapThresholdMs: this.deps.cfg().capture.gapThresholdMs });
    if (!compiled.ok) {
      this.deps.logger.warn(`[spirit] 本轮未记录：${compiled.reason}`);
      return;
    }
    if (compiled.draft === undefined) return;
    const draft = compiled.draft;
    /**
     * 用户原文只在**显式开启采集**时进 `fact.quote`（并按 maxQuoteChars 截断）。
     * 位置必须在 compile 之后：情绪判定那条链永远不该看到文本（信号包带自由文本会被整包拒），
     * 而 cues 与卡文本都不拿这个字段——三条约束都有用例守。
     * 按码点截（不是按 UTF-16 单元）：劈开代理对会写出无法编码的半个字符。
     */
    const cap = this.deps.cfg().capture;
    const quote = cap.userSnippet === true && input.newUserText !== ''
      ? Array.from(input.newUserText).slice(0, Math.max(0, Math.floor(cap.maxQuoteChars))).join('')
      : undefined;
    const fact = quote === undefined ? draft.fact : { ...draft.fact, quote };
    this.deps.store.append(
      {
        id: `x-${input.sessionId}-${input.now}-${runtime.firstTurnDone ? 'l' : 'f'}`,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        turnSeq: signals.turnSeq,
        tsMs: input.now,
        personaRevision: this.persona.revision,
      },
      { ...draft, fact },
    );
  }

  /** 登记在飞卡（适配器造好消息、拿到真实 id 后调）。 */
  noteInjected(agentId: string, messageId: string, fingerprint: string): void {
    if (messageId === '') return;
    // 没有运行态也要能登记：否则"先注一张卡、还没走过 pre-step"的时序下指纹会丢
    const runtime = this.runtimes.get(agentId) ?? { pending: new Map<string, string>(), firstTurnDone: true };
    runtime.pending.set(messageId, fingerprint);
    this.runtimes.set(agentId, runtime);
  }

  /**
   * 两段式生效：看到自家注入行真进了会话日志，才把指纹当"已发"。
   *
   * @param seq 该行进日志时的 seq；存下来才能下一轮回到表面核它还在不在
   * @returns 是否命中一个在飞卡
   */
  confirmInjected(messageId: string, seq?: number): boolean {
    for (const [agentId, runtime] of this.runtimes.entries()) {
      const fingerprint = runtime.pending.get(messageId);
      if (fingerprint === undefined) continue;
      runtime.pending.delete(messageId);
      runtime.lastFingerprint = fingerprint;
      if (typeof seq === 'number' && Number.isFinite(seq)) runtime.lastCardSeq = seq;
      this.deps.onConfirmed?.(agentId);
      return true;
    }
    return false;
  }

  /** 采集侧是否应当继续喂事件：off/关闭时不必累加（省无谓内存）。 */
  shouldObserve(): boolean {
    return this.eff().enabled && this.eff().live.enabled;
  }

  /**
   * 喂一个会话事件给采集器（由 card-observe 适配器调用）。
   *
   * 按 **sessionId** 键而不是 agentId：`session/event` 回调只给会话不给 agent，
   * 而 pre-step 取的又是同一会话的信号——键不一致会永远取到空信号。
   */
  observeEvent(sessionId: string, event: Parameters<TurnWatcher['observe']>[1], now: number): void {
    this.deps.watcher.observe(sessionId, event, now);
  }

  /**
   * 重置"已发过卡"的凭据（压缩/清空之后必须）。
   *
   * 不做这件事的后果很具体：卡行被摘要取代后已从模型上下文消失，但指纹还在，
   * 于是 `unchanged` 门会永久阻止重发 —— 表现为"压缩一次，角色就再也没情绪了"，
   * 而且不报错。姊妹包同理不信事件只信表面：这里**两个信号都接**
   *（`compaction/end` 与 `agent/created{source:'compact'|'clear'}`），因为它们各自都会漏。
   */
  resetCardState(key: string, why: 'compact' | 'clear'): void {
    const agentId = this.sessionToAgent.get(key) ?? key;
    const runtime = this.runtimes.get(agentId);
    if (runtime === undefined) return;
    runtime.lastFingerprint = undefined;
    runtime.lastCardSeq = undefined;
    runtime.pending.clear();
    runtime.firstTurnDone = why === 'clear';
    if (why === 'clear') runtime.mood = undefined;
    this.deps.logger.info(`[spirit] ${why} 后重置发卡凭据（下轮会重发）`);
  }

  /** agent 销毁时释放运行态（采集态按会话键，由 sessionId 单独释放）。 */
  release(agentId: string): void {
    this.runtimes.delete(agentId);
    this.diag.delete(agentId);
    this.lastRecall.delete(agentId);
    for (const [sessionId, agent] of [...this.sessionToAgent.entries()]) {
      if (agent === agentId) this.sessionToAgent.delete(sessionId);
    }
  }

  /** 会话销毁/不再参与时释放采集累加态。 */
  releaseSession(sessionId: string): void {
    this.deps.watcher.release(sessionId);
  }

  /** 当前生效档（面板读）。 */
  moodOf(agentId: string): Mood | undefined {
    return this.runtimes.get(agentId)?.mood;
  }
}
