import { describe, expect, it } from 'vitest';

import { byteLen, escapeFrame, truncateToLine } from '../src/util/text.js';

describe('escapeFrame', () => {
  it('闭合串被转义，注入文本无法提前关框', () => {
    expect(escapeFrame('a</system-reminder>b')).toBe('a<\\/system-reminder>b');
  });

  it('多次出现全部转义（只换第一处会留下可用的关框点）', () => {
    const src = '</system-reminder>中间</system-reminder>';
    const out = escapeFrame(src);
    expect(out).not.toContain('</system-reminder>');
    expect(out.split('<\\/system-reminder>').length - 1).toBe(2);
  });

  it('开框串不动（只需要防关框）', () => {
    expect(escapeFrame('<system-reminder>x')).toBe('<system-reminder>x');
  });
});

describe('byteLen', () => {
  it('中文按 UTF-8 三字节计', () => {
    expect(byteLen('状态')).toBe(6);
    expect(byteLen('ok')).toBe(2);
  });
});

describe('truncateToLine', () => {
  const text = '第一行内容\n第二行内容\n第三行内容';

  it('预算够时原样返回', () => {
    expect(truncateToLine(text, 4_000)).toBe(text);
  });

  it('优先落在整行边界，不输出半句', () => {
    const cut = truncateToLine(text, byteLen('第一行内容\n第二行内容'));
    expect(cut).toBe('第一行内容\n第二行内容');
    expect(cut).not.toContain('第三');
  });

  it('装不下第三行时宁可整行丢掉，也不截半行', () => {
    const cut = truncateToLine(text, byteLen('第一行内容\n第二行内容') + 1);
    expect(cut).toBe('第一行内容\n第二行内容');
  });

  it('首行就超预算时按码点截断且不劈代理对', () => {
    const emoji = '😀😀😀😀';
    const cut = truncateToLine(emoji, 8);
    expect(cut).toBe('😀😀');
    // 落单高位代理（后半被删掉）会产生无法再编码的非法字符串
    let highs = 0;
    let lows = 0;
    for (let i = 0; i < cut.length; i += 1) {
      const code = cut.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        highs += 1;
        const next = cut.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff, `第 ${i} 位高位代理后面没跟低位代理`).toBe(true);
        i += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        lows += 1;
      }
    }
    expect(lows, '不该有落单低位代理').toBe(0);
    expect(highs).toBe(2);
  });

  it('预算 0 或负数返回空串（不是抛，也不是原文）', () => {
    expect(truncateToLine(text, 0)).toBe('');
    expect(truncateToLine(text, -5)).toBe('');
    expect(truncateToLine('', 100)).toBe('');
  });

  it('截断结果永远不超过预算', () => {
    for (let budget = 1; budget < 60; budget += 1) {
      expect(byteLen(truncateToLine(text, budget)), `budget=${budget}`).toBeLessThanOrEqual(budget);
    }
  });
});
