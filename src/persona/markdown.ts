/**
 * 人设卡的 markdown 单源序列化（单层纯人话，文件本身就是恢复源）。
 *
 * 为什么不嵌 JSON 恢复区（用户拍板）：`PersonaCard` 的字段全是平标量或字符串数组，
 * 单层 markdown 无损表达得住；正文之外再放一份 JSON 是第二真源，两者迟早打架，
 * 而打架时"以哪份为准"没有好答案。
 *
 * 文件里**零 slug**：主人写「自己的失误」而不是 `self_mistake`——这份文件要能被
 * 人手改，就得用人手会写的词。词表单源在 `words.ts`（`TRIGGER_WORDS_ZH` /
 * `NOTICE_WORDS_ZH` / `VOICE_WORDS`），反查表由它们派生，不手抄第二份字面量。
 *
 * 解析纪律与存储层同口径：**读侧宽容、写侧严格**——
 * - 节缺失 ⇒ 该字段取默认卡对应值（宽容：人手删了一节不该炸）；
 * - 枚举词不认识 ⇒ **整体拒绝**并点名是哪个词（严格：把脏值留在库里是丢数据的开始，
 *   静默退回默认更糟——主人以为恢复成功了，实际人格被抹平）；
 * - `revision` 行只作展示：恢复时由 `PersonaStore.save()` 推进，外部给什么都不收。
 */

import { NOTICE_KINDS, TRIGGER_KINDS, VOICE_TIERS, type NoticeKind, type PersonaCard, type SalienceWeight, type TriggerKind, type VoiceTier } from '../types.js';
import { NOTICE_WORDS_ZH, TRIGGER_WORDS_ZH, VOICE_WORDS } from '../words.js';
import { DEFAULT_PERSONA, PERSONA_LIMITS } from './types.js';

const SECTION_NAME = '名字';
const SECTION_ALIASES = '昵称';
const SECTION_SELF_NAMES = '自称';
const SECTION_VOICE = '语气';
const SECTION_SALIENCE = '在意度';
const SECTION_FOCUS = '在意面';
const SECTION_VALUES = '价值';
const SECTION_BOUNDARIES = '边界';

/** 中文 label → slug 的反查表（从 words.ts 派生，唯一来源）。 */
const TRIGGER_BY_LABEL: ReadonlyMap<string, TriggerKind> = new Map(
  TRIGGER_KINDS.map((slug) => [TRIGGER_WORDS_ZH[slug], slug] as const),
);
const NOTICE_BY_LABEL: ReadonlyMap<string, NoticeKind> = new Map(
  NOTICE_KINDS.map((slug) => [NOTICE_WORDS_ZH[slug], slug] as const),
);
const VOICE_BY_LABEL: ReadonlyMap<string, VoiceTier> = new Map(
  VOICE_TIERS.map((slug) => [VOICE_WORDS[slug], slug] as const),
);

export function renderPersonaMarkdown(card: PersonaCard): string {
  const lines: string[] = [
    '# 人设卡',
    '',
    `- revision: ${card.revision}`,
    '',
    `## ${SECTION_NAME}`,
    card.name,
    '',
    `## ${SECTION_ALIASES}`,
  ];
  for (const alias of card.aliases) {
    lines.push(`- ${alias}`);
  }
  lines.push('', `## ${SECTION_SELF_NAMES}`);
  for (const selfName of card.selfNames) {
    lines.push(`- ${selfName}`);
  }
  lines.push('', `## ${SECTION_VOICE}`);
  lines.push(VOICE_WORDS[card.voice]);
  lines.push('', `## ${SECTION_SALIENCE}`);
  for (const trigger of TRIGGER_KINDS) {
    lines.push(`- ${TRIGGER_WORDS_ZH[trigger]}: ${card.salience[trigger] ?? DEFAULT_PERSONA.salience[trigger]}`);
  }
  lines.push('', `## ${SECTION_FOCUS}`);
  for (const notice of card.focus) {
    lines.push(`- ${NOTICE_WORDS_ZH[notice]}`);
  }
  lines.push('', `## ${SECTION_VALUES}`);
  for (const item of card.values) {
    lines.push(`- ${item}`);
  }
  lines.push('', `## ${SECTION_BOUNDARIES}`);
  for (const item of card.boundaries) {
    lines.push(`- ${item}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 按 `## ` 切节：节名 → 节内原始行（首行前的空行保留也无妨，消费时逐行 trim）。 */
function splitSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const heading = /^## (.+)$/u.exec(line);
    if (heading !== null && heading[1] !== undefined) {
      current = [];
      sections.set(heading[1].trim(), current);
      continue;
    }
    // `# 人设卡` 与 `- revision:` 行不属于任何节，跳过（顶层只作展示）
    if (current !== undefined && !line.startsWith('#')) current.push(line);
  }
  return sections;
}

/** 取节内第一条非空且非列表的文本行（名字/语气用）。 */
function firstLine(lines: readonly string[] | undefined): string {
  for (const line of lines ?? []) {
    const trimmed = line.trim();
    if (trimmed !== '' && !trimmed.startsWith('-')) return trimmed;
  }
  return '';
}

/** 取节内所有 `- ` 列表行的内容（只剥前导 `- ` 一次，条目正文不做二次语义解析）。 */
function listItems(lines: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const line of lines ?? []) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) out.push(trimmed.slice(2).trim());
    else if (trimmed === '-') out.push('');
  }
  return out.filter((item) => item !== '');
}

