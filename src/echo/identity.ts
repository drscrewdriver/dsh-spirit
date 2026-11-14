/**
 * 回响编号身份层（v0.8.11 / schema v16）：**记录持 echo 号，回响持 recall 号**。
 *
 * 为什么是 UUID 而不是内容哈希：
 * - 用户要求「UUID 级别、避免重复」——哈希是派生值，理论上可撞；UUID 由注册表保证一记录一号；
 * - echo 号必须**跨会话/跨重启稳定**：第一次见到记录时分配并落 `echo_identity`，之后永远复用；
 * - recall 号是事件号：一次注入一个，不复用、不回填。
 *
 * 边界：本模块只管发号与解号，不碰注入/渲染。
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** 记录号前缀（`echo-<uuid>`）。 */
export const ECHO_ID_PREFIX = 'echo-';
/** 回响事件号前缀（`recall-<uuid>`）。 */
export const RECALL_ID_PREFIX = 'recall-';
/** flashback 判定窗口：命中记录里最早的一条早于 7 天 ⇒ 这次回响是"勾起旧事"。 */
export const FLASHBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 新回响事件号：一轮注入一个（不复用）。 */
export function newRecallId(): string {
  return `${RECALL_ID_PREFIX}${randomUUID()}`;
}

/** 是否像 recording/事件号的形态（用于迁移与宽容读）。 */
export function isEchoId(value: string): boolean {
  return value.startsWith(ECHO_ID_PREFIX) && value.length > ECHO_ID_PREFIX.length;
}

export function isRecallId(value: string): boolean {
  return value.startsWith(RECALL_ID_PREFIX) && value.length > RECALL_ID_PREFIX.length;
}

/** 展示用短号：`echo-` + UUID 前 12 位（列表一行装得下；完整 UUID 进 tooltip）。 */
export function shortEchoId(echoId: string): string {
  const body = echoId.startsWith(ECHO_ID_PREFIX) ? echoId.slice(ECHO_ID_PREFIX.length) : echoId;
  const bare = body.replaceAll('-', '');
  return `${ECHO_ID_PREFIX}${bare.slice(0, 12)}`;
}

/** 展示用短号（recall 同口径）。 */
export function shortRecallId(recallId: string): string {
  const body = recallId.startsWith(RECALL_ID_PREFIX) ? recallId.slice(RECALL_ID_PREFIX.length) : recallId;
  const bare = body.replaceAll('-', '');
  return `${RECALL_ID_PREFIX}${bare.slice(0, 12)}`;
}

/** 命中记录的最早时间是否已过窗口（决定这次回响要不要打 flashback 标）。 */
export function isFlashback(oldestRecordTs: number | undefined, at: number, windowMs = FLASHBACK_WINDOW_MS): boolean {
  if (oldestRecordTs === undefined || !Number.isFinite(oldestRecordTs) || oldestRecordTs <= 0) return false;
  return oldestRecordTs <= at - windowMs;
}

/**
 * 领/取一条记录的 echo 号（幂等）：
 * 先查 `echo_identity(kind, mem_id)`；没有则生成 `echo-<uuid>` 写入再返回。
 *
 * 单写者（node:sqlite 单连接）+ INSERT ON CONFLICT DO NOTHING ⇒ 并发下也不会两号并存。
 *
 * @returns echo 号；`db` 不可用 / 参数缺失 ⇒ undefined（调用方退化为不显示编号，不编造）。
 */
export function resolveEchoId(db: DatabaseSync | null | undefined, kind: string, memId: string): string | undefined {
  const k = kind.trim();
  const id = memId.trim();
  if (db === null || db === undefined || k === '' || id === '') return undefined;
  try {
    const found = db
      .prepare(`SELECT echo_id FROM echo_identity WHERE kind = ? AND mem_id = ? LIMIT 1`)
      .get(k, id) as { echo_id?: unknown } | undefined;
    const existing = typeof found?.echo_id === 'string' ? found.echo_id : '';
    if (existing !== '') return existing;
    const fresh = `${ECHO_ID_PREFIX}${randomUUID()}`;
    db.prepare(
      `INSERT INTO echo_identity (echo_id, kind, mem_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, mem_id) DO NOTHING`,
    ).run(fresh, k, id, Date.now());
    // 冲突（并发插入）后回读，保证返回库里那一号
    const after = db
      .prepare(`SELECT echo_id FROM echo_identity WHERE kind = ? AND mem_id = ? LIMIT 1`)
      .get(k, id) as { echo_id?: unknown } | undefined;
    const settled = typeof after?.echo_id === 'string' ? after.echo_id : '';
    return settled !== '' ? settled : fresh;
  } catch {
    return undefined;
  }
}

/**
 * 把用户输入归一成 echo 号前缀（v0.8.12）：
 * - `echo-xxxx` / 全 UUID → 直接前缀匹配；
 * - 纯 hex/带连字符片段（≥6） → 补 `echo-` 前缀；
 * - 其它 → undefined（不是号查询，调用方走文本搜）。
 */
export function echoQueryPrefix(query: string): string | undefined {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === '') return undefined;
  if (trimmed.startsWith(ECHO_ID_PREFIX)) return trimmed;
  if (/^[0-9a-f][0-9a-f-]{5,}$/u.test(trimmed)) return `${ECHO_ID_PREFIX}${trimmed}`;
  return undefined;
}

/**
 * 按 echo 号找记录身份（注册表是唯一真源，不扫 echo_ref）。
 *
 * **去连字符比较**：展示短号是 UUID 去连字符后的前 12 位（`echo-e46c4b837a7a`），
 * 库里存的是带连字符的 `echo-e46c4b83-7a7a-…`——直接前缀 LIKE 会在第 8 位跨连字符时
 * 全部落空（用户实报：星图卡片上看得到的号，拿来搜却“注册表里没有”）。
 * 所以两边都去连字符后再比前缀。
 *
 * @returns 命中行（echoId/kind/memId）；不是号查询或库不可用 ⇒ []。
 */
export function findEchoIdentities(
  db: DatabaseSync | null | undefined,
  query: string,
): Array<{ echoId: string; kind: string; memId: string }> {
  const prefix = echoQueryPrefix(query);
  if (db === null || db === undefined || prefix === undefined) return [];
  const normalized = prefix.replaceAll('-', '');
  if (normalized === '') return [];
  try {
    const rows = db
      .prepare(
        `SELECT echo_id, kind, mem_id FROM echo_identity
         WHERE REPLACE(echo_id, '-', '') LIKE ?
         ORDER BY created_at DESC LIMIT 20`,
      )
      .all(`${normalized.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`) as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({ echoId: String(row['echo_id'] ?? ''), kind: String(row['kind'] ?? ''), memId: String(row['mem_id'] ?? '') }))
      .filter((row) => row.echoId !== '' && row.kind !== '' && row.memId !== '');
  } catch {
    return [];
  }
}

/** 批量取号（读面用）：同一条记录只查/建一次。 */
export function resolveEchoIds(
  db: DatabaseSync | null | undefined,
  rows: ReadonlyArray<{ kind: string; memId: string }>,
): Array<string | undefined> {
  const cache = new Map<string, string | undefined>();
  return rows.map((row) => {
    const key = `${row.kind}\u0000${row.memId}`;
    if (!cache.has(key)) cache.set(key, resolveEchoId(db, row.kind, row.memId));
    return cache.get(key);
  });
}
