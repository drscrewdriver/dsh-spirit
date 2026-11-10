/**
 * workspaceId 解析（v0.5.8）：空 workspaceId 的**修复链**，fallback 全局桶是兜底而非首选。
 *
 * 背景（真机事故）：写侧闸（TxnStore.insert 等）拒空 workspaceId——这是对的纪律；
 * 错的是调用方把空串一路传到写点。修复次序（尽量把范围修对，绝不错杀数据）：
 * 1. 候选值非空（在线 header.cwd / 回填 DRSC summary.cwd）⇒ 直接用；
 * 2. 反查同会话既有记录（txn_entry → experience，取最近一条非空非全局的 workspace_id）⇒ 修到对应范围；
 * 3. 仍不可得 ⇒ 落 WORKSPACE_GLOBAL 全局桶：数据照落、翻阅面全局视图（空 workspaceId=全局）可见，
 *    但注入读面按工作区过滤 ⇒ 不确定的历史不会漏进无关工作区的上下文。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 反查不到时的全局兜底桶 id（非空串 ⇒ 写侧闸照常成立；全局视图=空 workspaceId 查询已含它）。 */
export const WORKSPACE_GLOBAL = 'ws:global';

/** 只在非空且非全局桶时算"已知范围"（全局值不得被当证据二次传播）。 */
function usable(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' && value !== WORKSPACE_GLOBAL ? value.trim() : '';
}

/**
 * 解析会话的真实工作区；任何一步失败都往下走（查库异常按不可得处理，绝不抛穿采集链）。
 */
export function resolveWorkspaceId(db: DatabaseSync | null, sessionId: string, candidate: string): string {
  const direct = usable(candidate);
  if (direct !== '') return direct;
  if (db === null || sessionId === '') return WORKSPACE_GLOBAL;
  try {
    const txn = db
      .prepare(`SELECT workspace_id FROM txn_entry WHERE session_id = ? AND workspace_id <> '' ORDER BY ts_ms DESC LIMIT 1`)
      .get(sessionId) as { workspace_id?: unknown } | undefined;
    const fromTxn = usable(txn?.['workspace_id']);
    if (fromTxn !== '') return fromTxn;
  } catch {
    // 表缺/降级面 ⇒ 继续试下一源
  }
  try {
    const exp = db
      .prepare(`SELECT workspace_id FROM experience WHERE session_id = ? AND workspace_id <> '' ORDER BY ts_ms DESC LIMIT 1`)
      .get(sessionId) as { workspace_id?: unknown } | undefined;
    const fromExp = usable(exp?.['workspace_id']);
    if (fromExp !== '') return fromExp;
  } catch {
    // 同上：查不动就兜底，不抛穿
  }
  return WORKSPACE_GLOBAL;
}
