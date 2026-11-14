/**
 * 回响条目的时间反查 + memid 引用（v0.8.6 / v0.8.7 补 ref）。
 *
 * 用户实报两条：
 * 1. 条目必须回答"这条对应的时间"——不然「线程：X · 进行中」只是把卡抄了一遍。
 * 2. 回响要能挂回**具体的记忆条目**（memid）：`plugin-9lang-five-dim` 这样的任务/交付/体验 id
 *    才是内容，`echo-<ts>` 只是这一轮的观测编号，不该当条目标题。
 *
 * 三条纪律：
 * 1. **查不到就标 unknown、ref 缺省，不编**：行内容可能被 clipLine 截过、真源可能已更正。
 * 2. **只用带索引的等值/前缀查**：card_line / title 走 v13 索引；体验句由 `echo-times-exp.ts`
 *    读（门禁 TA.6(b)：读 experience 的文件不得也读本体表 ⇒ 按轨拆两个读面）。
 * 3. **降级面（db=null）全标 unknown**：观测面坏了不能拖垮注入。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { SpiritEchoEntry, SpiritEchoRef } from './contract.js';
import { experienceRef } from './echo-times-exp.js';

/** 反查用的前缀长度：注入行被 clipLine 截过，取前 40 字足够定位。 */
const PREFIX_CHARS = 40;

/** LIKE 字面量转义（用户内容里的 % _ 不当通配符）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function prefixOf(text: string): string {
  const clean = Array.from(text.trim()).slice(0, PREFIX_CHARS).join('');
  return clean === '' ? '' : `${escapeLike(clean)}%`;
}

/** 取 `标签：内容` 形式行里的内容部分（反馈段是 `认可：<card_line>` 这种双层）。 */
function afterFirstColon(text: string): string {
  const index = text.indexOf('：');
  return index < 0 ? text : text.slice(index + 1).trim();
}

/** 查一行 `id + 时刻`：命中 ⇒ {ts, ref}；查不到/坏行 ⇒ {}（不编造）。 */
function queryRef(
  db: DatabaseSync,
  sql: string,
  params: readonly unknown[],
  kind: SpiritEchoRef['kind'],
  label: string,
): { ts?: number; ref?: SpiritEchoRef } {
  try {
    const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
    if (row === undefined) return {};
    const ts = Number(row['ts']);
    const id = String(row['id'] ?? '');
    if (!Number.isFinite(ts) || ts <= 0 || id === '') return {};
    return { ts, ref: { kind, id, label } };
  } catch {
    return {};
  }
}

/**
 * 给分段条目补上"条目自身的时间"与 memid 引用。
 *
 * @param db - 权威库；null ⇒ 全部 unknown（降级面）。
 * @param sessionId - 该快照所属会话（体验句按会话内定位）。
 * @param entries - 已切好的条目（标签 + 行）。
 * @param at - 本轮注入时刻（状态/开场这类"就是这一轮"的段用它）。
 */
