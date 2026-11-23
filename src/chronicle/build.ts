/**
 * 编年汇编（v0.10 定位重钉）：把「事 / 感 / 线 / 记着」按天编到同一条轴上。
 *
 * 为什么要有这一层，而不是复用 `entries-list`：
 * 那个面答的是"我记了哪些句子"，而体验条目按设计只认摩擦（`neutral` 人格权重为 0 时不落库），
 * 于是它天然只能列出"我错了/我恢复了"。真机上 22 条里 18 条是失败与恢复——
 * **作为记忆界面，它展示的不是记忆，是伤疤清单**。编年要答的是另一个问题：
 * "我是怎么走到这儿的"，所以轴上必须以「事」为主体。
 *
 * 三条纪律：
 * 1. **只搬不造。** 本文件不生成任何新句子，只把已有行放进同一条轴并按天分组。
 *    文案模板归 `experience/render.ts`，蒸馏归 `distill/`，这里碰它们就等于第二真源。
 * 2. **重复才敢报数。** `repeat > 1` 只在同日 `(kind, text)` 等值成立时给出——
 *    这是库里的行数，不是"第几次"。
 * 3. **事不依赖感。** 就算把体验条目全藏起来，编年也要读得通；反过来也一样，
 *    少一路供给只是变稀，不是报错。
 */

import type {
  SpiritChronicleDay,
  SpiritChronicleItem,
  SpiritChronicleKind,
  SpiritChronicleResult,
} from '../contract.js';
import type { NoticeKind, TriggerKind } from '../types.js';

/** 每天条目顶（超出按时间取近的；面板不搬整库）。 */
export const CHRONICLE_PER_DAY_DEFAULT = 40;
/** 回看天数顶。 */
export const CHRONICLE_DAYS_MAX = 365;
/** 单条正文顶：编年是给人扫的，不是全文库。 */
export const CHRONICLE_TEXT_MAX = 320;

/** 交付行常见的主语前缀（写入侧 `ontology` 带的标签），编年里由 kind 徽标承担，正文去掉。 */
const DELIVERY_PREFIX = /^(?:交付物|交付|delivered|delivery)(?:\s*[:：]\s*)/iu;

/** 体验条目输入（= `ExperienceEntry` 的最小投影，避免 store 反依赖）。 */
export interface ChronicleFeelInput {
  id: string;
  tsMs: number;
  trigger: TriggerKind;
  notice: NoticeKind;
  text: string;
  gist?: string | null;
  sessionId?: string;
  echoId?: string;
}

/** 交付输入（= `TxnEntry` 的最小投影）。 */
export interface ChronicleWorkInput {
  id: string;
  tsMs: number;
  cardLine: string;
  summary?: string | null;
  sessionId?: string;
  echoId?: string;
}

/** 记着输入（= `SpiritMemoryRow` 的最小投影）。 */
export interface ChronicleNoteInput {
  id: string;
  tsMs: number;
  text: string;
  sessionId?: string;
  echoId?: string;
}

/** 生涯流程档输入（= `DistillDigestRow` 的最小投影；只取 week/month 这类「一段日子」档进轴）。 */
export interface ChronicleMilestoneInput {
  periodKey: string;
  tsMs: number;
  summary: string;
}

export interface ChronicleInput {
  feels: readonly ChronicleFeelInput[];
  works: readonly ChronicleWorkInput[];
  notes?: readonly ChronicleNoteInput[];
  milestones?: readonly ChronicleMilestoneInput[];
  /** 窗口（含两端，ms）。窗口外的行一律丢掉——编年不是全库导出。 */
  from: number;
  to: number;
  perDay?: number;
  /** 时区无关的日键构造（测试可注入固定实现）；缺省用本机时区。 */
  dayKeyOf?: (tsMs: number) => string;
}

