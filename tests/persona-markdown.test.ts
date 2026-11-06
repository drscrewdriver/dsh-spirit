/**
 * 人设 markdown 的门禁：单层纯人话文件必须**无损往返**，且拒绝口径明确。
 *
 * 为什么单独成文件：`persona.md` 是唯一能被主人手改的恢复源——round-trip 断一环
 * 就是"备份不可恢复"，而这在事故当天之前不会有任何症状。
 */
import { describe, expect, it } from 'vitest';

import { TRIGGER_KINDS } from '../src/types.js';
import type { PersonaCard } from '../src/types.js';
import { TRIGGER_WORDS_ZH, VOICE_WORDS, NOTICE_WORDS_ZH } from '../src/words.js';
import { DEFAULT_PERSONA } from '../src/persona/types.js';
import { parsePersonaMarkdown, renderPersonaMarkdown } from '../src/persona/markdown.js';

const FULL: PersonaCard = {
  id: 'default',
  revision: 7,
  name: '小鱼',
  aliases: ['阿鱼', '鱼鱼'],
  selfNames: ['我', '本鱼'],
  voice: 'warm',
  salience: {
    user_interruption: 2,
    tool_failure: 1,
    recovery: 2,
    task_close: 1,
    long_gap: 0,
    neutral: 0,
  },
  focus: ['self_mistake', 'user_state', 'being_ignored'],
  values: ['不把猜测写成事实', '先复述再动手'],
  boundaries: ['不主动外发消息'],
};

describe('renderPersonaMarkdown ⇄ parsePersonaMarkdown', () => {
  it('满字段卡 round-trip：除 revision 由 store 推进外逐字段相等', () => {
    const parsed = parsePersonaMarkdown(renderPersonaMarkdown(FULL));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect({ ...parsed.persona, revision: FULL.revision }).toEqual(FULL);
  });

  it('默认卡 round-trip（空 values/boundaries 解析回空数组而不是缺省）', () => {
    const parsed = parsePersonaMarkdown(renderPersonaMarkdown(DEFAULT_PERSONA));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.persona.values).toEqual([]);
    expect(parsed.persona.boundaries).toEqual([]);
    expect(parsed.persona.aliases).toEqual([]);
    expect(parsed.persona.selfNames).toEqual([]);
    expect(parsed.persona.name).toBe(DEFAULT_PERSONA.name);
  });

  it('昵称序列 round-trip：保序去重；超 24 字截断、超 8 个截断（自由词只套上限，不拒收）', () => {
    const many: PersonaCard = {
      ...FULL,
      aliases: ['阿鱼', '阿鱼', '鱼'.repeat(30), '小可爱', '鱼鱼', '阿麟', '小渔', '团子', '多多', '余余'],
    };
    const parsed = parsePersonaMarkdown(renderPersonaMarkdown(many));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.persona.aliases.length).toBeLessThanOrEqual(8);
    expect(parsed.persona.aliases[0]).toBe('阿鱼'); // 去重保序：首个重复只留一份
    expect(parsed.persona.aliases.every((alias) => alias.length <= 24)).toBe(true);
  });

  it('条目含 `-` / `:` 开头字符不被二次解析', () => {
    const tricky: PersonaCard = {
      ...FULL,
      values: ['- 这不是新列表项', '键: 值对不是语义'],
      boundaries: ['12:30 后不打扰'],
    };
    const parsed = parsePersonaMarkdown(renderPersonaMarkdown(tricky));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.persona.values).toEqual(['- 这不是新列表项', '键: 值对不是语义']);
    expect(parsed.persona.boundaries).toEqual(['12:30 后不打扰']);
  });

  it('文件里零 slug：在意度/在意面/语气全是 words.ts 中文', () => {
    const text = renderPersonaMarkdown(FULL);
    for (const slug of [...TRIGGER_KINDS, ...Object.keys(DEFAULT_PERSONA.salience), 'plain', 'warm', 'terse', 'self_mistake', 'user_state', 'being_ignored']) {
      expect(text, `不应含 slug ${slug}`).not.toContain(slug);
    }
    expect(text).toContain(VOICE_WORDS.warm);
    expect(text).toContain(TRIGGER_WORDS_ZH.long_gap);
    expect(text).toContain(NOTICE_WORDS_ZH.being_ignored);
  });

  it('未知语气词被整体拒绝，reason 点名该词并给合法值（旧 slug 也在列）', () => {
    const text = renderPersonaMarkdown(FULL).replace(VOICE_WORDS.warm, '文绉绉');
    const parsed = parsePersonaMarkdown(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('文绉绉');
    expect(parsed.reason).toContain('平实');
  });

  it('「plain」这类旧 slug 当未知词拒绝且提示中文', () => {
    const text = renderPersonaMarkdown(FULL).replace(VOICE_WORDS.warm, 'plain');
    const parsed = parsePersonaMarkdown(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('plain');
  });

  it('未知在意面词被拒且点名；在意度非 0|1|2 被拒', () => {
    const badFocus = renderPersonaMarkdown(FULL).replace(`- ${NOTICE_WORDS_ZH.self_mistake}`, '- 我的锅');
    const p1 = parsePersonaMarkdown(badFocus);
    expect(p1.ok).toBe(false);
    if (!p1.ok) expect(p1.reason).toContain('我的锅');

    const badWeight = renderPersonaMarkdown(FULL).replace(`- ${TRIGGER_WORDS_ZH.user_interruption}: 2`, `- ${TRIGGER_WORDS_ZH.user_interruption}: 9`);
    const p2 = parsePersonaMarkdown(badWeight);
    expect(p2.ok).toBe(false);
    if (!p2.ok) expect(p2.reason).toContain('被打断');
  });

  it('节缺失取默认值（宽容）；整份不像备份则拒（缺「## 名字」节）', () => {
    const noVoice = renderPersonaMarkdown(FULL).replace(/## 语气\n[\s\S]*?(?=\n## )/u, '');
    const p1 = parsePersonaMarkdown(noVoice);
    expect(p1.ok).toBe(true);
    if (p1.ok) expect(p1.persona.voice).toBe(DEFAULT_PERSONA.voice);

    const p2 = parsePersonaMarkdown('# 随便什么\n- 名字: 不是这个格式');
    expect(p2.ok).toBe(false);
    if (!p2.ok) expect(p2.reason).toContain('名字');
  });

  it('revision 行不采信：文件写 999 也由 store 推进（parse 输出恒为默认 revision）', () => {
    const parsed = parsePersonaMarkdown(renderPersonaMarkdown(FULL));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.persona.revision).toBe(DEFAULT_PERSONA.revision);
  });
});
