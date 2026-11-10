/**
 * 事务轨的采集侧（T3.1）：与 TurnWatcher 并列 observe 同一事件流。
 *
 * 情绪轨的 watcher 一个字都不读正文（那边是红线）。这一层刻意读三类文本——todo 标题、
 * tool 参数里的路径/URL、用户话语的意图命中——因为它写的是文本条目，而其中**只留档位
 * 不存原句**。所以"读什么"必须是计划口径点名的白名单：本文件里出现的每个读取点都在
 * spec 的采集白名单表里；其余字段一律忽略，不猜。
 *
 * 三条边界（与情绪轨的差别就在这三条上，别当成"同一个 watcher 的宽松版"）：
 * 1. **原句不进信号包**：意图只存档位（kind + bit）。原句是禁读面（见 experience/events.ts
 *    头注）——它会被 LLM 抄进 card_line，然后经记忆回环再进 system prompt，闭环就成立。
 * 2. **路径只留 basename**：会泄露工作区结构的是目录，不是文件名（与 experience/cues.ts 同一口径）。
 * 3. **URL 只留 host**：URL 的 path 段同样是结构泄露；host 是本层唯一允许的 URL 片段。
 *    ⚠️ host 没有对应 cue kind（词表只有 file|person|tool|topic）——所以 host 只进 prompt，
 *    不写 cue 行。这条口径缺口交回人手，见 plan findings。
 *
 * `key`（session/turn）是批次对账身份：校验侧靠它认"哪条提案对应哪次信号"，模型不得发明。
 */

import type { RawEvent } from '../experience/watcher.js';
import { CUE_LIMITS, baseName, normalizeCue } from '../experience/cues.js';
import { matchIntent, type IntentKind } from '../words.js';

/** 信号面各段的顶：无顶就是无界增长（这张表只增不删）。 */
export const TXN_SIGNAL_LIMITS = { titles: 8, toolNames: 8, pathBases: 8, urlHosts: 4, titleChars: 60 } as const;

/** 一次采集的信号包（prompt 的原料；`key` 是校验侧的对账身份）。 */
export interface TxnSignals {
  key: string;
  sessionId: string;
  workspaceId: string;
  turnSeq: number;
  tsMs: number;
  /** todo 快照的标题文本（结构字段，不是正文；长度与条数都有顶）。 */
  todoTitles: string[];
  /** tool/call 的工具名与参数里的 basename（白名单抽取，不读返回值正文）。 */
  toolNames: string[];
  pathBases: string[];
  /** URL 的 host 段（无对应 cue kind ⇒ 只进 prompt，不写 cue 行）。 */
  urlHosts: string[];
  /** 意图命中只留档位：原句不在包内（红线）。 */
  intent?: { kind: IntentKind; bit: number };
}

interface TxnState {
  sessionId: string;
  workspaceId: string;
  turnSeq: number;
  turnOpen: boolean;
  titles: string[];
  toolNames: string[];
  pathBases: string[];
  urlHosts: string[];
  intent: { kind: IntentKind; bit: number } | null;
  tsMs: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** user/message 的文本取"第一段 text"——只用来跑意图词表，原文不进包（红线）。 */
function firstTextBlock(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    const record = asRecord(block);
    if (record['type'] === 'text' && typeof record['text'] === 'string') return record['text'];
  }
  return '';
}

/**
 * tool/call 的 arguments 是"执行前参数快照"（结构量）——解析后只取白名单键。
 * `kind` 落的是 cue kind（file / tool / topic）：路径归 basename，命令归脚本名，URL 只留 host。
 * 这里出现的每个键都是计划字母点名的白名单键，其余一律不读。
 */
