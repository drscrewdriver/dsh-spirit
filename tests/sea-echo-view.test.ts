/**
 * 回响面纯函数（v0.8.11）：记录行文字 / 语气行 / 真源定位 / 编号短显。
 */
import { describe, expect, it } from 'vitest';

import { echoRefLabel, echoRefTarget, echoToneLines, shortEcho, shortRecall } from '../client/src/sea/echo-view.js';

const REF = {
  echoId: 'echo-3f9a2b7c-1d4e-4a5b-8c9d-0e1f2a3b4c5d',
  sessionId: 's1',
  kind: 'task',
  memId: 'task-a',
  title: 'plugin-9lang-five-dim',
  times: 1,
  recordTs: 1_700_000_000_000,
  firstTs: 1,
  lastTs: 2,
  lastRecallId: 'recall-3f9a2b7c-1d4e-4a5b-8c9d-0e1f2a3b4c5d',
};

describe('echoRefLabel（记录行文字）', () => {
  it('标题优先；×N 只在多次被想起时出现；编号绝不当标题', () => {
    expect(echoRefLabel(REF)).toBe('plugin-9lang-five-dim');
    expect(echoRefLabel({ ...REF, times: 3 })).toBe('plugin-9lang-five-dim \u00d73');
    expect(echoRefLabel(REF)).not.toContain('echo-');
  });

  it('没标题退 memId（不空行、不编造）', () => {
    expect(echoRefLabel({ ...REF, title: '   ' })).toBe('task-a');
  });
});

describe('编号短显', () => {
  it('echo 短号 = 前缀 + 去连字符 12 位；recall 同口径', () => {
    expect(shortEcho(REF.echoId)).toBe('echo-3f9a2b7c1d4e');
    expect(shortRecall(REF.lastRecallId)).toBe('recall-3f9a2b7c1d4e');
    // 非法/旧格式原样加前缀，不崩
    expect(shortEcho('weird')).toBe('echo-weird');
  });
});

describe('echoToneLines（语气栏）', () => {
  it('状态/开场各一行，顺序固定；缺者不出现', () => {
    expect(echoToneLines({ at: 1, state: '平常·按平时那样说', opening: '又见面了' }, { state: '状态：', opening: '开场：' }))
      .toEqual(['状态：平常·按平时那样说', '开场：又见面了']);
    expect(echoToneLines({ at: 1, state: '平常' }, { state: '状态：', opening: '开场：' })).toEqual(['状态：平常']);
    expect(echoToneLines({ at: 1, state: '' }, { state: '状态：', opening: '开场：' })).toEqual([]);
  });
});

describe('echoRefTarget（点行去哪）', () => {
  it('task/delivery → 本体任务线；memory/goal → 记着；experience/未知 → 条目流', () => {
    expect(echoRefTarget('task')).toEqual({ view: 'onto', ontoTab: 'tasks' });
    expect(echoRefTarget('delivery')).toEqual({ view: 'onto', ontoTab: 'tasks' });
    expect(echoRefTarget('memory')).toEqual({ view: 'onto', ontoTab: 'memory' });
    expect(echoRefTarget('goal')).toEqual({ view: 'onto', ontoTab: 'memory' });
    expect(echoRefTarget('experience')).toEqual({ view: 'entries' });
    expect(echoRefTarget('entity')).toEqual({ view: 'onto', ontoTab: 'entities' });
    expect(echoRefTarget('whatever')).toEqual({ view: 'entries' });
  });
});