/** 本机时区的日键（跨时区不假装统一：编年是给人看的，跟机器走）。 */
export function localDayKey(tsMs: number): string {
  const date = new Date(tsMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 正文归一：折行、去交付前缀、截断。**不改写任何措辞**。 */
export function chronicleText(raw: string): string {
  const flat = raw.replace(/\s+/gu, ' ').trim().replace(DELIVERY_PREFIX, '');
  if (flat.length <= CHRONICLE_TEXT_MAX) return flat;
  return `${flat.slice(0, CHRONICLE_TEXT_MAX - 1)}…`;
}

/**
 * 排序权重：**先按类别，再按时间**。
 *
 * 编年的产品纪律是「事是主体、感是注脚」，所以一天里的事必须整体压在感之上——
 * 否则一条晚上的"我又出错了"就会占据第一屏的最上面，而那正是这次重定位要治的病。
 * 同类之内才按时间倒序（近的在前）。
 */
const KIND_WEIGHT: Readonly<Record<SpiritChronicleKind, number>> = {
  work: 3,
  milestone: 2,
  note: 1,
  feel: 0,
};

function emptyCounts(): Record<SpiritChronicleKind, number> {
  return { work: 0, feel: 0, note: 0, milestone: 0 };
}

interface Pending {
  item: SpiritChronicleItem;
  day: string;
}

/**
 * 汇编一条编年轴。
 *
 * 排序：天倒序（近的在前）；天内按 `tsMs` 倒序，同刻按 `KIND_WEIGHT` 倒序（事在前）。
 * 聚合：同日同 kind 同 text ⇒ 合并成一行，`repeat` 累加，`tsMs` 取最新（最近一次发生）。
 */
export function buildChronicle(input: ChronicleInput): SpiritChronicleResult {
  const dayKeyOf = input.dayKeyOf ?? localDayKey;
  const perDay = Math.max(1, Math.floor(input.perDay ?? CHRONICLE_PER_DAY_DEFAULT));
  const inWindow = (ts: number): boolean => ts >= input.from && ts <= input.to;

  const merged = new Map<string, Pending>();
  const push = (pending: Pending): void => {
    const key = `${pending.day}|${pending.item.kind}|${pending.item.text}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, pending);
      return;
    }
    existing.item.repeat += pending.item.repeat;
    // 取最近一次发生：编年是"最后一次是什么时候"的口径，不是最早
    if (pending.item.tsMs > existing.item.tsMs) {
      existing.item.tsMs = pending.item.tsMs;
      existing.item.id = pending.item.id;
      if (pending.item.echoId !== undefined) existing.item.echoId = pending.item.echoId;
      if (pending.item.sessionId !== undefined) existing.item.sessionId = pending.item.sessionId;
    }
    if (existing.item.detail === undefined && pending.item.detail !== undefined) {
      existing.item.detail = pending.item.detail;
    }
  };

  for (const work of input.works) {
    if (!inWindow(work.tsMs)) continue;
    const text = chronicleText(work.cardLine);
    if (text === '') continue;
    const detail = typeof work.summary === 'string' ? chronicleText(work.summary) : '';
    push({
      day: dayKeyOf(work.tsMs),
      item: {
        kind: 'work',
        id: work.id,
        tsMs: work.tsMs,
        text,
        ...(detail === '' ? {} : { detail }),
        ...(work.echoId === undefined ? {} : { echoId: work.echoId }),
        ...(work.sessionId === undefined ? {} : { sessionId: work.sessionId }),
        repeat: 1,
      },
    });
  }

  for (const feel of input.feels) {
    if (!inWindow(feel.tsMs)) continue;
    const text = chronicleText(feel.text);
    if (text === '') continue;
    const gist = typeof feel.gist === 'string' ? chronicleText(feel.gist) : '';
    push({
      day: dayKeyOf(feel.tsMs),
      item: {
        kind: 'feel',
        id: feel.id,
        tsMs: feel.tsMs,
        text,
        // gist 与 text 同句时不再重复下发（早期行 gist 就是 text 的压缩版）
        ...(gist === '' || gist === text ? {} : { detail: gist }),
        ...(feel.echoId === undefined ? {} : { echoId: feel.echoId }),
        ...(feel.sessionId === undefined ? {} : { sessionId: feel.sessionId }),
        repeat: 1,
      },
    });
  }

  for (const note of input.notes ?? []) {
    if (!inWindow(note.tsMs)) continue;
    const text = chronicleText(note.text);
    if (text === '') continue;
    push({
      day: dayKeyOf(note.tsMs),
      item: {
        kind: 'note',
        id: note.id,
        tsMs: note.tsMs,
        text,
        ...(note.echoId === undefined ? {} : { echoId: note.echoId }),
        ...(note.sessionId === undefined ? {} : { sessionId: note.sessionId }),
        repeat: 1,
      },
    });
  }

  for (const milestone of input.milestones ?? []) {
    if (!inWindow(milestone.tsMs)) continue;
    // 时期档是「日期 · 类型 · 正文」的多行摘要：首行进 text，其余进 detail
    const lines = milestone.summary.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '');
    const head = chronicleText(lines[0] ?? '');
    if (head === '') continue;
    const rest = chronicleText(lines.slice(1).join(' '));
    push({
      day: dayKeyOf(milestone.tsMs),
      item: {
        kind: 'milestone',
        id: `ms-${milestone.periodKey}`,
        tsMs: milestone.tsMs,
        text: head,
        ...(rest === '' ? {} : { detail: rest }),
        repeat: 1,
      },
    });
  }

  const byDay = new Map<string, SpiritChronicleItem[]>();
  for (const pending of merged.values()) {
    const list = byDay.get(pending.day) ?? [];
    list.push(pending.item);
    byDay.set(pending.day, list);
  }

  let total = 0;
  const days: SpiritChronicleDay[] = [];
  for (const [day, items] of byDay) {
    items.sort((a, b) => (KIND_WEIGHT[b.kind] - KIND_WEIGHT[a.kind]) || (b.tsMs - a.tsMs));
    const kept = items.slice(0, perDay);
    const counts = emptyCounts();
    let dayTotal = 0;
    for (const item of kept) {
      counts[item.kind] += 1;
      dayTotal += item.repeat;
    }
    total += dayTotal;
    days.push({ day, items: kept, counts });
  }
  days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

  return {
    days,
    total,
    from: input.from,
    to: input.to,
    empty: days.length === 0,
  };
}
