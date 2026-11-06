/**
 * 「线索头」视图（v0.3.5 长觉阶梯）：主题分区 + 洞察 + 碰撞人工裁决。
 *
 * 挂在翻阅 tab 的第二子视图（条目流 ⇄ 线索头）：主题列表来自 topics-get，
 * 冲突清单在顶部（conflict 双条并排）——裁决按钮走 insight-resolve 写面：
 * 「信这条」= 败方 supersede 到胜方；「都收起来」= winnerId 空。
 * 机器不自动删、人也不删：裁决只改状态位，原文永远读得回来（正交性的落点）。
 */
import { createElement, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import type { SpiritInsightView } from '../../../src/contract.js';
import { copyOf } from '../copy.js';
import type { RpcFn } from '../rpc.js';

const HEAD_STYLE: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid rgba(120,160,255,.14)' };
const LIST_STYLE: CSSProperties = { listStyle: 'none', padding: '10px 14px', margin: 0, display: 'grid', gap: 8, overflowY: 'auto' };
const ITEM_STYLE: CSSProperties = { padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(120,160,255,.16)', fontSize: 12 };
const BADGE_STYLE: CSSProperties = { fontSize: 11, padding: '0 6px', borderRadius: 6, background: 'rgba(120,160,255,.12)', color: '#8fa8d8' };
const MUTED_STYLE: CSSProperties = { fontSize: 12, color: '#6d7891' };
const BUTTON_STYLE: CSSProperties = { background: 'rgba(120,160,255,.1)', color: '#b8c9ee', border: '1px solid rgba(120,160,255,.22)', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer' };
const CONFLICT_STYLE: CSSProperties = { ...ITEM_STYLE, border: '1px solid rgba(255,170,110,.5)' };

interface TopicEntry {
  id: string;
  name: string;
  origin: string;
  entries: number;
  insights: number;
  insightRows: SpiritInsightView[];
}

export interface SeaTopicsProps {
  rpc?: RpcFn;
}

export function SeaTopics(props: SeaTopicsProps) {
  const { rpc } = props;
  const copy = copyOf(typeof document === 'undefined' ? undefined : document.documentElement.lang);
  const [topics, setTopics] = useState<TopicEntry[]>([]);
  const [conflicts, setConflicts] = useState<SpiritInsightView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (rpc === undefined) return;
    try {
      const result = await rpc('topics-get', {});
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setTopics(result.value.topics);
      setConflicts(result.value.conflicts);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rpc]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const resolve = (winnerId: string, loserId: string): void => {
    if (rpc === undefined) return;
    void rpc('insight-resolve', { winnerId, loserId })
      .then((result) => {
        setNote(result.ok ? copy['topic.conflictResolved'] : `${copy['rec.failed']}: ${result.error.message}`);
        void load();
      })
      .catch(() => setNote(copy['rec.failed']));
  };

  // 冲突按主题配对展示（同 topic 的两条并排；单条兜底行也显示，不吞信息）
  const conflictGroups = new Map<string, SpiritInsightView[]>();
  for (const row of conflicts) {
    const list = conflictGroups.get(row.topicId) ?? [];
    list.push(row);
    conflictGroups.set(row.topicId, list);
  }

  return createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 } },
    createElement(
      'header',
      { style: HEAD_STYLE },
      createElement('h4', { style: { margin: 0, fontSize: 13, color: '#9fc1ff' } }, copy['topic.view']),
      createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => void load() }, copy['sea.refresh']),
    ),
    error !== null ? createElement('p', { style: { margin: '8px 14px', color: '#ff9a9a', fontSize: 12 } }, `${copy['sea.loadFailed']}: ${error}`) : null,
    note !== null ? createElement('p', { style: { margin: '6px 14px', ...MUTED_STYLE } }, note) : null,
    conflictGroups.size > 0
      ? createElement(
        'div',
        { style: { padding: '0 14px' } },
        createElement(
          'ul',
          { style: LIST_STYLE },
          [...conflictGroups.entries()].map(([topicId, rows]) =>
            createElement(
              'li',
              { key: `cf-${topicId}`, style: CONFLICT_STYLE },
              createElement('div', { style: { color: '#ffca7a', marginBottom: 4 } }, copy['topic.conflictTitle']),
              createElement('div', { style: MUTED_STYLE }, copy['topic.conflictHint']),
              ...rows.map((row) =>
                createElement(
                  'div',
                  { key: row.id, style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' } },
                  createElement('span', { style: { color: '#e8eeff' } }, row.text),
                  createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => resolve(row.id, rows.find((x) => x.id !== row.id)?.id ?? '') }, copy['topic.keepThis']),
                ),
              ),
              rows.length >= 2
                ? createElement(
                  'div',
                  { style: { marginTop: 6 } },
                  createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => { for (const row of rows) resolve('', row.id); } }, copy['topic.hideBoth']),
                )
                : null,
            ),
          ),
        ),
      )
      : null,
    topics.length === 0 && error === null
      ? createElement('p', { style: { margin: '18px 14px', ...MUTED_STYLE } }, copy['topic.empty'])
      : createElement(
        'ul',
        { style: LIST_STYLE },
        topics.map((topic) =>
          createElement(
            'li',
            { key: topic.id, style: ITEM_STYLE },
            createElement(
              'div',
              { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', cursor: 'pointer' }, onClick: () => setExpanded(expanded === topic.id ? null : topic.id) },
              createElement('span', { style: { color: '#9fc1ff' } }, topic.name),
              createElement('span', { style: BADGE_STYLE }, topic.origin === 'distilled' ? copy['topic.originDistilled'] : copy['topic.originHeuristic']),
              createElement('span', { style: MUTED_STYLE }, `${topic.entries} ${copy['topic.entries']} · ${topic.insights} ${copy['topic.insights']}`),
            ),
            expanded === topic.id
              ? createElement(
                'div',
                { style: { marginTop: 6, display: 'grid', gap: 4 } },
                topic.insightRows.length === 0
                  ? createElement('p', { style: MUTED_STYLE }, copy['topic.empty'])
                  : topic.insightRows.map((row) =>
                    createElement(
                      'div',
                      { key: row.id, style: { paddingLeft: 8, borderLeft: '2px solid rgba(120,160,255,.3)' } },
                      createElement('div', { style: { color: '#e8eeff' } }, row.text),
                      createElement('div', { style: MUTED_STYLE }, `${row.status} · ${row.evidenceIds.length} evidence`),
                    ),
                  ),
              )
              : null,
          ),
        ),
      ),
  );
}
