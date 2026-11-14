/**
 * 召回查询串的来源判定与拼装（P0）。
 *
 * 两个真实问题：
 * 1. **白名单漏人**：`hooks/card-pre-step.ts` 原来只认 `source.kind === 'user'`，
 *    第三方 IM 桥（自定义 kind，如 `im-connect`）的会话因此**历史召回永不触发**，且无日志。
 *    改成黑名单：只拉黑宿主注入与插件自产，**不认识就当人话**。
 * 2. **短句没线索**：「推」「在吗」能过 `queryWorthRecall` 的 ≥2 字门槛，但拿它检索
 *    几乎必然零命中。短于阈值时向前拼最近几句（有上限、去重），并且**只用于检索**——
 *    记账与 quote 采集仍用原句（绝不把拼出来的长串写进体验正文）。
 */
import { textOfMessage } from '../util/host-shape.js';

/** 机器来源黑名单：宿主注入的上下文、插件自产、以及自己投递的语气消息。 */
const MACHINE_SOURCES: ReadonlySet<string> = new Set([
  'runtime-context',
  'time-context',
  'skill-catalog',
  'speak-up',
  'soul-tone',
  'goal-round',
  'subagent-notice',
  'schedule',
  'spirit-card',
]);

/** 前缀黑名单：system-* / tool-* / subagent* / goal* / plugin:*。 */
const MACHINE_PREFIXES: readonly string[] = ['system-', 'tool-', 'subagent', 'goal', 'plugin:', 'spirit'];

/**
 * 这条消息是不是「人在说话」。
 *
 * 空 kind ⇒ true（认不出来当人话）；命中黑名单 ⇒ false；其余一律 true。
 */
export function isHumanSource(kind: unknown): boolean {
  const value = typeof kind === 'string' ? kind.trim().toLowerCase() : '';
  if (value === '') return true;
  if (MACHINE_SOURCES.has(value)) return false;
  return !MACHINE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/** 取本轮所有「人说的」消息正文（保序、去空、去连续重复）。 */
export function humanTexts(messages: readonly unknown[], maxCharsPerText = 240): string[] {
  const out: string[] = [];
  for (const raw of messages) {
    const kind = (raw as { source?: { kind?: unknown } })?.source?.kind;
    if (!isHumanSource(kind)) continue;
    const text = textOfMessage(raw).trim();
    if (text === '') continue;
    const capped = Array.from(text).slice(0, maxCharsPerText).join('');
    if (out[out.length - 1] === capped) continue;
    out.push(capped);
  }
  return out;
}

/** 本轮最后一条「人说的」消息（记账与 quote 用；单条时与旧行为逐字等价）。 */
export function pickHumanText(messages: readonly unknown[], maxChars = 240): string {
  const texts = humanTexts(messages, maxChars);
  return texts.length === 0 ? '' : (texts[texts.length - 1] as string);
}

export interface RecallQueryOptions {
  /** 去空白/标点后短于此值 ⇒ 补上文（默认 6）。 */
  minChars?: number;
  /** 拼装后的总长上限（默认 240，与 `pickHumanText` 同口径）。 */
  maxChars?: number;
  /** 最多向前借几条（默认 6）。 */
  maxPrev?: number;
}

function collapsedLength(text: string): number {
  return text.replace(/[\s\p{P}]/gu, '').length;
}

function capText(text: string, maxChars: number): string {
  return Array.from(text).slice(0, Math.max(1, maxChars)).join('');
}

/**
 * 构造检索查询串：最后一条人话；太短则向前拼最近几句（不超上限、不重复）。
 *
 * 为什么「跳过放不下的」而不是截断：截断会把上一条正文切成半句，检索 token 反而更脏。
 */
export function buildRecallQuery(messages: readonly unknown[], opts: RecallQueryOptions = {}): string {
  const minChars = Math.max(1, Math.floor(opts.minChars ?? 6));
  const maxChars = Math.max(minChars, Math.floor(opts.maxChars ?? 240));
  const maxPrev = Math.max(0, Math.floor(opts.maxPrev ?? 6));
  const texts = humanTexts(messages, maxChars);
  if (texts.length === 0) return '';
  const current = texts[texts.length - 1] as string;
  if (collapsedLength(current) >= minChars) return capText(current, maxChars);
  const parts: string[] = [current];
  let length = current.length;
  for (let i = texts.length - 2; i >= 0 && parts.length - 1 < maxPrev; i -= 1) {
    const candidate = texts[i] as string;
    if (parts.includes(candidate)) continue;
    if (length + 1 + candidate.length > maxChars) continue;
    parts.push(candidate);
    length += 1 + candidate.length;
  }
  return capText(parts.join(' '), maxChars);
}