function argumentField(rawArgs: unknown): { value: string; kind: 'file' | 'tool' | null } {
  const fields = typeof rawArgs === 'string' ? parseMaybeJson(rawArgs) : asRecord(rawArgs);
  for (const key of ['file_path', 'path', 'url', 'command'] as const) {
    const value = fields[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    if (key === 'url') return { value: hostOf(value), kind: null }; // host 无对应 kind（见头注口径缺口）
    if (key === 'command') return { value: normalizeCue(value.trim().split(/\s+/u)[0] ?? ''), kind: 'tool' };
    return { value: normalizeCue(baseName(value)), kind: 'file' };
  }
  return { value: '', kind: null };
}

function parseMaybeJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

function pushCapped(list: string[], token: string, max: number): void {
  if (token === '' || list.includes(token)) return;
  if (list.length >= max) return;
  list.push(token);
}

export class TransactionWatcher {
  private readonly states = new Map<string, TxnState>();

  /**
   * 吃一个宿主事件。任何无法识别的形状一律忽略（不猜字段）。
   *
   * @param sessionId 事件所属会话（信号包身份）
   * @param workspaceId 事件所属工作区（信号包身份）
   * @param event {type,data} 形状；来自 session/event
   * @param now 当前毫秒（注入以便测试）
   */
  observe(sessionId: string, workspaceId: string, event: RawEvent, now: number): void {
    if (sessionId === '') return;
    const state = this.state(sessionId, workspaceId, now);
    const data = asRecord(event.data);
    switch (event.type) {
      case 'turn/start': {
        const turn = Number(data['turn']);
        if (Number.isFinite(turn)) state.turnSeq = turn;
        state.turnOpen = true;
        state.tsMs = now;
        break;
      }
      case 'turn/end': {
        state.turnOpen = false;
        state.tsMs = now;
        break;
      }
      case 'tool/call': {
        const name = normalizeCue(asText(data['name']));
        pushCapped(state.toolNames, name, TXN_SIGNAL_LIMITS.toolNames);
        const extracted = argumentField(data['arguments']);
        if (extracted.value !== '') {
          // kind 就是 cue kind 映射表（file / tool / topic）；host 段无对应 kind，只进 prompt
          if (extracted.kind === 'file') pushCapped(state.pathBases, extracted.value, TXN_SIGNAL_LIMITS.pathBases);
          else if (extracted.kind === 'tool') pushCapped(state.toolNames, extracted.value, TXN_SIGNAL_LIMITS.toolNames);
          else pushCapped(state.urlHosts, extracted.value, TXN_SIGNAL_LIMITS.urlHosts);
        }
        state.tsMs = now;
        break;
      }
      case 'user/message': {
        const source = asRecord(data['source']);
        if (asText(source['kind']) !== 'user') break; // 自家卡与别的插件的注入行不算用户发言
        const hit = matchIntent(firstTextBlock(data['content']));
        if (hit !== null) state.intent = hit; // 只存档位，原句不留
        state.tsMs = now;
        break;
      }
      case 'todo/write': {
        if (!Array.isArray(data['todos'])) break;
        for (const rawTodo of data['todos']) {
          const todo = asRecord(rawTodo);
          const title = asText(todo['content']).trim().slice(0, TXN_SIGNAL_LIMITS.titleChars);
          if (title !== '') pushCapped(state.titles, title, TXN_SIGNAL_LIMITS.titles);
        }
        state.tsMs = now;
        break;
      }
      default:
        break;
    }
  }

  /**
   * 取本轮信号并清空累加器（turn/end 后由调用方取一次）。
   * 全空的一轮不必出条目（宁缺毋造）。
   */
  takeSignals(sessionId: string, now: number): TxnSignals | null {
    const state = this.states.get(sessionId);
    if (state === undefined) return null;
    if (state.turnSeq === 0) return null; // 没走过 turn/start ⇒ 身份缺失，不猜
    const signals: TxnSignals = {
      key: `${state.sessionId}/${state.turnSeq}`,
      sessionId: state.sessionId,
      workspaceId: state.workspaceId,
      turnSeq: state.turnSeq,
      tsMs: state.tsMs,
      todoTitles: [...state.titles],
      toolNames: [...state.toolNames],
      pathBases: [...state.pathBases],
      urlHosts: [...state.urlHosts],
    };
    if (state.intent !== null) signals.intent = { ...state.intent };
    this.states.set(sessionId, { ...state, titles: [], toolNames: [], pathBases: [], urlHosts: [], intent: null, tsMs: now });
    return signals;
  }

  /** 本轮是否有可采信号（全空的轮不进队列——空轮进队列会攒出"无原料的批次"）。 */
  hasActivity(sessionId: string): boolean {
    const state = this.states.get(sessionId);
    if (state === undefined) return false;
    return state.turnSeq > 0 && (state.titles.length > 0 || state.toolNames.length > 0 || state.pathBases.length > 0 || state.intent !== null);
  }

  /** 会话级顶：无界会话不能无界攒状态（照 experience watcher 的 MAX_TRACKED_TOOLS 口径）。 */
  private state(sessionId: string, workspaceId: string, now: number): TxnState {
    let state = this.states.get(sessionId);
    if (state === undefined) {
      if (this.states.size >= CUE_LIMITS.maxPerEntry * 8) {
        const oldest = this.states.keys().next();
        if (!oldest.done) this.states.delete(oldest.value);
      }
      state = {
        sessionId,
        workspaceId,
        turnSeq: 0,
        turnOpen: false,
        titles: [],
        toolNames: [],
        pathBases: [],
        urlHosts: [],
        intent: null,
        tsMs: now,
      };
      this.states.set(sessionId, state);
    }
    return state;
  }

  /** 释放会话的累加态（agent/disposed 时调用）。 */
  release(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /** 最后见过的轮号（只读，供对账）。 */
  lastTurnSeq(sessionId: string): number {
    return this.states.get(sessionId)?.turnSeq ?? 0;
  }
}
