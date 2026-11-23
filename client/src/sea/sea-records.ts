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

import type { SpiritJournalRow, SpiritTxnRow, SpiritTaskRow, SpiritEntityNode, SpiritEvaluationRow, SpiritEchoSnapshot, SpiritEchoRecordRow, SpiritEchoTone, SpiritEchoRecallInfo, SpiritEchoLocateHit, SpiritSearchHit, SpiritRecordDetailResult, SpiritMemoryListResult } from '../../../src/contract.js';
import { copyOf } from '../copy.js';
import type { RpcFn } from '../rpc.js';
import { useHtmlLang } from '../use-html-lang.js';
import { SeaTopics } from './sea-topics.js';
import { SeaChronicle } from './sea-chronicle.js';
import { echoRefTarget, shortEcho } from './echo-view.js';
import { EchoRecallHeader, EchoRefsList, EchoToneBar } from './echo-refs-list.js';
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
  /** 头部「刷新/⟲」令牌（v0.5.9）：递增 ⇒ 按当前视图重取（条目/本周/本体）；0 为初值不动作。 */
  refreshToken?: number;
  /** 回响深链（v0.8.1）：侧栏指定打开的子视图。 */
  requestedView?: 'echo';
  /** 深链令牌：递增即切换视图；0 为初值不动作。 */
  viewToken?: number;
  /** 星图定位（v0.8.12）：把 echo 号交给星海选中对应星点。 */
  onLocateEcho?: (echoId: string) => void;
}

