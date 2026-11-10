/**
 * 交付条目的规则打分（v0.7 / 对表 dsh-agent-soul 的确定性打分，补"四级 salience 选不出高低"的洞）。
 *
 * 四级 salience（反馈 > 总结 > 步骤 > 思考）回答的是"这条在哪个档"，**同档内谁更值得说**
 * 过去只能靠"最新优先"（交付卡行 = listRecent(1)）。这里给它一把可解释的尺：
 * 确定性、零 LLM、可重算派生——不落库、不进真源，换公式随时重排。
 *
 * 打分形状（总分 0..~150，同分以 tsMs 新者胜）：
 * - 档位基底：tier1=100 / tier2=70 / tier3=40 / 其他=20
 * - 来源加分：user_explicit +20（主人原话）/ derived_summary +10（模型归纳）
 * - 结构加分：带 cue +10（有可检索锚点）/ 有 summary +8（交付描述更完整）
 * - 近因微调：24 小时内每小时 +0.5（上限 +12；跨天不靠它，跨天交给档位）
 * - 噪声罚分：cardLine 短于 6 字 -10（"我回复了『好』"这类）
 */
export interface ScorableTxn {
  salienceTier: number;
  sourceTrust: string;
  cardLine: string;
  summary?: string;
  cues?: ReadonlyArray<{ cue: string; kind: string }>;
  tsMs: number;
}

export interface ScoreCtx {
  now: number;
}

const TIER_BASE: Record<number, number> = { 1: 100, 2: 70, 3: 40 };

export function ruleScore(row: ScorableTxn, ctx: ScoreCtx): number {
  let score = TIER_BASE[row.salienceTier] ?? 20;
  if (row.sourceTrust === 'user_explicit') score += 20;
  else if (row.sourceTrust === 'derived_summary') score += 10;
  if ((row.cues?.length ?? 0) > 0) score += 10;
  if (typeof row.summary === 'string' && row.summary.trim() !== '') score += 8;
  const ageMs = Math.max(0, ctx.now - row.tsMs);
  const ageHours = ageMs / 3_600_000;
  if (ageHours < 24) score += Math.min(12, (24 - ageHours) * 0.5);
  if (Array.from(row.cardLine.trim()).length < 6) score -= 10;
  return Math.round(score);
}

/** 取分最高者；同分取更新（tsMs 大者）。空窗口 ⇒ undefined（不编造）。 */
export function pickBest<T extends ScorableTxn>(rows: readonly T[], ctx: ScoreCtx): T | undefined {
  let best: T | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const score = ruleScore(row, ctx);
    if (score > bestScore || (score === bestScore && (best === undefined || row.tsMs > best.tsMs))) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}
