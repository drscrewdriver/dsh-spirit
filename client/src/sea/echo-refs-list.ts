/**
 * 回响面两块渲染（v0.8.11）：语气栏 + 记录列表。
 *
 * 编号语义（用户口径）：
 * - 列表行 = **一条记录**（progress/done 卡片本身），带 `echo-<uuid>` 短号 + **记录时间**；
 * - 行内「原文」按 `lastRecallId`（`recall-<uuid>`）取那一轮注入卡；
 * - 语气/状态单独一栏，标「特殊格式·非引用」。
 *
 * 抽成组件而非内联，是为了能服务端序列化断言（不必等真机截图才发现行文字不对）。
 */
import { createElement, type CSSProperties, type ReactElement } from 'react';

import type { SpiritEchoRecordRow, SpiritEchoTone } from '../../../src/contract.js';
import { echoRefLabel, echoToneLines, shortEcho, shortRecall } from './echo-view.js';

const MUTED: CSSProperties = { fontSize: 12, color: '#6d7891' };
const BADGE: CSSProperties = { fontSize: 11, padding: '0 6px', borderRadius: 6, background: 'rgba(120,160,255,.12)', color: '#8fa8d8' };
const CUE: CSSProperties = { fontSize: 11, padding: '0 6px', borderRadius: 6, background: 'rgba(120,160,255,.1)', color: '#8fa8d8' };
const BUTTON: CSSProperties = { background: 'rgba(120,160,255,.1)', color: '#b8c9ee', border: '1px solid rgba(120,160,255,.22)', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer' };
const ITEM: CSSProperties = { padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(120,160,255,.16)', fontSize: 12 };
const ROW_TEXT: CSSProperties = { fontSize: 13, color: '#e8eeff', flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word', padding: 0, border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer' };
const ID_STYLE: CSSProperties = { fontSize: 11, color: '#6d7891', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };

export interface EchoToneBarProps {
  tone: SpiritEchoTone;
  copy: { badge: string; state: string; opening: string };
  formatTime: (ms: number) => string;
}

/** 「此刻/语气」栏：特殊格式、非引用（状态/开场各一行）。 */
export function EchoToneBar(props: EchoToneBarProps): ReactElement {
  const { tone, copy, formatTime } = props;
  return createElement(
    'div',
    { 'data-spirit': 'echo-tone', style: { padding: '8px 14px', borderBottom: '1px solid rgba(120,160,255,.12)' } },
    createElement(
      'div',
      { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 } },
      createElement('span', { style: CUE }, copy.badge),
      createElement('span', { style: MUTED }, formatTime(tone.at)),
    ),
    ...echoToneLines(tone, { state: copy.state, opening: copy.opening }).map((line, index) =>
      createElement('div', { key: index, style: { fontSize: 13, color: '#e8eeff', marginTop: index === 0 ? 4 : 2, whiteSpace: 'pre-wrap' } }, line),
    ),
  );
}

export interface EchoRecallHeaderProps {
  recall: { recallId: string; at: number; flashback: boolean };
  copy: { label: string; flashback: string };
  formatTime: (ms: number) => string;
}

/** 回响事件头：`recall-xxxx · 时间 [FLASHBACK]`——一次注入一个事件号。 */
export function EchoRecallHeader(props: EchoRecallHeaderProps): ReactElement {
  const { recall, copy, formatTime } = props;
  return createElement(
    'div',
    { 'data-spirit': 'echo-recall', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 14px', borderBottom: '1px solid rgba(120,160,255,.1)' } },
    createElement('span', { style: CUE }, copy.label),
    createElement('span', { style: { ...ID_STYLE, color: '#8fa8d8' }, title: recall.recallId }, shortRecall(recall.recallId)),
    createElement('span', { style: MUTED }, formatTime(recall.at)),
    recall.flashback ? createElement('span', { style: { ...CUE, background: 'rgba(255,190,120,.14)', color: '#e8c07f' } }, copy.flashback) : null,
  );
}

export interface EchoRefsListProps {
  records: readonly SpiritEchoRecordRow[];
  /** 展开的注入卡（按 lastRecallId 匹配行）。 */
  detail: { echoId: string; text: string } | null;
  copy: { original: string; detailEmpty: string };
  emptyText: string;
  kindLabel: (kind: string) => string;
  formatTime: (ms: number) => string;
  /** 「原文」按钮（按 lastRecallId 取那一轮回响卡）。 */
  onOriginal: (row: SpiritEchoRecordRow) => void;
  /** 点标题 → 定位真源视图。 */
  onOpen: (row: SpiritEchoRecordRow) => void;
}

/** 记录列表：一行 = 一条记录（echo-<uuid> + 记录时间 + ×N + 原文）。 */
export function EchoRefsList(props: EchoRefsListProps): ReactElement {
  const { records, detail, copy, emptyText, kindLabel, formatTime, onOriginal, onOpen } = props;
  if (records.length === 0) {
    return createElement('p', { style: { margin: '18px 14px', ...MUTED } }, emptyText);
  }
  return createElement(
    'div',
    { style: { overflowY: 'auto', flex: '1 1 auto', minHeight: 0, padding: '8px 14px' }, 'data-spirit': 'echo-records' },
    ...records.map((row) => createElement(
      'div',
      { key: `${row.sessionId}-${row.echoId}`, style: { ...ITEM, marginBottom: 8, background: 'rgba(10,14,26,.45)' } },
      createElement(
        'div',
        { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 } },
        createElement('span', { style: BADGE }, kindLabel(row.kind)),
        createElement(
          'button',
          { type: 'button', style: ROW_TEXT, 'data-spirit': 'echo-ref-title', title: row.echoId, onClick: () => onOpen(row) },
          echoRefLabel(row),
        ),
        // 记录时间（记录自己的时间，不是注入时刻）
        createElement('span', { style: MUTED }, formatTime(row.recordTs)),
        createElement('button', { type: 'button', style: BUTTON, 'data-spirit': 'echo-ref-original', onClick: () => onOriginal(row) }, copy.original),
      ),
      // 记录号可见（等价 memid）：短号展示、全 UUID 进 tooltip
      createElement('div', { style: { ...ID_STYLE, marginTop: 2 }, title: row.echoId }, shortEcho(row.echoId)),
      detail !== null && detail.echoId === row.echoId
        ? createElement('div', { style: { marginTop: 6, fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: '#e8eeff' } }, detail.text === '' ? copy.detailEmpty : detail.text)
        : null,
    )),
  );
}
