/**
 * 滑窗淡出（注意力形态档位）：条目 → full / gist / held。
 *
 * 理念：人会遗忘——经历的关注窗口会滑动。遗忘不是删除，是**逐出注意力**：
 * 原文（full）→ 一句话（gist）→ 不上卡（held，库内永远在、窗口回涨可复原）。
 * 存储侧本就 append-only 永不删，本文件只做注入侧的形态降级。
 *
 * 三条实现纪律（都是别的判据的红线，破一条就连带炸）：
 * 1. **公式对齐姊妹包衰减**：`w = 0.5^(Δt/halfLife)`，地板 0.5 同源——同式便于交叉
 *    对照，且与「fadeEnabled=false 逐字节回归 v0.1」的冻结臂兼容。
 * 2. **量化纪律**：Δt 按 halfLife 整数档离散化后再算 w——档内字节稳定，重发只发生在
 *    跨档。连续漂移的 w 会让 unchanged 门每轮失效（每张卡都算"内容变了"），
 *    那是最贵的静默回归。
 * 3. **地板与 util/decay.ts 解耦**：那边三处消费（情绪派生/近因排序/DRSC 候选）不许被
 *    淡出改动连带；这里另立函数，缺省地板同为 0.5 是刻意的一致而非复用。
 *
 * 反馈两轴分离：手打分（-1..5）**只重排**进卡优先序，绝不进 m——
 * 打分是"人觉得重不重要"，衰减是"客观变淡"，合并成一条曲线就是自我强化回路。
 */

import { REACTION_STRONG, type ExperienceEntry } from '../types.js';

/** 上卡形态：原文 / 一句话 / 逐出注意力（库内仍在）。 */
export const FORM_FULL = 'full' as const;
export const FORM_GIST = 'gist' as const;
export const FORM_HELD = 'held' as const;
export const ENTRY_FORMS = [FORM_FULL, FORM_GIST, FORM_HELD] as const;
export type EntryForm = (typeof ENTRY_FORMS)[number];

/** 淡出所需配置切片（取自 `cfg.recall`，测试可直接构造）。 */
export interface FadeConfig {
  /** 千分位整数（550 = 0.55）：full 档的 m 地板。 */
  fullMinScore: number;
  /** 千分位整数（250 = 0.25）：gist 档的 m 地板；低于它 ⇒ held。 */
  gistMinScore: number;
  /** gist 要求的最低 salience（弱条目连 gist 都不配，直接 held）。 */
  gistMinSalience: number;
  fadeEnabled: boolean;
  /** 人工反馈重排闸（两轴分离：只重排，永不进 m）。 */
  feedbackEnabled: boolean;
  /**
   * **冻结开关**（v19）：`0` ⇒ 全阶恒 1000（不淡）；`>0` ⇒ 启用 0-7-30 台阶。
   * 名字保留是为了不跳变已有配置与面板控件，新尺度看下面四个键。
   */
  fadeHalfLifeMs: number;
  /** 台阶一「当下」的边界（天）：Δt 小于它 ⇒ 1000。`0` = 直接进「一周后」阶。 */
  fadeHotDays?: number;
  /** 台阶二「一周后」的边界（天）。 */
  fadeColdDays?: number;
  /** 台阶二权重（千分位，500..1000）。 */
  fadeWarmWeight?: number;
  /** 末阶权重（千分位，500..1000，且 ≤ warm）。 */
  fadeColdWeight?: number;
}

/** salience ∈ 0..2 归一到 0..1（0 的条目本就不入库，兜底时按最低档）。 */
function salienceUnit(salience: number): number {
  if (!Number.isFinite(salience) || salience <= 0) return 0;
  return Math.min(1, salience / 2);
}

/**
 * 注意力权重：`0.5^(quantizedΔt / halfLife)`，地板 0.5。
 *
 * `halfLifeMs <= 0` ⇒ 恒 1（冻结窗口）。地板的语义后果要说清：时间单独永远至多让
 * 条目“变淡一半”（salience=2 的下限 m=500 ⇒ 停在 gist 档；salience=1 的下限 m=250
 * ⇒ 恰在缺省 gist 地板上）。所以 **held 由三条路达成**：无残句可降级（v1 旧行）、
 * salience 低于 gist 档（v1 旧行落 0 正是此路）、把 gistMinScore 调高于时间下限。
 * 这不是缺陷而是价值观：人会想起很久以前的事，只要它真的还重要（与 decay.ts 同一句话）。
 */
/**
 * 旧连续半衰期曲线（v19 起**不再参与定档**）：保留导出只为对照/诊断。
 *
 * 为什么弃用：`max(0.5, 0.5^floor(Δt/halfLife))` 在 halfLife=90min 时 Δt≥90min 一律 0.5，
 * 实际只产出「1.0 / 0.5」两档——台阶分辨率被地板抹平了。
 */
export function attentionWeight(tsMs: number, now: number, halfLifeMs: number): number {
  if (!(halfLifeMs > 0)) return 1;
  const delta = Math.max(0, now - tsMs);
  // 量化：Δt 折算成"跨了几个半衰期"的整数档（连续 Δt 是 churn 之源）
  const halfLives = Math.floor(delta / halfLifeMs);
  return Math.max(0.5, Math.pow(0.5, halfLives));
}

