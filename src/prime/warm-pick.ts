/**
 * 暖记忆的**注入挑选**（v0.11）：从上游「关于这个人」的那批里，每轮最多挑 1 条进回忆卡。
 *
 * 为什么这一层必须单独存在，且必须窄：
 * 展示面（编年）宽松无所谓——多一行只是多看一眼；**注入面每轮都在花 token 和注意力**，
 * 而且它会和 fish-memory / agent-soul 的注入段正面重叠。所以这里的三道闸比展示面严得多。
 *
 * ## 三道闸（缺一不可）
 *
 * 1. **type 白名单**（`WARM_INJECT_TYPES`）：只有 `user_*` 四类。
 *    实测上游 chat 家族 58 条的构成是
 *    `user_communication 16 / instruction 15 / episodic 11 / persona 8 / user_info 5 / user_hobby 2 / user_behavior 1`，
 *    这里排除的三类各有硬理由：
 *    - `instruction` 是**用户指令**。当"回忆"每轮重放 = 陈旧指令在我没被要求时自己复现，
 *      比不记更危险；而且它一旦进卡，模型没有任何办法区分"这是当时的指示"和"这是现在的要求"。
 *    - `persona` 是人格。人格归 dsh-soul / dsh-agent-soul，spirit 的纪律是"不做人格配置"。
 *    - `episodic` 实测 11 条里多数 `valid_to` 非空（上游已判失效）；可进编年展示，不进注入。
 * 2. **安全闸**：`hitsInjection`（防指令注入）+ `containsSecret`（防机密回流）。
 *    上游正文是 LLM 从会话里蒸出来的，它可能裹挟任何当时出现过的东西——不筛就是开一个
 *    "外部文本经上游回流进我现在的上下文"的口子。
 * 3. **重复闸**：冷却窗（同一条 24h 内不再出现）+ 近义去重（Jaccard ≥0.7 视为同义）。
 *    必要性来自实测：19 条干净候选里 `user_communication` 有 3 条讲同一件事
 *    （"回复先给结论别铺垫"，11-23 / 11-18 / 11-07 三个措辞版本）——
 *    不做这一步，会连着几天注入同一句话的不同说法。
 *
 * 全部纯查表、零模型调用：注入面的判定一旦能读"模型输出"，就等于把上下文交给被注入方。
 */

import { hitsInjection } from '../words.js';
import { containsSecret } from '../ontology/scrub.js';
import { tokenize } from '../search/tokens.js';
import type { WarmthTier } from '../types.js';
import type { L1WarmthRow } from './l1-source.js';
import { WARMTH_COOL_MIN, type WarmChronicleItem } from './l1-warmth.js';

/**
 * 可进注入的 type 白名单。
 *
 * ⚠️ 这是**允许清单**不是禁止清单：上游将来新增一个 type 时，它默认**进不了注入**
 * （展示面仍会收到它）。这个方向是刻意的——注入面的漏放比展示面的漏收贵得多。
 */
export const WARM_INJECT_TYPES = [
  'user_info',
  'user_hobby',
  'user_communication',
  'user_behavior',
] as const;

export type WarmInjectType = (typeof WARM_INJECT_TYPES)[number];

/**
 * 取料回看天数：30 天。
 *
 * 为什么不是"全史"：候选池只需要"最近还成立、还说得出"的那批；
 * 拉全史会让库里的老版本参与竞争，而老版本往往更长、token 更多，反而更容易过近义闸。
 */
export const WARM_LOOKBACK_DAYS = 30;
/** 上游取料缓存窗（同一轮多个 agent 只开一次库；上游蒸馏本身是分钟级批量）。 */
export const WARM_LOOKBACK_CACHE_MS = 60_000;

/** 冷却窗：同一条记忆 24h 内不重复注入（一轮一次，19 条候选 ≈ 19 天不重样）。 */
export const WARM_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
/** 近义阈值：Jaccard ≥0.7 视为同义（实测 3 条同义样本可盖住，且不会误合不同偏好）。 */
export const WARM_SIM_THRESHOLD = 0.7;
/**
 * "重提"门槛：连续这么多天一次暖记忆都没进卡，才允许重提近义内容。
 *
 * 为什么需要它、又为什么是 7 天：
 * 近义闸的价值在于"别把同一个偏好的三个措辞版本连着几天端上来"——实测 11-23 / 11-18 / 11-07
 * 就是同一个偏好的三代版本，而**旧版本比新版本更可能过闸**（措辞更长、token 更多）。
 * 所以沉默必须优先于重提（宁可这轮不带，也别把 11-07 的旧说法盖在 11-23 的新说法上）。
 * 但永久沉默同样不行：新装机器上干净候选可能只有 3 条，一周不重样就耗光了。
 * 7 天是"人不会觉得烦"与"功能不会死掉"的交点，且与编年默认回看 30 天同量级。
 */
