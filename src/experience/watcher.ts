/**
 * 轮次信号采集器：把宿主会话事件流折成**结构化**的每轮信号。
 *
 * 为什么单独一层：情绪档的原料必须只来自宿主事件的结构字段。本文件里出现的每一个
 * `event.data.*` 读取点都是宿主 SessionEventMap 已声明的形状（`tool/call.name`、
 * `tool/result.message.isError`、`turn/end.reason.kind`、`todo/write.todos[]`），
 * **不读任何正文**——工具返回内容、assistant 文本、用户消息文本内容一概不看
 * （用户消息只看"有没有新的一条""长度"这两个结构量）。
 *
 * 三条容易写错的边界：
 * 1. **失败判据在 `message.isError`，不在 `event.data.error`**——后者是失败身份与
 *    给用户看的原因，允许缺席；只看 error 会把没带 error 的真失败漏掉。
 * 2. **`recovered` 要同名工具**：换一个工具成功不算"刚才是那一下没过"。
 * 3. **`user_interruption` = 本轮还开着（见过 turn/start 未见 turn/end）时又进来一条
 *    用户来源消息**。它是"被打断"，不是"被纠正"——后者必须读文本才能判，属禁读面。
 */

import { type ExperienceFact, type TurnSignals } from '../types.js';

/** 一个 agent 的轮内累加状态。 */
interface TurnState {
  turnSeq: number;
  turnOpen: boolean;
  toolCalls: number;
  toolFailures: number;
  /** callId → 工具名（tool/result 只带 callId，名字要靠 tool/call 配）。 */
  pendingCalls: Map<string, string>;
  /** 本会话内失败过的工具名，用于判定"同名恢复"。 */
  failedTools: Set<string>;
  recovered: boolean;
  userInterruption: boolean;
  hasNewUserMessage: boolean;
  userChars: number;
  taskClosed: boolean;
  lastTsMs: number;
  /** 最近一次"有实质活动"的时刻，用于 gapMs。 */
  lastActivityMs: number;
  /** 最后一次 todo 快照的结构性计数（刀3；undefined = 从未见过快照，不编造未竟）。 */
  todoOpen?: number;
  todoInProgress?: number;
  facts: ExperienceFact;
}

/** 宿主事件的读取面（只取需要的结构字段，不做全类型依赖）。 */
export interface RawEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: unknown;
}

export interface WatcherConfig {
  gapThresholdMs: number;
}

const MAX_TRACKED_TOOLS = 24;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 用户消息的结构量：只数长度，不看内容。 */
function textLengthOf(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    const record = asRecord(block);
    if (record['type'] === 'text' && typeof record['text'] === 'string') total += record['text'].length;
  }
  return total;
}

/**
 * todo 快照的结构计数（刀3）：只数状态，不读 content。
 *
 * 未竟判定只允许来自主人（用户）可见的 todo 快照——它同样是情绪输入，
 * 而自由文本会整包被 isStructuredOnly 拒掉；这里把“有几个还开着”算成整数，
 * 对外文案只拿档位（不伪造具体性：计数真为 3 才能说三条）。
 */
function todoCounts(rawTodos: unknown): { nonEmpty: boolean; done: boolean; open: number; inProgress: number } {
  if (!Array.isArray(rawTodos)) return { nonEmpty: false, done: false, open: 0, inProgress: 0 };
  const todos = rawTodos.map(asRecord);
  const openSet = new Set(['pending', 'in_progress', 'open', 'todo']);
  const nonEmpty = todos.length > 0;
  let open = 0;
  let inProgress = 0;
  for (const t of todos) {
    const status = str(t['status']).toLowerCase();
    if (status === 'in_progress') inProgress += 1;
    if (status !== '' && openSet.has(status)) open += 1;
  }
  const done = nonEmpty && open === 0 && todos.every((t) => str(t['status']) !== '');
  return { nonEmpty, done, open, inProgress };
}

