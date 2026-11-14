/**
 * 注入回响面（v0.7 / 对表 dsh-prime-memory 的 memory 激活槽位）：
 * 每轮 `agent/pre-step` 落一条快照——注入了什么（全文 + 指纹 + 分段行数）、或为什么没注入（门名）。
 *
 * 三条边界：
 * 1. **进程内环形缓冲，不落库**：这是观测面（诊断用），不是记忆真源。重启归零不算丢数据。
 * 2. **只存已发生的**：跳过轮也记一条（reason=门名）——"这轮为什么没卡"正是最难查的那类。
 * 3. **有顶**：全局 200 条，防面板把日志面当数据库用。
 */
import type { SpiritEchoEntry, SpiritEchoSegment, SpiritEchoSnapshot } from './contract.js';

// 分段词表与 slot/render.ts 的标签一一对应（记着/惦记 = v0.8 工作账与目的层入卡的段）。
export const ECHO_SEGMENTS = ['状态', '反馈', '线程', '记着', '惦记', '事务', '刚刚', '想起', '开场'] as const;
const ECHO_MAX = 200;

/** 快照形状单源在契约（RPC 响应直接用），本模块只负责采集与缓冲。 */
export type EchoSegmentCount = SpiritEchoSegment;
export type EchoSnapshot = SpiritEchoSnapshot;
/** 一个分段条目（标签 + 内容行）；形状单源在契约。 */
export type EchoEntry = SpiritEchoEntry;

/** 壳子行：包裹标签本身不是内容（声明/免责行在首个标签行之前，天然被丢）。 */
const SHELL_LINE_RE = /^<\/?system-reminder>$/u;

/** 从卡文本解析分段行数：行首 `标签：` 命中词表才计（正文里出现同词不算）。 */
export function parseEchoSegments(text: string): EchoSegmentCount[] {
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) {
    const head = line.trim();
    for (const name of ECHO_SEGMENTS) {
      if (head.startsWith(`${name}：`)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        break;
      }
    }
  }
  return [...counts.entries()].map(([name, lines]) => ({ name, lines }));
}

/**
 * 卡文本 → 侧栏一行摘要。
 *
 * 注入卡整张是 `<system-reminder>` 包的，头两行是「（角色体验快照 · 取代先前快照）」
 * 这类壳子——原样截前 200 字，侧栏第一行就会变成标签与免责声明，而不是「这一轮她
 * 想起了什么」。所以这里只挑分段行（`状态：`/`刚刚：`/`想起：`…），用 ` · ` 连成
 * 一句；一行分段都没有才退回压平后的正文。
 */
export function previewOfEcho(text: string, max = 200): string {
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const head = raw.trim();
    if (head === '') continue;
    for (const name of ECHO_SEGMENTS) {
      if (head.startsWith(`${name}：`)) {
        lines.push(head);
        break;
      }
    }
    if (lines.length >= 3) break;
  }
  const flat = (lines.length > 0 ? lines.join(' · ') : text).replaceAll(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * 卡文本 → 分段条目（回响页的渲染单元）。
 *
 * 用户实报：把整张卡原文贴上去等于没观测——壳子行（`<system-reminder>`、快照声明、
 * 免责声明）不是内容，分段行才是。这里按行首标签切段，无标签的后续行归入上一段（不丢换行），
 * 壳子行一律剔除。与 parseEchoSegments 同源词表（不开第二套标签判据）。
 */
export function splitEchoEntries(text: string): EchoEntry[] {
  const out: EchoEntry[] = [];
  let current: EchoEntry | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (SHELL_LINE_RE.test(line)) continue;
    const label = ECHO_SEGMENTS.find((name) => line.startsWith(`${name}：`));
    if (label !== undefined) {
      current = { name: label, lines: [line.slice(label.length + 1).trim()] };
      out.push(current);
      continue;
    }
    if (current !== undefined) current.lines.push(line);
  }
  for (const entry of out) {
    entry.lines = entry.lines.filter((line) => line !== '');
  }
  return out.filter((entry) => entry.lines.length > 0);
}

export class EchoLog {
  private items: EchoSnapshot[] = [];
  /**
   * 单调递增的观测代数：服务端投影据此 O(1) 判脏。
   *
   * 只随「缓冲真的变了」递增（record/clear），不随 list 读取变化——投影 apply 拿它
   * 与 state.rev 比一次就能决定是否重建，不必逐条 diff。进程内计数，重启归零，
   * 与缓冲本身同寿命。
   */
  private rev = 0;

  record(input: {
    at: number;
    agentId: string;
    sessionId: string;
    workspaceId: string;
    kind: 'injected' | 'skipped';
    reason?: string;
    fingerprint?: string;
    text?: string;
  }): EchoSnapshot {
    const text = input.text ?? '';
    const snapshot: EchoSnapshot = {
      at: input.at,
      agentId: input.agentId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      reason: input.reason ?? '',
      fingerprint: input.fingerprint ?? '',
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      segments: text === '' ? [] : parseEchoSegments(text),
      entries: text === '' ? [] : splitEchoEntries(text),
    };
    this.items.push(snapshot);
    if (this.items.length > ECHO_MAX) this.items.splice(0, this.items.length - ECHO_MAX);
    this.rev += 1;
    return snapshot;
  }

  /** 倒序（最新在前）；sessionId 空 = 全部会话。 */
  list(opts: { sessionId?: string; limit?: number } = {}): EchoSnapshot[] {
    const sessionId = (opts.sessionId ?? '').trim();
    const limit = Math.max(1, Math.min(ECHO_MAX, Math.floor(Number.isFinite(opts.limit) ? (opts.limit as number) : 20)));
    const filtered = sessionId === '' ? this.items : this.items.filter((item) => item.sessionId === sessionId);
    return filtered.slice(-limit).reverse();
  }

  size(): number {
    return this.items.length;
  }

  /** 缓冲当前代数（record/clear 各推一次；重启从 0 起）。 */
  revision(): number {
    return this.rev;
  }

  clear(): void {
    this.items = [];
    this.rev += 1;
  }
}
