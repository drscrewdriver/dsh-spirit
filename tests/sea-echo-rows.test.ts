/**
 * 回响面组件渲染（v0.8.11）：语气栏 + 回响事件头 + 记录列表。
 * 要素树断言：记录行带 echo 短号与记录时间；「原文」按 lastRecallId；事件头带 recall 号与 FLASHBACK。
 */
import { describe, expect, it } from 'vitest';

import { EchoRecallHeader, EchoRefsList, EchoToneBar } from '../client/src/sea/echo-refs-list.js';

/** 极简 React 元素 → 伪 HTML（测试环境 react 为轻量替身：children 在顶层）。 */
function html(node: unknown): string {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => html(child)).join('');
  const el = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown };
  const props = el.props ?? {};
  const attrs = Object.entries(props)
    .filter(([key]) => key !== 'children' && key !== 'style')
    .map(([key, value]) => `${key}="${String(value)}"`)
    .join(' ');
  const children = props['children'] ?? el.children;
  const inner = Array.isArray(children) ? children.map((child) => html(child)).join('') : html(children);
  const tag = typeof el.type === 'string' ? el.type : 'component';
  return `<${tag}${attrs === '' ? '' : ` ${attrs}`}>${inner}</>`;
}

const RECORD = {
  echoId: 'echo-3f9a2b7c-1d4e-4a5b-8c9d-0e1f2a3b4c5d',
  sessionId: 's1',
  kind: 'task',
  memId: 'task-a',
  title: 'plugin-9lang-five-dim',
  times: 3,
  recordTs: 1_700_000_000_000,
  firstTs: 1_700_000_100_000,
  lastTs: 1_700_000_900_000,
  lastRecallId: 'recall-9f8e7d6c-5b4a-4321-8765-0a1b2c3d4e5f',
};

const COPY = { original: '原文', detailEmpty: '这条早期落档没有原文' };
const kindLabel = (kind: string): string => (kind === 'task' ? '任务' : kind);
const formatTime = (): string => '11/9 02:46';

describe('EchoRefsList（记录列表）', () => {
  it('行 = kind 徽标 + 标题（×N）+ 记录时间 + 原文；echo 短号在副行、全号在 tooltip', () => {
    const out = html(EchoRefsList({ records: [RECORD], detail: null, copy: COPY, emptyText: '空', kindLabel, formatTime, onOriginal: () => {}, onOpen: () => {} }));
    expect(out).toContain('任务');
    expect(out).toContain('plugin-9lang-five-dim ×3');
    expect(out).toContain('11/9 02:46');
    expect(out).toContain('原文');
    expect(out).toContain('data-spirit="echo-ref-title"');
    expect(out).toContain('echo-3f9a2b7c1d4e');
    expect(out).toContain(`title="${RECORD.echoId}"`);
    // 行文字用 title，不是编号：编号只在副行/tooltip 里
    expect(out.includes('>plugin-9lang-five-dim ×3<')).toBe(true);
  });

  it('展开原文按 echoId 匹配；无原文给「早期落档」话术', () => {
    const withText = html(EchoRefsList({ records: [RECORD], detail: { echoId: RECORD.echoId, text: '整张注入卡' }, copy: COPY, emptyText: '空', kindLabel, formatTime, onOriginal: () => {}, onOpen: () => {} }));
    expect(withText).toContain('整张注入卡');
    const empty = html(EchoRefsList({ records: [RECORD], detail: { echoId: RECORD.echoId, text: '' }, copy: COPY, emptyText: '空', kindLabel, formatTime, onOriginal: () => {}, onOpen: () => {} }));
    expect(empty).toContain('这条早期落档没有原文');
    const other = html(EchoRefsList({ records: [RECORD], detail: { echoId: 'echo-other', text: '不该出现' }, copy: COPY, emptyText: '空', kindLabel, formatTime, onOriginal: () => {}, onOpen: () => {} }));
    expect(other).not.toContain('不该出现');
  });

  it('空列表 ⇒ 空态文案', () => {
    const out = html(EchoRefsList({ records: [], detail: null, copy: COPY, emptyText: '还没有被召回的记忆引用', kindLabel, formatTime, onOriginal: () => {}, onOpen: () => {} }));
    expect(out).toContain('还没有被召回的记忆引用');
  });
});

describe('EchoRecallHeader（回响事件头）', () => {
  it('recall 短号 + 时间；flashback 时出 FLASHBACK 标', () => {
    const out = html(EchoRecallHeader({
      recall: { recallId: 'recall-9f8e7d6c-5b4a-4321-8765-0a1b2c3d4e5f', at: 1_700_000_000_000, flashback: true },
      copy: { label: '回响', flashback: 'FLASHBACK' },
      formatTime,
    }));
    expect(out).toContain('回响');
    expect(out).toContain('recall-9f8e7d6c5b4a');
    expect(out).toContain('FLASHBACK');
    expect(out).toContain('data-spirit="echo-recall"');
    const plain = html(EchoRecallHeader({ recall: { recallId: 'recall-x', at: 1, flashback: false }, copy: { label: '回响', flashback: 'FLASHBACK' }, formatTime }));
    expect(plain).not.toContain('FLASHBACK');
  });
});

describe('EchoToneBar（语气栏）', () => {
  it('特殊格式徽标 + 状态/开场各一行；缺者不出现', () => {
    const out = html(EchoToneBar({ tone: { at: 1, state: '平常·按平时那样说', opening: '又见面了' }, copy: { badge: '特殊格式 · 非引用', state: '状态：', opening: '开场：' }, formatTime }));
    expect(out).toContain('特殊格式 · 非引用');
    expect(out).toContain('状态：平常·按平时那样说');
    expect(out).toContain('开场：又见面了');
    const onlyState = html(EchoToneBar({ tone: { at: 1, state: '平常' }, copy: { badge: 'b', state: '状态：', opening: '开场：' }, formatTime }));
    expect(onlyState).not.toContain('开场：');
  });
});
