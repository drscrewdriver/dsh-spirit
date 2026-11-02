/**
 * 未竟账（刀3）：会话收尾时把「还开着几个口子」落一行账，新会话开局带出一行。
 *
 * 四条定性，每条都对着一条既有红线：
 * 1. **基元 = session**（一会话一行，更晚的结算行 supersede 更早的）。绝不写进
 *    experience——deriveMood 会对条目计权，未竟入账等于伪造情绪输入。
 * 2. **只吃结构计数**（watcher.openLoops 的 todo 快照计数）。文案只拿档位：
 *    计数真值可以进库，但对外只在“确实数到”时才说数（不伪造具体性）。
 * 3. **append-only + superseded_by**，无 DELETE；GC 照 session-modes 的纪律——
 *    无条目不写入、读取侧过期不带出，行数有顶（每会话一行 × 会话数）。
 * 4. 触发只有 `agent/disposed` 与 turn/end 兜底（宿主没有 session/end）；
 *    重复入账由取代链收敛，不靠去重键。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { MinimalLogger } from '../persona/store.js';

export interface LedgerRow {
  id: string;
  sessionId: string;
  workspaceId: string;
  tsMs: number;
  turnSeq: number;
  /** 还开着的 todo 数（pending/open/todo 状态）。 */
  open: number;
  /** 其中进行中的条数。 */
  inProgress: number;
  supersededBy?: string;
}

function toRow(raw: Record<string, unknown>): LedgerRow {
  return {
    id: String(raw['id'] ?? ''),
    sessionId: String(raw['session_id'] ?? ''),
    workspaceId: String(raw['workspace_id'] ?? ''),
    tsMs: Number(raw['ts_ms'] ?? 0),
    turnSeq: Number(raw['turn_seq'] ?? 0),
    open: Number(raw['open_band'] ?? 0),
    inProgress: Number(raw['in_progress_band'] ?? 0),
    supersededBy: raw['superseded_by'] === undefined || raw['superseded_by'] === null ? undefined : String(raw['superseded_by']),
  };
}

export class LedgerStore {
  /** 降级模式的内存镜像（有顶；同 ExperienceStore 的纪律）。 */
  private readonly mirror: LedgerRow[] = [];

  constructor(private readonly deps: { db: DatabaseSync | null; logger: MinimalLogger }) {}

  /**
   * 结算一行（幂等：同 id 再写是 no-op；同会话更早的行被本行取代）。
   *
   * open/inProgress 全 0 的行**照记**——「确认收完」本身就是账（读侧据此知道
   * 这条会话线是善后过的，不是断头的）；但 openLoops 给 undefined 时调用方不该进来。
   */
  append(row: LedgerRow): void {
    if (this.deps.db === null) {
      if (!this.mirror.some((e) => e.id === row.id)) {
        // 同会话更早的结算行被本行取代（与 DB 臂同语义：置标记不删行）
        for (const e of this.mirror) {
          if (e.sessionId === row.sessionId && e.id !== row.id && e.supersededBy === undefined) e.supersededBy = row.id;
        }
        this.mirror.push(row);
        if (this.mirror.length > 200) this.mirror.shift();
      }
      return;
    }
    try {
      this.deps.db
        .prepare(
          `INSERT INTO session_ledger (id, session_id, workspace_id, ts_ms, turn_seq, open_band, in_progress_band, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(row.id, row.sessionId, row.workspaceId, row.tsMs, row.turnSeq, row.open, row.inProgress, row.tsMs);
      // 取代同会话更早的结算行：只置标记不删行
      this.deps.db
        .prepare(`UPDATE session_ledger SET superseded_by = ?, updated_at = ? WHERE session_id = ? AND id <> ? AND superseded_by IS NULL`)
        .run(row.id, row.tsMs, row.sessionId, row.id);
    } catch (err) {
      this.deps.logger.warn(`[spirit] 未竟账写入失败（退内存镜像）：${err instanceof Error ? err.message : String(err)}`);
      if (!this.mirror.some((e) => e.id === row.id)) this.mirror.push(row);
    }
  }

  /**
   * 读上一会话的未竟账（新会话开局用）：同工作区、排除本会话、最近一条未取代。
   * `maxAgeMs > 0` 时过期行不给（陈旧账不带出——不把上周的悬着的事当今天的）。
   */
  latestFor(workspaceId: string, excludeSessionId: string, now: number, maxAgeMs: number): LedgerRow | undefined {
    if (this.deps.db === null) {
      const pool = this.mirror
        .filter((e) => e.workspaceId === workspaceId && e.sessionId !== excludeSessionId && e.supersededBy === undefined)
        .sort((a, b) => b.tsMs - a.tsMs)[0];
      return pool !== undefined && (maxAgeMs <= 0 || now - pool.tsMs <= maxAgeMs) ? pool : undefined;
    }
    try {
      const raw = this.deps.db
        .prepare(
          `SELECT * FROM session_ledger
           WHERE workspace_id = ? AND session_id <> ? AND superseded_by IS NULL
           ORDER BY ts_ms DESC, id DESC LIMIT 1`,
        )
        .get(workspaceId, excludeSessionId) as Record<string, unknown> | undefined;
      if (raw === undefined) return undefined;
      const row = toRow(raw);
      if (maxAgeMs > 0 && now - row.tsMs > maxAgeMs) return undefined;
      return row;
    } catch {
      return undefined;
    }
  }
}

/**
 * 未竟账的对外文案（档位化，不伪造具体性）。
 *
 * 「还开着 X 个口子」只有计数真实存在时才给数；未知（undefined）⇒ 整行不给。
 * 措辞是体验语汇不是任务指令：它说"我这儿没放下"，不说"你还有 3 个 todo 没做完"。
 */
export function ledgerLineText(row: LedgerRow | undefined): string | undefined {
  if (row === undefined) return undefined;
  if (row.open <= 0) return undefined;
  if (row.open === 1) return row.inProgress > 0 ? '上次那条线还有一步正开着，我没放下' : '上次有一条线停在没收口的地方，我没放下';
  return `上次有 ${row.open} 处没收口，我记着它们还开着`;
}
