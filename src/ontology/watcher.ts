/**
 * 本体层的采集侧（Phase B / TB.1）：与情绪轨、事务遥测轨并列的**第三条线**，observe 同一事件流。
 *
 * 与事务遥测 watcher 的根本区别（别当成"同一 watcher 的宽松版"）：
 * - 事务遥测 watcher 只吃结构信号（todo 标题/basename/意图 bit），原句不进包；
 * - 本体 watcher **要读正文语义**（P1 分级信任）：用户消息原文（脱敏后）、任务目标、助手动作——
 *   因为本体记忆的基本单元是"有内容的交付"，不读正文就抽不出实体/任务/关注面。
 *
 * 三条边界：
 * 1. **只读用户/助手/任务文本，绝不读工具返回正文**：工具输出是第三方载荷主通道，维持禁读。
 * 2. **入库前脱敏**：userText/assistantText 先 dropIfSecret（含密整段置空），再按顶截断——
 *    原文只作当轮 LLM 原料，绝不整段落库；落库的是 LLM 产出的抽象 delivery/entities。
 * 3. **身份不猜**：sessionId/workspaceId 拿不到就跳过。
 *
 * 助手文本（D1）：宿主是否在 session/event 发 assistant 行未经核实；发得出就采，发不出就留空——
 * 本体抽取不因此崩（少一路原料而已），Phase F 再据实探真补强。
 */
import type { RawEvent } from '../experience/watcher.js';
import { dropIfSecret } from './scrub.js';
import { baseName, normalizeCue } from '../experience/cues.js';

/** 各段顶：无顶就是无界增长 + 撑爆 prompt。 */
export const ONTOLOGY_SIGNAL_LIMITS = {
  userChars: 1200,
  assistantChars: 1200,
  todoTitles: 8,
  toolNames: 8,
  pathBases: 8,
  titleChars: 80,
} as const;

/** 一轮的本体信号包（LLM 原料）。 */
export interface OntologySignals {
  key: string;
  sessionId: string;
  workspaceId: string;
  turnSeq: number;
  tsMs: number;
  /** 用户消息原文（脱敏+钳短）；含密则为空串。 */
  userText: string;
  /** 助手动作文本（脱敏+钳短）；宿主不发 assistant 事件则为空串。 */
  assistantText: string;
  todoTitles: string[];
  toolNames: string[];
  pathBases: string[];
  /** 回填标志：true ⇒ 抽取器落库时打 TRUST_BACKFILL（注入读面排除），区别于在线 derived_summary。 */
  backfill?: boolean;
}

interface OntologyState {
  sessionId: string;
  workspaceId: string;
  turnSeq: number;
  userText: string;
  assistantText: string;
  todoTitles: string[];
  toolNames: string[];
  pathBases: string[];
  tsMs: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 取消息 content 的全部 text 块拼接（用户/助手都用它）；调用方负责脱敏+截断。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text']);
  }
  return parts.join('\n');
}

function argumentPaths(rawArgs: unknown): string[] {
  const fields = typeof rawArgs === 'string' ? safeJson(rawArgs) : asRecord(rawArgs);
  const out: string[] = [];
  for (const key of ['file_path', 'path'] as const) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim() !== '') out.push(normalizeCue(baseName(value)));
  }
  return out;
}
function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function pushCapped(list: string[], token: string, max: number): void {
  if (token === '' || list.includes(token) || list.length >= max) return;
  list.push(token);
}

/** 码点截断（劈代理对会写出无法编码的半个字符）。 */
function clamp(text: string, maxChars: number): string {
  return Array.from(text).slice(0, maxChars).join('');
}

export class OntologyWatcher {
  private readonly states = new Map<string, OntologyState>();

