/**
 * 「翻阅」tab（v0.3.3）：条目管理面——搜索 / 筛选 / 分页 / 详情 / ★ / 藏起 / 更正式编辑。
 *
 * 三条纪律：
 * 1. **不轮询**（与星海同口径）：打开拉一次，动作后**全量重取**（不做增量拼接——
 *    藏/编辑/合并都会让行位移，增量会把列表拼歪）；
 * 2. **选中不悬空**：编辑后旧行进取代链、id 会变，展开态与编辑态一律收掉重开
 *    （星海 §十一 的 selected 引用老坑在列表形态下的同形问题）；
 * 3. **拟人化文案**（R5）：动作按钮说鱼的话（「藏起来」「再想起」「理解变了」），
 *    不出现机械词；机械词闸见 tests/gates.test.ts。
 *
 * 卡片的徽章/正文/gist/线索结构与手记同源同形（从 panel.ts 检视段迁来）。
 */
import { createElement, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import type { SpiritJournalRow } from '../../../src/contract.js';
import { copyOf } from '../copy.js';
import type { RpcFn } from '../rpc.js';
import { SeaTopics } from './sea-topics.js';
import { NOTICE_LABEL, TRIGGER_LABEL, TRIGGER_ORDER } from './sea-labels.js';

const HEAD_STYLE: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid rgba(120,160,255,.14)' };
const MUTED_STYLE: CSSProperties = { fontSize: 12, color: '#6d7891' };
const BUTTON_STYLE: CSSProperties = { background: 'rgba(120,160,255,.1)', color: '#b8c9ee', border: '1px solid rgba(120,160,255,.22)', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer' };
const BUTTON_ON_STYLE: CSSProperties = { ...BUTTON_STYLE, background: 'rgba(120,160,255,.3)', color: '#fff' };
const LIST_STYLE: CSSProperties = { listStyle: 'none', padding: '10px 14px', margin: 0, display: 'grid', gap: 8, overflowY: 'auto' };
const ITEM_STYLE: CSSProperties = { padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(120,160,255,.16)', fontSize: 12 };
const BADGE_STYLE: CSSProperties = { fontSize: 11, padding: '0 6px', borderRadius: 6, background: 'rgba(120,160,255,.12)', color: '#8fa8d8' };
const CUE_STYLE: CSSProperties = { fontSize: 11, padding: '0 6px', borderRadius: 6, background: 'rgba(120,160,255,.1)', color: '#8fa8d8' };
const INPUT_STYLE: CSSProperties = { ...BUTTON_STYLE, background: 'rgba(10,14,26,.6)' };
const TEXTAREA_STYLE: CSSProperties = { width: '100%', boxSizing: 'border-box', background: 'rgba(10,14,26,.6)', color: '#e8eeff', border: '1px solid rgba(120,160,255,.22)', borderRadius: 8, padding: 6, fontSize: 12 };

const PAGE_SIZE = 50;

function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface SeaRecordsProps {
  rpc?: RpcFn;
}

export function SeaRecords(props: SeaRecordsProps) {
  const { rpc } = props;
  const copy = copyOf(typeof document === 'undefined' ? undefined : document.documentElement.lang);

  const [rows, setRows] = useState<SpiritJournalRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 筛选态：query 输入与生效值分开（Enter 提交，不逐键打后端）
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [trigger, setTrigger] = useState('');
  const [lane, setLane] = useState('');
  const [marked, setMarked] = useState(false);
  const [withGhosts, setWithGhosts] = useState(false);
  const [hiddenView, setHiddenView] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 子视图（v0.3.5）：条目流 ⇄ 线索头（主题分区 + 碰撞裁决）——同一 tab 两面，不加第五 tab
  const [view, setView] = useState<'entries' | 'topics'>('entries');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editGist, setEditGist] = useState('');
  const [editSalience, setEditSalience] = useState(0);
  const seqRef = useRef(0);

  const fetchPage = useCallback(async (nextOffset: number, append: boolean) => {
    if (rpc === undefined) return;
    const token = ++seqRef.current;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc('entries-list', {
        ...(query === '' ? {} : { query }),
        ...(trigger === '' ? {} : { trigger }),
        ...(lane === '' ? {} : { lane }),
        ...(marked ? { marked: true } : {}),
        ...(withGhosts ? { includeGhosts: true } : {}),
        ...(hiddenView ? { hiddenOnly: true } : {}),
        offset: nextOffset,
        limit: PAGE_SIZE,
      });
      if (token !== seqRef.current) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setRows((current) => (append ? [...current, ...result.value.rows] : result.value.rows));
      setOffset(nextOffset);
      setHasMore(result.value.hasMore);
      setTruncated(result.value.truncated);
    } catch (err) {
      if (token !== seqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [rpc, query, trigger, lane, marked, withGhosts, hiddenView]);

  // 筛选条件一变就从头重取（动作后的重取也走这里，不做增量拼接）
  useEffect(() => {
    setExpandedId(null);
    setEditingId(null);
    void fetchPage(0, false);
  }, [fetchPage]);

  const reload = (): void => {
    void fetchPage(0, false);
  };

  const act = (fn: () => Promise<void>): void => {
    fn().catch(() => setNote(copy['rec.failed']));
  };

  const mark = (row: SpiritJournalRow): void => {
    if (rpc === undefined) return;
    act(async () => {
      const scored = typeof row.feedbackScore === 'number' && row.feedbackScore > 0;
      const result = await rpc('experience-feedback', { entryId: row.id, score: scored ? -1 : 5 });
      setNote(result.ok ? (scored ? copy['sea.unmarked'] : copy['sea.marked']) : `${copy['sea.markFailed']}: ${result.error.message}`);
      reload();
    });
  };

  const hide = (row: SpiritJournalRow): void => {
    if (rpc === undefined) return;
    act(async () => {
      const result = await rpc(hiddenView ? 'entries-unhide' : 'entries-hide', { ids: [row.id] });
      setNote(result.ok ? (hiddenView ? copy['rec.unhidden'] : copy['rec.hidden']) : `${copy['rec.failed']}: ${result.error.message}`);
      reload();
    });
  };

  const startEdit = (row: SpiritJournalRow): void => {
    setEditingId(row.id);
    setExpandedId(row.id);
    setEditText(row.text);
    setEditGist(row.gist ?? '');
    setEditSalience(row.salience ?? 0);
  };

  const saveEdit = (row: SpiritJournalRow): void => {
    if (rpc === undefined) return;
    act(async () => {
      const result = await rpc('entries-update', {
        entryId: row.id,
        ...(editText !== row.text ? { text: editText } : {}),
        ...(editGist !== (row.gist ?? '') ? { gist: editGist } : {}),
        ...(editSalience !== (row.salience ?? 0) ? { salience: editSalience } : {}),
      });
      // 编辑后 id 会变（更正式插新行）：展开/编辑态收掉，列表从头重取
      setNote(result.ok ? copy['rec.edited'] : `${copy['rec.failed']}: ${result.error.message}`);
      setEditingId(null);
      setExpandedId(null);
      reload();
    });
  };

  const editable = (row: SpiritJournalRow): boolean => row.supersededBy === null && row.hiddenAt === null;

  if (view === 'topics') {
    return createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 } },
      createElement(
        'header',
        { style: HEAD_STYLE },
        createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => setView('entries') }, copy['panel.recent']),
        createElement('button', { type: 'button', style: BUTTON_ON_STYLE, onClick: () => setView('topics') }, copy['topic.view']),
      ),
      createElement(SeaTopics, { rpc }),
    );
  }

  return createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 } },
    createElement(
      'header',
      { style: HEAD_STYLE },
      createElement('h4', { style: { margin: 0, fontSize: 13, color: '#9fc1ff' } }, copy['rec.title']),
      createElement('input', {
        style: { ...INPUT_STYLE, width: 200 },
        placeholder: copy['rec.search'],
        value: queryInput,
        onChange: (event: { target: { value: string } }) => setQueryInput(event.target.value),
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key === 'Enter') setQuery(queryInput.trim());
          if (event.key === 'Escape') {
            setQueryInput('');
            setQuery('');
          }
        },
      }),
      query !== ''
        ? createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => { setQueryInput(''); setQuery(''); } }, copy['rec.searchClear'])
        : null,
      createElement(
        'select',
        { style: BUTTON_STYLE, value: trigger, onChange: (event: { target: { value: string } }) => setTrigger(event.target.value) },
        createElement('option', { value: '' }, `${copy['rec.filterTrigger']}·${copy['rec.filterAll']}`),
        TRIGGER_ORDER.map((slug) => createElement('option', { key: slug, value: slug }, TRIGGER_LABEL[slug] !== undefined ? copy[TRIGGER_LABEL[slug]] : slug)),
      ),
      createElement(
        'select',
        { style: BUTTON_STYLE, value: lane, onChange: (event: { target: { value: string } }) => setLane(event.target.value) },
        createElement('option', { value: '' }, `${copy['rec.filterLane']}·${copy['rec.filterAll']}`),
        createElement('option', { value: 'live' }, copy['panel.laneLive']),
        createElement('option', { value: 'drsc' }, copy['panel.laneDrsc']),
      ),
      createElement('button', { type: 'button', style: marked ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setMarked((v) => !v) }, copy['rec.filterMarked']),
      createElement('button', { type: 'button', style: withGhosts ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setWithGhosts((v) => !v) }, copy['rec.filterGhosts']),
      createElement('button', { type: 'button', style: hiddenView ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setHiddenView((v) => !v) }, copy['rec.filterHidden']),
      createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => reload() }, copy['sea.refresh']),
      createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => setView('topics') }, copy['topic.view']),
    ),
    error !== null ? createElement('p', { style: { margin: '8px 14px', color: '#ff9a9a', fontSize: 12 } }, `${copy['sea.loadFailed']}: ${error}`) : null,
    note !== null ? createElement('p', { style: { margin: '6px 14px', ...MUTED_STYLE } }, note) : null,
    rows.length === 0 && error === null && !busy
      ? createElement('p', { style: { margin: '18px 14px', ...MUTED_STYLE } }, hiddenView ? copy['rec.emptyHidden'] : copy['rec.empty'])
      : null,
    createElement(
      'ul',
      { style: LIST_STYLE },
      rows.map((row) =>
        createElement(
          'li',
          { key: row.id, style: { ...ITEM_STYLE, opacity: row.supersededBy !== null ? 0.6 : 1 } },
          // 徽章行（与手记卡片同源同形）
          createElement(
            'div',
            { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
            createElement('span', { style: BADGE_STYLE }, TRIGGER_LABEL[row.trigger as keyof typeof TRIGGER_LABEL] !== undefined ? copy[TRIGGER_LABEL[row.trigger as keyof typeof TRIGGER_LABEL]] : row.trigger),
            createElement('span', { style: BADGE_STYLE }, NOTICE_LABEL[row.notice as keyof typeof NOTICE_LABEL] !== undefined ? copy[NOTICE_LABEL[row.notice as keyof typeof NOTICE_LABEL]] : row.notice),
            createElement('span', { style: BADGE_STYLE }, `${copy['rec.filterLane']}·${row.lane === 'drsc' ? copy['panel.laneDrsc'] : copy['panel.laneLive']}`),
            row.salience !== null ? createElement('span', { style: BADGE_STYLE }, `${copy['panel.salienceShort']} ${row.salience}`) : null,
            typeof row.feedbackScore === 'number' && row.feedbackScore > 0 ? createElement('span', { style: { ...BADGE_STYLE, color: '#ffca7a' } }, '★') : null,
            row.hiddenAt !== null ? createElement('span', { style: { ...BADGE_STYLE, color: '#ffca7a' } }, copy['rec.hiddenNote']) : null,
            row.supersededBy !== null ? createElement('span', { style: { ...BADGE_STYLE, color: '#ffca7a' } }, copy['rec.supersededNote']) : null,
          ),
          createElement('div', { style: { fontSize: 13, lineHeight: 1.6, color: '#e8eeff', marginTop: 4, whiteSpace: 'pre-wrap' } }, row.text),
          row.gist !== null && row.gist !== '' ? createElement('div', { style: { ...MUTED_STYLE, fontStyle: 'italic', marginTop: 2 } }, row.gist) : null,
          row.cues.length > 0
            ? createElement(
              'div',
              { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 } },
              createElement('span', { style: MUTED_STYLE }, copy['panel.cues']),
              ...row.cues.map((cue) => createElement('span', { key: cue, style: CUE_STYLE }, cue)),
            )
            : null,
          createElement(
            'div',
            { style: { ...MUTED_STYLE, marginTop: 4 } },
            `${copy['panel.turn']} ${row.turnSeq} · ${formatTime(row.tsMs)} · ${copy['rec.session']} ${row.sessionId !== undefined ? row.sessionId.slice(0, 10) : '—'}`,
          ),
          expandedId === row.id && editingId !== row.id
            ? createElement('div', { style: { ...MUTED_STYLE, marginTop: 6, wordBreak: 'break-all' } }, `id ${row.id}${row.sourceRef !== null ? ` · ${row.sourceRef}` : ''}`)
            : null,
          editingId === row.id
            ? createElement(
              'div',
              { style: { display: 'grid', gap: 6, marginTop: 8 } },
              createElement('label', { style: MUTED_STYLE }, copy['rec.editText'],
                createElement('textarea', { style: TEXTAREA_STYLE, rows: 2, value: editText, onChange: (event: { target: { value: string } }) => setEditText(event.target.value) })),
              createElement('label', { style: MUTED_STYLE }, copy['rec.editGist'],
                createElement('input', { style: { ...TEXTAREA_STYLE }, value: editGist, onChange: (event: { target: { value: string } }) => setEditGist(event.target.value) })),
              createElement('label', { style: MUTED_STYLE }, copy['rec.editSalience'],
                createElement('select', { style: BUTTON_STYLE, value: String(editSalience), onChange: (event: { target: { value: string } }) => setEditSalience(Number(event.target.value)) },
                  [0, 1, 2].map((v) => createElement('option', { key: v, value: String(v) }, String(v))))),
              createElement(
                'div',
                { style: { display: 'flex', gap: 8 } },
                createElement('button', { type: 'button', style: BUTTON_ON_STYLE, onClick: () => saveEdit(row) }, copy['rec.editSave']),
                createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => { setEditingId(null); if (expandedId === row.id) setExpandedId(null); } }, copy['rec.editCancel']),
              ),
            )
            : null,
          // 动作行：幽灵行只许回看（编辑与藏起都不给，恢复走「藏起来的」视图同规则）
          row.supersededBy === null
            ? createElement(
              'div',
              { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
              typeof row.feedbackScore === 'number' && row.feedbackScore > 0
                ? createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => mark(row) }, copy['sea.unmark'])
                : createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => mark(row) }, copy['sea.markImportant']),
              createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => hide(row) }, hiddenView ? copy['rec.unhide'] : copy['rec.hide']),
              editable(row) && editingId !== row.id
                ? createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => startEdit(row) }, copy['rec.edit'])
                : null,
              createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => setExpandedId(expandedId === row.id ? null : row.id) }, copy['sea.detail']),
            )
            : null,
        ),
      ),
    ),
    hasMore
      ? createElement('div', { style: { padding: '0 14px 12px' } },
        createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => void fetchPage(offset + PAGE_SIZE, true) }, copy['rec.loadMore']))
      : null,
    truncated ? createElement('p', { style: { margin: '0 14px 12px', ...MUTED_STYLE } }, copy['rec.truncated']) : null,
  );
}