/** 未竟读面（ledger 消费）：最后一次 todo 快照的结构计数；从未见过快照 ⇒ undefined（不编造）。 */
export interface OpenLoops {
  open: number;
  inProgress: number;
}

export class TurnWatcher {
  private readonly states = new Map<string, TurnState>();

  constructor(private readonly cfg: WatcherConfig) {}

  private state(agentId: string, now: number): TurnState {
    let state = this.states.get(agentId);
    if (state === undefined) {
      state = {
        turnSeq: 0,
        turnOpen: false,
        toolCalls: 0,
        toolFailures: 0,
        pendingCalls: new Map(),
        failedTools: new Set(),
        recovered: false,
        userInterruption: false,
        hasNewUserMessage: false,
        userChars: 0,
        taskClosed: false,
        lastTsMs: now,
        lastActivityMs: now,
        facts: {},
      };
      this.states.set(agentId, state);
    }
    return state;
  }

  /** 释放 agent 的累加态（agent/disposed 时调用，否则长期会话会攒下无界条目）。 */
  release(agentId: string): void {
    this.states.delete(agentId);
  }

  /**
   * 未竟读面（刀3）：**只读快照，不清计数**。
   * 绝不能用 takeSignals 实现这个读——那会把 todoOpen 重置成 undefined，
   * 而 turn/end 兑底路先于 agent/disposed 到达时，“最后快照”会被中间读取吃掉（集成测试调出的真 bug）。
   * 从未见过快照 ⇒ undefined——ledger 不入账（宁缺毋造）。
   */
  openLoops(agentId: string): OpenLoops | undefined {
    const state = this.states.get(agentId);
    if (state === undefined || state.todoOpen === undefined || state.todoInProgress === undefined) return undefined;
    return { open: state.todoOpen, inProgress: state.todoInProgress };
  }

  /** 最后见过的轮号（只读；dispose 结算拿它做幂等 id，与 turn/end 路的同轮 id 自然收敛）。 */
  lastTurnSeq(agentId: string): number {
    return this.states.get(agentId)?.turnSeq ?? 0;
  }

  /**
   * 吃一个宿主事件。任何无法识别的形状一律忽略（不猜字段）。
   *
   * @param agentId 事件所属 agent
   * @param event 事件（{type,data} 形状；来自 session/event）
   * @param now 当前毫秒（注入以便测试）
   */
  observe(agentId: string, event: RawEvent, now: number): void {
    const state = this.state(agentId, now);
    const data = asRecord(event.data);
    switch (event.type) {
      case 'turn/start': {
        const turn = Number(data['turn']);
        if (Number.isFinite(turn)) state.turnSeq = turn;
        state.turnOpen = true;
        state.lastActivityMs = now;
        break;
      }
      case 'turn/end': {
        state.turnOpen = false;
        state.lastActivityMs = now;
        break;
      }
      case 'tool/call': {
        const callId = str(data['callId']);
        const name = str(data['name']);
        state.toolCalls += 1;
        state.lastActivityMs = now;
        if (callId !== '' && name !== '') {
          if (state.pendingCalls.size >= MAX_TRACKED_TOOLS) {
            // 有顶：异常长轮次不能无界攒 map
            const oldest = state.pendingCalls.keys().next();
            if (!oldest.done) state.pendingCalls.delete(oldest.value);
          }
          state.pendingCalls.set(callId, name);
          // 只留最后一个工具名作为细节锚（不猜参数内容、不解析 arguments）
          state.facts.tool = name;
        }
        break;
      }
      case 'tool/result': {
        const message = asRecord(data['message']);
        const callId = str(message['toolCallId']) || str(asRecord(message['source'])['callId']);
        const name = state.pendingCalls.get(callId) ?? '';
        state.pendingCalls.delete(callId);
        const isError = message['isError'] === true;
        if (isError) {
          state.toolFailures += 1;
          if (name !== '') {
            if (state.failedTools.size >= MAX_TRACKED_TOOLS) state.failedTools.clear();
            state.failedTools.add(name);
          }
        } else if (name !== '' && state.failedTools.has(name)) {
          // 同名工具先败后成才算"缓过来"；换工具成功不算
          state.recovered = true;
          state.failedTools.delete(name);
        }
        state.lastActivityMs = now;
        break;
      }
      case 'user/message': {
        const source = asRecord(data['source']);
        const kind = str(source['kind']);
        if (kind !== 'user') {
          // 插件/合成注入行不算用户发言（自家卡、别的插件的召回注入都在这里被挡掉）
          break;
        }
        // 只量长度，不读内容（结构量）
        const chars = textLengthOf(data['content']);
        state.userChars = chars;
        if (state.turnOpen) {
          // 本轮未闭合就又有用户消息 = 中途插话
          state.userInterruption = true;
        } else {
          state.hasNewUserMessage = true;
        }
        state.lastTsMs = now;
        state.lastActivityMs = now;
        break;
      }
      case 'todo/write': {
        const counts = todoCounts(data['todos']);
        if (counts.nonEmpty && counts.done) state.taskClosed = true;
        // 只留最后一次快照的计数（刀3）；未知形状整包不算
        if (counts.nonEmpty) state.todoOpen = counts.open;
        if (counts.nonEmpty) state.todoInProgress = counts.inProgress;
        break;
      }
      default:
        break;
    }
  }

