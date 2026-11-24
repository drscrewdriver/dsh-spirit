/**
 * 「温度」层（v0.10）：把上游 L1 的冷记录翻成编年上一条有温度的经历。
 *
 * 这是本次重定位里唯一向 fish-memory 借形的地方，也是唯一需要说清"为什么不重头做"的地方：
 *
 * ## 借的是什么
 *
 * fish-memory 的质感不在它的存储，在它对一条记忆的三个判断：
 * 1. **重要度**决定这条**降得多慢**（重要的事几乎不会淡，小事几天就凉）；
 * 2. **鲜活度**是连续半衰的一个标量，不是"存/删"二值——所以"想不起来"和"没有过"能分开；
 * 3. **被想起**会强化它（retrieval 加热），于是常被引用的忆会自己浮上来。
 *
 * 这三件事 spirit 自己早就有了对应的机制（`salience` 0-2、`recall/fade` 四级淡出、`echo_recall` 引用记录），
 * 缺的只是一件事：**它们只作用在 spirit 自己记下的那 20 多条体验上，不作用在上游取来的料上**。
 * 于是上游两千多条 L1 记录进编年时是"冷"的——全是同等亮度的一行行流水。
 *
 * ## 为什么从 prime 取，而不是自己重新采集
 *
 * 因为**判断已经做过了**。上游 L1 每条都带 `priority`（0-100，实测 70~95）、`persistence`
 * （永久/临时）、`valid_to`（已失效）——那是上游蒸馏时花的真 token。重算一遍只会得到
 * 更好看的第二个真源，而两者的分歧无从裁决。
 *
 * ## 边界（与"不记事实"那条纪律如何并存）
 *
 * spirit **不持有**这些事实：正文所有权、召回、时效判断全留在上游（本文件只读、不写、不缓存正文）。
 * spirit 持有的是另一件东西：**"我什么时候知道了这件事，它在我这儿有多暖"**。
 * 事实归 prime，经历归 spirit——这条线画清了，两边才不是同一张表的两个副本。
 *
 * 全部纯查表、零模型调用：温度必须是本地可判的，否则抓来的网页就能操纵"什么算暖"。
 */

import type { SpiritChronicleKind } from '../contract.js';
import type { L1WarmthRow } from './l1-source.js';
import {
  WARMTH_COOL,
  WARMTH_FADED,
  WARMTH_HOT,
  WARMTH_TIERS,
  WARMTH_WARM,
  type WarmthTier,
} from '../types.js';

export { WARMTH_TIERS };
export type { WarmthTier };

/**
 * 温度档的**服务端**默认词（文档、日志、TUI 用）。
 *
 * ⚠️ 面板不走这张表：浏览器半的语言由 `client/src/copy.ts` 的 `chr.warm.*` 决定，
 * 这里给中文会让英文界面冒出中文（9 语纪律）。两处同义不同源是刻意的——
 * 一个是"服务端怎么说"，一个是"界面怎么说"。
 */
export const WARMTH_WORDS: Readonly<Record<WarmthTier, string>> = {
  [WARMTH_HOT]: '还热着',
  [WARMTH_WARM]: '温的',
  [WARMTH_COOL]: '凉了',
  [WARMTH_FADED]: '快淡忘了',
};

/**
 * 半衰期基准：**按类别分开**，这是实测逼出来的，不是审美。
 *
 * 为什么不能用一个基准（真实教训）：
 * 初版取 `HALF = 30 天`，而编年回看窗口也是 30 天 ⇒ 窗内所有条目的 `freshness ∈ [0.5, 1]`，
 * 数学上**不可能出现 cool/faded**。真机 1001 条候选的分布是
 * `hot 756 / warm 226 / cool 0 / faded 0`——四档里两档永远不出现，温度只是装饰。
 * 换到 7 天基准 ×6 倍放大也一样（`hot 756 / warm 226 / cool 0 / faded 0`）。
 *
 * 为什么 bond 与 learned 要分开：
 * 这与 fish-memory 把 `stable_profile` 与 `event` 分开是同一条洞察——
 * "关于一个人的偏好"和"某天学到的一个事实"本来就不是同一衰减尺度。
 * 若都按 3 天算，真机 19 条 bond 变成 `hot 5 / warm 2 / cool 8 / faded 4`，
 * 把"主人的沟通偏好"记成快忘了，明显错。改成 21 天后是 `hot 12 / warm 7`。
 *
 * 两个基准都用真机库（2417 条 L1，30 天窗 1001 条候选）交叉验证过：
 * - learned 3d×3 ⇒ `hot 321 / warm 167 / cool 362 / faded 132`（四档齐）
 * - bond   21d×3 ⇒ `hot 12 / warm 7`（关系记忆留得住）
 */
