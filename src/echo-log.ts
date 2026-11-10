/**
 * 注入回响面（v0.7 / 对表 dsh-prime-memory 的 memory 激活槽位）：
 * 每轮 `agent/pre-step` 落一条快照——注入了什么（全文 + 指纹 + 分段行数）、或为什么没注入（门名）。
 *
 * 三条边界：
 * 1. **进程内环形缓冲，不落库**：这是观测面（诊断用），不是记忆真源。重启归零不算丢数据。
 * 2. **只存已发生的**：跳过轮也记一条（reason=门名）——"这轮为什么没卡"正是最难查的那类。
 * 3. **有顶**：全局 200 条，防面板把日志面当数据库用。
 */
import type { SpiritEchoSegment, SpiritEchoSnapshot } from './contract.js';

export const ECHO_SEGMENTS = ['状态', '反馈', '线程', '事务', '刚刚', '想起', '开场'] as const;
const ECHO_MAX = 200;

/** 快照形状单源在契约（RPC 响应直接用），本模块只负责采集与缓冲。 */
export type EchoSegmentCount = SpiritEchoSegment;
export type EchoSnapshot = SpiritEchoSnapshot;

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

export class EchoLog {
  private items: EchoSnapshot[] = [];

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
    };
    this.items.push(snapshot);
    if (this.items.length > ECHO_MAX) this.items.splice(0, this.items.length - ECHO_MAX);
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

  clear(): void {
    this.items = [];
  }
}
