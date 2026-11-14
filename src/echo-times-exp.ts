/**
 * 回响条目的体验句时刻反查（v0.8.6，单独一个文件是有原因的）。
 *
 * 门禁 TA.6(b) 规定：**读 `experience` 的文件不得同时读本体表**——否则本体行会泄进
 * 情绪派生/注入可见面。回响的时间反查天然要跨两边（「想起：」查体验、「线程：」查任务），
 * 所以按轨拆成两个读面：本文件只读 experience，`echo-times.ts` 只读本表/记忆/目的，
 * 由后者组合结果。这样隔离规则是**结构上成立**的，而不是靠注释请求豁免。
 *
 * 本模块的输出只用于观测面（回响页显示时间），绝不回流到注入或情绪判定。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 反查用的前缀长度（与 echo-times 同口径：注入行被 clipLine 截过，前缀是唯一可靠定位方式）。 */
const PREFIX_CHARS = 40;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 在本会话的体验条目里找这句话的时刻与条目 id（memid）。
 *
 * @returns 命中 ⇒ {id, ts}；会话或文本为空、查不到 ⇒ undefined（调用方标 unknown，不编造）。
 */
export function experienceRef(db: DatabaseSync, sessionId: string, text: string): { id: string; ts: number } | undefined {
  const sid = sessionId.trim();
  const clean = Array.from(text.trim()).slice(0, PREFIX_CHARS).join('');
  if (sid === '' || clean === '') return undefined;
  try {
    // 走 exp_session_ts：会话内前缀匹配（等值查不中，注入行被截过）
    const row = db
      .prepare(`SELECT id, ts_ms FROM experience WHERE session_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY ts_ms DESC LIMIT 1`)
      .get(sid, `%${escapeLike(clean)}%`) as { id?: unknown; ts_ms?: unknown } | undefined;
    const id = typeof row?.['id'] === 'string' ? row['id'] : '';
    const ts = Number(row?.['ts_ms']);
    return id === '' || !Number.isFinite(ts) || ts <= 0 ? undefined : { id, ts };
  } catch {
    return undefined;
  }
}
