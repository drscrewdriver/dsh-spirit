import { readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AROUSAL_TIERS,
  NOTICE_KINDS,
  REACTION_TIERS,
  TRIGGER_KINDS,
  VALENCE_TIERS,
  VOICE_TIERS,
  type PersonaCard,
} from '../src/types.js';
import { AROUSAL_WORDS, NOTICE_WORDS, REACTION_WORDS, VALENCE_WORDS, VOICE_WORDS } from '../src/words.js';
import { DEFAULT_PERSONA, sanitizePersona, validatePersona, PERSONA_LIMITS } from '../src/persona/types.js';
import { composePersonaText, personaTextFits } from '../src/persona/render.js';
import { PersonaStore } from '../src/persona/store.js';
import { pickNotice, pickReaction, shouldRecord, COVERED_TRIGGERS, salienceOf } from '../src/experience/select.js';
import { byteLen } from '../src/util/text.js';

const logs: { info: string[]; warn: string[] } = { info: [], warn: [] };
const logger = { info: (m: string) => logs.info.push(m), warn: (m: string) => logs.warn.push(m) };

describe('词表完备性', () => {
  it('每个枚举成员都有对外词，且没有野键', () => {
    expect(Object.keys(NOTICE_WORDS).sort()).toEqual([...NOTICE_KINDS].sort());
    expect(Object.keys(REACTION_WORDS).sort()).toEqual([...REACTION_TIERS].sort());
    expect(Object.keys(VALENCE_WORDS).sort()).toEqual([...VALENCE_TIERS].sort());
    expect(Object.keys(AROUSAL_WORDS).sort()).toEqual([...AROUSAL_TIERS].sort());
    expect(Object.keys(VOICE_WORDS).sort()).toEqual([...VOICE_TIERS].sort());
    for (const word of Object.values(AROUSAL_WORDS)) expect(word.length).toBeGreaterThan(0);
  });
});

describe('人格卡校验与收窄', () => {
  it('脏 salience 值按"越界夹端点、非有限退 0"收窄（9 不会静默变成"不记"）', () => {
    const { persona } = sanitizePersona({
      name: '测试',
      voice: 'warm',
      salience: { user_correction: 9, tool_failure: '2', recovery: null, task_close: 1, long_gap: -3, neutral: 1.7 },
    });
    expect(salienceOf(persona, 'user_correction')).toBe(2);
    expect(salienceOf(persona, 'tool_failure')).toBe(2);
    expect(salienceOf(persona, 'recovery')).toBe(0);
    expect(salienceOf(persona, 'task_close')).toBe(1);
    expect(salienceOf(persona, 'long_gap')).toBe(0);
    expect(salienceOf(persona, 'neutral'), '1.7 向下整到 1').toBe(1);
  });

  it('focus 全脏 ⇒ 退默认关注面（不能退成"什么都不记"，那看起来像插件坏了）', () => {
    const { persona } = sanitizePersona({ name: '测试', voice: 'plain', focus: ['nonsense', 42] });
    expect(persona.focus).toEqual([...DEFAULT_PERSONA.focus]);
  });

  it('超长数组与超长条目被裁剪到上限', () => {
    const { persona } = sanitizePersona({
      name: 'x'.repeat(100),
      voice: 'plain',
      values: Array.from({ length: 40 }, (_, i) => `v${i}`),
      boundaries: Array.from({ length: 40 }, () => '长'.repeat(200)),
    });
    expect(persona.values).toHaveLength(PERSONA_LIMITS.values);
    expect(persona.boundaries[0]?.length).toBe(PERSONA_LIMITS.itemChars);
    expect(persona.name.length).toBe(PERSONA_LIMITS.nameChars);
  });

  it('写入门拒脏形状，读侧宽容退默认（两侧口径相反是故意的）', () => {
    expect(validatePersona({ name: '  ', voice: 'plain', salience: {}, focus: [] }).ok).toBe(false);
    expect(validatePersona({ name: 'n', voice: 'loud', salience: {}, focus: [] }).ok).toBe(false);
    expect(validatePersona(null).ok).toBe(false);
    expect(validatePersona({ name: 'n', voice: 'terse', salience: { neutral: 1 }, focus: ['environment'] }).ok).toBe(true);
    expect(sanitizePersona('junk').fellBack).toBe(true);
  });
});

describe('人格区文本（同态与预算）', () => {
  const card: PersonaCard = {
    ...DEFAULT_PERSONA,
    name: '阿昭',
    voice: 'terse',
    values: ['把话说清楚', '不编没有依据的结论'],
    boundaries: ['不会为了显得顺利而说"差不多了"'],
  };

  it('同一张卡两次渲染字节全等', () => {
    expect(composePersonaText(card, 700)).toBe(composePersonaText(card, 700));
  });

  it('文本里没有数字时间戳、路径、情绪数值', () => {
    const text = composePersonaText(card, 700);
    expect(text).not.toMatch(/\d{4}-\d{2}/u);
    expect(text).not.toMatch(/[-+]0?\.\d/u);
    expect(text).not.toContain(card.id);
  });

  it('改 boundaries 会让文本变；改 revision 不会', () => {
    const base = composePersonaText(card, 700);
    const edited = composePersonaText({ ...card, boundaries: [] }, 700);
    const bumped = composePersonaText({ ...card, revision: card.revision + 5 }, 700);
    expect(edited).not.toBe(base);
    expect(bumped).toBe(base);
  });

  it('超预算截在整行边界（不留半句）', () => {
    const full = composePersonaText(card, 700);
    const lines = full.split('\n');
    for (let budget = byteLen(lines[0] ?? ''); budget < byteLen(full); budget += 1) {
      const cut = composePersonaText(card, budget);
      expect(byteLen(cut), `budget=${budget}`).toBeLessThanOrEqual(budget);
      // 截断结果必须仍然是完整行的前缀集合（每行都不是半句）
      for (const line of cut.split('\n')) expect(full.split('\n')).toContain(line);
    }
    expect(personaTextFits(card, 1)).toBe(false);
  });

  it('默认人格（无 values/boundaries）只剩两行', () => {
    const text = composePersonaText(DEFAULT_PERSONA, 700);
    expect(text.split('\n')).toHaveLength(2);
  });
});

