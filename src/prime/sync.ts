/**
 * 主人档案的同步引擎：探测 prime-memory → 取 person 实体 → 渲染同步段 → 落库。
 *
 * 两条"绝不"比逻辑本身更重要：
 * 1. **缺席/空图绝不写空段**——拿不到源 ≠ 主人的背景消失了；覆盖成空是数据事故。
 *    跳过时只更新探测状态，sync_text 原样留在表里。
 * 2. **谁是主人绝不猜**——图上没有"主人"标记，渲染成实体清单（prime 自己的排序分
 *    决定收录与顺序），断言错主体比列清单糟得多。
 *
 * 去重窗（60s，进程内时间戳）把 timer / sync-now / ping 三个入口收敛成一条真请求：
 * ping 风暴的后果只是一次多余的本地 HTTP 读，不值得为它建持久化节流表。
 */

import type { SpiritConfig } from '../contract.js';
import type { MinimalLogger } from '../persona/store.js';
import type { OwnerProfileRow, OwnerSyncMeta } from '../store/owner.js';
import type { OwnerProfileStore } from '../store/owner.js';
import type { PrimeClient, PrimePersonNode } from './client.js';

/** 同步段单条字符顶（档案预算 400B 约容五行，单条再长就是灌水面）。 */
export const OWNER_SYNC_LINE_MAX = 120;
/** 同步段条数顶（与 client 的检索 limit 同值，两处各钳一次：少一边都只是防御）。 */
export const OWNER_SYNC_NODE_MAX = 8;
/** 手动/ping/定时共用的去重窗。 */
export const OWNER_SYNC_DEDUP_MS = 60_000;

export type PrimeStatus = 'available' | 'absent' | 'graph-off';

export interface SyncOutcome {
  ok: boolean;
  updated: boolean;
  reason?: string;
}

/**
 * person 节点列表 → 同步段文本（纯函数：不含时间戳、不含 id，两次调用字节全等）。
 *
 * 空列表 ⇒ `null`：这是"没有可写的内容"，调用方据此跳过落库——
 * 返回空串会被当成"合法的空档案"覆盖掉旧同步段。
 */
export function renderOwnerSyncText(nodes: readonly PrimePersonNode[]): string | null {
  const lines: string[] = [];
  for (const node of nodes.slice(0, OWNER_SYNC_NODE_MAX)) {
    // currentState 是 `key: value` 逐行；取前 3 行拼一句，再长就截整条（不截半句）
    const facts = node.currentState
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .slice(0, 3);
    const alias = node.aliases.length > 0 ? `（${node.aliases[0]}）` : '';
    const body = facts.length === 0 ? `${node.name}${alias}` : `${node.name}${alias}：${facts.join('；')}`;
    lines.push(body.length > OWNER_SYNC_LINE_MAX ? `${body.slice(0, OWNER_SYNC_LINE_MAX - 1)}…` : body);
  }
  return lines.length === 0 ? null : lines.join('\n');
}

export interface OwnerSyncDeps {
  client: PrimeClient;
  store: OwnerProfileStore;
  cfg: () => SpiritConfig;
  logger: MinimalLogger;
  /** 注入面（单测）；缺省 Date.now。 */
  now?: () => number;
}

export class OwnerSyncService {
  private readonly nowFn: () => number;
  private lastSyncAt = 0;
  private probeCache: { status: PrimeStatus; at: number } | null = null;

  constructor(private readonly deps: OwnerSyncDeps) {
    this.nowFn = deps.now ?? (() => Date.now());
  }

  /**
   * 探测 prime 可用三态（带 TTL 缓存）。
   *
   * `available` 的定义是"RPC 面在且图上有人"——`graph-off` 与 `absent` 分开报，
   * 面板才能说清"装了但没开图"和"没装"是两回事（DRSC 0 段同课）。
   */
  async probe(force = false): Promise<PrimeStatus> {
    const ttl = this.deps.cfg().owner.probeCacheTtlMs;
    const at = this.nowFn();
    if (!force && this.probeCache !== null && at - this.probeCache.at < ttl) return this.probeCache.status;
    let status: PrimeStatus;
    try {
      const nodes = await this.fetchPersons();
      status = nodes.length > 0 ? 'available' : 'graph-off';
    } catch {
      status = 'absent';
    }
    this.probeCache = { status, at };
    return status;
  }

  /**
   * 取 person 列表：**主路径就是 graph-preview 种子榜**。
   *
   * 真宿主实测（T2.2）定死了这个顺序：prime 的 `searchGraphNodes` 对空 query 是
   * "零 token ⇒ 直接返空"（tokens.length===0 分支），图里有数据也永远空——
   * spec §2.2 的退路条款"不允许则退种子榜"由实测触发，种子榜即主路径。
   * `searchPersons` 保留在 client（prime 若将来支持全量语义可一行切回），
   * 但同步链不再用它：每次同步先打一个注定空转的请求不是保守，是浪费。
   */
  private async fetchPersons(): Promise<PrimePersonNode[]> {
    return this.deps.client.graphPreviewPersons();
  }

  /**
   * 执行一次同步。三个入口（定时器 / sync-now / ping）都走这里。
   *
   * 去重窗命中 ⇒ `{updated:false}`（不是错误；面板显示"刚刚同步过"）。
   * 取数失败/空图 ⇒ 保留旧段、只报状态，绝不写空。
   */
  async sync(): Promise<SyncOutcome> {
    const at = this.nowFn();
    if (at - this.lastSyncAt < OWNER_SYNC_DEDUP_MS) {
      return { ok: true, updated: false, reason: 'dedup-window' };
    }
    this.lastSyncAt = at;
    let nodes: PrimePersonNode[];
    try {
      nodes = await this.fetchPersons();
    } catch (err) {
      // 缺席不是事故：静默跳过 + 一行 info，状态行由 probe() 说话
      this.probeCache = { status: 'absent', at };
      this.deps.logger.info(`[spirit] 主人档案同步跳过（prime-memory 不可达）：${err instanceof Error ? err.message : String(err)}`);
      return { ok: true, updated: false, reason: 'prime-absent' };
    }
    const text = renderOwnerSyncText(nodes);
    if (text === null) {
      this.probeCache = { status: 'graph-off', at };
      return { ok: true, updated: false, reason: 'graph-empty' };
    }
    this.probeCache = { status: 'available', at };
    const meta: OwnerSyncMeta = { syncedAt: at, sourceNodes: nodes.length, degraded: false };
    const row: OwnerProfileRow = this.deps.store.setSync(text, meta);
    this.deps.logger.info(`[spirit] 主人档案同步段已更新（${nodes.length} 个 person 实体）；自述段未动（rev${row.revision}）`);
    return { ok: true, updated: true };
  }
}
