/**
 * 召回查询串（P0）：来源黑名单 + 短句补线索 + 与记账字段分离。
 */
import { describe, expect, it } from 'vitest';

import { buildRecallQuery, humanTexts, isHumanSource, pickHumanText } from '../src/recall/query-source.js';

function msg(kind: unknown, text: string): unknown {
  return { source: { kind }, content: [{ type: 'text', text }] };
}

describe('来源判定（黑名单）', () => {
  it('真人来源放行，包括不认识的第三方桥', () => {
    for (const kind of ['user', 'im-connect', 'qq-bridge', ''] as const) {
      expect(isHumanSource(kind), kind).toBe(true);
    }
  });

  it('机器人自产与宿主注入被跳过', () => {
    for (const kind of ['runtime-context', 'speak-up', 'time-context', 'skill-catalog', 'soul-tone', 'plugin:x', 'tool-call', 'subagent-notice'] as const) {
      expect(isHumanSource(kind), kind).toBe(false);
    }
  });
});

describe('取文本', () => {
  it('多来源混排时只取人话；机器消息不进候选', () => {
    const messages = [msg('user', '第一句'), msg('runtime-context', 'Current runtime context.'), msg('im-connect', '第二句')];
    expect(humanTexts(messages)).toEqual(['第一句', '第二句']);
    expect(pickHumanText(messages)).toBe('第二句');
  });

  it('全是机器消息 ⇒ 空（上层不注入）', () => {
    expect(pickHumanText([msg('plugin:x', '[dream] 整理任务'), msg('runtime-context', 'ctx')])).toBe('');
  });
});

describe('短句补线索', () => {
  it('短句向前拼上文', () => {
    const query = buildRecallQuery([msg('user', '刚才那个气泡副屏的问题修好了吗'), msg('user', '推')]);
    expect(query.startsWith('推 ')).toBe(true);
    expect(query).toContain('气泡副屏');
  });

  it('够长则一个字都不加', () => {
    const long = '气泡在副屏上还是出现在主屏';
    expect(buildRecallQuery([msg('user', '上一句无关的'), msg('user', long)])).toBe(long);
  });

  it('有上限，也不重复拼同一句', () => {
    const query = buildRecallQuery([msg('user', '推'), msg('user', '很长'.repeat(200)), msg('user', '推')], { maxChars: 60, maxPrev: 6 });
    expect(query.length).toBeLessThanOrEqual(60);
    expect((query.match(/推/gu) ?? []).length).toBe(1);
  });

  it('只有机器消息 ⇒ 空', () => {
    expect(buildRecallQuery([msg('speak-up', '该去找他聊天了。')])).toBe('');
  });
});