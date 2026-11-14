/**
 * L1 → 本体重建（v0.8.24）：历史重建不再扫会话（DRSC），改读"蒸馏激活中的 L1 记忆"。
 *
 * 映射（只做流程/交付/实体，不复制知识正文）：
 * - `work_task`    → `task`（标题 80 字；含 完成/done/已推送/交付/上线 ⇒ done，否则 progress）
 * - `work_artifact`→ `txn_entry`（card_line 80 字 / summary 240 字，trust=derived_summary）
 * - `graph_nodes` / repo_key / workspace → `entity`（project/concept；只建实体，不写知识）
 * - 之后：`entity_alias` → `entity_upstream_link` → `entity_record_ref`（知识只存引用）
 *
 * 幂等：id 由 L1 record_id 派生（`l1-task:<id>` / `l1-dlv:<id>` / 实体按归一化名），重跑覆盖不重复。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { MinimalLogger } from '../persona/store.js';
import { TRUST_DERIVED_SUMMARY } from '../types.js';
import { buildEntityAliases, buildEntityLinks, linkKnowledgeRecords, lastPathSegment, normalizeEntityName } from './entity-align.js';
import { loadL1Entities, searchL1Records, type L1RecordRow } from './l1-source.js';

export interface L1IngestDeps {
  db: () => DatabaseSync | null;
  ontology: {
    upsertTask(input: { id: string; title: string; status?: string; workspaceId: string; tsMs: number }): boolean;
    upsertEntity(input: { kind: 'project' | 'concept'; name: string; alias?: string; tsMs: number }): { id: string } | null;
  };
  txn: {
    insert(input: {
      id: string;
      sessionId: string;
      workspaceId: string;
      tsMs: number;
      turnSeq: number;
      cardLine: string;
      summary?: string | null;
      sourceTrust: typeof TRUST_DERIVED_SUMMARY;
    }): { ok: boolean };
  };
  dbPath?: string;
  logger: MinimalLogger;
}

export interface L1IngestResult {
  total: number;
  tasks: number;
  deliveries: number;
  entities: number;
  links: number;
  refs: number;
  knowledge: number;
}

const DONE_PATTERN = /(完成|done|已推送|推送完成|交付|上线|落地|发布)/iu;

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * 读 L1 并重建本体/交付/实体引用。
 *
 * @param opts.days - 回看天数（0 = 全史，默认 0）
 * @param opts.limit - 读取上限（默认 800，封顶 2000）
 */
export function ingestL1(deps: L1IngestDeps, opts: { days?: number; limit?: number } = {}, now = Date.now()): L1IngestResult {
  const db = deps.db();
  const empty: L1IngestResult = { total: 0, tasks: 0, deliveries: 0, entities: 0, links: 0, refs: 0, knowledge: 0 };
  if (db === null) return empty;
  const days = Number.isFinite(opts.days) ? Math.max(0, Math.floor(opts.days as number)) : 0;
  const limit = Math.max(1, Math.min(2000, Math.floor(Number.isFinite(opts.limit) ? (opts.limit as number) : 800)));
  const rows: L1RecordRow[] = searchL1Records({
    days,
    limit,
    ...(deps.dbPath === undefined ? {} : { dbPath: deps.dbPath }),
  });

  // 1) 实体：上游 graph_nodes + repo/workspace（只建实体；不写知识正文）
  const entities = new Map<string, string>();
  const addEntity = (name: string, kind: 'project' | 'concept'): void => {
    const trimmed = name.trim();
    const norm = normalizeEntityName(trimmed);
    if (norm === '') return;
    const hit = deps.ontology.upsertEntity({ kind, name: trimmed, tsMs: now });
    if (hit !== null) entities.set(norm, hit.id);
  };
  for (const item of loadL1Entities(deps.dbPath)) {
    addEntity(item.repoKey !== '' ? item.repoKey : item.name, item.repoKey !== '' ? 'project' : 'concept');
  }
  for (const row of rows) {
    const repo = row.repoKey ?? '';
    if (repo !== '') addEntity(lastPathSegment(repo), 'project');
    const workspace = row.workspaceId ?? '';
    if (workspace !== '') addEntity(lastPathSegment(workspace), 'project');
  }

  // 2) 任务线（work_task）与交付（work_artifact）
  let tasks = 0;
  let deliveries = 0;
  for (const row of rows) {
    if (row.type === 'work_task') {
      const ok = deps.ontology.upsertTask({
        id: `l1-task:${row.id}`,
        title: clip(row.content, 80),
        status: DONE_PATTERN.test(row.content) ? 'done' : 'progress',
        workspaceId: row.workspaceId !== undefined && row.workspaceId !== '' ? row.workspaceId : 'ws:global',
        tsMs: row.tsMs || now,
      });
      if (ok) tasks += 1;
    } else if (row.type === 'work_artifact') {
      try {
        const written = deps.txn.insert({
          id: `l1-dlv:${row.id}`,
          sessionId: 'l1',
          workspaceId: row.workspaceId !== undefined && row.workspaceId !== '' ? row.workspaceId : 'ws:global',
          tsMs: row.tsMs || now,
          turnSeq: 0,
          cardLine: clip(row.content, 80),
          summary: clip(row.content, 240),
          sourceTrust: TRUST_DERIVED_SUMMARY,
        });
        if (written.ok) deliveries += 1;
      } catch {
        /* 主键冲突/闸拒 ⇒ 幂等跳过 */
      }
    }
  }

  // 3) 实体对齐 + 知识引用（只存 id/type/ts）
  const aliases = buildEntityAliases(db);
  const align = buildEntityLinks(db, loadL1Entities(deps.dbPath), now);
  const refs = linkKnowledgeRecords(db, rows);
  const knowledge = rows.filter((row) => row.type !== 'work_task' && row.type !== 'work_artifact' && row.type !== 'episodic').length;

  deps.logger.info(
    `[spirit] L1 重建：读 ${rows.length} 条（知识性 ${knowledge} 条只存引用）· task ${tasks} · 交付 ${deliveries} · 实体 ${entities.size} · alias ${aliases} · link ${align.links} · ref ${refs}`,
  );
  return { total: rows.length, tasks, deliveries, entities: entities.size, links: align.links, refs, knowledge };
}
