/**
 * 因果边存储（v0.3.5 长觉阶梯）：两源同表——heuristic（确定性打底）+ llm（长觉投影）。
 *
 * 纪律（照姊妹包图谱写面的实战形状，取其适合本库规模的部分）：
 * - relation 是**开放词表**：只钳长度不做白名单（LLM 提的新关系词不该被静默丢），
 *   但「因果」的规范集单源在 types.ts SPIRIT_CAUSAL_RELATIONS（截断优先与图例都读它）；
 * - LLM 边必须带 evidence（两端与佐证条目），无证据的提案拒收——「边必须可解释」的星海不变式延伸；
 * - 同 (from,to) 对 llm 覆盖 heuristic（投影更可信）；
 * - 派生缓存定性：整表可重算，允许 DELETE；不进 recent()/deriveMood/注入（G15）。
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { MinimalLogger } from '../persona/store.js';
import { SPIRIT_CAUSAL_RELATIONS, TRIGGER_RECOVERY, TRIGGER_TOOL_FAILURE, type ExperienceEntry } from '../types.js';

export const EDGE_RELATION_MAX = 24;
export const EDGE_CAP = 2000;

export interface CausalEdgeRow {
  id: string;
  fromEntry: string;
  toEntry: string;
  relation: string;
  origin: string;
  evidenceIds: string[];
  confidence: number;
}

/** 规范因果判定（单源四词；面板与截断优先用它，不各抄词表）。 */
export function isCausalRelation(relation: string): boolean {
  return (SPIRIT_CAUSAL_RELATIONS as readonly string[]).includes(relation);
}

function edgeId(from: string, to: string, relation: string, origin: string): string {
  let hash = 5381;
  const key = `${origin}|${from}|${to}|${relation}`;
  for (let i = 0; i < key.length; i += 1) hash = ((hash * 33) ^ key.charCodeAt(i)) >>> 0;
  return `ce-${hash.toString(36)}`;
}

function toRow(raw: Record<string, SQLOutputValue>): CausalEdgeRow | null {
  const id = typeof raw['id'] === 'string' ? raw['id'] : '';
  if (id === '') return null;
  let evidence: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(raw['evidence_json'] ?? '[]'));
    if (Array.isArray(parsed)) evidence = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    evidence = [];
  }
  return {
    id,
    fromEntry: String(raw['from_entry'] ?? ''),
    toEntry: String(raw['to_entry'] ?? ''),
    relation: String(raw['relation'] ?? ''),
    origin: String(raw['origin'] ?? 'heuristic'),
    evidenceIds: evidence,
    confidence: Number(raw['confidence'] ?? 500),
  };
}

/**
 * 启发式打底（纯函数，零模型）：同会话里「失败 → 恢复」相邻对给一条 '导致' 边
 * （那次恢复是被那次失败逼出来的——这是查表语义能确证的唯一因果对）。
 * supersede 关系**不在此表**：星海已有 kind:'supersede' 边，双画是噪音。
 */
export function heuristicEdges(entries: readonly ExperienceEntry[]): Array<{ from: string; to: string; relation: string }> {
  const out: Array<{ from: string; to: string; relation: string }> = [];
  const bySession = new Map<string, ExperienceEntry[]>();
  for (const entry of entries) {
    if (entry.supersededBy !== undefined || entry.hiddenAt !== undefined) continue;
    const list = bySession.get(entry.sessionId) ?? [];
    list.push(entry);
    bySession.set(entry.sessionId, list);
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => a.tsMs - b.tsMs);
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const cur = list[i];
      if (prev !== undefined && cur !== undefined && prev.trigger === TRIGGER_TOOL_FAILURE && cur.trigger === TRIGGER_RECOVERY) {
        out.push({ from: prev.id, to: cur.id, relation: '导致' });
      }
    }
  }
  return out;
}

export class EdgeStore {
  constructor(private readonly deps: { db: () => DatabaseSync | null; logger: MinimalLogger }) {}

  /** 启发式回填（幂等：同 id REPLACE，重复跑不多画）。 */
  backfillHeuristic(edges: ReadonlyArray<{ from: string; to: string; relation: string }>, now: number): number {
    const db = this.deps.db();
    if (db === null) return 0;
    let n = 0;
    try {
      db.exec('BEGIN');
      try {
        for (const edge of edges) {
          if (edge.from === '' || edge.to === '' || edge.from === edge.to) continue;
          db.prepare(`INSERT OR REPLACE INTO causal_edge (id, from_entry, to_entry, relation, origin, evidence_json, confidence, source_run, created_at) VALUES (?, ?, ?, ?, 'heuristic', '[]', 500, '', ?)`)
            .run(edgeId(edge.from, edge.to, edge.relation, 'heuristic'), edge.from, edge.to, edge.relation.slice(0, EDGE_RELATION_MAX), now);
          n += 1;
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return n;
    } catch (err) {
      this.deps.logger.warn(`[spirit] 启发式边回填失败：${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /**
   * LLM 投影边插入（单事务由调用方收口）。无 evidence 拒收；同 (from,to) 对删 heuristic 让位。
   * @returns 实际落库边数
   */
  insertLlm(runId: string, edges: ReadonlyArray<{ from: string; to: string; relation: string; evidenceIds: string[]; confidence?: number }>, now: number): number {
    const db = this.deps.db();
    if (db === null) return 0;
    let n = 0;
    for (const edge of edges) {
      const relation = edge.relation.trim().slice(0, EDGE_RELATION_MAX);
      if (edge.from === '' || edge.to === '' || edge.from === edge.to || relation === '') continue;
      if (edge.evidenceIds.length === 0) continue; // 无证据的因果提案拒收（「边必须可解释」不变式）
      db.prepare(`DELETE FROM causal_edge WHERE from_entry = ? AND to_entry = ? AND origin = 'heuristic'`).run(edge.from, edge.to);
      const confidence = Math.max(0, Math.min(1000, Math.round(edge.confidence ?? 700)));
      db.prepare(`INSERT OR REPLACE INTO causal_edge (id, from_entry, to_entry, relation, origin, evidence_json, confidence, source_run, created_at) VALUES (?, ?, ?, ?, 'llm', ?, ?, ?, ?)`)
        .run(edgeId(edge.from, edge.to, relation, 'llm'), edge.from, edge.to, relation, JSON.stringify(edge.evidenceIds.slice(0, 24)), confidence, runId, now);
      n += 1;
    }
    return n;
  }

  /** 星海并边读面（causal 优先给足，其余按 confidence 降序；总量有顶）。 */
  forSea(limit = 600): CausalEdgeRow[] {
    const db = this.deps.db();
    if (db === null) return [];
    try {
      const rows = db.prepare(`SELECT * FROM causal_edge ORDER BY confidence DESC, created_at DESC LIMIT ?`).all(Math.min(EDGE_CAP, limit)) as Record<string, SQLOutputValue>[];
      return rows.map(toRow).filter((row): row is CausalEdgeRow => row !== null);
    } catch {
      return [];
    }
  }

  clearAll(): void {
    const db = this.deps.db();
    if (db === null) return;
    try {
      db.exec(`DELETE FROM causal_edge`);
    } catch (err) {
      this.deps.logger.warn(`[spirit] 因果边表清空失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
