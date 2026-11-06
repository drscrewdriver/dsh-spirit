/**
 * 蒸馏记忆存储（v0.3.5 长觉阶梯）：insight = 主题级洞察（≤120 字，鱼自己的话）。
 *
 * 定性：派生可重建（action_bias 同构），不进 recent()/deriveMood/注入（G15）。
 * 碰撞检查落点（用户点名 R7）：
 * - conflict 双留：两条矛盾 insight 都保状态 `conflict` 等人工裁决，**机器绝不自动删**；
 * - stale 传播：证据条目被更正/藏起 ⇒ 读侧 join 判 stale（不删不重算，条目回场即自愈）；
 * - 裁决走状态位：「信这条」= 败方 superseded_by 胜方；「都收起来」= 双方 superseded。
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { MinimalLogger } from '../persona/store.js';

export const INSIGHT_TEXT_MAX = 120;

export type InsightStatus = 'active' | 'conflict' | 'stale' | 'superseded';

export interface InsightRow {
  id: string;
  topicId: string;
  text: string;
  evidenceIds: string[];
  status: InsightStatus;
  supersededBy: string | null;
  sourceRun: string;
  createdAt: number;
  updatedAt: number;
}

function toRow(raw: Record<string, SQLOutputValue>): InsightRow | null {
  const id = typeof raw['id'] === 'string' ? raw['id'] : '';
  if (id === '') return null;
  let evidence: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(raw['evidence_json'] ?? '[]'));
    if (Array.isArray(parsed)) evidence = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    evidence = []; // 证据坏了不连坐条目：丢证据、留句子（fact_json 同法）
  }
  return {
    id,
    topicId: String(raw['topic_id'] ?? ''),
    text: String(raw['text'] ?? ''),
    evidenceIds: evidence,
    status: String(raw['status'] ?? 'active') as InsightStatus,
    supersededBy: typeof raw['superseded_by'] === 'string' ? raw['superseded_by'] : null,
    sourceRun: String(raw['source_run'] ?? ''),
    createdAt: Number(raw['created_at'] ?? 0),
    updatedAt: Number(raw['updated_at'] ?? 0),
  };
}

export class InsightStore {
  constructor(private readonly deps: { db: () => DatabaseSync | null; logger: MinimalLogger }) {}

  /**
   * 一批洞察落库（调用方保证在单事务里——ruminate 的原子性在这里不收口，只在此处被用）。
   * 文本 trim+钳 120 字；空文本拒收（宁缺毋滥）。@returns 实际落库行
   */
  insertBatch(now: number, runId: string, items: Array<{ topicId: string; text: string; evidenceIds: string[] }>): InsightRow[] {
    const db = this.deps.db();
    if (db === null) return [];
    const out: InsightRow[] = [];
    for (const item of items) {
      const text = item.text.trim().slice(0, INSIGHT_TEXT_MAX);
      if (text === '' || item.topicId === '') continue;
      const id = `ins-${now.toString(36)}-${out.length}-${Math.random().toString(36).slice(2, 6)}`;
      db.prepare(`INSERT INTO insight (id, topic_id, text, evidence_json, status, source_run, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`)
        .run(id, item.topicId, text, JSON.stringify(item.evidenceIds.slice(0, 24)), runId, now, now);
      const row = toRow({ id, topic_id: item.topicId, text, evidence_json: JSON.stringify(item.evidenceIds), status: 'active', superseded_by: null, source_run: runId, created_at: now, updated_at: now });
      if (row !== null) out.push(row);
    }
    return out;
  }

  /** 碰撞标记：双方都进 conflict（双留，等人工裁决；已是 superseded 的不打扰）。 */
  markConflict(ids: readonly string[], now: number): number {
    const db = this.deps.db();
    if (db === null) return 0;
    let n = 0;
    for (const id of ids) {
      n += (db.prepare(`UPDATE insight SET status = 'conflict', updated_at = ? WHERE id = ? AND status = 'active'`).run(now, id).changes ?? 0) > 0 ? 1 : 0;
    }
    return n;
  }

  /**
   * 人工裁决「信这条」：败方 supersede 到胜方（派生域的状态位改判，不动工作记忆）。
   * winnerId 空串 = 「都收起来」：败方直接 superseded（无胜方，不造假引用）。
   */
  resolveKeep(winnerId: string, loserId: string, now: number): boolean {
    const db = this.deps.db();
    if (db === null || loserId === '' || winnerId === loserId) return false;
    try {
      return (db.prepare(`UPDATE insight SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND status IN ('active','conflict','stale')`).run(winnerId, now, loserId).changes ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /** 读侧 stale 判定（不写库，join 一次在场判据）：证据全灭 ⇒ stale 语义。 */
  byTopic(topicId: string): InsightRow[] {
    const db = this.deps.db();
    if (db === null) return [];
    try {
      const rows = db.prepare(`SELECT * FROM insight WHERE topic_id = ? AND status <> 'superseded' ORDER BY created_at DESC LIMIT 100`).all(topicId) as Record<string, SQLOutputValue>[];
      return rows.map((raw) => {
        const row = toRow(raw);
        if (row === null) return null;
        // stale 传播在读侧：证据里至少一条仍在场 ⇒ active/conflict 原样；全被更正/藏起 ⇒ 展示为 stale（库值不动，自愈免费）
        if (row.status === 'active' || row.status === 'conflict') {
          const alive = row.evidenceIds.length === 0
            ? true
            : (db.prepare(`SELECT COUNT(*) AS n FROM experience WHERE superseded_by IS NULL AND hidden_at IS NULL AND id IN (${row.evidenceIds.map(() => '?').join(',')})`).get(...(row.evidenceIds as never[])) as Record<string, SQLOutputValue> | undefined)?.['n'];
          if (typeof alive === 'number' && alive === 0 && row.evidenceIds.length > 0) return { ...row, status: 'stale' as InsightStatus };
        }
        return row;
      }).filter((row): row is InsightRow => row !== null);
    } catch {
      return [];
    }
  }

  /** 冲突清单（面板碰撞裁决区数据源）：conflict 行按主题分组回。 */
  conflictList(): InsightRow[] {
    const db = this.deps.db();
    if (db === null) return [];
    try {
      const rows = db.prepare(`SELECT * FROM insight WHERE status = 'conflict' ORDER BY topic_id ASC, created_at DESC LIMIT 200`).all() as Record<string, SQLOutputValue>[];
      return rows.map(toRow).filter((row): row is InsightRow => row !== null);
    } catch {
      return [];
    }
  }

  /** 整表重算入口（派生缓存定性）。 */
  clearAll(): void {
    const db = this.deps.db();
    if (db === null) return;
    try {
      db.exec(`DELETE FROM insight`);
    } catch (err) {
      this.deps.logger.warn(`[spirit] insight 表清空失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
