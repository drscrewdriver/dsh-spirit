/**
 * 人格卡的形状校验与内置默认。
 *
 * 人格在这里的角色是**记录的选择器**（`salience` 决定什么事值得记、`focus` 决定记哪一面、
 * `voice` 决定怎么说），而不只是进系统提示的一段描述文本。所以校验的重点不是"文本好不好看"，
 * 而是**取值域**：salience 必须是 0/1/2，focus 必须是 notice 域内的成员——脏值不会报错，
 * 只会让某些事件永远记不进、或记出一个空句（静默坏）。
 */

import { clampInt, clampTier } from '../util/tier.js';
import { NOTICE_KINDS, VOICE_TIERS, TRIGGER_KINDS, NOTICE_BEING_IGNORED, NOTICE_SELF_MISTAKE, NOTICE_TASK_STALL, NOTICE_USER_STATE, TRIGGER_LONG_GAP, TRIGGER_NEUTRAL, TRIGGER_RECOVERY, TRIGGER_TASK_CLOSE, TRIGGER_TOOL_FAILURE, TRIGGER_USER_CORRECTION, type NoticeKind, type PersonaCard, type SalienceWeight, type TriggerKind, type VoiceTier } from '../types.js';

/** 字段规模上限：人格文件是人手写的，超长就是写错了，不是要支持的特性。 */
export const PERSONA_LIMITS = { values: 8, boundaries: 8, nameChars: 40, itemChars: 120 } as const;

/**
 * 内置默认人格。
 *
 * `salience` 的缺省形状取"中性轮不记"（`neutral: 0`）：默认形态下只记有摩擦或有结论的轮次，
 * 否则每轮一条，条目库就退化成逐轮日志（那正是"每天一本日记"的形状，不是体验条目）。
 */
export const DEFAULT_PERSONA: PersonaCard = {
  id: 'default',
  revision: 1,
  name: '未命名角色',
  voice: 'plain',
  salience: {
    [TRIGGER_USER_CORRECTION]: 2,
    [TRIGGER_TOOL_FAILURE]: 1,
    [TRIGGER_RECOVERY]: 2,
    [TRIGGER_TASK_CLOSE]: 1,
    [TRIGGER_LONG_GAP]: 1,
    [TRIGGER_NEUTRAL]: 0,
  },
  focus: [NOTICE_SELF_MISTAKE, NOTICE_TASK_STALL, NOTICE_USER_STATE, NOTICE_BEING_IGNORED],
  values: [],
  boundaries: [],
};

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, PERSONA_LIMITS.itemChars))
    .filter((item) => item !== '')
    .slice(0, limit);
}

/**
 * salience 逐键收窄。
 *
 * 口径与 `clampInt` 一致：**越界夹到端点，非有限退兜底 0**。
 * 为什么不把 `9` 退成 `0`：那会静默丢掉用户最在意的那一类记录（越界值几乎必然是
 * "很在意"的意思写重了）；而静默丢记录比夹错一格难查得多。
 */
function weightOf(value: unknown): SalienceWeight {
  const numeric = typeof value === 'number' ? value : Number(value);
  const clamped = clampInt(numeric, 0, 2, 0);
  return (clamped === 0 || clamped === 1 ? clamped : 2) as SalienceWeight;
}

function salienceOf(value: unknown): Record<TriggerKind, SalienceWeight> {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const out = { ...DEFAULT_PERSONA.salience };
  for (const trigger of TRIGGER_KINDS) {
    const candidate = raw[trigger];
    if (candidate === undefined) continue;
    out[trigger] = weightOf(candidate);
  }
  return out;
}

function focusOf(value: unknown): NoticeKind[] {
  if (!Array.isArray(value)) return [...DEFAULT_PERSONA.focus];
  const kept = value
    .map((item) => clampTier(item, NOTICE_KINDS, undefined as unknown as NoticeKind))
    .filter((item): item is NoticeKind => item !== undefined);
  // 全脏或全空 ⇒ 退回默认关注面，而不是"什么都不记"（后者会让插件看起来坏了）
  return kept.length > 0 ? [...new Set(kept)] : [...DEFAULT_PERSONA.focus];
}

/**
 * 把任意来源（用户手写的 json）收窄成合法 PersonaCard。
 *
 * 与 `sanitize` 不同，这里**不返回错误**：人格文件坏掉时插件应当退回默认人格继续工作，
 * 而不是把整个会话拖停（调用方负责把"退回了默认"报出来）。
 */
export function sanitizePersona(raw: unknown): { persona: PersonaCard; fellBack: boolean } {
  if (typeof raw !== 'object' || raw === null) return { persona: { ...DEFAULT_PERSONA }, fellBack: true };
  const value = raw as Record<string, unknown>;
  const name = typeof value['name'] === 'string' ? value['name'].trim().slice(0, PERSONA_LIMITS.nameChars) : '';
  const id = typeof value['id'] === 'string' ? value['id'].trim().slice(0, PERSONA_LIMITS.nameChars) : '';
  const revisionRaw = typeof value['revision'] === 'number' ? Math.floor(value['revision']) : Number.NaN;
  const revision = Number.isFinite(revisionRaw) && revisionRaw >= 1 ? revisionRaw : DEFAULT_PERSONA.revision;
  const voice = clampTier(value['voice'], VOICE_TIERS, DEFAULT_PERSONA.voice);
  const fellBack = name === '' && !Array.isArray(value['salience']);
  return {
    persona: {
      id: id === '' ? DEFAULT_PERSONA.id : id,
      revision,
      name: name === '' ? DEFAULT_PERSONA.name : name,
      voice,
      salience: salienceOf(value['salience']),
      focus: focusOf(value['focus']),
      values: stringList(value['values'], PERSONA_LIMITS.values),
      boundaries: stringList(value['boundaries'], PERSONA_LIMITS.boundaries),
    },
    fellBack,
  };
}

/** 写入门的硬校验：形状不合法就拒写（读侧宽容、写侧严格，两侧口径不能反）。 */
export function validatePersona(raw: unknown): { ok: true; persona: PersonaCard } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: '不是对象' };
  const value = raw as Record<string, unknown>;
  if (typeof value['name'] !== 'string' || value['name'].trim() === '') return { ok: false, reason: 'name 必填且非空' };
  if (typeof value['voice'] !== 'string' || !VOICE_TIERS.includes(value['voice'] as VoiceTier)) {
    return { ok: false, reason: `voice 必须是 ${VOICE_TIERS.join('/')}` };
  }
  if (typeof value['salience'] !== 'object' || value['salience'] === null) return { ok: false, reason: 'salience 必填对象' };
  if (!Array.isArray(value['focus'])) return { ok: false, reason: 'focus 必填数组' };
  return { ok: true, persona: sanitizePersona(raw).persona };
}