export function SeaRecords(props: SeaRecordsProps) {
  const { rpc, refreshToken, requestedView, viewToken } = props;
  const copy = copyOf(useHtmlLang());
  /** 记录号徽标（v0.8.11）：星图/翻阅都要看得到 echo id（短号展示，全 UUID 进 tooltip）。 */
  const echoChip = (echoId: string | undefined): ReturnType<typeof createElement> | null =>
    echoId === undefined || echoId === ''
      ? null
      : createElement('span', { key: 'echo-id', style: { ...MUTED_STYLE, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }, title: echoId, 'data-spirit': 'echo-id' }, shortEcho(echoId));

  /** 搜索块（v0.8.14）：号命中给记录列表，文本命中给全域跨类型结果；两者都带「打开」与「星图定位」。 */
  const locateBlock = (): ReturnType<typeof createElement> | null => {
    if (searchMode === '' || echoHitQuery === '') return null;
    const isId = searchMode === 'id';
    const rows: ReturnType<typeof createElement>[] = isId
      ? echoHits.map((hit) => {
        const key = hit.echoId;
        return createElement(
          'div',
          { key, style: { ...ITEM_STYLE } },
          createElement(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            createElement('span', { style: BADGE_STYLE }, kindLabel(hit.kind)),
            createElement('span', { style: { fontSize: 13, color: '#e8eeff' } }, hit.title),
            echoChip(hit.echoId),
            hit.recordTs > 0 ? createElement('span', { style: MUTED_STYLE }, formatTime(hit.recordTs)) : null,
            expandButton(key, hit.kind, hit.memId),
            createElement('button', { type: 'button', style: BUTTON_STYLE, 'data-spirit': 'echo-locate-open', onClick: () => openRefTarget({ kind: hit.kind }) }, copy['echo.locateOpen']),
            createElement('button', { type: 'button', style: BUTTON_STYLE, 'data-spirit': 'echo-locate-graph', onClick: () => props.onLocateEcho?.(hit.echoId) }, copy['echo.locateGraph']),
          ),
          detailBlock(key),
        );
      })
      : globalHits.map((hit) => {
        const key = `${hit.kind}-${hit.id}`;
        return createElement(
          'div',
          { key, style: { ...ITEM_STYLE } },
          createElement(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            createElement('span', { style: BADGE_STYLE }, kindLabel(hit.kind)),
            createElement('span', { style: { fontSize: 13, color: '#e8eeff' } }, hit.title),
            echoChip(hit.echoId),
            hit.ts > 0 ? createElement('span', { style: MUTED_STYLE }, formatTime(hit.ts)) : null,
            expandButton(key, hit.kind, hit.id),
            createElement('button', { type: 'button', style: BUTTON_STYLE, 'data-spirit': 'echo-locate-open', onClick: () => openRefTarget({ kind: hit.kind }) }, copy['echo.locateOpen']),
            hit.echoId === undefined
              ? null
              : createElement('button', { type: 'button', style: BUTTON_STYLE, 'data-spirit': 'echo-locate-graph', onClick: () => props.onLocateEcho?.(hit.echoId!) }, copy['echo.locateGraph']),
          ),
          detailBlock(key),
        );
      });
    return createElement(
      'div',
      { 'data-spirit': 'echo-locate', style: { padding: '8px 14px', borderBottom: '1px solid rgba(120,160,255,.12)' } },
      createElement(
        'div',
        { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: '#8e9ab5' } },
        createElement('span', { style: CUE_STYLE }, isId ? copy['echo.locateTitle'] : copy['echo.searchTitle']),
        createElement('span', { style: { ...MUTED_STYLE, fontFamily: 'ui-monospace, monospace' }, title: echoHitQuery }, echoHitQuery),
        echoHitBusy ? createElement('span', { style: MUTED_STYLE }, '...') : null,
      ),
      rows.length === 0
        ? createElement('div', { style: { ...MUTED_STYLE, marginTop: 4 } }, isId ? copy['echo.locateEmpty'] : copy['echo.searchEmpty'])
        : createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } }, ...rows),
    );
  };

  const kindLabel = (kind: string): string => {
    if (kind === 'task') return copy['echo.kind.task'];
    if (kind === 'delivery') return copy['echo.kind.delivery'];
    if (kind === 'experience') return copy['echo.kind.experience'];
    if (kind === 'memory') return copy['echo.kind.memory'];
    if (kind === 'goal') return copy['echo.kind.goal'];
    return kind;
  };

  const [rows, setRows] = useState<SpiritJournalRow[]>([]);
  const [offset, setOffset] = useState(0);
  /** v19 翻阅游标：追加时用它替代 OFFSET（null = 从头开始或上一页到底） */
  const cursorRef = useRef<{ tsMs: number; id: string } | null>(null);
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
  // 子视图（v0.3.5）：条目流 ⇄ 线索头（主题分区 + 碰撞裁决）；v0.4 加本周事务——同一 tab 三面，不加第五 tab
  // v0.10 定位重钉：默认面从「条目流」改成「编年」——条目流按设计只认摩擦，
  // 拿它当默认等于让主人一进来先看一串"我又出错了"。编年以「事」为主体，才是记忆该有的样子。
  const [view, setView] = useState<'chronicle' | 'entries' | 'topics' | 'week' | 'onto' | 'echo'>('chronicle');
  // 本周事务（timeline-query）：切到该面时拉一次，不轮询
  const [weekRows, setWeekRows] = useState<SpiritTxnRow[]>([]);
  const [weekBusy, setWeekBusy] = useState(false);
  // 本体面（v0.5）：任务线 / 实体 / 反馈 三视图 + 点开看做成明细；切到该面时各拉一次
  const [ontoTab, setOntoTab] = useState<'tasks' | 'entities' | 'feedback' | 'memory'>('tasks');
  const [ontoTasks, setOntoTasks] = useState<SpiritTaskRow[]>([]);
  const [ontoEntities, setOntoEntities] = useState<SpiritEntityNode[]>([]);
  const [ontoEvals, setOntoEvals] = useState<SpiritEvaluationRow[]>([]);
  const [ontoDetail, setOntoDetail] = useState<{ label: string; rows: SpiritTxnRow[] } | null>(null);
  const [ontoBusy, setOntoBusy] = useState(false);
  const [ontoBackfilling, setOntoBackfilling] = useState(false);
  // 回响面（v0.8.11）：记录聚合（echo-<uuid>）+ 最近回响事件（recall-<uuid>）+ 语气（特殊格式）
  const [echoRows, setEchoRows] = useState<SpiritEchoSnapshot[]>([]);
  const [echoBusy, setEchoBusy] = useState(false);
  const [echoRefRows, setEchoRefRows] = useState<SpiritEchoRecordRow[]>([]);
  const [echoTone, setEchoTone] = useState<SpiritEchoTone | null>(null);
  const [echoRecall, setEchoRecall] = useState<SpiritEchoRecallInfo | null>(null);
  const [echoDetail, setEchoDetail] = useState<{ echoId: string; text: string } | null>(null);
  // 模型可写记忆（v0.8）：两本账+日记+目的（本体「记着」子页 / 回响页生涯补充）
  const [memoryView, setMemoryView] = useState<SpiritMemoryListResult | null>(null);
  // 本体面搜索（v0.6.1）：输入与生效值分开（Enter 提交，照条目流口径）
  const [ontoQueryInput, setOntoQueryInput] = useState('');
  const [ontoQuery, setOntoQuery] = useState('');
  // 按 echo 号搜索/定位 + 全域文本搜索（v0.8.14）：号查询走注册表，文本查询跨类型，不跟当前分页绑定
  const [echoHits, setEchoHits] = useState<SpiritEchoLocateHit[]>([]);
  const [globalHits, setGlobalHits] = useState<SpiritSearchHit[]>([]);
  const [searchMode, setSearchMode] = useState<'id' | 'text' | ''>('');
  const [echoHitQuery, setEchoHitQuery] = useState('');
  const [echoHitBusy, setEchoHitBusy] = useState(false);
  // 命中行内展开（v0.8.17）：一行一个 key，详情按需取并缓存
  const [expandedKey, setExpandedKey] = useState('');
  const [detailMap, setDetailMap] = useState<Record<string, SpiritRecordDetailResult | null>>({});
  const [detailBusyKey, setDetailBusyKey] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editGist, setEditGist] = useState('');
  const [editSalience, setEditSalience] = useState(0);
  const seqRef = useRef(0);

  /** 命中行的详情块：加载中 / 记录不在了 / 明细行。 */
  const detailBlock = (key: string): ReturnType<typeof createElement> | null => {
    if (expandedKey !== key) return null;
    if (detailBusyKey === key) return createElement('div', { style: { ...MUTED_STYLE, marginTop: 4 } }, `${copy['echo.expandLoading']}...`);
    const detail = detailMap[key];
    if (detail === undefined || detail === null) {
      return createElement('div', { style: { ...MUTED_STYLE, marginTop: 4 } }, copy['echo.detailGone']);
    }
    return createElement(
      'div',
      { 'data-spirit': 'record-detail', style: { marginTop: 6, paddingTop: 6, borderTop: '1px dashed rgba(120,160,255,.18)' } },
      ...detail.lines.map((line, index) => createElement(
        'div',
        { key: index, style: { fontSize: 12, lineHeight: 1.6, color: '#cfd8ea', whiteSpace: 'pre-wrap' } },
        line,
      )),
    );
  };

  /** 展开/收起按钮。 */
  const expandButton = (key: string, kind: string, id: string): ReturnType<typeof createElement> => createElement(
    'button',
    { type: 'button', style: BUTTON_STYLE, 'data-spirit': 'echo-expand', onClick: () => void toggleDetail(key, kind, id) },
    expandedKey === key ? copy['echo.collapse'] : copy['echo.expand'],
  );

  /**
   * 统一搜索（v0.8.14）：先试 echo 号（注册表），不是号就跨类型文本搜（任务/交付/体验/记着/目的/实体）。
   * 返回模式：`id` = 号命中；`text` = 文本全域搜；`none` = 空词。
   */
  const runSearch = useCallback(async (raw: string): Promise<'id' | 'text' | 'none'> => {
    const q = raw.trim();
    if (rpc === undefined || q === '') {
      setEchoHits([]);
      setGlobalHits([]);
      setSearchMode('');
      setEchoHitQuery('');
      return 'none';
    }
    setEchoHitBusy(true);
    try {
      const located = await rpc('echo-locate', { q });
      if (located.ok && located.value.idQuery && located.value.hits.length > 0) {
        setEchoHits(located.value.hits);
        setGlobalHits([]);
        setEchoHitQuery(q);
        setSearchMode('id');
        return 'id';
      }
      // 号查不到（或只是碎片）⇒ 继续走文本全域搜，不停在“注册表没有”
      const found = await rpc('spirit-search', { q, limit: 24 }).catch(() => undefined);
      setEchoHits([]);
      setGlobalHits(found !== undefined && found.ok ? found.value.hits : []);
      setEchoHitQuery(q);
      setSearchMode('text');
      return 'text';
    } catch {
      setEchoHits([]);
      setGlobalHits([]);
      setSearchMode('');
      setEchoHitQuery('');
      return 'none';
    } finally {
      setEchoHitBusy(false);
    }
  }, [rpc]);

  /** 行内展开/收起（v0.8.17）：详情按需取，取过就缓存（不重复请求）。 */
  const toggleDetail = useCallback(async (key: string, kind: string, id: string): Promise<void> => {
    if (expandedKey === key) {
      setExpandedKey('');
      return;
    }
    setExpandedKey(key);
    if (detailMap[key] !== undefined || rpc === undefined) return;
    setDetailBusyKey(key);
    try {
      const result = await rpc('record-detail', {
        kind: kind as 'task' | 'delivery' | 'experience' | 'memory' | 'goal' | 'entity',
        id,
      });
      setDetailMap((prev) => ({ ...prev, [key]: result.ok ? result.value : null }));
    } catch {
      setDetailMap((prev) => ({ ...prev, [key]: null }));
    } finally {
      setDetailBusyKey('');
    }
  }, [expandedKey, detailMap, rpc]);

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
        // v19：追加时优先用游标（直接吃 ts_ms 索引；服务端 cursor 优先于 offset）
        ...(append && cursorRef.current !== null ? { cursor: cursorRef.current } : {}),
        limit: PAGE_SIZE,
      });
      if (token !== seqRef.current) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setRows((current) => (append ? [...current, ...result.value.rows] : result.value.rows));
      setOffset(nextOffset);
      cursorRef.current = result.value.nextCursor ?? null;
      setHasMore(result.value.hasMore);
      setTruncated(result.value.truncated);
      // 条目流搜索同样先试号/全域搜索，命中会在列表上方出定位块
      void runSearch(query);
    } catch (err) {
      if (token !== seqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [rpc, query, trigger, lane, marked, withGhosts, hiddenView, runSearch]);

  // 筛选条件一变就从头重取（动作后的重取也走这里，不做增量拼接）
  useEffect(() => {
    setExpandedId(null);
    setEditingId(null);
    void fetchPage(0, false);
  }, [fetchPage]);

  const reload = (): void => {
    void fetchPage(0, false);
  };

  /** 本周事务（近 7 天，服务端按当前时刻算区间）：只读 timeline-query，动作无关不重取。 */
  const fetchWeek = useCallback(async () => {
    if (rpc === undefined) return;
    const token = ++seqRef.current;
    setWeekBusy(true);
    setError(null);
    try {
      const result = await rpc('timeline-query', { days: 7, limit: 200 });
      if (token !== seqRef.current) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setWeekRows(result.value.rows);
    } catch (err) {
      if (token !== seqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWeekBusy(false);
    }
  }, [rpc]);

  // 切到本周面时拉一次（与条目面同口径：打开取，不轮询）
  useEffect(() => {
    if (view === 'week') void fetchWeek();
  }, [view, fetchWeek]);

  /** 本体面三视图各拉一次（动作无关不重取；点实体/任务再按需拉明细）。 */
  const fetchOnto = useCallback(async () => {
    if (rpc === undefined) return;
    const token = ++seqRef.current;
    setOntoBusy(true);
    setError(null);
    try {
      const [tasks, graph, evals] = await Promise.all([
        rpc('task-list', { workspaceId: '', limit: 50 }),
        rpc('entity-graph', { limit: 60 }),
        rpc('evaluation-list', { limit: 100 }),
      ]);
      const mem = await rpc('memory-list', { limit: 50 }).catch(() => ({ ok: false }) as const);
      if (token !== seqRef.current) return;
      if (mem.ok) setMemoryView(mem.value);
      if (tasks.ok) setOntoTasks(tasks.value.tasks);
      if (graph.ok) setOntoEntities(graph.value.nodes);
      if (evals.ok) setOntoEvals(evals.value.rows);
      const bad = [tasks, graph, evals].find((r) => !r.ok);
      if (bad !== undefined && !bad.ok) setError(bad.error.message);
    } catch (err) {
      if (token !== seqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOntoBusy(false);
    }
  }, [rpc]);

  /** 本体面搜索（v0.6.1）：先试号查询（echo-xxxx）；号命中就只给定位结果，不再拿号去拼文本搜索。 */
  const searchOnto = useCallback(() => {
    if (rpc === undefined) return;
    const q = ontoQueryInput.trim();
    setOntoQuery(q);
    setOntoDetail(null);
    if (q === '') { void runSearch(''); void fetchOnto(); return; }
    setOntoBusy(true);
    setError(null);
    void runSearch(q)
      .then((mode) => {
        if (mode === 'id') {
          setOntoBusy(false);
          return;
        }
        const call = ontoTab === 'entities'
          ? rpc('entity-graph', { limit: 60, q }).then((r) => { if (r.ok) setOntoEntities(r.value.nodes); return r; })
          : rpc('task-list', { workspaceId: '', limit: 50, q }).then((r) => { if (r.ok) setOntoTasks(r.value.tasks); return r; });
        void call
          .then((r) => { if (!r.ok) setError(r.error.message); })
          .catch(() => setError(copy['rec.failed']))
          .finally(() => setOntoBusy(false));
      })
      .catch(() => setOntoBusy(false));
  }, [rpc, ontoQueryInput, ontoTab, fetchOnto, runSearch, copy]);

  const openTask = useCallback((task: SpiritTaskRow) => {
    if (rpc === undefined) return;
    void rpc('task-detail', { taskId: task.id })
      .then((result) => { if (result.ok) setOntoDetail({ label: result.value.task?.title ?? task.title, rows: result.value.deliveries }); })
      .catch(() => undefined);
  }, [rpc]);

  const openEntity = useCallback((entity: SpiritEntityNode) => {
    if (rpc === undefined) return;
    void rpc('entity-lookup', { entityId: entity.id })
      .then((result) => { if (result.ok) setOntoDetail({ label: result.value.entity?.name ?? entity.name, rows: result.value.deliveries }); })
      .catch(() => undefined);
  }, [rpc]);

  useEffect(() => {
    if (view === 'onto') void fetchOnto();
  }, [view, fetchOnto]);

  /** 回响面（v0.8.11）：一次取回 轮次观测 + 记录聚合 + 回响事件 + 语气。 */
  const fetchEcho = useCallback(async () => {
    if (rpc === undefined) return;
    const token = ++seqRef.current;
    setEchoBusy(true);
    setError(null);
    try {
      const result = await rpc('inject-echo', { limit: 50 });
      if (token !== seqRef.current) return;
      if (result.ok) {
        setEchoRows(result.value.items);
        setEchoRefRows(result.value.records ?? []);
        setEchoTone(result.value.tone ?? null);
        setEchoRecall(result.value.recall ?? null);
      } else {
        setError(result.error.message);
        setEchoRefRows([]);
      }
      // 生涯补充（v0.8）：pinned 的心里话/约定也在这儿露一眼（这就是「回响通道调生涯记忆」）
      const mem = await rpc('memory-list', { limit: 20 }).catch(() => ({ ok: false }) as const);
      if (token !== seqRef.current) return;
      if (mem.ok) setMemoryView(mem.value);
    } catch (err) {
      if (token !== seqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEchoBusy(false);
    }
  }, [rpc]);

  /** 记录的「原文」：按 lastRecallId（recall-<uuid>）取那一轮注入卡；早期行没存原文 ⇒ 如实说。 */
  const openEchoDetail = useCallback(async (row: SpiritEchoRecordRow): Promise<void> => {
    if (rpc === undefined) return;
    if (row.lastRecallId === '') {
      setEchoDetail({ echoId: row.echoId, text: '' });
      return;
    }
    const result = await rpc('echo-detail', { sessionId: row.sessionId, id: row.lastRecallId }).catch(() => undefined);
    if (result !== undefined && result.ok) {
      const item = result.value.item;
      setEchoDetail({ echoId: row.echoId, text: item === undefined ? '' : (item.text !== '' ? item.text : item.preview) });
      return;
    }
    setEchoDetail({ echoId: row.echoId, text: '' });
  }, [rpc]);

  /** 记录行点开 → 定位到真源视图（task/delivery → 本体任务线；memory/goal → 记着；experience → 条目流）。 */
  const openRefTarget = useCallback((row: { kind: string }): void => {
    const target = echoRefTarget(row.kind);
    setEchoDetail(null);
    if (target.view === 'entries') {
      setView('entries');
      return;
    }
    setOntoTab(target.ontoTab);
    setView('onto');
  }, []);

  useEffect(() => {
    if (view === 'echo') void fetchEcho();
  }, [view, fetchEcho]);

  // 回响深链（v0.8.1）：token 递增即切到指定子视图；视图切换自身的 effect 负责拉新。
  useEffect(() => {
    if (viewToken === undefined || viewToken === 0 || requestedView === undefined) return;
    setView(requestedView);
  }, [viewToken, requestedView]);

  // 头部刷新令牌（v0.5.9）：重建期间不离开翻阅面也能拉新——按当前视图重取，条目流永远重取（它背后是热路）。
  useEffect(() => {
    if (refreshToken === undefined || refreshToken === 0) return;
    reload();
    if (view === 'week') void fetchWeek();
    if (view === 'onto') void fetchOnto();
    if (view === 'echo') void fetchEcho();
    // 依赖只跟令牌：视图切换自身的 effect 已负责拉新，这里不重复挂 view
  }, [refreshToken]);

  /** 回填历史（ontology-backfill-run，异步受理）：进度在「做梦」页看；这里只发起+回显受理。 */
  const runBackfill = useCallback(() => {
    if (rpc === undefined || ontoBackfilling) return;
    setOntoBackfilling(true);
    setNote(null);
    void rpc('ontology-backfill-run', { dryRun: false })
      .then((result) => {
        if (!result.ok) { setNote(`${copy['rec.failed']}: ${result.error.message}`); return; }
        setNote(result.value.accepted ? copy['onto.backfillDone'] : `${copy['rec.failed']}: ${result.value.reason ?? ''}`);
      })
      .catch(() => setNote(copy['rec.failed']))
      .finally(() => setOntoBackfilling(false));
  }, [rpc, ontoBackfilling]);

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

  /** 六面切换行（编年 / 条目流 / 线索头 / 本周 / 本体 / 回响）：当前面高亮。 */
  const switchTabs = (active: 'chronicle' | 'entries' | 'topics' | 'week' | 'onto' | 'echo'): ReturnType<typeof createElement>[] => [
    createElement('button', { key: 'c', type: 'button', style: active === 'chronicle' ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setView('chronicle') }, copy['chr.tab']),
    createElement('button', { key: 'e', type: 'button', style: active === 'entries' ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setView('entries') }, copy['panel.recent']),
    createElement('button', { key: 't', type: 'button', style: active === 'topics' ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setView('topics') }, copy['topic.view']),
    createElement('button', { key: 'w', type: 'button', style: active === 'week' ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setView('week') }, copy['rec.weekView']),
    createElement('button', { key: 'o', type: 'button', style: active === 'onto' ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setView('onto') }, copy['onto.tab']),
    createElement('button', { key: 'h', type: 'button', style: active === 'echo' ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setView('echo') }, copy['rec.echo']),
  ];

  if (view === 'week') {
    return createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, colorScheme: 'dark' } },
      createElement(
        'header',
        { style: HEAD_STYLE },
        ...switchTabs('week'),
        createElement('h4', { style: { margin: 0, fontSize: 13, color: '#9fc1ff' } }, copy['rec.weekTitle']),
        createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => void fetchWeek() }, copy['sea.refresh']),
      ),
      error !== null ? createElement('p', { style: { margin: '8px 14px', color: '#ff9a9a', fontSize: 12 } }, `${copy['sea.loadFailed']}: ${error}`) : null,
      weekRows.length === 0 && error === null && !weekBusy
        ? createElement('p', { style: { margin: '18px 14px', ...MUTED_STYLE } }, copy['rec.weekEmpty'])
        : null,
      createElement(
        'ul',
        { style: LIST_STYLE },
        weekRows.map((row) =>
          createElement(
            'li',
            { key: row.id, style: ITEM_STYLE },
            createElement(
              'div',
              { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
              createElement('span', { style: BADGE_STYLE }, formatTime(row.tsMs)),
              echoChip(row.echoId),
              row.topics.map((topic) => createElement('span', { key: `tp-${topic}`, style: CUE_STYLE }, topic)),
              row.cues.map((cue) => createElement('span', { key: `cue-${cue}`, style: CUE_STYLE }, cue)),
            ),
            createElement('div', { style: { fontSize: 13, lineHeight: 1.6, color: '#e8eeff', marginTop: 4, whiteSpace: 'pre-wrap' } }, row.cardLine),
            row.summary !== undefined && row.summary !== ''
              ? createElement('div', { style: { ...MUTED_STYLE, marginTop: 4, whiteSpace: 'pre-wrap' } }, row.summary)
              : null,
          ),
        ),
      ),
    );
  }

  if (view === 'echo') {
    return createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, colorScheme: 'dark' } },
      createElement(
        'header',
        { style: HEAD_STYLE },
        ...switchTabs('echo'),
        createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => void fetchEcho() }, copy['sea.refresh']),
      ),
      error !== null ? createElement('p', { style: { margin: '8px 14px', color: '#ff9a9a', fontSize: 12 } }, `${copy['sea.loadFailed']}: ${error}`) : null,
      // 生涯补充（v0.8）：pinned 的心里话/约定——回响页也能调生涯记忆
      (memoryView?.life ?? []).some((row) => row.pinned)
        ? createElement(
          'div',
          { style: { padding: '6px 14px', borderBottom: '1px solid rgba(120,160,255,.12)' } },
          createElement('div', { style: { fontSize: 12, color: '#8e9ab5' } }, copy['echo.lifeNote']),
          ...(memoryView?.life ?? []).filter((row) => row.pinned).map((row) =>
            createElement('div', { key: row.id, style: { ...MUTED_STYLE, marginTop: 2, whiteSpace: 'pre-wrap' } }, `· ${row.text}`),
          ),
        )
        : null,
      // 生涯流程档（v0.8.18）：回响页只放近 7 天档的前 3 行（pinned 记忆在上，不抢位）
      (memoryView?.distill ?? []).some((row) => row.kind === 'week')
        ? createElement(
          'div',
          { style: { padding: '6px 14px', borderBottom: '1px solid rgba(120,160,255,.12)' }, 'data-spirit': 'echo-digest' },
          createElement('div', { style: { fontSize: 12, color: '#8e9ab5' } }, copy['echo.digestNote']),
          ...(memoryView?.distill ?? [])
            .filter((row) => row.kind === 'week')
            .flatMap((row) => row.text.split('\n'))
            .filter((line) => line.trim() !== '')
            .slice(0, 3)
            .map((line, index) => createElement('div', { key: index, style: { ...MUTED_STYLE, marginTop: 2, whiteSpace: 'pre-wrap' } }, `· ${line}`)),
        )
        : null,
      // 回响事件头（v0.8.11）：recall-<uuid> · 时间 · FLASHBACK 标
      echoRecall !== null
        ? createElement(EchoRecallHeader, {
          recall: echoRecall,
          copy: { label: copy['echo.recallLabel'], flashback: copy['echo.flashback'] },
          formatTime,
        })
        : null,
      // 「此刻/语气」特殊格式栏（v0.8.8）：语气/状态不是记录，与列表分栏
      echoTone !== null
        ? createElement(EchoToneBar, {
          tone: echoTone,
          copy: { badge: copy['echo.toneBadge'], state: copy['echo.toneState'], opening: copy['echo.toneOpening'] },
          formatTime,
        })
        : null,
      // 主列表：记录（echo-<uuid>）——行形与本体/记着同构（组件化后可测，见 echo-refs-list）
      echoRefRows.length === 0 && echoBusy
        ? null
        : createElement(EchoRefsList, {
          records: echoRefRows,
          detail: echoDetail,
          copy: { original: copy['echo.refOriginal'], detailEmpty: copy['echo.detailEmpty'] },
          emptyText: copy['echo.refsEmpty'],
          kindLabel,
          formatTime,
          onOriginal: (row) => void openEchoDetail(row),
          onOpen: openRefTarget,
        }),
      // 轮次观测（回答「这一轮为什么没卡」）：折叠保留，不顶掉引用列表
      echoRows.length > 0
        ? createElement(
          'details',
          { style: { padding: '8px 14px' } },
          createElement('summary', { style: { ...MUTED_STYLE, cursor: 'pointer' } }, copy['echo.stepsTitle']),
          ...echoRows.slice(0, 10).map((item) => createElement(
            'div',
            { key: `${item.at}-${item.sessionId}-${item.kind}`, style: { ...MUTED_STYLE, marginTop: 4, fontSize: 11, whiteSpace: 'pre-wrap' } },
            `${new Date(item.at).toLocaleString()} \u00b7 ${item.kind === 'injected' ? copy['echo.injected'] : `${copy['echo.skipped']} \u00b7 ${item.reason}`}${item.origin === 'persisted' ? ` \u00b7 ${copy['echo.persisted']}` : ''}`,
          )),
        )
        : null,
    );
  }

  if (view === 'onto') {
    // 记忆分组渲染（v0.8）：生涯/工作/目的/日记共用一套行形（kind 徽标 + pinned 标记）
    const memGroup = (title: string, rows: Array<{ id: string; kind: string; text: string; pinned: boolean; echoId?: string; updatedAt?: number }>, note?: string): ReturnType<typeof createElement> =>
      createElement(
        'div',
        { key: title, style: { marginTop: 10 } },
        createElement('div', { style: { fontSize: 12, color: '#8e9ab5' } }, `${title}（${rows.length}）`),
        note === undefined || note === '' ? null : createElement('div', { style: { ...MUTED_STYLE, marginTop: 2 }, 'data-spirit': 'digest-entities' }, note),
        rows.length === 0
          ? createElement('div', { style: { ...MUTED_STYLE, marginTop: 4 } }, copy['memory.empty'])
          : createElement(
            'ul',
            { style: LIST_STYLE },
            ...rows.map((row) => createElement(
              'li',
              { key: row.id, style: ITEM_STYLE },
              createElement(
                'div',
                { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                createElement('span', { style: BADGE_STYLE }, row.kind),
                row.pinned ? createElement('span', { style: CUE_STYLE }, copy['memory.pinned']) : null,
                typeof row.updatedAt === 'number' ? createElement('span', { style: MUTED_STYLE }, formatTime(row.updatedAt)) : null,
                echoChip(row.echoId),
              ),
              createElement('div', { style: { fontSize: 13, lineHeight: 1.6, color: '#e8eeff', marginTop: 4, whiteSpace: 'pre-wrap' } }, row.text),
            )),
          ),
      );
    const innerTab = (k: 'tasks' | 'entities' | 'feedback' | 'memory', label: string): ReturnType<typeof createElement> =>
      createElement('button', { key: k, type: 'button', style: ontoTab === k ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => { setOntoTab(k); setOntoDetail(null); setOntoQuery(''); setOntoQueryInput(''); void fetchOnto(); } }, label);
    const empty = ontoTab === 'tasks' ? ontoTasks.length === 0 : ontoTab === 'entities' ? ontoEntities.length === 0 : ontoTab === 'memory' ? (memoryView === null || memoryView.life.length + memoryView.work.length + memoryView.diary.length + memoryView.goals.length === 0) : ontoEvals.length === 0;
    return createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, colorScheme: 'dark' } },
      createElement(
        'header',
        { style: HEAD_STYLE },
        ...switchTabs('onto'),
        innerTab('tasks', copy['onto.tasks']),
        innerTab('entities', copy['onto.entities']),
        innerTab('feedback', copy['onto.feedback']),
        innerTab('memory', copy['onto.memory']),
        ontoTab === 'feedback'
          ? null
          : createElement('input', {
            key: 'onto-q',
            style: { ...INPUT_STYLE, width: 160 },
            'data-spirit': 'onto-search-input',
            value: ontoQueryInput,
            placeholder: ontoTab === 'entities' ? copy['onto.searchPhEntities'] : copy['onto.searchPhTasks'],
            onChange: (event: { target: { value: string } }) => setOntoQueryInput(event.target.value),
            onKeyDown: (event: { key: string }) => { if (event.key === 'Enter') searchOnto(); },
          }),
        ontoTab === 'feedback'
          ? null
          : createElement('button', { type: 'button', style: ontoQuery !== '' ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => searchOnto() }, copy['onto.search']),
        createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => void fetchOnto() }, copy['sea.refresh']),
        createElement('button', { type: 'button', style: ontoBackfilling ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => runBackfill() }, ontoBackfilling ? copy['onto.backfilling'] : copy['onto.backfill']),
      ),
      error !== null ? createElement('p', { style: { margin: '8px 14px', color: '#ff9a9a', fontSize: 12 } }, `${copy['sea.loadFailed']}: ${error}`) : null,
      note !== null ? createElement('p', { style: { margin: '6px 14px', ...MUTED_STYLE } }, note) : null,
      // 号查询结果（v0.8.12）：按 echo 号搜到的记录 + 星图定位
      locateBlock(),
      ontoDetail !== null
        ? createElement(
            'div',
            { style: { borderBottom: '1px solid rgba(120,160,255,.14)', padding: '8px 14px' } },
            createElement(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' } },
              createElement('span', { style: { fontSize: 13, color: '#9fc1ff' } }, `${copy['onto.deliveries']}：${ontoDetail.label}`),
              createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => setOntoDetail(null) }, copy['onto.close']),
            ),
            createElement(
              'ul',
              { style: LIST_STYLE },
              ontoDetail.rows.length === 0
                ? createElement('li', { style: { ...ITEM_STYLE, ...MUTED_STYLE } }, copy['onto.empty'])
                : ontoDetail.rows.map((row) =>
                    createElement(
                      'li',
                      { key: row.id, style: ITEM_STYLE },
                      createElement(
                        'div',
                        { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                        createElement('span', { style: BADGE_STYLE }, formatTime(row.tsMs)),
                        echoChip(row.echoId),
                        ...row.cues.map((cue) => createElement('span', { key: `c-${cue}`, style: CUE_STYLE }, cue)),
                      ),
                      createElement('div', { style: { fontSize: 13, lineHeight: 1.6, color: '#e8eeff', marginTop: 4, whiteSpace: 'pre-wrap' } }, row.cardLine),
                      row.summary !== undefined && row.summary !== ''
                        ? createElement('div', { style: { ...MUTED_STYLE, marginTop: 4, whiteSpace: 'pre-wrap' } }, row.summary)
                        : null,
                    ),
                  ),
            ),
          )
        : null,
      empty && error === null && !ontoBusy
        ? createElement('p', { style: { margin: '18px 14px', ...MUTED_STYLE } }, ontoQuery !== '' ? copy['onto.searchEmpty'] : copy['onto.empty'])
        : null,
      ontoTab === 'tasks'
        ? createElement(
            'ul',
            { style: LIST_STYLE },
            ontoTasks.map((task) =>
              createElement(
                'li',
                { key: task.id, style: ITEM_STYLE },
                createElement(
                  'div',
                  { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                  createElement('span', { style: BADGE_STYLE }, task.status),
                  createElement('span', { style: MUTED_STYLE }, formatTime(task.updatedAt)),
                  echoChip(task.echoId),
                ),
                createElement('div', { style: { fontSize: 13, lineHeight: 1.6, color: '#e8eeff', marginTop: 4 } }, task.title),
                task.nextStep !== undefined && task.nextStep !== ''
                  ? createElement('div', { style: { ...MUTED_STYLE, marginTop: 2 } }, `${copy['onto.nextStep']}：${task.nextStep}`)
                  : null,
                createElement('button', { type: 'button', style: { ...BUTTON_STYLE, marginTop: 6 }, onClick: () => openTask(task) }, copy['sea.detail']),
              ),
            ),
          )
        : ontoTab === 'entities'
        ? createElement(
            'ul',
            { style: LIST_STYLE },
            ontoEntities.map((entity) =>
              createElement(
                'li',
                { key: entity.id, style: ITEM_STYLE },
                createElement(
                  'div',
                  { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                  createElement('span', { style: BADGE_STYLE }, entity.kind),
                  createElement('span', { style: MUTED_STYLE }, String(entity.importance)),
                ),
                createElement('div', { style: { fontSize: 13, lineHeight: 1.6, color: '#e8eeff', marginTop: 4 } }, entity.name),
                createElement('button', { type: 'button', style: { ...BUTTON_STYLE, marginTop: 6 }, onClick: () => openEntity(entity) }, copy['sea.detail']),
              ),
            ),
          )
        : ontoTab === 'feedback'
        ? createElement(
            'ul',
            { style: LIST_STYLE },
            ontoEvals.map((ev) =>
              createElement(
                'li',
                { key: ev.id, style: ITEM_STYLE },
                createElement(
                  'div',
                  { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                  createElement('span', { style: BADGE_STYLE }, ev.kind),
                  createElement('span', { style: MUTED_STYLE }, `${ev.anchorMode}·${ev.anchorConfidence}`),
                  createElement('span', { style: MUTED_STYLE }, formatTime(ev.tsMs)),
                ),
                createElement(
                  'div',
                  { style: { fontSize: 13, lineHeight: 1.6, color: '#e8eeff', marginTop: 4, whiteSpace: 'pre-wrap' } },
                  ev.userLine !== undefined && ev.userLine !== '' ? ev.userLine : (ev.deliveryId !== null ? ev.deliveryId : '—'),
                ),
              ),
            ),
          )
        : createElement(
            'div',
            { style: { padding: '4px 14px 18px', overflowY: 'auto', flex: '1 1 auto', minHeight: 0 } },
            ...(memoryView === null
              ? [createElement('p', { style: MUTED_STYLE }, copy['memory.empty'])]
              : [
                // 刷新流程档（v0.8.18）：手动重算三档（幂等，里程碑只增不改）
                createElement(
                  'div',
                  { key: 'digest-refresh', style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 } },
                  createElement('button', {
                    type: 'button',
                    style: BUTTON_STYLE,
                    'data-spirit': 'digest-refresh',
                    onClick: () => {
                      const call = rpc;
                      if (call === undefined) return;
                      void (async () => {
                        await call('distill-digest-run', {}).catch(() => undefined);
                        const mem = await call('memory-list', {}).catch(() => undefined);
                        if (mem !== undefined && mem.ok) setMemoryView(mem.value);
                      })();
                    },
                  }, copy['memory.refreshDigest']),
                ),
                memGroup(copy['memory.life'], memoryView.life.map((m) => ({ id: m.id, kind: m.kind, text: m.text, pinned: m.pinned, ...(m.echoId === undefined ? {} : { echoId: m.echoId }), updatedAt: m.updatedAt }))),
                memGroup(copy['memory.work'], memoryView.work.map((m) => ({ id: m.id, kind: m.kind, text: m.text, pinned: m.pinned, ...(m.echoId === undefined ? {} : { echoId: m.echoId }), updatedAt: m.updatedAt }))),
                memGroup(copy['memory.goals'], memoryView.goals.map((g) => ({ id: g.id, kind: g.status, text: g.title, pinned: false, ...(g.echoId === undefined ? {} : { echoId: g.echoId }), updatedAt: g.updatedAt }))),
                memGroup(copy['memory.diary'], memoryView.diary.map((m) => ({ id: m.id, kind: m.kind, text: m.text, pinned: m.pinned, ...(m.echoId === undefined ? {} : { echoId: m.echoId }), updatedAt: m.updatedAt }))),
                // 对话细节（v0.8.24）：代理自记的要点（不自动注入）
                memGroup(copy['memory.episode'], (memoryView.episode ?? []).map((m) => ({ id: m.id, kind: m.kind, text: m.text, pinned: m.pinned, updatedAt: m.updatedAt }))),
                // 生涯流程档（v0.8.18）：三档分开——week 近期 / month 中期 / milestone 只增不改；知识性归上游
                // v0.8.25：先看「按会话」（会话内 + 跨会话已去重，重复标 ×N），再看时间窗口档
                ...(['session', 'week', 'month', 'milestone'] as const).map((tier) => {
                  const rows = (memoryView.distill ?? []).filter((m) => m.kind === tier);
                  const entities = [...new Set(rows.flatMap((m) => m.entityNames ?? []))];
                  return memGroup(
                    tier === 'session' ? copy['memory.digestSession'] : tier === 'week' ? copy['memory.digestWeek'] : tier === 'month' ? copy['memory.digestMonth'] : copy['memory.digestMilestone'],
                    rows.map((m) => ({ id: m.id, kind: tier, text: m.text, pinned: false, updatedAt: m.updatedAt })),
                    entities.length === 0 ? undefined : `${copy['memory.digestEntities']}${entities.join('、')}`,
                  );
                }),
              ]),
          ),
    );
  }

  if (view === 'topics') {
    return createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, colorScheme: 'dark' } },
      createElement(
        'header',
        { style: HEAD_STYLE },
        ...switchTabs('topics'),
      ),
      createElement(SeaTopics, { rpc }),
    );
  }

  if (view === 'chronicle') {
    return createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, colorScheme: 'dark' } },
      createElement('header', { style: HEAD_STYLE }, ...switchTabs('chronicle')),
      createElement(SeaChronicle, {
        ...(rpc === undefined ? {} : { rpc }),
        ...(refreshToken === undefined ? {} : { refreshToken }),
        ...(props.onLocateEcho === undefined ? {} : { onLocateEcho: props.onLocateEcho }),
      }),
    );
  }

  return createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, colorScheme: 'dark' } },
    createElement(
      'header',
      { style: HEAD_STYLE },
      createElement('h4', { style: { margin: 0, fontSize: 13, color: '#9fc1ff' } }, copy['rec.title']),
      createElement('input', {
        style: { ...INPUT_STYLE, width: 200 },
        'data-spirit': 'entries-search-input',
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
      ...switchTabs('entries'),
    ),
    error !== null ? createElement('p', { style: { margin: '8px 14px', color: '#ff9a9a', fontSize: 12 } }, `${copy['sea.loadFailed']}: ${error}`) : null,
    note !== null ? createElement('p', { style: { margin: '6px 14px', ...MUTED_STYLE } }, note) : null,
    // 号查询结果（v0.8.12）：按 echo 号搜到的记录 + 星图定位
    locateBlock(),
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
          echoChip(row.echoId),
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
