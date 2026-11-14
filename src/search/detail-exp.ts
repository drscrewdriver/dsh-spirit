/**
 * 记录详情 · 体验轨（v0.8.17）：单独文件守法 TA.6(b)（读 experience 的文件不得读本体表）。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { SpiritRecordDetailResult } from '../contract.js';

function timeLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 取一条体验条目的明细（正文 + 残句 + 情绪/来源 + 时间）。
 * @returns 明细；找不到 ⇒ undefined
 */
export function loadExperienceDetail(
  db: DatabaseSync | null | undefined,
  id: string,
): SpiritRecordDetailResult | undefined {
  if (db === null || db === undefined || id.trim() === '') return undefined;
  try {
    const row = db
      .prepare(`SELECT id, text, gist, trigger, notice, reaction, lane, salience, ts_ms, session_id FROM experience WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const title = String(row['text'] ?? '');
    const lines: string[] = [];
    const gist = String(row['gist'] ?? '');
    if (gist !== '') lines.push(`一句话：${gist}`);
    lines.push(
      `情绪：${String(row['trigger'] ?? '')} · ${String(row['notice'] ?? '')} · ${String(row['reaction'] ?? '')}`,
    );
    const salience = row['salience'];
    if (salience !== null && salience !== undefined) lines.push(`在意度：${String(salience)}/2`);
    const lane = String(row['lane'] ?? '');
    if (lane !== '') lines.push(`来源：${lane === 'drsc' ? '会话扫描（drsc）' : '实时（live）'}`);
    const when = timeLabel(Number(row['ts_ms'] ?? 0));
    if (when !== '') lines.push(`记录时间：${when}`);
    const session = String(row['session_id'] ?? '');
    if (session !== '') lines.push(`会话：${session.slice(0, 12)}`);
    return { kind: 'experience', id, title, lines, ts: Number(row['ts_ms'] ?? 0) };
  } catch {
    return undefined;
  }
}