/** m = salience 归一 × 注意力权重，缩到千分位整数（离散、可进指纹）。 */
const DAY_MS = 86_400_000;

/** 末阶地板：时间单独永远至多让一条经历「变淡一半」。 */
export const FADE_FLOOR_PERMILLE = 500;

function clampPermille(value: number, fallback: number): number {
  const n = Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(FADE_FLOOR_PERMILLE, Math.min(1_000, n));
}

/**
 * 0-7-30 台阶权重（千分位整数）：
 * - `Δt < fadeHotDays` ⇒ 1000（当下）
 * - `Δt < fadeColdDays` ⇒ `fadeWarmWeight`（一周后）
 * - 其余 ⇒ `fadeColdWeight`（一月后，地板）
 *
 * 三条设计纪律：
 * 1. **地板只作用末阶**——这是「真台阶」与「只有两档」的唯一分界；
 * 2. **离散取值**——同一阶内 m 不变，卡文本才稳定（连续漂移会让「同档不重发」每轮失效）；
 * 3. `fadeHalfLifeMs <= 0` ⇒ 全阶 1000（冻结语义保留，作对照臂用）。
 */
export function ladderWeightPermille(
  tsMs: number,
  now: number,
  cfg: Pick<FadeConfig, 'fadeHalfLifeMs' | 'fadeHotDays' | 'fadeColdDays' | 'fadeWarmWeight' | 'fadeColdWeight'>,
): number {
  if (!(cfg.fadeHalfLifeMs > 0)) return 1_000;
  const delta = Math.max(0, now - tsMs);
  const hotDays = Math.max(0, Math.round(cfg.fadeHotDays ?? 7));
  const coldDays = Math.max(hotDays, Math.round(cfg.fadeColdDays ?? 30));
  if (delta < hotDays * DAY_MS) return 1_000;
  const warm = clampPermille(cfg.fadeWarmWeight ?? 750, 750);
  const cold = Math.min(warm, clampPermille(cfg.fadeColdWeight ?? FADE_FLOOR_PERMILLE, FADE_FLOOR_PERMILLE));
  return delta < coldDays * DAY_MS ? warm : cold;
}

/**
 * 分数 m（千分位）：`salience 归一 × 台阶权重`。
 *
 * v19 起不再用连续半衰期——旧曲线在半衰期 90 分钟 + 地板 0.5 下只有「1.0 / 0.5」两个值，
 * 「昨天的事」与「上个月的事」权重完全一样。
 */
export function fadeScoreMs(entry: Pick<ExperienceEntry, 'tsMs' | 'salience'>, now: number, cfg: FadeConfig): number {
  const w = ladderWeightPermille(entry.tsMs, now, cfg);
  return Math.round(salienceUnit(entry.salience ?? 0) * w);
}

/**
 * 定档。fadeEnabled=false ⇒ 恒 full（与 v0.1 逐字节一致，回归冻结臂）。
 *
 * gist 形态还要求条目**有** gist 列（编译期派生；v1 迁移来的旧行没有 ⇒ 退 held 而不是
 * 现场造句）。full 判定不看 gist：salience×w 够高就连原文一起端上来。
 */
export function formOf(entry: ExperienceEntry, now: number, cfg: FadeConfig): EntryForm {
  if (!cfg.fadeEnabled) return FORM_FULL;
  const m = fadeScoreMs(entry, now, cfg);
  if (m >= cfg.fullMinScore) return FORM_FULL;
  if (m >= cfg.gistMinScore && cfg.gistMinSalience <= (entry.salience ?? 0) && entry.gist !== undefined && entry.gist !== '') {
    return FORM_GIST;
  }
  return FORM_HELD;
}

/** 条目进卡的实际文本（held ⇒ 空串，由调用方过滤；形态缺文本时宁缺毋造）。 */
export function formText(entry: ExperienceEntry, form: EntryForm): string {
  if (form === FORM_HELD) return '';
  if (form === FORM_GIST) return entry.gist ?? '';
  return entry.text;
}

/**
 * 强负体验且已被逐出注意力 ⇒ 交给条件化（刀4）以"语气"续命，不再复述内容。
 * 这是「遗忘形态转化」的交接点：held 不等于什么都没剩下。
 */
export function isToneCarry(entry: ExperienceEntry, form: EntryForm): boolean {
  return form === FORM_HELD && entry.reaction === REACTION_STRONG;
}

/**
 * 反馈重排比较器（两轴分离的执行点）：分数高者优先进卡，**未打分保持原序**。
 *
 * `scoreOf` 由调用方提供（读 feedback_score 列）；这里不碰 m、不碰形态判定——
 * 打分改变"先进哪条"，不改变"还记不记得"。
 */
export function feedbackFirst<T>(items: readonly T[], scoreOf: (item: T) => number): T[] {
  const indexed = items.map((item, index) => ({ item, index, score: scoreOf(item) }));
  indexed.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.index - b.index; // 稳定：未打分/同分保持入参序
  });
  return indexed.map((row) => row.item);
}

/** 指纹用的形态摘要（量化后的档名，不含时间戳——同档同文本 ⇒ 同摘要）。 */
export function formDigest(forms: readonly EntryForm[]): string {
  return forms.join(',');
}