export const WARM_RESURFACE_MS = 7 * 24 * 60 * 60 * 1_000;
/** 注入只考虑"温"以上的条目（凉了/快淡忘了不值得占每轮的字节）。 */
export const WARM_INJECT_MIN_WARMTH = WARMTH_COOL_MIN + 0.22;
/**
 * 单条注入正文顶：**48 字**（约 150 字节）。
 *
 * 这个数不是拍的，是拿 512 字节的卡算出来的：
 * 卡头三行（框标 + 签名 + 声明）≈150B，状态行 ≈30B，两行「刚刚」≈250B，
 * 剩下的钱只够一行 150B 左右的暖记忆。初版取 100 字（≈300B）的实测结果是
 * **每一轮都被预算丢掉**——功能看着装好了，其实从来没进过上下文，而且不报错。
 *
 * 48 字也正好是一句"她喜欢什么"该有的长度：再长就不是记忆，是简历。
 */
export const WARM_INJECT_TEXT_MAX = 48;

/**
 * 这些文本块不是"关于这个人"的记忆，而是差点混进来的东西。
 *
 * 判据是上游正文的**开头套话形态**，不是内容语义——语义判定要模型，那就破了零调用纪律。
 * 实测上游蒸馏常把"任务目标/步骤"写成 `目标：…步骤：…`、把结论写成 `结论：…依据：…`，
 * 那是工作事实的壳，不该被当成"她喜欢什么"每轮重念。
 */
const WORK_SHAPE_PREFIX = /^(?:目标|步骤|结论|依据|现状|交付物|验收|背景)\s*[:：]/u;

/** 一轮挑选的跨轮状态（由装配点持有，进程内即可：冷却与去重都是"最近几天"的语义）。 */
export interface WarmPickState {
  /** memId → 上次注入时刻（冷却窗）。 */
  lastInjectedAt: Map<string, number>;
  /** 上一次成功注入的时刻（"重提"门槛用；undefined = 从没注入过）。 */
  lastAnyAt?: number;
  /** 最近注入过的 token 集（近义去重，最多留 8 条就够）。 */
  recentTokens: string[][];
}

export function createWarmPickState(): WarmPickState {
  return { lastInjectedAt: new Map(), recentTokens: [] };
}

/** 正文是否长得像"工作事实的壳"而不是一条关于人的记忆。 */
export function looksLikeWorkShape(text: string): boolean {
  return WORK_SHAPE_PREFIX.test(text.trim());
}

/**
 * 单条候选能不能进注入（不含跨轮状态的部分）。
 *
 * 返回原因串便于门禁与面板解释"为什么这轮没带暖记忆"——静默不注入最难排查。
 */
export function injectRejectReason(item: WarmChronicleItem, row: Pick<L1WarmthRow, 'type'>): string | null {
  if (!(WARM_INJECT_TYPES as readonly string[]).includes(row.type)) return `type:${row.type}`;
  if (item.expired) return 'expired';
  if (item.warmth < WARM_INJECT_MIN_WARMTH) return 'too_cold';
  if (item.text.trim() === '') return 'empty';
  if (looksLikeWorkShape(item.text)) return 'work_shape';
  if (hitsInjection(item.text)) return 'injection';
  if (containsSecret(item.text)) return 'secret';
  return null;
}