export type ParsePersonaMarkdownResult = { ok: true; persona: PersonaCard } | { ok: false; reason: string };

export function parsePersonaMarkdown(text: string): ParsePersonaMarkdownResult {
  if (!text.includes(`## ${SECTION_NAME}`)) {
    return { ok: false, reason: `不是本插件的人设备份（缺「## ${SECTION_NAME}」节）；备份可从人设页「查看备份」导出` };
  }
  const sections = splitSections(text);

  const name = firstLine(sections.get(SECTION_NAME)) || DEFAULT_PERSONA.name;

  const voiceLine = firstLine(sections.get(SECTION_VOICE));
  let voice: VoiceTier = DEFAULT_PERSONA.voice;
  if (voiceLine !== '') {
    const found = VOICE_BY_LABEL.get(voiceLine);
    if (found === undefined) {
      return {
        ok: false,
        reason: `语气不认识「${voiceLine}」（合法值：${VOICE_TIERS.map((t) => VOICE_WORDS[t]).join('/')}；旧版 slug 如 plain/terse/warm 不再接受）`,
      };
    }
    voice = found;
  }

  const salience = { ...DEFAULT_PERSONA.salience };
  for (const item of listItems(sections.get(SECTION_SALIENCE))) {
    const sep = item.lastIndexOf(':');
    if (sep <= 0) return { ok: false, reason: `在意度行应为「- <项>: <0|1|2>」，收到「- ${item}」` };
    const label = item.slice(0, sep).trim();
    const rawWeight = item.slice(sep + 1).trim();
    const trigger = TRIGGER_BY_LABEL.get(label);
    if (trigger === undefined) {
      return { ok: false, reason: `在意度项不认识「${label}」（合法值：${TRIGGER_KINDS.map((t) => TRIGGER_WORDS_ZH[t]).join('/')}）` };
    }
    const weight = Number(rawWeight);
    if (!Number.isInteger(weight) || weight < 0 || weight > 2) {
      return { ok: false, reason: `「${label}」的在意度必须是 0、1 或 2，收到「${rawWeight}」` };
    }
    salience[trigger] = weight as SalienceWeight;
  }

  let focus: NoticeKind[] = [...DEFAULT_PERSONA.focus];
  const focusItems = listItems(sections.get(SECTION_FOCUS));
  if (focusItems.length > 0) {
    const mapped: NoticeKind[] = [];
    for (const label of focusItems) {
      const found = NOTICE_BY_LABEL.get(label);
      if (found === undefined) {
        return { ok: false, reason: `在意面不认识「${label}」（合法值：${NOTICE_KINDS.map((n) => NOTICE_WORDS_ZH[n]).join('/')}）` };
      }
      mapped.push(found);
    }
    focus = [...new Set(mapped)];
  }

  return {
    ok: true,
    persona: {
      id: DEFAULT_PERSONA.id,
      // revision 不采信文件里的值：恢复走 save()，由 store 推进（与 persona-set 同纪律）
      revision: DEFAULT_PERSONA.revision,
      name,
      // 昵称是自由词（非枚举），不设拒收口径；只套上限截断（去重保序，与 sanitize 同形状）
      aliases: [...new Set(listItems(sections.get(SECTION_ALIASES)).map((item) => item.slice(0, PERSONA_LIMITS.aliasChars)))].slice(0, PERSONA_LIMITS.aliases),
      selfNames: [...new Set(listItems(sections.get(SECTION_SELF_NAMES)).map((item) => item.slice(0, PERSONA_LIMITS.aliasChars)))].slice(0, PERSONA_LIMITS.selfNames),
      voice,
      salience,
      focus,
      values: listItems(sections.get(SECTION_VALUES)),
      boundaries: listItems(sections.get(SECTION_BOUNDARIES)),
    },
  };
}