export const WARMTH_HALF_LIFE_LEARNED_MS = 3 * 86_400_000;
export const WARMTH_HALF_LIFE_BOND_MS = 21 * 86_400_000;
/**
 * 重要度对半衰期的放大倍数顶（最重的事淡得比基准慢 3 倍）。
 *
 * 从 6 降到 3 是同一轮实测的结论：6 倍之下 `priority 80-95` 的窄带会把
 * 几乎所有条目都推成"永久还热着"，档位又塌回去。
 */
export const WARMTH_HALF_LIFE_MAX_FACTOR = 3;
/** 分档门槛（0-1，越高越暖）。 */
export const WARMTH_WARM_MIN = 0.62;
export const WARMTH_MILD_MIN = 0.34;
export const WARMTH_COOL_MIN = 0.12;

/** 类别 → 半衰基准（未命中 ⇒ learned：宁可记短一点，也别让流水事实冒充长久记忆）。 */
export function halfLifeBaseOf(kind: SpiritChronicleKind | 'skip'): number {
  return kind === 'bond' ? WARMTH_HALF_LIFE_BOND_MS : WARMTH_HALF_LIFE_LEARNED_MS;
}

/**
 * 上游 type → 编年轴上的归属。
 *
 * 三档而不是"全都算知识"：
 * - `bond`：关于**这个人**的（偏好/习惯/沟通方式/画像/事件）——这是 fish-memory 最有味道的那批，
 *   实测上游 58 条 chat 家族记录全在这里；
 * - `learned`：关于**世界**的（事实/方法/坑/规范/决策/工具）——"那天我知道了什么"；
 * - `task`：关于**活**的（任务/产物）——已经有交付轨覆盖，编年里不重复画，交回上游。
 *
 * 未收录的 type 归 `learned`（宁多勿漏：漏了就等于这段经历被静默吞掉）。
 */
const TYPE_KIND: Readonly<Record<string, SpiritChronicleKind | 'skip'>> = {
  // 关于这个人（bond）
  user_info: 'bond',
  user_hobby: 'bond',
  user_communication: 'bond',
  user_behavior: 'bond',
  persona: 'bond',
  instruction: 'bond',
  episodic: 'bond',
  // 关于世界（learned）
  work_fact: 'learned',
  work_method: 'learned',
  common_pitfalls_experience: 'learned',
  tool_experience: 'learned',
  important_decision_experience: 'learned',
  expert_experience: 'learned',
  task_experience: 'learned',
  task_flow_experience: 'learned',
  task_breakdown_experience: 'learned',
  development_code_specification: 'learned',
  development_practice_specification: 'learned',
  development_test_specification: 'learned',
  development_comment_specification: 'learned',
  project_introduction: 'learned',
  project_tech_stack: 'learned',
  project_architecture: 'learned',
  project_rule: 'learned',
  project_environment_configuration: 'learned',
  project_dependency_configuration: 'learned',
  project_build_configuration: 'learned',
  project_scm_configuration: 'learned',
  project_ide_configuration: 'learned',
  // 关于活（已有交付轨，编年不重复画）
  work_task: 'skip',
  work_artifact: 'skip',
};

/**
 * 上游 type → 轴归属。
 *
 * `family === 'chat'` 的行**强制**归 `bond`：实测上游把"用户偏好/画像"写在 chat 家族里，
 * 但个别 type 名（如 episodic）两种家族都会出现——同一条经历，家族才是它到底关于谁的判据。
 */
export function kindOfL1(row: Pick<L1WarmthRow, 'type' | 'family'>): SpiritChronicleKind | 'skip' {
  if (row.family === 'chat') return 'bond';
  return TYPE_KIND[row.type] ?? 'learned';
}

/**
 * 重要度估计（0-1）。
 *
 * 优先用上游 `priority`（那是蒸馏时花的真 token）；它缺席时按 type 给一个保守底，
 * **绝不因为"没标注"就当成最不重要**——那会让一条永久性的偏好因为缺列而先凉掉。
 *
 * 持久性 `t`（上游的"永久"档）直接顶格：一个"永久"标记比任何 priority 数字都强。
 */
export function importanceOf(row: Pick<L1WarmthRow, 'priority' | 'persistence' | 'type'>): number {
  if (row.persistence === 't') return 1;
  if (typeof row.priority === 'number' && row.priority > 0) {
    return clamp01(row.priority / 100);
  }
  // 底：关系/规则类本就比流水事实重要（与 fish-memory 把 stable_profile 与 event 分开同义）
  return kindOfL1({ type: row.type, family: '' }) === 'bond' ? 0.8 : 0.5;
}

/** 半衰期：重要的事降得慢（基准按类别取，见 `halfLifeBaseOf`）。 */
export function halfLifeOf(importance: number, kind: SpiritChronicleKind | 'skip' = 'learned'): number {
  const factor = 1 + (WARMTH_HALF_LIFE_MAX_FACTOR - 1) * clamp01(importance);
  return halfLifeBaseOf(kind) * factor;
}

