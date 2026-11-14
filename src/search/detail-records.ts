/**
 * 记录详情 · 非体验轨（v0.8.17）：任务 / 交付 / 记着 / 目的 / 实体。
 *
 * 门禁 TA.6(b)：读 `experience` 的文件不得同时读本体表 ⇒ 体验详情单独放 `detail-exp.ts`，
 * 本文件不出现 `FROM experience`。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { SpiritRecordDetailResult } from '../contract.js';

type DetailKind = 'task' | 'delivery' | 'memory' | 'goal' | 'entity';

function one(db: DatabaseSync, sql: string, params: readonly unknown[]): Record<string, unknown> | undefined {
  try {
    return db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

function many(db: DatabaseSync, sql: string, params: readonly unknown[]): Array<Record<string, unknown>> {
  try {
    return db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function timeLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 取非体验轨记录的明细。
 * @returns 明细；找不到 ⇒ undefined（调用方如实说“记录不在了”）
 */
export function loadRecordDetail(
  db: DatabaseSync | null | undefined,
  kind: DetailKind,
  id: string,
): SpiritRecordDetailResult | undefined {
  if (db === null || db === undefined || id.trim() === '') return undefined;

  if (kind === 'task') {
    const row = one(db, `SELECT id, title, status, next_step, workspace_id, updated_at FROM task WHERE id = ?`, [id]);
    if (row === undefined) return undefined;
    const title = String(row['title'] ?? '');
    const lines: string[] = [];
    const status = String(row['status'] ?? '');
    if (status !== '') lines.push(`状态：${status}`);
    const next = String(row['next_step'] ?? '');
    if (next !== '') lines.push(`下一步：${next}`);
    const ts = Number(row['updated_at'] ?? 0);
    const when = timeLabel(ts);
    if (when !== '') lines.push(`记录时间：${when}`);
    // 这条任务线的交付（最多 6 条）：任务本身没有星点，明细里把它做成了什么列出来
    const deliveries = many(
      db,
      `SELECT t.card_line, t.ts_ms FROM task_delivery d JOIN txn_entry t ON t.id = d.delivery_id
       WHERE d.task_id = ? AND d.superseded_at IS NULL ORDER BY t.ts_ms DESC LIMIT 6`,
      [id],
    );
    if (deliveries.length > 0) {
      lines.push(`交付（${deliveries.length}）：`);
      for (const item of deliveries) lines.push(`· ${String(item['card_line'] ?? '')}`);
    } else {
      lines.push('交付：暂无');
    }
    const workspace = String(row['workspace_id'] ?? '');
    if (workspace !== '') lines.push(`工作区：${workspace}`);
    return { kind, id, title, lines, ts };
  }

  if (kind === 'delivery') {
    const row = one(db, `SELECT id, card_line, summary, ts_ms, session_id, source_trust FROM txn_entry WHERE id = ?`, [id]);
    if (row === undefined) return undefined;
    const title = String(row['card_line'] ?? '');
    const lines: string[] = [];
    const summary = String(row['summary'] ?? '');
    if (summary !== '') lines.push(`摘要：${summary}`);
    const when = timeLabel(Number(row['ts_ms'] ?? 0));
    if (when !== '') lines.push(`记录时间：${when}`);
    const session = String(row['session_id'] ?? '');
    if (session !== '') lines.push(`会话：${session.slice(0, 12)}`);
    const trust = String(row['source_trust'] ?? '');
    if (trust !== '') lines.push(`来源：${trust}`);
    return { kind, id, title, lines, ts: Number(row['ts_ms'] ?? 0) };
  }

  if (kind === 'memory') {
    const row = one(db, `SELECT id, text, kind, scope, pinned, updated_at FROM model_memory WHERE id = ?`, [id]);
    if (row === undefined) return undefined;
    const title = String(row['text'] ?? '');
    const lines: string[] = [
      `账本：${String(row['scope'] ?? '')} · 类型：${String(row['kind'] ?? '')}`,
      Number(row['pinned'] ?? 0) === 1 ? '已钉住（每轮注入）' : '未钉住',
    ];
    const when = timeLabel(Number(row['updated_at'] ?? 0));
    if (when !== '') lines.push(`记录时间：${when}`);
    return { kind, id, title, lines, ts: Number(row['updated_at'] ?? 0) };
  }

  if (kind === 'goal') {
    const row = one(db, `SELECT id, title, status, why, updated_at FROM goal WHERE id = ?`, [id]);
    if (row === undefined) return undefined;
    const title = String(row['title'] ?? '');
    const lines: string[] = [`状态：${String(row['status'] ?? '')}`];
    const why = String(row['why'] ?? '');
    if (why !== '') lines.push(`为什么：${why}`);
    const when = timeLabel(Number(row['updated_at'] ?? 0));
    if (when !== '') lines.push(`记录时间：${when}`);
    return { kind, id, title, lines, ts: Number(row['updated_at'] ?? 0) };
  }

  const row = one(db, `SELECT id, name, kind, importance, aliases_json, updated_at FROM entity WHERE id = ?`, [id]);
  if (row === undefined) return undefined;
  const title = String(row['name'] ?? '');
  const lines: string[] = [`类型：${String(row['kind'] ?? '')} · 在意度：${String(row['importance'] ?? '')}`];
  try {
    const aliases: unknown = JSON.parse(String(row['aliases_json'] ?? '[]'));
    if (Array.isArray(aliases) && aliases.length > 0) lines.push(`别名：${aliases.map((item) => String(item)).join('、')}`);
  } catch {
    /* 坏 JSON ⇒ 不列别名 */
  }
  const when = timeLabel(Number(row['updated_at'] ?? 0));
  if (when !== '') lines.push(`记录时间：${when}`);
  return { kind, id, title, lines, ts: Number(row['updated_at'] ?? 0) };
}
