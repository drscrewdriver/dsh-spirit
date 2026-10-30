/**
 * 注入统计（纯内存注册表，零文件 I/O）。
 *
 * 口径说清：**这是"注入统计"，不是离线 recall@k**——运行时没有 ground truth，
 * 命中率只能按"发过卡的轮次里有多少真被确认生效"算。把两者混为一个词，
 * 后面所有归因结论都建在错的分母上（姊妹包为此专门在注释里钉过口径）。
 *
 * 生命周期：`agent/disposed` 即删；不持久化（面板读的是"这个会话现在怎么样"，
 * 重启后从 0 开始是诚实的，伪造历史反而误导）。
 */

import type { SpiritMoodView, SpiritSessionStats } from './contract.js';
import type { Gate, PreStepOutcome } from './spirit.js';
import type { SpiritVerdict, Mood } from './types.js';

interface Counters {
  sessionId: string;
  injectedTurns: number;
  bypassedTurns: number;
  offTurns: number;
  /** 确认生效过的卡数（两段式生效的分子）。 */
  confirmedTurns: number;
  lastCardBytes: number;
  lastRecallHits: number;
  lastOutcome: Gate;
  mood: Mood | undefined;
  drscVerdict: SpiritVerdict;
  degraded: boolean;
  entryCount: number;
  updatedAt: number;
}

export interface StatsInput {
  agentId: string;
  sessionId: string;
  now: number;
  outcome: PreStepOutcome;
  /** 本轮检索段实际进卡的条数。 */
  recallHits: number;
  entryCount: number;
  mood: Mood | undefined;
  drscVerdict: SpiritVerdict;
  degraded: boolean;
}

export class SpiritStats {
  private readonly byAgent = new Map<string, Counters>();

  private ensure(agentId: string, sessionId: string, now: number): Counters {
    let row = this.byAgent.get(agentId);
    if (row === undefined) {
      row = {
        sessionId,
        injectedTurns: 0,
        bypassedTurns: 0,
        offTurns: 0,
        confirmedTurns: 0,
        lastCardBytes: 0,
        lastRecallHits: 0,
        lastOutcome: 'injected',
        mood: undefined,
        drscVerdict: 'skipped',
        degraded: false,
        entryCount: 0,
        updatedAt: now,
      };
      this.byAgent.set(agentId, row);
    }
    row.sessionId = sessionId;
    row.updatedAt = now;
    return row;
  }

  /** 记一轮结果（pre-step 出口调这里，而不是在业务分支里散着 +1）。 */
  note(input: StatsInput): void {
    const row = this.ensure(input.agentId, input.sessionId, input.now);
    row.entryCount = input.entryCount;
    row.mood = input.mood;
    row.drscVerdict = input.drscVerdict;
    row.degraded = input.degraded;
    row.lastRecallHits = input.recallHits;
    row.lastOutcome = input.outcome.reason;
    switch (input.outcome.kind) {
      case 'injected':
        row.injectedTurns += 1;
        row.lastCardBytes = input.outcome.bytes;
        break;
      case 'recorded':
        row.bypassedTurns += 1;
        row.lastCardBytes = 0;
        break;
      default:
        // passthrough：区分"会话关了"与其它静默（unchanged/budget/error 都属正常节流）
        if (input.outcome.reason === 'session-off' || input.outcome.reason === 'subagent') row.offTurns += 1;
        row.lastCardBytes = 0;
        break;
    }
  }

  /** 卡被确认生效（会话日志看到自家行）。 */
  noteConfirmed(agentId: string): void {
    const row = this.byAgent.get(agentId);
    if (row !== undefined) row.confirmedTurns += 1;
  }

  /** agent 销毁即释放（不然长会话列表会无界攒条目）。 */
  release(agentId: string): void {
    this.byAgent.delete(agentId);
  }

  /** 取某个 agent 的快照（面板/pill 数据源；找不到返回 null，不编零值假数据）。 */
  snapshot(agentId: string, mode: { off: boolean; bypass: boolean }): SpiritSessionStats | null {
    const row = this.byAgent.get(agentId);
    if (row === undefined) return null;
    const mood: SpiritMoodView | null =
      row.mood === undefined
        ? null
        : { valence: row.mood.valence, arousal: row.mood.arousal, label: row.mood.label, revision: row.mood.revision, tendency: '' };
    return {
      sessionId: row.sessionId,
      entryCount: row.entryCount,
      moodLabel: row.mood?.label ?? '',
      valence: row.mood?.valence ?? '',
      arousal: row.mood?.arousal ?? '',
      lastCardBytes: row.lastCardBytes,
      injectedTurns: row.injectedTurns,
      bypassedTurns: row.bypassedTurns,
      offTurns: row.offTurns,
      lastRecallHits: row.lastRecallHits,
      updatedAt: row.updatedAt,
      drscVerdict: row.drscVerdict,
      degraded: row.degraded,
      mood,
      mode,
    };
  }

  /** 按 sessionId 找 agent（面板只有 sessionId）。 */
  agentOfSession(sessionId: string): string | undefined {
    for (const [agentId, row] of this.byAgent.entries()) {
      if (row.sessionId === sessionId) return agentId;
    }
    return undefined;
  }

  /**
   * 最近有活动的会话（设置页分节拿不到会话上下文时的兜底）。
   *
   * 为什么在服务端算：客户端要自己做这件事就得先拉一份"会话列表"，
   * 而本插件根上就不维护会话索引（那是 DRSC 的地盘）。
   */
  latest(): { agentId: string; sessionId: string } | null {
    let best: { agentId: string; sessionId: string; updatedAt: number } | null = null;
    for (const [agentId, row] of this.byAgent.entries()) {
      if (best === null || row.updatedAt > best.updatedAt) best = { agentId, sessionId: row.sessionId, updatedAt: row.updatedAt };
    }
    return best === null ? null : { agentId: best.agentId, sessionId: best.sessionId };
  }

  /** 确认生效计数（A/B 归因报告用）。 */
  confirmedOf(agentId: string): number {
    return this.byAgent.get(agentId)?.confirmedTurns ?? 0;
  }
}