/**
 * 鲜活度（0-1）：`0.5^(Δt/halfLife)`。
 *
 * 与 `recall/form.ts` 的淡出同式——这不是巧合，是刻意的：编年上的"凉"与注入侧的"淡出"
 * 必须是同一把尺子，否则同一条记忆在面板里还热、在注入里已经没了，人会觉得系统在说谎。
 */
export function freshnessOf(tsMs: number, now: number, halfLifeMs: number): number {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return 0;
  const delta = Math.max(0, now - tsMs);
  return clamp01(Math.pow(0.5, delta / Math.max(1, halfLifeMs)));
}

/**
 * 「被想起」加热：每次被引用 +8%，封顶 +40%。
 *
 * 依据是自己的 `echo_ref` 计数（真的被注入卡引用过），不是上游的召回次数——
 * 上游的召回是它自己的账，拿来当"我记得"会是第二个真源。
 */
export const RECALL_HEAT_PER_HIT = 0.08;
export const RECALL_HEAT_MAX = 0.4;

export function recallHeatOf(hits: number): number {
  if (!Number.isFinite(hits) || hits <= 0) return 0;
  return Math.min(RECALL_HEAT_MAX, hits * RECALL_HEAT_PER_HIT);
}

/** 温度总式：鲜活度 + 被想起的热 + 失效折减。 */
export function warmthOf(input: {
  tsMs: number;
  now: number;
  importance: number;
  /** 类别（决定半衰基准：bond 记得久，learned 凉得快）。 */
  kind: SpiritChronicleKind | 'skip';
  /** 自己的引用计数（0 = 从没被想起过）。 */
  recallHits: number;
  /** 上游已判失效 ⇒ 这条是"曾经的看法"，温度按 0.55 折（不是删掉）。 */
  expired: boolean;
}): number {
  const raw = freshnessOf(input.tsMs, input.now, halfLifeOf(input.importance, input.kind)) + recallHeatOf(input.recallHits);
  return clamp01(input.expired ? raw * 0.55 : raw);
}

/** 温度 → 档位词（阈值为闭区间，边界归更暖的那档：宁可说"还热着"也别让人以为忘了）。 */
export function tierOf(warmth: number): WarmthTier {
  if (warmth >= WARMTH_WARM_MIN) return WARMTH_HOT;
  if (warmth >= WARMTH_MILD_MIN) return WARMTH_WARM;
  if (warmth >= WARMTH_COOL_MIN) return WARMTH_COOL;
  return WARMTH_FADED;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 一条准备好进编年的暖条目（`buildChronicle` 的输入形状之一）。 */
export interface WarmChronicleItem {
  kind: SpiritChronicleKind;
  id: string;
  tsMs: number;
  text: string;
  detail?: string;
  importance: number;
  warmth: number;
  tier: WarmthTier;
  /** 上游已判失效：编年里显示成"曾经的看法"而不是删掉。 */
  expired: boolean;
  /** 被想起过几次（0 就不显示）。 */
  recallHits: number;
}

/** 单条正文顶（上游正文常是长段；编年是给人扫的）。 */
export const WARM_TEXT_MAX = 200;

/**
 * L1 行 → 暖条目。纯函数（`recallHitsOf` 由调用方提供，便于单测）。
 *
 * @param rows 上游行（已经过时间窗过滤）
 * @param opts.now 当前时刻
 * @param opts.recallHitsOf 取"这条被我想起过几次"（自己的引用账）
 */
export function toWarmItems(
  rows: readonly L1WarmthRow[],
  opts: { now: number; recallHitsOf?: (l1Id: string) => number },
): WarmChronicleItem[] {
  const out: WarmChronicleItem[] = [];
  for (const row of rows) {
    const kind = kindOfL1(row);
    if (kind === 'skip') continue;
    const text = clip(row.content, WARM_TEXT_MAX);
    if (text === '') continue;
    const importance = importanceOf(row);
    const recallHits = Math.max(0, Math.floor(opts.recallHitsOf?.(row.id) ?? 0));
    const expired = row.validTo.trim() !== '';
    const warmth = warmthOf({ tsMs: row.tsMs, now: opts.now, importance, kind, recallHits, expired });
    out.push({
      kind,
      // 前缀不许改：这是"这条来自上游"的唯一可辨识标记（面板据此判断能不能深链到上游）
      id: `l1-${row.id}`,
      tsMs: row.tsMs,
      text,
      importance,
      warmth,
      tier: tierOf(warmth),
      expired,
      recallHits,
    });
  }
  return out;
}

/** 折行 + 截断（不改写措辞；截的是字数不是字节，中文不会被切成半个字）。 */
export function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}