  /**
   * 取本轮信号并清空累加器（轮首调用一次）。
   *
   * `gapMs` 用"上一个活动时刻到 now 的间隔"，而**不是**"距上一条用户消息的间隔"——
   * 一轮里可能跑了很多工具却没新消息，按后者会把长工具误判成长间隔。
   */
  takeSignals(agentId: string, now: number): TurnSignals {
    const state = this.state(agentId, now);
    const gapMs = Math.max(0, now - state.lastActivityMs);
    const facts: ExperienceFact = {
      ...state.facts,
      toolCalls: state.toolCalls,
      toolFailures: state.toolFailures,
      userChars: state.userChars,
      gapMs,
      turnSpan: state.turnSeq > 0 ? [state.turnSeq, state.turnSeq] : undefined,
    };
    const signals: TurnSignals = {
      turnSeq: state.turnSeq,
      hasNewUserMessage: state.hasNewUserMessage,
      userChars: state.userChars,
      toolCalls: state.toolCalls,
      toolFailures: state.toolFailures,
      recovered: state.recovered,
      userInterruption: state.userInterruption,
      gapMs,
      taskClosed: state.taskClosed,
      facts,
    };
    this.reset(agentId, now, state.turnSeq, state.failedTools);
    return signals;
  }

  /** 本轮是否发生过实质事件（全空的一轮不必编译条目）。 */
  hasActivity(agentId: string): boolean {
    const state = this.states.get(agentId);
    if (state === undefined) return false;
    return (
      state.toolCalls > 0
      || state.hasNewUserMessage
      || state.userInterruption
      || state.taskClosed
      || state.recovered
    );
  }

  /**
   * 取完信号后重新开一轮的累加器。
   *
   * 两个东西故意**不清**：
   * - `turnSeq`：它属于会话而不属于一轮；
   * - `failedTools`："刚才那下没过"是跳轮事实——跟着清掉就永远判不出 `recovery`，
   *   而恢复恰恰是体验里最不该丢的那一类（本轮实测发现并修掉的缺陷）。
   */
  private reset(agentId: string, now: number, keepTurnSeq: number, keepFailedTools?: Set<string>): void {
    this.states.set(agentId, {
      turnSeq: keepTurnSeq,
      turnOpen: false,
      toolCalls: 0,
      toolFailures: 0,
      pendingCalls: new Map(),
      // 故意带上旧值：长期会话里失败过的工具名不能无界增长，超限时由 observe 侧重开
      failedTools: keepFailedTools ?? new Set<string>(),
      recovered: false,
      userInterruption: false,
      hasNewUserMessage: false,
      userChars: 0,
      taskClosed: false,
      lastTsMs: now,
      lastActivityMs: now,
      facts: {},
    });
  }
}
