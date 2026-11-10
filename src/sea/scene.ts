/**
 * 记忆星海：场景构建（纯函数，零 IO、零模型调用）。
 *
 * 三条不变式（与 3d-memory-sea 的做法同源，但坐标语义换成双极）：
 * 1. **点必须来自真实条目**：不凭空生成、不补占位点；
 * 2. **边必须可解释**：只允许「共享 cue / 时间邻近 / 取代链」三类，绝不随机连；
 * 3. **scene 由纯函数算出**：前端只负责几何与绘制，随时可重算。
 *
 * 两个"不能复用"的地方（都在本文件显式实现，别处不要再抄）：
 * - `seaFreshness` **不复用** `util/decay.ts` 的 `decayWeight`：后者有 0.5 地板，
 *   那是给排序防沉底的；亮度需要真的能暗下去，复用会让极老的点永远半亮。
 * - `axisOf` **不读 `text`**：归属轴只能由结构化事实推（trigger / userChars），
 *   否则外部文本就能挪动整张图的位置，这是提示注入面。
 *
 * 坐标（x/y/z）不在这里算：`axis` 与 `freshness` 是语义，属于后端；
 * 球面投影与相机属于前端，换主题/换布局不该重取数据。
 */

import type { SpiritSeaEdge, SpiritSeaGraph, SpiritSeaPoint, SpiritSeaStats } from '../contract.js';
import type { ExperienceEntry, TriggerKind } from '../types.js';
/** 星海窗口上限：一次投影最多取多少条（超出丢最老的）。 */
export const SEA_WINDOW_LIMIT = 3_000;
/** 本体交付点的投影上限（v0.6）：独立于体验窗口，不把 3000 点情绪星图埋进工作记录。 */
export const SEA_DELIVERY_MAX = 500;
/** 单点文本上限（详情卡另有全文/残句）。 */
export const SEA_POINT_TEXT_MAX = 120;
/** 全图边上限。 */
export const SEA_EDGE_MAX = 6_000;
/** 每个点最多连几条边（防止毛线球）。 */
export const SEA_MAX_NEIGHBORS = 6;
/** 时间邻居：每点与前后各几条相连（保证孤立点也有线）。 */
export const SEA_TIME_NEIGHBORS = 2;
/** 出现在超过这么多条里的 cue 不作为连线依据（相当于对高频词做 IDF 截断）。 */
export const SEA_HUB_CUE_MAX = 40;
/** 时间窗：相邻时间窗内的点更容易连上。 */
export const SEA_TIME_WINDOW_MS = 6 * 60 * 60 * 1_000;

/**
 * 归属轴基值：+1 = 关于主人，−1 = 关于她自己。
 *
 * 只能取「本地可机械判定」的信号（与 experience/events.ts 的红线一致）。
 * 数值是经验缺省，不是校准结论：用户插话最接近"关于对方"，工具失败最接近"关于自己"。
 */
const TRIGGER_AXIS: Record<TriggerKind, number> = {
  user_interruption: 0.6,
  long_gap: 0.3,
  task_close: 0.15,
  tool_failure: -0.35,
  recovery: -0.15,
  neutral: 0,
};

/** 淡出复算参数（与配置同源；星海的 `stats.fade` 是**读数**，不是注入判据）。 */
export interface SeaFadeCfg {
  enabled: boolean;
  /** 千分位：full 档分数地板（550 = 0.55）。 */
  fullMinScore: number;
  /** 千分位：gist 档分数地板。 */
  gistMinScore: number;
  /** gist 档最低 salience。 */
  gistMinSalience: number;
}

/** 星海构建参数。 */
export interface BuildSeaSceneOptions {
  now: number;
  /**
   * 亮度老化尺度（ms）：用**天尺度**（`sea.agingHalfLifeMs`）。
   * 拿注入侧的小时尺度算跨月的库，会得到“全图都是暗星”（真浏览器实测过）。
   */
  halfLifeMs: number;
  /**
   * 档位（tier）衰减尺度（ms）：用**小时尺度**（`recall.fadeHalfLifeMs`），
   * 因为 tier 的语义就是“这条还在不在注意力窗口里”，必须与注入侧同一把尺。
   * 缺省同 `halfLifeMs`。
   */
  tierHalfLifeMs?: number;
  /** 库内可用条目总数（不是窗口内点数）。 */
  total: number;
  /** 当前情绪档词；拿不到就给空串，不编造。 */
  moodLabel: string;
  /** 库不可用（走内存镜像）时为 true。 */
  degraded: boolean;
  /** 本次窗口上限（面板显示「已加载 X / 上限 Y」）。 */
  window: number;
  /** 条目 id → cue 列表（缺省则只连时间边）。 */
  cues?: ReadonlyMap<string, readonly string[]>;
  /** 淡出复算参数；缺省时全部按 full 计。 */
  fade?: SeaFadeCfg;
  /** 近因高亮 id（图上打光晕）；只保留确实存在于窗口内的。 */
  focusIds?: readonly string[];
  /** 因果边（v0.3.5 长觉阶梯：启发式打底 + LLM 投影）；缺省则无因果边。 */
  causalEdges?: readonly SeaCausalInput[];
  /** 本体轨交付（v0.6）：作为 kind:'delivery' 点入图，与体验星同图异色。 */
  deliveries?: readonly SeaDeliveryInput[];
}