export function resolveEntryTimes(
  db: DatabaseSync | null,
  sessionId: string,
  entries: readonly SpiritEchoEntry[],
  at: number,
): SpiritEchoEntry[] {
  if (db === null) return entries.map((entry) => ({ ...entry, tsSource: 'unknown' as const }));
  const sid = sessionId.trim();
  return entries.map((entry) => {
    const line = entry.lines[0] ?? '';
    // 状态/开场：本轮的读数，时间就是本轮（没有 memid —— 它不是某条记忆）
    if (entry.name === '状态' || entry.name === '开场') {
      return { ...entry, ts: at, tsSource: 'turn' as const };
    }
    if (entry.name === '线程') {
      const title = line.split(' · ')[0]?.trim() ?? '';
      if (title === '') return { ...entry, tsSource: 'unknown' as const };
      const got = queryRef(db, `SELECT id, updated_at AS ts FROM task WHERE title = ? LIMIT 1`, [title], 'task', title);
      return { ...entry, ...(got.ts === undefined ? { tsSource: 'unknown' as const } : { ts: got.ts, tsSource: 'item' as const }), ...(got.ref === undefined ? {} : { ref: got.ref }) };
    }
    if (entry.name === '事务') {
      if (line === '') return { ...entry, tsSource: 'unknown' as const };
      const got = queryRef(db, `SELECT id, ts_ms AS ts FROM txn_entry WHERE card_line = ? ORDER BY ts_ms DESC LIMIT 1`, [line], 'delivery', line);
      return { ...entry, ...(got.ts === undefined ? { tsSource: 'unknown' as const } : { ts: got.ts, tsSource: 'item' as const }), ...(got.ref === undefined ? {} : { ref: got.ref }) };
    }
    if (entry.name === '反馈') {
      // 行形如 `认可：<card_line>`：剥掉评价词再按交付句回查
      const cardLine = afterFirstColon(line);
      if (cardLine === '') return { ...entry, tsSource: 'unknown' as const };
      const got = queryRef(db, `SELECT id, ts_ms AS ts FROM txn_entry WHERE card_line = ? ORDER BY ts_ms DESC LIMIT 1`, [cardLine], 'delivery', cardLine);
      return { ...entry, ...(got.ts === undefined ? { tsSource: 'unknown' as const } : { ts: got.ts, tsSource: 'item' as const }), ...(got.ref === undefined ? {} : { ref: got.ref }) };
    }
    if (entry.name === '刚刚' || entry.name === '想起') {
      // 体验句归另一个读面（本文件不碰 experience 表）；sid 为空时它自己返回 undefined
      const got = sid === '' ? undefined : experienceRef(db, sid, line);
      return { ...entry, ...(got === undefined ? { tsSource: 'unknown' as const } : { ts: got.ts, tsSource: 'item' as const, ref: { kind: 'experience', id: got.id, label: line } as SpiritEchoRef }) };
    }
    if (entry.name === '记着') {
      const prefix = prefixOf(line);
      if (prefix === '') return { ...entry, tsSource: 'unknown' as const };
      const got = queryRef(
        db,
        `SELECT id, updated_at AS ts FROM model_memory WHERE text LIKE ? ESCAPE '\\' AND forgotten_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
        [prefix],
        'memory',
        line,
      );
      return { ...entry, ...(got.ts === undefined ? { tsSource: 'unknown' as const } : { ts: got.ts, tsSource: 'item' as const }), ...(got.ref === undefined ? {} : { ref: got.ref }) };
    }
    if (entry.name === '惦记') {
      if (line === '') return { ...entry, tsSource: 'unknown' as const };
      const got = queryRef(db, `SELECT id, updated_at AS ts FROM goal WHERE title = ? ORDER BY updated_at DESC LIMIT 1`, [line], 'goal', line);
      return { ...entry, ...(got.ts === undefined ? { tsSource: 'unknown' as const } : { ts: got.ts, tsSource: 'item' as const }), ...(got.ref === undefined ? {} : { ref: got.ref }) };
    }
    return { ...entry, tsSource: 'unknown' as const };
  });
}

/**
 * 内容优先的标题（v0.8.7）：侧栏/星图用的一行文字。
 *
 * 优先级 = 用户实报的口径：线程（任务名）> 反馈 > 事务（交付句）> 记着 > 惦记 > 刚刚 > 想起 > 状态 > 开场。
 * 线程取 ` · ` 前的那段（`plugin-9lang-five-dim`），其余取整行。
 */
export function titleOfEntries(entries: readonly SpiritEchoEntry[]): string {
  const priority = ['线程', '反馈', '事务', '记着', '惦记', '刚刚', '想起', '状态', '开场'];
  for (const name of priority) {
    const entry = entries.find((item) => item.name === name);
    const line = entry?.lines[0]?.trim() ?? '';
    if (line === '') continue;
    return name === '线程' ? (line.split(' · ')[0]?.trim() ?? line) : line;
  }
  return '';
}
