/**
 * 主题分区存储（v0.3.5 长觉阶梯）。
 *
 * 两源同表：heuristic（cues×trigger 确定性聚桶，零模型即时回填）与 distilled（长觉 LLM 归题精修）。
 * 定性是**派生缓存**（action_bias 同构）：整表可重算，允许 UPDATE/DELETE；
 * 但绝不进 recent()/deriveMood/注入——G15 实闸盯守。
 *
 * 归属改判 = 旧关联行置 superseded_at + 写新行（append-only 精神在派生域的延续：
 * 改判历史可回看，整表重算时才真删）。topicCap 有顶：主题不许长成长尾。
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { MinimalLogger } from '../persona/store.js';

export const TOPIC_CAP = 32;
export const TOPIC_NAME_MAX = 40;
/** 兜底位：归不进任何主题的条目去这里（照姊妹包 WING_FALLBACK 的防发散做法）。 */
export const TOPIC_GENERAL = 'general';

export interface TopicRow {
  id: string;
  name: string;
  origin: string;
  status: string;
  createdAt: number;
}

/** 名字 → 稳定 id：同名再归必同 id（哈希不做冲突解决，name 唯一性由 ensureTopic 的查询把守）。 */
function topicIdOf(name: string): string {
  let hash = 5381;
  for (let i = 0; i < name.length; i += 1) hash = ((hash * 33) ^ name.charCodeAt(i)) >>> 0;
  return `t-${hash.toString(36)}`;
}

export class TopicStore {
  constructor(private readonly deps: { db: () => DatabaseSync | null; logger: MinimalLogger }) {}

  /** 确保主题存在（trim+钳长度+去重）；超 cap 时新主题不建、返回 general 兜底位。 */
  ensureTopic(name: string, origin: 'heuristic' | 'distilled', now: number): TopicRow {
    const clean = name.trim().slice(0, TOPIC_NAME_MAX);
    const target = clean === '' ? TOPIC_GENERAL : clean;
    const id = topicIdOf(target);
    const db = this.deps.db();
    const fallback: TopicRow = { id, name: target, origin, status: 'active', createdAt: now };
    if (db === null) return fallback;
    try {
      const found = db.prepare(`SELECT id, name, origin, status, created_at FROM topic WHERE id = ?`).get(id) as Record<string, SQLOutputValue> | undefined;
      if (found !== undefined) {
        return { id: String(found['id']), name: String(found['name']), origin: String(found['origin'] ?? origin), status: String(found['status'] ?? 'active'), createdAt: Number(found['created_at'] ?? now) };
      }
      const countRow = db.prepare(`SELECT COUNT(*) AS n FROM topic WHERE status = 'active'`).get() as Record<string, SQLOutputValue> | undefined;
      if (typeof countRow?.['n'] === 'number' && countRow['n'] >= TOPIC_CAP && target !== TOPIC_GENERAL) {
        // cap 吃满：不再开新主题，归到兜底位（LLM 想造 50 个题也塞不下，防长尾）
        return this.ensureTopic(TOPIC_GENERAL, origin, now);
      }
      db.prepare(`INSERT INTO topic (id, name, origin, status, created_at) VALUES (?, ?, ?, 'active', ?)`).run(id, target, origin, now);
      return fallback;
    } catch (err) {
      this.deps.logger.warn(`[spirit] 主题确保失败（本次退内存形状）：${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  }

  /**
   * 条目归题（改判=旧行置 superseded_at + 写新行，同事务）。
   * 同题重复归属是幂等 no-op（返回 false 不算失败）。
   */
  assign(entryId: string, topicId: string, origin: 'heuristic' | 'distilled', now: number): boolean {
    const db = this.deps.db();
    if (db === null || entryId === '' || topicId === '') return false;
    try {
      const current = db.prepare(`SELECT topic_id FROM experience_topic WHERE entry_id = ? AND superseded_at IS NULL`).get(entryId) as Record<string, SQLOutputValue> | undefined;
      if (current !== undefined && String(current['topic_id'] ?? '') === topicId) return false;
      db.exec('BEGIN');
      try {
        db.prepare(`UPDATE experience_topic SET superseded_at = ? WHERE entry_id = ? AND superseded_at IS NULL`).run(now, entryId);
        db.prepare(`INSERT INTO experience_topic (topic_id, entry_id, origin, created_at) VALUES (?, ?, ?, ?)`).run(topicId, entryId, origin, now);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return true;
    } catch (err) {
      this.deps.logger.warn(`[spirit] 条目归题失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** 主题列表 + 每主题在场条目数/洞察数（面板主题视图数据源）。 */
  topicsWithCounts(): Array<{ topic: TopicRow; entries: number; insights: number }> {
    const db = this.deps.db();
    if (db === null) return [];
    try {
      const topics = db.prepare(`SELECT id, name, origin, status, created_at FROM topic WHERE status = 'active' ORDER BY created_at ASC`).all() as Record<string, SQLOutputValue>[];
      return topics.map((row) => {
        const id = String(row['id'] ?? '');
        const entries = db.prepare(`SELECT COUNT(*) AS n FROM experience_topic et WHERE et.topic_id = ? AND et.superseded_at IS NULL AND EXISTS (SELECT 1 FROM experience e WHERE e.id = et.entry_id AND e.superseded_by IS NULL AND e.hidden_at IS NULL)`).get(id) as Record<string, SQLOutputValue> | undefined;
        const insights = db.prepare(`SELECT COUNT(*) AS n FROM insight WHERE topic_id = ? AND status IN ('active','conflict')`).get(id) as Record<string, SQLOutputValue> | undefined;
        return {
          topic: { id, name: String(row['name'] ?? ''), origin: String(row['origin'] ?? ''), status: 'active', createdAt: Number(row['created_at'] ?? 0) },
          entries: typeof entries?.['n'] === 'number' ? entries['n'] : 0,
          insights: typeof insights?.['n'] === 'number' ? insights['n'] : 0,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * 确定性骨架回填：按「首条 cue × trigger」聚桶成主题（零模型，装好即有分区）。
   * cue 只从结构化事实来（用户原文永不进 cues 的纪律在这里免费继承）。
   * @returns 本次实际归题的条目数
   */
  heuristicBackfill(entries: Array<{ id: string; trigger: string; cues: string[] }>, now: number): number {
    let assigned = 0;
    for (const entry of entries) {
      const bucket = entry.cues[0];
      if (bucket === undefined) continue; // 无 cue 的条目不强塞主题（宁缺毋滥，长觉再归）
      const topic = this.ensureTopic(`${bucket}`, 'heuristic', now);
      if (this.assign(entry.id, topic.id, 'heuristic', now)) assigned += 1;
    }
    return assigned;
  }

  /** 整表重算入口（派生缓存定性：清空是合法动作，不是数据事故）。 */
  clearAll(): void {
    const db = this.deps.db();
    if (db === null) return;
    try {
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM experience_topic');
        db.exec('DELETE FROM topic');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      this.deps.logger.warn(`[spirit] 主题表清空失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