  observe(sessionId: string, workspaceId: string, event: RawEvent, now: number): void {
    if (sessionId === '') return;
    const state = this.state(sessionId, workspaceId, now);
    const data = asRecord(event.data);
    switch (event.type) {
      case 'turn/start': {
        const turn = Number(data['turn']);
        if (Number.isFinite(turn)) state.turnSeq = turn;
        state.tsMs = now;
        break;
      }
      case 'turn/end':
        state.tsMs = now;
        break;
      case 'user/message': {
        if (asText(asRecord(data['source'])['kind']) !== 'user') break;
        const raw = contentText(data['content']);
        const safe = dropIfSecret(raw);
        if (safe !== null) state.userText = clamp(safe, ONTOLOGY_SIGNAL_LIMITS.userChars);
        state.tsMs = now;
        break;
      }
      case 'assistant/message': {
        // D1：宿主可能不发这个事件；发了就采，没发这条 case 永不命中，assistantText 留空。
        const raw = contentText(data['content']);
        const safe = dropIfSecret(raw);
        if (safe !== null) state.assistantText = clamp(safe, ONTOLOGY_SIGNAL_LIMITS.assistantChars);
        state.tsMs = now;
        break;
      }
      case 'tool/call': {
        pushCapped(state.toolNames, normalizeCue(asText(data['name'])), ONTOLOGY_SIGNAL_LIMITS.toolNames);
        for (const p of argumentPaths(data['arguments'])) pushCapped(state.pathBases, p, ONTOLOGY_SIGNAL_LIMITS.pathBases);
        state.tsMs = now;
        break;
      }
      case 'todo/write': {
        if (!Array.isArray(data['todos'])) break;
        for (const rawTodo of data['todos']) {
          const title = asText(asRecord(rawTodo)['content']).trim().slice(0, ONTOLOGY_SIGNAL_LIMITS.titleChars);
          pushCapped(state.todoTitles, title, ONTOLOGY_SIGNAL_LIMITS.todoTitles);
        }
        state.tsMs = now;
        break;
      }
      default:
        break;
    }
  }

  /** 取一轮信号并清空累加器；无任何文本/结构原料 ⇒ null（宁缺毋造）。 */
  takeSignals(sessionId: string, now: number): OntologySignals | null {
    const state = this.states.get(sessionId);
    if (state === undefined || state.turnSeq === 0) return null;
    const hasContent = state.userText !== '' || state.assistantText !== ''
      || state.todoTitles.length > 0 || state.toolNames.length > 0 || state.pathBases.length > 0;
    if (!hasContent) return null;
    const signals: OntologySignals = {
      key: `${state.sessionId}/${state.turnSeq}`,
      sessionId: state.sessionId,
      workspaceId: state.workspaceId,
      turnSeq: state.turnSeq,
      tsMs: state.tsMs,
      userText: state.userText,
      assistantText: state.assistantText,
      todoTitles: [...state.todoTitles],
      toolNames: [...state.toolNames],
      pathBases: [...state.pathBases],
    };
    this.states.set(sessionId, {
      ...state,
      userText: '',
      assistantText: '',
      todoTitles: [],
      toolNames: [],
      pathBases: [],
      tsMs: now,
    });
    return signals;
  }

  hasActivity(sessionId: string): boolean {
    const state = this.states.get(sessionId);
    if (state === undefined) return false;
    return state.turnSeq > 0 && (state.userText !== '' || state.assistantText !== ''
      || state.todoTitles.length > 0 || state.toolNames.length > 0 || state.pathBases.length > 0);
  }

  release(sessionId: string): void {
    this.states.delete(sessionId);
  }

  private state(sessionId: string, workspaceId: string, now: number): OntologyState {
    let state = this.states.get(sessionId);
    if (state === undefined) {
      if (this.states.size >= 64) {
        const oldest = this.states.keys().next();
        if (!oldest.done) this.states.delete(oldest.value);
      }
      state = { sessionId, workspaceId, turnSeq: 0, userText: '', assistantText: '', todoTitles: [], toolNames: [], pathBases: [], tsMs: now };
      this.states.set(sessionId, state);
    }
    return state;
  }
}