/** Jaccard 相似度（用自家分词器，与检索侧同一口径）。空集 ⇒ 0。 */
export function jaccardOf(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

export interface WarmPickInput {
  /** 上游行（调用方已按时间窗取过）。 */
  rows: readonly L1WarmthRow[];
  /** 对应的暖条目（与 rows 同序、同 id 前缀；由 `toWarmItems` 产出）。 */
  items: readonly WarmChronicleItem[];
  state: WarmPickState;
  now: number;
  /** 上一次成功注入的时刻（决定"重提"门槛）；都没注入过 ⇒ undefined。 */
  lastAnyAt?: number;
}

export interface WarmPickResult {
  /** 选中进卡的那一条（`null` = 本轮不带）。 */
  item: { id: string; text: string; tier: WarmthTier } | null;
  /** 被拒原因计数（面板/日志解释用；不含被选中那条）。 */
  rejected: Record<string, number>;
}

/**
 * 挑一条暖记忆进卡。
 *
 * 排序：温度降序 → 同温度取更近。取第一条通过全部闸的。
 *
 * 为什么"每轮只一条"而不是多条：19 条候选轮换 ≈19 天不重样，一轮一条已经够；
 * 多带只是稀释卡片里真正重要的状态/近因段。
 *
 * ## 两遍制（近义闸是**有条件的**软闸）
 *
 * 第一遍过全部闸。只有当**连续 `WARM_RESURFACE_MS`（7 天）一次都没注入过**，
 * 且没有任何候选被硬闸挡住时，才放松近义闸再挑一次。
 *
 * 为什么不是无条件放松：近义候选里的**旧版本更容易过闸**（措辞更长、token 更多），
 * 无条件放松等于让 11-07 的旧说法盖掉 11-23 的新说法——那不是"记起"，是"记错"。
 * 所以沉默在短期内优先于重提；只有久到"这一周什么暖的都没说过"时，重提才比继续沉默好。
 */
export function pickWarmForCard(input: WarmPickInput): WarmPickResult {
  const strict = pickOnce(input, { allowSimilar: false });
  if (strict.item !== null) return strict;
  // 只有"没人被硬闸挡住、全被近义挡住"时才可能放松；否则放松等于放行被硬闸拒的候选
  const hardRejects = Object.keys(strict.rejected).filter((reason) => reason !== 'similar');
  if (hardRejects.length > 0) return strict;
  // 且必须已经沉默够久——否则宁可这轮不带，也不让旧措辞盖掉新措辞
  if (input.lastAnyAt === undefined || input.now - input.lastAnyAt < WARM_RESURFACE_MS) return strict;
  const relaxed = pickOnce(input, { allowSimilar: true });
  return relaxed.item === null ? strict : relaxed;
}

function pickOnce(input: WarmPickInput, opts: { allowSimilar: boolean }): WarmPickResult {
  const { state, now } = input;
  const rejected: Record<string, number> = {};
  const bump = (reason: string): void => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  };

  // rows 与 items 按 id 对表（items 的 id 是 `l1-<row.id>`，且 kind==='skip' 的行已被 toWarmItems 丢掉，
  // 所以不能用下标直接配——那样会错位到隔壁行）
  const rowById = new Map<string, L1WarmthRow>();
  for (const row of input.rows) rowById.set(`l1-${row.id}`, row);

  const candidates = input.items
    .filter((item) => item.kind === 'bond')
    .slice()
    .sort((a, b) => (b.warmth - a.warmth) || (b.tsMs - a.tsMs));

  for (const item of candidates) {
    const row = rowById.get(item.id);
    if (row === undefined) {
      bump('row_missing');
      continue;
    }
    const reason = injectRejectReason(item, row);
    if (reason !== null) {
      bump(reason);
      continue;
    }
    const last = state.lastInjectedAt.get(item.id);
    if (last !== undefined && now - last < WARM_COOLDOWN_MS) {
      bump('cooldown');
      continue;
    }
    if (!opts.allowSimilar) {
      const tokens = tokenize(item.text).slice(0, 24);
      if (state.recentTokens.some((recent) => jaccardOf(tokens, recent) >= WARM_SIM_THRESHOLD)) {
        bump('similar');
        continue;
      }
    }
    return {
      item: {
        id: item.id,
        text: clipChars(item.text, WARM_INJECT_TEXT_MAX),
        tier: item.tier,
      },
      rejected,
    };
  }
  return { item: null, rejected };
}

/**
 * 提交一次注入（记账）。
 *
 * 与挑选分开是刻意的：挑选可能在 `renderCard` 因预算装不下而作废——
 * 那时候不能记"注入过"，否则一条从没进过上下文的记忆会白吃 24h 冷却。
 */
export function commitWarmInject(state: WarmPickState, picked: { id: string; text: string }, now: number): void {
  state.lastInjectedAt.set(picked.id, now);
  state.lastAnyAt = now;
  state.recentTokens.push(tokenize(picked.text).slice(0, 24));
  // 只留最近 8 条：更早的候选早就过了冷却窗，翻回去比也没意义
  if (state.recentTokens.length > 8) state.recentTokens.splice(0, state.recentTokens.length - 8);
  // 冷却表有界：超过 2 个窗的条目不再需要（窗本身就挡住了）
  for (const [id, at] of state.lastInjectedAt) {
    if (now - at > WARM_COOLDOWN_MS * 2) state.lastInjectedAt.delete(id);
  }
}

/** 按**字数**截断（不是字节：中文按字节截会切出半个字）。 */
export function clipChars(value: string, max: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}
