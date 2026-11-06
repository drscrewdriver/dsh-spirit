/**
 * 「记忆星海」主面板页（全屏画布 + 详情 + 人设入口）。
 *
 * 三条克制：
 * 1. **不长期轮询**：打开拉一次、之后靠「刷新」。星海的 3000 点窗口比手记的 30 行贵得多，
 *    每 2 秒搬一次全库投影是没必要的负担（真要看实时变化，第二期上 SSE 而不是缩短轮询）；
 * 2. **图为主、看为辅**：详情卡与底部列表都只读同一份 `points`，不另发请求；
 * 3. **主题只影响观感**：类型色相写死在 `sea-themes.ts`，换皮不会让图失去信息量。
 */
import { createElement, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import type { SpiritSeaGraph, SpiritSeaPoint } from '../../../src/contract.js';
import { SPIRIT_VERSION } from '../../../src/contract.js';
import { copyOf } from '../copy.js';
import { sessionIdOf, type SeatProps } from '../env.js';
import type { RpcFn } from '../rpc.js';
import { SeaPersona } from './sea-persona.js';
import { SeaRecords } from './sea-records.js';
import { SeaDream } from './sea-dream.js';
import { THEME_LABEL, TRIGGER_LABEL } from './sea-labels.js';
import { SeaView } from './sea-view.js';
import { THEME_IDS, browserStorage, loadGlowFactor, loadHiGlow, loadThemeId, saveGlowFactor, saveHiGlow, saveThemeId, themeById, withGlow } from './sea-themes.js';
import { loadLayoutMode, saveLayoutMode, type SeaLayoutMode } from './sea-layout.js';

/**
 * 外层给视口锚而不是 `height: 100%`：宿主 `main` 面板不给确定高度，百分比链会断、
 * 画布停在半高（姊妹包真机踩过的坑，见 dsh-prime-memory/docs/explorer-ui-entry-pitfalls.md 布局①）。
 */
const PAGE_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 'calc(100vh - 48px)', background: '#05060b', color: '#cfd6e4' };
const BAR_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid rgba(120,160,255,.14)' };
const TITLE_STYLE: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: '.08em', color: '#9fc1ff' };
const STAT_STYLE: CSSProperties = { fontSize: 12, color: '#8e9ab5' };
const MUTED_STYLE: CSSProperties = { fontSize: 12, color: '#6d7891' };
const BUTTON_STYLE: CSSProperties = { background: 'rgba(120,160,255,.1)', color: '#b8c9ee', border: '1px solid rgba(120,160,255,.22)', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer' };
const BUTTON_ON_STYLE: CSSProperties = { ...BUTTON_STYLE, background: 'rgba(120,160,255,.3)', color: '#fff' };
const BODY_STYLE: CSSProperties = { display: 'flex', flex: '1 1 auto', minHeight: 0, flexWrap: 'wrap' };
const CARD_STYLE: CSSProperties = { width: 320, minWidth: 260, flex: '0 1 320px', padding: '12px 14px', borderLeft: '1px solid rgba(120,160,255,.14)', overflowY: 'auto' };
const LIST_STYLE: CSSProperties = { listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 6 };
const ITEM_STYLE: CSSProperties = { padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(120,160,255,.16)', fontSize: 12, cursor: 'pointer' };
/** 线索 chips（详情卡的“证据面”，与手记卡片同源同形）。 */
const CUE_STYLE: CSSProperties = { fontSize: 11, padding: '0 6px', borderRadius: 6, background: 'rgba(120,160,255,.1)', color: '#8fa8d8' };

export interface SeaPanelProps extends SeatProps {
  rpc?: RpcFn;
  /** 顶栏「关闭」：由入口注入（宿主 `layout.selectPanel(null)`）。 */
  onClose?: () => void;
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function SeaPanel(props: SeaPanelProps) {
  const { rpc } = props;
  const copy = copyOf(typeof document === 'undefined' ? undefined : document.documentElement.lang);
  const seatSessionId = sessionIdOf(props);
  const storageRef = useRef(browserStorage());
  const mountedRef = useRef(true);

  const [graph, setGraph] = useState<SpiritSeaGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<'all' | 'session'>('all');
  const [themeId, setThemeId] = useState<string>(() => loadThemeId(storageRef.current));
  const [showLabels, setShowLabels] = useState(true);
  const [showEdges, setShowEdges] = useState(true);
  const [glowFactor, setGlowFactor] = useState(() => loadGlowFactor(storageRef.current));
  const [hiGlow, setHiGlow] = useState(() => loadHiGlow(storageRef.current));
  const [layoutMode, setLayoutMode] = useState<SeaLayoutMode>(() => loadLayoutMode(storageRef.current));
  const [focusOnly, setFocusOnly] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const [selected, setSelected] = useState<SpiritSeaPoint | null>(null);
  // 四 tab（v0.3.3）：星海=图、人设=卡、翻阅=条目管理面（设置卡检视段搬入处）、做梦=整理 pass
  const [tab, setTab] = useState<'sea' | 'persona' | 'records' | 'dream'>('sea');
  const [note, setNote] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (rpc === undefined) return;
    const token = ++seqRef.current;
    const nextScope: 'all' | 'session' = scope === 'session' && seatSessionId !== '' ? 'session' : 'all';
    setError(null);
    try {
      const result = await rpc('sea-graph', nextScope === 'session' ? { scope: 'session', sessionId: seatSessionId } : { scope: 'all' });
      if (token !== seqRef.current || !mountedRef.current) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setGraph(result.value);
      // 选中的点跟着新数据换引用：不在窗口里就关详情卡；在的话必须换成刷新后的对象
      // ——否则刚打完★按钮不翻转（真组件验证实测到：库里已写入但面板仍显示「这条重要」）。
      setSelected((current) => {
        if (current === null) return null;
        return result.value.points.find((point) => point.id === current.id) ?? null;
      });
    } catch (err) {
      if (token !== seqRef.current || !mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rpc, scope, seatSessionId]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  // Esc 关掉详情卡：选中的星还在，只是不再占右侧那块面（窄面板下这是唯一的退路）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const theme = withGlow(themeById(themeId), glowFactor);
  const focus = new Set(graph?.focusIds ?? []);
  const points = graph?.points ?? [];
  const stats = graph?.stats ?? null;
  const spanDays = stats?.span !== null && stats?.span !== undefined ? Math.max(1, Math.round((stats.span.to - stats.span.from) / 86_400_000)) : 0;

  const mark = (entryId: string, score: number): void => {
    if (rpc === undefined) return;
    void rpc('experience-feedback', { entryId, score })
      .then((result) => {
        setNote(result.ok ? (score > 0 ? copy['sea.marked'] : copy['sea.unmarked']) : `${copy['sea.markFailed']}: ${result.error.message}`);
        void load();
      })
      .catch(() => setNote(copy['sea.markFailed']));
  };

  const switchTheme = (id: string): void => {
    setThemeId(id);
    saveThemeId(storageRef.current, id);
  };

  /** 辉光倍率只作用到本次渲染与 localStorage，不进 volatile 契约（纯视觉偏好）。 */
  const switchGlow = (value: number): void => {
    setGlowFactor(value);
    saveGlowFactor(storageRef.current, value);
  };

  /**
   * 高质量辉光 = 强走 WebGL2（密集区相加叠亮的 bloom 质感）。
   *
   * 关掉时不会自动降级（升级单向是为了不在拖拽中重建 buffer），所以这里用 key 强制重建
   * 画布：用户显式改画质是一个“愿意接受视角复位”的动作，不是意外抖动。
   */
  const switchHiGlow = (): void => {
    const next = !hiGlow;
    setHiGlow(next);
    saveHiGlow(storageRef.current, next);
  };

  /**
   * 组织方式切换（双极胶囊 ⇄ 星盘轨道）。
   *
   * 它是“拿什么当坐标轴”，不是“换个皮”：两种组式的“上下”与“远近”语义不同，
   * 所以图例与提示文字必须跟着变（留着旧图例就是让主人读错图）。
   */
  const switchLayoutMode = (): void => {
    const next: SeaLayoutMode = layoutMode === 'poles' ? 'orbits' : 'poles';
    setLayoutMode(next);
    saveLayoutMode(storageRef.current, next);
  };

  return createElement(
    'section',
    { style: PAGE_STYLE },
    createElement(
      'header',
      { style: BAR_STYLE },
      createElement('h3', { style: TITLE_STYLE }, copy['sea.title']),
      // BUILD 标记：装机冒烟靠它一眼分辨“旧页 / 新代码没进包”（姊妹包验收口径：
      // 装机成功≠生效，得能看见新代码的痕迹；版本号也是回读 dist 之外的第二证据）
      createElement('span', { style: { ...MUTED_STYLE, letterSpacing: '.04em' } }, `v${SPIRIT_VERSION}`),
      createElement('span', { style: MUTED_STYLE }, layoutMode === 'poles' ? `${copy['sea.hint']} · ${copy['sea.notFact']}` : `${copy['sea.hintOrbits']} · ${copy['sea.notFact']}`),
      createElement('span', { style: MUTED_STYLE }, layoutMode === 'poles' ? `↑ ${copy['sea.poleOwner']} · ↓ ${copy['sea.poleSelf']}` : copy['sea.orbitsLegend']),
      createElement(
        'button',
        { type: 'button', style: tab === 'sea' ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setTab('sea') },
        copy['sea.viewSea'],
      ),
      createElement(
        'button',
        { type: 'button', style: tab === 'persona' ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setTab('persona') },
        copy['sea.viewPersona'],
      ),
      createElement(
        'button',
        { type: 'button', style: tab === 'records' ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setTab('records') },
        copy['sea.viewRecords'],
      ),
      createElement(
        'button',
        { type: 'button', style: tab === 'dream' ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setTab('dream') },
        copy['sea.viewDream'],
      ),
      createElement('span', { style: { ...STAT_STYLE, marginLeft: 'auto' } },
        stats === null
          ? '—'
          : `${copy['sea.loaded']} ${stats.loaded} · ${copy['sea.total']} ${stats.total} · ${copy['sea.edges']} ${stats.edges} · ${copy['sea.spanDays']} ${spanDays} · ${copy['sea.fadeTiers']} ${stats.fade.full}/${stats.fade.gist}/${stats.fade.held}${stats.ghosts > 0 ? ` · ${copy['sea.ghosts']} ${stats.ghosts}` : ''}${stats.moodLabel === '' ? '' : ` · ${copy['sea.mood']} ${stats.moodLabel}`}`,
      ),
      createElement(
        'button',
        { type: 'button', style: BUTTON_STYLE, onClick: () => setScope(scope === 'all' ? 'session' : 'all') },
        scope === 'all' ? copy['sea.scopeAll'] : copy['sea.scopeSession'],
      ),
      createElement(
        'select',
        { style: BUTTON_STYLE, title: copy['sea.themeHint'], value: themeId, onChange: (event: { target: { value: string } }) => switchTheme(event.target.value) },
        THEME_IDS.map((id) => createElement('option', { key: id, value: id }, `${copy['sea.theme']}·${THEME_LABEL[id] !== undefined ? copy[THEME_LABEL[id]] : id}`)),
      ),
      createElement('button', { type: 'button', style: showLabels ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setShowLabels((v) => !v) }, copy['sea.labels']),
      createElement('button', { type: 'button', style: showEdges ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setShowEdges((v) => !v) }, copy['sea.edges']),
      createElement(
        'label',
        { style: { ...MUTED_STYLE, display: 'inline-flex', gap: 4, alignItems: 'center' } },
        copy['sea.glow'],
        createElement('input', {
          type: 'range',
          min: 0.5,
          max: 2.5,
          step: 0.05,
          value: String(glowFactor),
          style: { width: 76 },
          onChange: (event: { target: { value: string } }) => switchGlow(Number(event.target.value)),
        }),
      ),
      createElement(
        'button',
        { type: 'button', style: BUTTON_STYLE, title: copy['sea.layoutHint'], onClick: switchLayoutMode },
        `${copy['sea.layout']}·${layoutMode === 'poles' ? copy['sea.layoutPoles'] : copy['sea.layoutOrbits']}`,
      ),
      createElement(
        'button',
        { type: 'button', style: hiGlow ? BUTTON_ON_STYLE : BUTTON_STYLE, title: copy['sea.hiGlowHint'], onClick: switchHiGlow },
        copy['sea.hiGlow'],
      ),
      createElement('button', { type: 'button', style: focusOnly ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setFocusOnly((v) => !v) }, copy['sea.focusOnly']),
      createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => setResetToken((v) => v + 1) }, '⟲'),
      createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => void load() }, copy['sea.refresh']),
      props.onClose !== undefined ? createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => props.onClose?.() }, copy['sea.close']) : null,
    ),
    error !== null
      ? createElement('p', { style: { margin: '8px 14px', color: '#ff9a9a', fontSize: 12 } }, `${copy['sea.loadFailed']}: ${error}`)
      : null,
    stats?.degraded === true ? createElement('p', { style: { margin: '6px 14px', ...MUTED_STYLE } }, copy['sea.degraded']) : null,
    // 因果边图例（v0.3.5）：图上真有因果边才出现（图例与实际画的东西对得上是铁律）
    (graph?.edges ?? []).some((edge) => edge.kind === 'causal')
      ? createElement('p', { style: { margin: '6px 14px', ...MUTED_STYLE, color: '#ffaa6e' } }, copy['causal.legend'])
      : null,
    // DRSC 短提示（v0.3.3）：只在 warn 时出现（skipped 是中性无据不进故障提示）；
    // 完整指引在设置卡，这里只指路不开第二份 banner（两处文案不一致是最难对账的债）。
    graph?.drscVerdict === 'warn'
      ? createElement('p', { style: { margin: '6px 14px', ...MUTED_STYLE, color: '#ffca7a' } }, copy['drscHint.seaShort'])
      : null,
    tab === 'persona'
      // 人设面占满主体区：它是个表单，不需要画布背板
      ? createElement('div', { style: { flex: '1 1 auto', overflowY: 'auto' } }, createElement(SeaPersona, { rpc }))
      : tab === 'records'
        // 翻阅面同样占满主体区：长列表需要确定高度链（布局①同源纪律），不叠画布背板
        ? createElement('div', { style: { flex: '1 1 auto', minHeight: 0, display: 'flex' } }, createElement(SeaRecords, { rpc }))
        : tab === 'dream'
          ? createElement('div', { style: { flex: '1 1 auto', overflowY: 'auto' } }, createElement(SeaDream, { rpc }))
          : createElement(
      'div',
      { style: BODY_STYLE },
      points.length === 0 && error === null
        ? createElement('p', { style: { margin: '18px 14px', ...MUTED_STYLE } }, copy['sea.empty'])
        : createElement(SeaView, {
            key: hiGlow ? 'sea-gl' : 'sea-2d',
            points,
            edges: graph?.edges ?? [],
            theme,
            preferWebgl: hiGlow,
            layoutMode,
            poleLabels: { self: copy['sea.poleSelf'], owner: copy['sea.poleOwner'] },
            focus,
            focusOnly,
            showLabels,
            showEdges,
            selectedId: selected?.id ?? null,
            resetToken,
            onSelect: setSelected,
          }),
      createElement(
        'aside',
        { style: CARD_STYLE },
        selected === null
          ? createElement('p', { style: MUTED_STYLE }, copy['sea.detail'])
          : createElement(
            'div',
            null,
            createElement('h4', { style: { margin: '0 0 6px', fontSize: 13, color: '#9fc1ff' } }, copy['sea.detail']),
            createElement('div', { style: { fontSize: 14, lineHeight: 1.6, color: '#e8eeff', whiteSpace: 'pre-wrap' } }, selected.text),
            selected.superseded
              ? createElement('div', { style: { color: '#ffca7a', fontSize: 12, marginTop: 4 } }, copy['sea.detailSuperseded'])
              : null,
            selected.gist !== null ? createElement('div', { style: { ...MUTED_STYLE, marginTop: 6 } }, `${copy['sea.detailGist']}：${selected.gist}`) : null,
            selected.cues.length > 0
              ? createElement(
                'div',
                { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 } },
                createElement('span', { style: MUTED_STYLE }, copy['panel.cues']),
                ...selected.cues.map((cue) => createElement('span', { key: cue, style: CUE_STYLE }, cue)),
              )
              : null,
            createElement(
              'div',
              { style: { ...MUTED_STYLE, marginTop: 8 } },
              `${TRIGGER_LABEL[selected.trigger] !== undefined ? copy[TRIGGER_LABEL[selected.trigger]] : selected.trigger} · ${copy['sea.detailTurn']} ${selected.turnSeq} · ${formatTime(selected.t)}`,
            ),
            createElement(
              'div',
              { style: { ...MUTED_STYLE } },
              `${copy['sea.detailSource']}：${selected.lane === 'drsc' ? copy['sea.sourceDrsc'] : copy['sea.sourceLive']} · ${copy['sea.detailSalience']} ${selected.salience}/2 · ${copy['sea.detailFreshness']} ${Math.round(selected.freshness * 100)}% · ${copy['sea.fadeTiers']} ${selected.tier}`,
            ),
            createElement(
              'div',
              { style: { ...MUTED_STYLE, wordBreak: 'break-all' } },
              `${copy['sea.detailSession']}：${selected.sessionId.slice(0, 12)}`,
            ),
            createElement(
              'div',
              { style: { display: 'flex', gap: 8, marginTop: 10 } },
              selected.feedback !== null && selected.feedback > 0
                ? createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => mark(selected.id, -1) }, copy['sea.unmark'])
                : createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => mark(selected.id, 5) }, copy['sea.markImportant']),
            ),
          ),
        createElement('h4', { style: { margin: '16px 0 0', fontSize: 13, color: '#9fc1ff' } }, copy['panel.recent']),
        createElement(
          'ul',
          { style: LIST_STYLE },
          [...points]
            .slice(-8)
            .reverse()
            .map((point) =>
              createElement(
                'li',
                {
                  key: point.id,
                  style: { ...ITEM_STYLE, opacity: point.id === selected?.id ? 1 : 0.75 },
                  onClick: () => setSelected(point),
                },
                createElement('div', null, point.text),
                point.gist !== null ? createElement('div', { style: { ...MUTED_STYLE, fontStyle: 'italic' } }, point.gist) : null,
                createElement('div', { style: MUTED_STYLE }, `${formatTime(point.t)} · ${TRIGGER_LABEL[point.trigger] !== undefined ? copy[TRIGGER_LABEL[point.trigger]] : point.trigger}`),
              ),
            ),
        ),
        note !== null ? createElement('p', { style: { ...MUTED_STYLE, marginTop: 10 } }, note) : null,
      ),
    ),
  );
}