/** 交付点输入（rpc 层从 TxnStore 取行后映射；scene 保持纯函数不碰 store）。 */
export interface SeaDeliveryInput {
  id: string;
  tsMs: number;
  sessionId: string;
  turnSeq: number;
  cardLine: string;
  summary: string | null;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * 老化权重（0..1）：`pow(0.5, Δ/halfLife)`，**无地板**。
 *
 * `halfLifeMs <= 0` ⇒ 恒为 1（关闭衰减）。负 Δ（时钟回拨/未来时间戳）按 0 处理，
 * 避免出现 >1 的亮度。
 */
export function seaFreshness(tsMs: number, now: number, halfLifeMs: number): number {
  if (!(halfLifeMs > 0)) return 1;
  const delta = Math.max(0, now - tsMs);
  return clamp(Math.pow(0.5, delta / halfLifeMs), 0, 1);
}

/**
 * 归属轴：−1（关于她自己）..+1（关于主人）。
 *
 * **只读 trigger 与 `fact.userChars`**，不碰 `text` / `quote`。
 * `userChars` 是弱信号（本轮用户说了多少），最多贡献 +0.2。
 */
export function axisOf(entry: Pick<ExperienceEntry, 'trigger' | 'fact'>): number {
  const base = TRIGGER_AXIS[entry.trigger] ?? 0;
  const userChars = Number(entry.fact?.userChars ?? 0);
  const bump = userChars > 0 && Number.isFinite(userChars) ? 0.2 * Math.min(1, userChars / 200) : 0;
  return clamp(base + bump, -1, 1);
}

/** 单条文本压到窗口上限（不截英文单词，直接按字符切）。 */
function textOf(entry: ExperienceEntry): string {
  const raw = String(entry.text ?? '').replace(/\s+/g, ' ').trim();
  return raw.length > SEA_POINT_TEXT_MAX ? `${raw.slice(0, SEA_POINT_TEXT_MAX - 1)}…` : raw;
}

/**
 * 淡出档位复算：`m = (salience/2) × freshness`，与注入侧同一公式与阈值。
 *
 * 用途仅限面板读数（让"这盏灯为什么暗了"可解释）；注入判据永远是
 * `recall/recent.ts` 那条路，这里不参与、不回灌。
 */
export function fadeTierOf(
  entry: Pick<ExperienceEntry, 'salience' | 'gist'>,
  freshness: number,
  cfg: SeaFadeCfg | undefined,
): 'full' | 'gist' | 'held' {
  if (cfg === undefined || !cfg.enabled) return 'full';
  const salience = clamp(Number(entry.salience ?? 0), 0, 2);
  const score = (salience / 2) * clamp(freshness, 0, 1) * 1_000;
  if (score >= cfg.fullMinScore) return 'full';
  if (score >= cfg.gistMinScore && salience >= cfg.gistMinSalience && (entry.gist ?? '') !== '') return 'gist';
  return 'held';
}

/** 共享 cue 的相似度：`交/较小集合`（对称、对短条目友好）。 */
function cueOverlap(a: readonly string[], b: readonly string[]): { shared: number; ratio: number } {
  if (a.length === 0 || b.length === 0) return { shared: 0, ratio: 0 };
  const setB = new Set(b);
  let shared = 0;
  for (const cue of a) if (setB.has(cue)) shared += 1;
  return { shared, ratio: shared / Math.max(1, Math.min(a.length, b.length)) };
}

/**
 * 连线：只在「共享 cue」与「时间邻近」里找候选，避免 O(n²)；因果边（v0.3.5）直接并入。
 *
 * 输出顺序确定（score 降序 → a → b），保证同一份数据两次构建逐字节一致。
 * 因果边 score=1.1（高于任何关联边的 1.0）：截断优先级 causal>cue>time 用分值表达，
 * 排序函数不改 ⇒ 既有边的相对顺序零回归。
 */
export interface SeaCausalInput {
  from: string;
  to: string;
  relation: string;
}

function buildEdges(
  points: readonly SpiritSeaPoint[],
  cues: ReadonlyMap<string, readonly string[]>,
  list: readonly ExperienceEntry[] = [],
  causal: readonly SeaCausalInput[] = [],
): SpiritSeaEdge[] {
  if (points.length < 2) return [];
  const byId = new Map(points.map((point) => [point.id, point]));
  const bucketOf = new Map<string, string[]>();
  for (const point of points) {
    const list = cues.get(point.id);
    if (list === undefined) continue;
    for (const cue of list) {
      const bucket = bucketOf.get(cue) ?? [];
      bucket.push(point.id);
      bucketOf.set(cue, bucket);
    }
  }

  const pairScores = new Map<string, { a: string; b: string; score: number; kind: SpiritSeaEdge['kind']; label?: string }>();

  // 因果边先入桶（两端都必须在窗口内，不造悬空边；同对已有则让位因果——投影比共现更值得画）
  const windowIds = new Set(points.map((point) => point.id));
  for (const edge of causal) {
    if (!windowIds.has(edge.from) || !windowIds.has(edge.to) || edge.from === edge.to) continue;
    const [left, right] = edge.from < edge.to ? [edge.from, edge.to] : [edge.to, edge.from];
    pairScores.set(`${left}|${right}`, { a: left, b: right, score: 1.1, kind: 'causal', label: edge.relation });
  }

  const consider = (aId: string, bId: string, kind: SpiritSeaEdge['kind']): void => {
    if (aId === bId) return;
    const a = byId.get(aId);
    const b = byId.get(bId);
    if (a === undefined || b === undefined) return;
    const [left, right]: [SpiritSeaPoint, SpiritSeaPoint] = aId < bId ? [a, b] : [b, a];
    const key = `${left.id}|${right.id}`;
    // 已记过就不重记：因果/取代边先入桶时，共现/时间邻接不再改写
    if (pairScores.has(key)) return;
    const overlap = cueOverlap(cues.get(left.id) ?? [], cues.get(right.id) ?? []);
    const dt = Math.abs(left.t - right.t);
    const timeSim = dt <= SEA_TIME_WINDOW_MS ? 1 - dt / SEA_TIME_WINDOW_MS : 0;
    const score = 0.7 * overlap.ratio + 0.3 * timeSim;
    // 时间邻居不卡分数阈值：它们的 score 常常接近 0，但仍得把孤岛连上
    if (score <= 0 && kind !== 'time') return;
    pairScores.set(key, { a: left.id, b: right.id, score: Math.round(score * 1_000) / 1_000, kind });
  };

  for (const [, bucket] of bucketOf) {
    if (bucket.length < 2 || bucket.length > SEA_HUB_CUE_MAX) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) consider(bucket[i]!, bucket[j]!, 'cue');
    }
  }

  // 时间邻居：保证"没有任何共享 cue"的点也有线（孤岛不是线，是断点）
  for (let i = 1; i < points.length; i += 1) {
    for (let back = 1; back <= SEA_TIME_NEIGHBORS; back += 1) {
      if (i - back < 0) break;
      consider(points[i - back]!.id, points[i]!.id, 'time');
    }
  }

  // 取代链：只画**两端都在窗口内**的。拿不到另一端就不画，不造悬空边
  const inWindow = new Set(points.map((point) => point.id));
  for (const entry of list) {
    const next = entry.supersededBy;
    if (typeof next !== 'string' || next === '' || !inWindow.has(next)) continue;
    const [left, right] = entry.id < next ? [entry.id, next] : [next, entry.id];
    pairScores.set(`${left}|${right}`, { a: left, b: right, score: 1, kind: 'supersede' });
  }

  const degree = new Map<string, number>();
  const edges: SpiritSeaEdge[] = [];
  const ordered = [...pairScores.values()].sort((x, y) => y.score - x.score || (x.a < y.a ? -1 : 1) || (x.b < y.b ? -1 : 1));
  for (const pair of ordered) {
    if (edges.length >= SEA_EDGE_MAX) break;
    const da = degree.get(pair.a) ?? 0;
    const db = degree.get(pair.b) ?? 0;
    if (da >= SEA_MAX_NEIGHBORS || db >= SEA_MAX_NEIGHBORS) continue;
    degree.set(pair.a, da + 1);
    degree.set(pair.b, db + 1);
    edges.push({ a: pair.a, b: pair.b, score: pair.score, kind: pair.kind, ...(pair.label === undefined ? {} : { label: pair.label }) });
  }
  return edges;
}