describe('PersonaStore', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spirit-persona-'));
    logs.info.length = 0;
    logs.warn.length = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('无文件 ⇒ 退默认人格，且不报警告（missing 是正常首启）', () => {
    const store = new PersonaStore({ dataDir: dir, logger });
    expect(store.current().name).toBe(DEFAULT_PERSONA.name);
    expect(logs.warn).toHaveLength(0);
  });

  it('损坏文件 ⇒ 退默认 + 一条告警（说出来，但不抛）', () => {
    const store = new PersonaStore({ dataDir: dir, logger });
    store.save({ name: '甲', voice: 'plain', salience: DEFAULT_PERSONA.salience, focus: DEFAULT_PERSONA.focus });
    writeFileSync(join(dir, 'persona.json'), '{"version":1,"data":{');
    store.invalidate();
    expect(store.current().name).toBe(DEFAULT_PERSONA.name);
    expect(logs.warn.join('|')).toContain('corrupt');
  });

  it('写入推进 revision，且旧版进了历史文件（永不静默覆盖）', () => {
    const store = new PersonaStore({ dataDir: dir, logger });
    const first = store.save({ name: '甲', voice: 'plain', salience: DEFAULT_PERSONA.salience, focus: DEFAULT_PERSONA.focus });
    expect(first.ok).toBe(true);
    const second = store.save({ name: '乙', voice: 'warm', salience: DEFAULT_PERSONA.salience, focus: DEFAULT_PERSONA.focus });
    if (!second.ok || !first.ok) throw new Error('应写入成功');
    expect(second.persona.revision).toBeGreaterThan(first.persona.revision);
    const history = readFileSync(join(dir, 'persona-history.jsonl'), 'utf8').trim().split('\n');
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history.some((line) => line.includes('甲'))).toBe(true);
    expect(store.current().name).toBe('乙');
  });

  it('外部给的 revision 不能把版本往回带', () => {
    const store = new PersonaStore({ dataDir: dir, logger });
    store.save({ name: '甲', voice: 'plain', salience: DEFAULT_PERSONA.salience, focus: DEFAULT_PERSONA.focus, revision: 99 });
    const back = store.save({ name: '乙', voice: 'plain', salience: DEFAULT_PERSONA.salience, focus: DEFAULT_PERSONA.focus, revision: 1 });
    if (!back.ok) throw new Error('应写入成功');
    expect(back.persona.revision).toBe(100);
  });

  it('脏形状被拒写，库里仍是上一版', () => {
    const store = new PersonaStore({ dataDir: dir, logger });
    store.save({ name: '甲', voice: 'plain', salience: DEFAULT_PERSONA.salience, focus: DEFAULT_PERSONA.focus });
    const rejected = store.save({ name: '乙', voice: 'screaming', salience: {}, focus: [] });
    expect(rejected.ok).toBe(false);
    expect(store.current().name).toBe('甲');
  });
});

describe('记录选择器', () => {
  it('每个事件族都有候选关注面（漏一个就会渲染不出 notice）', () => {
    expect([...COVERED_TRIGGERS].sort()).toEqual([...TRIGGER_KINDS].sort());
  });

  it('salience 0 不记；1/2 记', () => {
    const persona: PersonaCard = { ...DEFAULT_PERSONA, salience: { ...DEFAULT_PERSONA.salience, tool_failure: 0, recovery: 2 } };
    expect(shouldRecord('tool_failure', persona)).toBe(false);
    expect(shouldRecord('recovery', persona)).toBe(true);
    expect(shouldRecord('neutral', DEFAULT_PERSONA)).toBe(false);
  });

  it('同一事件在两个人格下记到不同面（人格真的在改记什么）', () => {
    const selfBlaming: PersonaCard = { ...DEFAULT_PERSONA, focus: ['self_mistake'] };
    const toolBlaming: PersonaCard = { ...DEFAULT_PERSONA, focus: ['environment'] };
    expect(pickNotice('tool_failure', selfBlaming)).toBe('self_mistake');
    expect(pickNotice('tool_failure', toolBlaming)).toBe('environment');
  });

  it('focus 与候选无交集时退候选首项，不返回空', () => {
    const persona: PersonaCard = { ...DEFAULT_PERSONA, focus: ['being_ignored'] };
    expect(pickNotice('tool_failure', persona)).toBe(NOTICE_KINDS[6]);
  });

  it('反应强度按规则：2 且非中性才 strong；0 是 none', () => {
    const persona: PersonaCard = { ...DEFAULT_PERSONA, salience: { ...DEFAULT_PERSONA.salience, neutral: 2, user_correction: 2, task_close: 1 } };
    expect(pickReaction('user_correction', persona)).toBe('strong');
    expect(pickReaction('task_close', persona)).toBe('mild');
    // 没事发生却记"很在意"= 看起来情绪失控且无依据
    expect(pickReaction('neutral', persona)).toBe('mild');
    const noSalience: PersonaCard = { ...DEFAULT_PERSONA, salience: { ...DEFAULT_PERSONA.salience, recovery: 0 } };
    expect(pickReaction('recovery', noSalience)).toBe('none');
  });
});
