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
import { recentForms, formsDigest, type FormedEntry } from './recall/recent.js';
import { feedbackFirst, type FadeConfig } from './recall/form.js';
import { recallHistory, queryWorthRecall, type HistoryDeps } from './recall/history.js';
import { deriveMood, moodChanged, withRevisionBump, type MoodConfig } from './slot/derive.js';
import { renderCard } from './slot/render.js';
import { biasTendency, readBias, type BiasReader } from './slot/bias.js';
import { TRIGGER_TOOL_FAILURE, type ExperienceEntry, type Mood, type PersonaCard } from './types.js';
import type { FadeStats, SpiritConfig, SpiritLiveSettings } from './contract.js';
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
  | { kind: 'injected'; text: string; bytes: number; fingerprint: string; reason: Gate; tendency?: string };

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
  /** 未竟账读面（刀3）：新会话首轮带出一行；省略/空 ⇒ 整段不出现。 */
  ledgerLine?(workspaceId: string, excludeSessionId: string, now: number): string | undefined;
  /** 条件化查表（刀4）：(workspace, actionKey) → 档位；O(1)，禁扫表。 */
  biasBand?(workspaceId: string, actionKey: string, now: number): number | undefined;
  /** 条件化冷写（刀4）：turn/end 结算里顺手 upsert，绝不在 pre-step 写。 */
  onBiasUpsert?(workspaceId: string, actionKey: string, band: number, now: number): void;
  /** 未竟账结算（刀3）：索引层落 session_ledger；只吃结构计数。 */
  onLedgerSettle?(row: { sessionId: string; workspaceId: string; turnSeq: number; open: number; inProgress: number; tsMs: number }): void;
  /** 淡出计数回调（stats 腿）：每轮把形态分布递出去，不在这里存。 */
  onFadeStats?(agentId: string, stats: FadeStats): void;
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
  private readonly diag = new Map<string, { entryCount: number; recallHits: number; mood: Mood | undefined; outcome: Gate; tendency?: string }>();
  /** 本轮检索段实际命中数（供诊断面读）。 */
  private readonly lastRecall = new Map<string, number>();
  /** sessionId → agentId：压缩事件只给会话，而运行态按 agent 计。 */
  private readonly sessionToAgent = new Map<string, string>();
  /**
   * 本轮的记账上下文（sessionId 为键）：`turn/end` 到达时拿它落一条体验。
   *
   * 为什么需要它：信号累加器在 `turn/end` 时已经齐了，但 `workspaceId` 与本轮新用户文本
   * 只在 pre-step 的 payload 里——不在这里存下，结算时就只能拿到空字段。
   */
  private readonly turnCtx = new Map<string, { workspaceId: string; newUserText: string }>();
  /** 会话→工作区的账本上下文：与 turnCtx 同生命周期，但**不随 release 删**（disposed 结算时靠它）。 */
  private readonly ledgerCtx = new Map<string, string>();
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

  private moodCfg(cfg: ReturnType<Spirit['eff']>, biasBands?: Map<string, number>): MoodConfig {
    return {
      halfLifeMs: cfg.recall.halfLifeMs,
      stepCap: cfg.tier.stepCap,
      staleAfterMs: cfg.tier.staleAfterMs,
      ...(biasBands === undefined || biasBands.size === 0 ? {} : { biasBands }),
    };
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
      ...(outcome.kind === 'injected' && outcome.tendency !== undefined ? { tendency: outcome.tendency } : {}),
    });
    return outcome;
  }

  /** 面板读的每轮诊断（没跑过任何一轮 ⇒ 全零形状，不编数据）。 */
  diagOf(agentId: string): { entryCount: number; recallHits: number; mood: Mood | undefined; outcome: Gate; tendency?: string } {
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
      // 存下本轮的记账上下文：真记录发生在 `turn/end`（见 flushTurn），而那时只剩 session。
      // **只在新用户轮存**：一个轮里有多个 step，后续 step 的 messageCount=0、newUserText 为空，
      // 若不问条件就写，会把本轮真正的用户文本冲掉（影响 quote 采集），也会让纯工具轮被记上。
      if (input.messageCount > 0) {
        this.turnCtx.set(input.sessionId, { workspaceId: input.workspaceId, newUserText: input.newUserText });
        this.ledgerCtx.set(input.sessionId, input.workspaceId);
      }
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
      // 这是**兜底路**：正常时序下 `turn/end` 已经结算并清空累加器，这里取到空信号⇒不重复记；
      // 只有 `turn/end` 漏发（真宿主存在这条线）时，上一轮的信号才在这里落库。
      this.record(signals, input, runtime);
      if (bypass) {
        // 旁路：记录与派生都做，只是不出卡——这是归因实验的对照组
        this.runtimes.set(input.agentId, { ...runtime, pending: runtime.pending, firstTurnDone: true });
        return { kind: 'recorded', reason: 'bypass' };
      }

      // ── 派生档位（只吃条目，不吃信号） ──
      const recentK = Math.max(0, Math.floor(cfg.card.recentK));
      const fade = fadeConfigOf(cfg);
      // 淡出开启时候选池放宽：held 逐出后需要有替补（多取几条的成本是一次索引读，<1ms）
      const poolK = fade.fadeEnabled ? Math.max(recentK * 3, recentK + 4) : Math.max(recentK + 2, 4);
      const entries = this.deps.recentEntries(input.sessionId, poolK);
      // 条件化（刀4）两通道共用一次读表：band 集按候选池里出现过的 trigger 取（O(1)×小常数，禁扫表）
      const biasReader: BiasReader | undefined = this.deps.biasBand === undefined
        ? undefined
        : (actionKey) => this.deps.biasBand!(input.workspaceId, actionKey, input.now);
      const biasBands = collectBiasBands(cfg, biasReader, entries);
      const derived = deriveMood(runtime.mood, entries, input.now, this.moodCfg(cfg, biasBands));
      const mood = withRevisionBump(runtime.mood, derived);
      const changed = moodChanged(runtime.mood, mood);

      // ── 重发判据：档位没动且近因内容没动 ⇒ 沿用上一张 ──
      // 淡出臂：形态档位进指纹——档内字节稳定，重发只发生在跨档（量化纪律的执行点）
      const formed: FormedEntry[] = fade.fadeEnabled
        ? recentForms(entries, { now: input.now, halfLifeMs: cfg.recall.halfLifeMs, limit: recentK, fade })
        : recentForms(entries, { now: input.now, halfLifeMs: cfg.recall.halfLifeMs, limit: recentK });
      const recentTexts = formed.map((item) => item.text);
      const fingerprint = fade.fadeEnabled
        ? `${mood.revision}|${recentTexts.join('#')}|${formsDigest(formed)}`
        : `${mood.revision}|${recentTexts.join('#')}`;
      if (fade.fadeEnabled) this.deps.onFadeStats?.(input.agentId, fadeStatsOf(formed, entries));
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

      // 开场段两行：跨会话基调（既有）+ 未竟账（刀3，只吃结构计数；拿不到就整行不出现）
      const toneParts: string[] = [];
      if (!runtime.firstTurnDone && cfg.card.crossSessionM > 0) {
        const tone = previousTone(this.deps.previousEntries(input.workspaceId, input.sessionId, cfg.card.crossSessionM), {
          maxChars: cfg.recall.maxCharsPerEntry,
        });
        if (tone !== undefined && tone !== '') toneParts.push(tone);
        const ledger = this.deps.ledgerLine?.(input.workspaceId, input.sessionId, input.now);
        if (ledger !== undefined && ledger !== '') toneParts.push(ledger);
        // 反馈重排也接开场段：人标过“重要”的基调行先说（两轴分离：只换序，不改内容与档位）
        if (fade.fadeEnabled && fade.feedbackEnabled && toneParts.length > 1) {
          const markedOf = (part: string): number => {
            const hit = entries.find((entry) => entry.text === part || entry.gist === part || (entry.gist !== undefined && part.includes(entry.gist)));
            return hit?.feedbackScore !== undefined && hit.feedbackScore > 0 ? hit.feedbackScore : 0;
          };
          const ordered = feedbackFirst(toneParts, markedOf);
          toneParts.length = 0;
          toneParts.push(...ordered);
        }
      }
      const tone = toneParts.join('；');

      // 条件化（刀4）：只经卡文本通道——不改 decision、不碰系统提示；乘子通道在上方 moodCfg
      const tendencyOverride = biasTendency(readBias(cfg, biasReader, failedActionKeys(cfg, entries), biasBands));

      const card = renderCard({
        mood,
        recent: recentTexts,
        recalled,
        ...(tone !== '' ? { tone } : {}),
        ...(tendencyOverride !== undefined ? { tendencyOverride } : {}),
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
      return {
        kind: 'injected',
        text: card.text,
        bytes: card.bytes,
        fingerprint,
        reason: 'injected',
        ...(tendencyOverride !== undefined ? { tendency: tendencyOverride } : {}),
      };
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

  /** 记录所需的最小轮上下文（pre-step 的 input 本身就满足这个形状）。 */
  private record(
    signals: ReturnType<SpiritDeps['watcher']['takeSignals']>,
    input: { sessionId: string; workspaceId: string; now: number; newUserText: string },
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
    const entry = this.deps.store.append(
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
    // 条件化冷写（刀4）：工具没走通这件事本身是可检索的动作键；band 取条目 reaction 档，
    // 与已存档取严不取松（一次 mild 不许抹掉上次的 strong）
    if (draft.trigger === TRIGGER_TOOL_FAILURE && entry.fact.tool !== undefined && entry.fact.tool !== '') {
      const fresh = draft.reaction === 'strong' ? 2 : 1;
      const stored = this.deps.biasBand?.(input.workspaceId, entry.fact.tool, input.now);
      const band = typeof stored === 'number' && stored > fresh ? stored : fresh;
      this.deps.onBiasUpsert?.(input.workspaceId, entry.fact.tool, band, input.now);
    }
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
    // 一轮结束就是它的体验已经齐了——在这里结算，而不是等下一轮 pre-step。
    if (event.type === 'turn/end') this.flushTurn(sessionId, now);
  }

  /**
   * 本轮结算：`turn/end` 一到就把这一轮的信号编译成体验条目。
   *
   * 为什么不能只靠下一轮 pre-step（改动前的做法）：那会把**会话的最后一轮**永远丢掉——
   * 而 headless 一次任务就是一轮 ⇒ 整条记录轨在那条线上一条都不落（真机实测：跑完几个会话，
   * 库里运行时写入的条目数==0）。“记录过程的点滴”不许靠“还有下一轮”才成立。
   */
  flushTurn(sessionId: string, now: number): void {
    const ctx = this.turnCtx.get(sessionId);
    if (ctx === undefined) return;
    this.turnCtx.delete(sessionId);
    const signals = this.deps.watcher.takeSignals(sessionId, now);
    const agentId = this.sessionToAgent.get(sessionId);
    const runtime = this.runtimes.get(agentId ?? '') ?? { pending: new Map<string, string>(), firstTurnDone: true };
    try {
      this.record(signals, { sessionId, workspaceId: ctx.workspaceId, now, newUserText: ctx.newUserText }, runtime);
      // 未竟账兑底（刀3）：disposed 不发/丢失的宿主线在这里也能入账（取代链收敛重复）
      this.settleLedger(sessionId, ctx.workspaceId, signals.turnSeq, now);
    } catch (err) {
      // 结算失败不许影响会话本身（全链 fail-open）；下一轮的兑底路还会再试
      this.deps.logger.warn(`[spirit] turn/end 结算异常（本轮未记）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  
  /**
   * 未竟账结算（刀3）：取最后一次 todo 快照的结构计数落一行账。
   *
   * openLoops 给 undefined（从未见过快照）⇒ 不入账——宁缺毋造，也不拿“没看见”
   * 当“都收完了”的善后凭据。id 含 turnSeq：同一轮重复结算幂等（ON CONFLICT DO NOTHING）。
   */
  settleLedger(sessionId: string, workspaceId: string, turnSeq: number, now: number): void {
    const cfg = this.eff();
    if (!cfg.ledger.enabled || this.deps.onLedgerSettle === undefined) return;
    const loops = this.deps.watcher.openLoops(sessionId);
    if (loops === undefined) return;
    this.deps.onLedgerSettle({
      sessionId,
      workspaceId,
      turnSeq,
      open: loops.open,
      inProgress: loops.inProgress,
      tsMs: now,
    });
  }
  
  /**
   * agent 销毁时的会话级收尾（card-observe 在 `release()` 之前调）：
   * 先结算未竟账，再释放采集态——顺序反了 openLoops 会被清空，账永远不落。
   */
  settleOnDispose(agentId: string, now: number): void {
    for (const [sessionId, mapped] of [...this.sessionToAgent.entries()]) {
      if (mapped !== agentId) continue;
      const workspaceId = this.ledgerCtx.get(sessionId);
      if (workspaceId === undefined) continue;
      // 绝不能用 takeSignals 取轮号：它会顺手清掉 todo 计数，把“最后快照”吃掉（真 bug，集成测试调出）
      this.settleLedger(sessionId, workspaceId, this.deps.watcher.lastTurnSeq(sessionId), now);
    }
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
      if (agent === agentId) {
        this.sessionToAgent.delete(sessionId);
        // 记账上下文与会话同生命周期：不删就会在长宿主里积下无限条目
        this.turnCtx.delete(sessionId);
      }
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

/** 生效配置 → 淡出参数切片（纯投影，不在编排里藏默认值）。 */
function fadeConfigOf(cfg: SpiritConfig): FadeConfig {
  return {
    fadeEnabled: cfg.recall.fadeEnabled,
    feedbackEnabled: cfg.recall.feedbackEnabled,
    fadeHalfLifeMs: cfg.recall.fadeHalfLifeMs,
    fullMinScore: cfg.recall.fadeFullMinScore,
    gistMinScore: cfg.recall.fadeGistMinScore,
    gistMinSalience: cfg.recall.gistMinSalience,
  };
}

/** 本轮形态分布（held = 候选池里被逐出注意力的未取代条目；marked = 被人标过重要的条数）。 */
function fadeStatsOf(formed: readonly FormedEntry[], pool: readonly ExperienceEntry[]): FadeStats {
  const usable = pool.filter((entry) => entry.supersededBy === undefined && entry.text !== '');
  let full = 0;
  let gist = 0;
  for (const item of formed) {
    if (item.form === 'full') full += 1;
    else if (item.form === 'gist') gist += 1;
  }
  const marked = usable.filter((entry) => typeof entry.feedbackScore === 'number' && (entry.feedbackScore ?? 0) > 0).length;
  return { full, gist, marked, held: Math.max(0, usable.length - formed.length), pool: usable.length };
}

/** 条件化的动作键集：候选池里“没走通”的工具名（结构字段，不读任何文本）。 */
function failedActionKeys(cfg: SpiritConfig, entries: readonly ExperienceEntry[]): string[] {
  if (!cfg.bias.enabled) return [];
  const keys = new Set<string>();
  for (const entry of entries) {
    if (entry.supersededBy !== undefined) continue;
    if (entry.trigger === TRIGGER_TOOL_FAILURE && entry.fact.tool !== undefined && entry.fact.tool !== '') {
      keys.add(entry.fact.tool);
    }
  }
  return [...keys];
}

/**
 * 乘子通道的 band 集：trigger → 该族条目涉及动作的最强 band。
 * 只读候选池内已见过的工具名（O(池)×O(1) 查表），不新增输入源。
 */
function collectBiasBands(cfg: SpiritConfig, reader: BiasReader | undefined, entries: readonly ExperienceEntry[]): Map<string, number> {
  const bands = new Map<string, number>();
  if (!cfg.bias.enabled || reader === undefined) return bands;
  for (const entry of entries) {
    if (entry.supersededBy !== undefined) continue;
    if (entry.trigger !== TRIGGER_TOOL_FAILURE) continue;
    const tool = entry.fact.tool;
    if (tool === undefined || tool === '') continue;
    const band = reader(tool);
    if (band === undefined || band <= 0) continue;
    const prev = bands.get(entry.trigger) ?? 0;
    if (band > prev) bands.set(entry.trigger, band);
  }
  return bands;
}