/**
 * 把条目列表投影成场景。
 *
 * 返回类型不含 `drscVerdict`：判定是探测面的事实、不是场景几何，由 rpc 层装配时补
 * （scene 保持纯函数，测试不拿探测值当输入）。
 *
 * @param entries 窗口内条目（**必须已按时间升序**）
 */
export function buildSeaScene(entries: readonly ExperienceEntry[], opts: BuildSeaSceneOptions): Omit<SpiritSeaGraph, 'drscVerdict'> {
  const windowSize = Math.max(1, Math.floor(opts.window));
  // 上限在 store 与这里各把一次：store 那把是“少读”，这把是“不管调用方递来多少都不画超窗的图”
  const list = entries.length > windowSize ? entries.slice(entries.length - windowSize) : entries;
  const points: SpiritSeaPoint[] = list.map((entry) => {
    const freshness = seaFreshness(entry.tsMs, opts.now, opts.halfLifeMs);
    const tierFreshness = seaFreshness(entry.tsMs, opts.now, opts.tierHalfLifeMs ?? opts.halfLifeMs);
    return {
      id: entry.id,
      t: entry.tsMs,
      sessionId: entry.sessionId,
      turnSeq: entry.turnSeq,
      kind: 'experience',
      trigger: entry.trigger,
      lane: entry.lane,
      text: textOf(entry),
      gist: entry.gist ?? null,
      salience: clamp(Number(entry.salience ?? 0), 0, 2),
      freshness,
      tier: fadeTierOf(entry, tierFreshness, opts.fade),
      axis: axisOf(entry),
      feedback: typeof entry.feedbackScore === 'number' ? entry.feedbackScore : null,
      cues: (opts.cues?.get(entry.id) ?? []).slice(0, 4),
      superseded: typeof entry.supersededBy === 'string' && entry.supersededBy !== '',
    };
  });

  // 本体交付点（v0.6）：同尺度老化、tier 用同一公式（salience 固定 1=tier2 权重）；
  // axis 固定 +0.35：交付永远是"为主人的任务做的"，不读正文推轴（那是注入面）。
  const deliveryPoints: SpiritSeaPoint[] = (opts.deliveries ?? []).slice(0, SEA_DELIVERY_MAX).map((d) => {
    const freshness = seaFreshness(d.tsMs, opts.now, opts.halfLifeMs);
    const tierFreshness = seaFreshness(d.tsMs, opts.now, opts.tierHalfLifeMs ?? opts.halfLifeMs);
    const gist = d.summary === null ? null : d.summary.length > SEA_POINT_TEXT_MAX ? `${d.summary.slice(0, SEA_POINT_TEXT_MAX - 1)}…` : d.summary;
    return {
      id: d.id,
      t: d.tsMs,
      sessionId: d.sessionId,
      turnSeq: d.turnSeq,
      kind: 'delivery',
      trigger: 'neutral' as TriggerKind,
      lane: 'onto',
      text: (() => {
        const raw = d.cardLine.replace(/\s+/g, ' ').trim();
        return raw.length > SEA_POINT_TEXT_MAX ? `${raw.slice(0, SEA_POINT_TEXT_MAX - 1)}…` : raw;
      })(),
      gist,
      salience: 1,
      freshness,
      tier: fadeTierOf({ salience: 1, gist: gist ?? undefined }, tierFreshness, opts.fade),
      axis: 0.35,
      feedback: null,
      cues: [],
      superseded: false,
    };
  });

  // 合图按时间升序：时间邻居连线与 span 都依赖这个不变式
  const merged = [...points, ...deliveryPoints].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));

  const edges = buildEdges(merged, opts.cues ?? new Map(), list, opts.causalEdges ?? []);

  const byTrigger: Record<string, number> = {};
  const byLane: Record<string, number> = {};
  const fade = { full: 0, gist: 0, held: 0 };
  for (const point of merged) {
    byTrigger[point.trigger] = (byTrigger[point.trigger] ?? 0) + 1;
    byLane[point.lane] = (byLane[point.lane] ?? 0) + 1;
    // 档位已在点上算过（与光晕门控同一个值），不在这里重算第二套
    fade[point.tier] += 1;
  }

  const stats: SpiritSeaStats = {
    loaded: merged.length,
    ghosts: merged.filter((point) => point.superseded).length,
    total: Math.max(merged.length, Math.floor(opts.total)),
    edges: edges.length,
    byTrigger,
    byLane,
    fade,
    moodLabel: opts.moodLabel,
    span: merged.length > 0 ? { from: merged[0]!.t, to: merged[merged.length - 1]!.t } : null,
    degraded: opts.degraded === true,
    window: windowSize,
  };

  const known = new Set(merged.map((point) => point.id));
  const focusIds = (opts.focusIds ?? []).filter((id) => known.has(id));

  return { points: merged, edges, stats, focusIds };
}
