/**
 * 「编年」子视图（v0.10 定位重钉）：这条鱼走到今天这一步的经历轴。
 *
 * 为什么它是翻阅 tab 的默认面：翻阅原来的默认是「条目流」，而条目流只查体验表，
 * 体验表按设计只认摩擦（失败/恢复/打断/收尾），于是第一屏永远是一串"我又出错了"。
 * 那不是记忆，是伤疤清单。编年把「事」放在前面、「感」缩成注脚，才答得上
 * "我是怎么走到这儿的"。
 *
 * 三条纪律：
 * 1. **不轮询**（与星海同口径）：打开拉一次，切天数/点刷新才重取。
 * 2. **不编造**：`repeat` 是库里真的等值重复行数；为 1 就不显示倍数。
 * 3. **两极可折叠**：感（feel）默认折叠同句——同一个坑一天踩八次不该占八行。
 */
import { createElement, useCallback, useEffect, useState, type CSSProperties } from 'react';

import type { SpiritChronicleKind, SpiritChronicleResult } from '../../../src/contract.js';
import { copyOf } from '../copy.js';
import type { RpcFn } from '../rpc.js';
import { useHtmlLang } from '../use-html-lang.js';

const HEAD_STYLE: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid rgba(120,160,255,.14)' };
const MUTED_STYLE: CSSProperties = { fontSize: 12, color: '#6d7891' };
const BUTTON_STYLE: CSSProperties = { background: 'rgba(120,160,255,.1)', color: '#b8c9ee', border: '1px solid rgba(120,160,255,.22)', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer' };
const BUTTON_ON_STYLE: CSSProperties = { ...BUTTON_STYLE, background: 'rgba(120,160,255,.3)', color: '#fff' };
const DAY_STYLE: CSSProperties = { padding: '10px 14px', borderTop: '1px solid rgba(120,160,255,.1)' };
const ITEM_STYLE: CSSProperties = { display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0' };
const BADGE_STYLE: CSSProperties = { fontSize: 11, padding: '0 6px', borderRadius: 6, background: 'rgba(120,160,255,.12)', color: '#8fa8d8', flex: '0 0 auto' };
const WORK_BADGE_STYLE: CSSProperties = { ...BADGE_STYLE, background: 'rgba(120,220,170,.16)', color: '#8fe3bc' };
const MILESTONE_BADGE_STYLE: CSSProperties = { ...BADGE_STYLE, background: 'rgba(255,208,120,.16)', color: '#ffd687' };
const TEXT_STYLE: CSSProperties = { fontSize: 13, lineHeight: 1.6, color: '#e8eeff', whiteSpace: 'pre-wrap' };
const FEEL_TEXT_STYLE: CSSProperties = { ...TEXT_STYLE, fontSize: 12, color: '#9aa7bf' };
const DETAIL_STYLE: CSSProperties = { ...MUTED_STYLE, marginTop: 2, whiteSpace: 'pre-wrap' };

/** 窗口档位：默认 30 天（与"回看这一段"的日常粒度一致）。 */
const WINDOWS: ReadonlyArray<{ days: number; key: 'chr.win7' | 'chr.win30' | 'chr.win90' }> = [
  { days: 7, key: 'chr.win7' },
  { days: 30, key: 'chr.win30' },
  { days: 90, key: 'chr.win90' },
];

const KIND_LABEL: Record<SpiritChronicleKind, 'chr.kind.work' | 'chr.kind.feel' | 'chr.kind.note' | 'chr.kind.milestone'> = {
  work: 'chr.kind.work',
  feel: 'chr.kind.feel',
  note: 'chr.kind.note',
  milestone: 'chr.kind.milestone',
};

/**
 * 日头文案：`3/21 周五 · 做成 2 · 感受 5`。
 *
 * 日期在客户端格式化（宿主只给 YYYY-MM-DD 的日键），避免服务端替浏览器决定时区。
 */
function dayLabel(day: string, locale: string): string {
  const parts = day.split('-').map((part) => Number(part));
  if (parts.length !== 3) return day;
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 0;
  const date = parts[2] ?? 0;
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(date)) return day;
  const stamp = new Date(year, month - 1, date);
  if (Number.isNaN(stamp.getTime())) return day;
  try {
    return stamp.toLocaleDateString(locale, { month: 'numeric', day: 'numeric', weekday: 'short' });
  } catch {
    return day;
  }
}

function formatClock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface SeaChronicleProps {
  rpc?: RpcFn;
  /** 头部刷新令牌（与翻阅/星海同源）：递增即重取。 */
  refreshToken?: number;
  /** 星图定位（v0.8.12）：把 echo 号交给星海选中对应星点。 */
  onLocateEcho?: (echoId: string) => void;
}

export function SeaChronicle(props: SeaChronicleProps) {
  const { rpc, refreshToken, onLocateEcho } = props;
  const lang = useHtmlLang();
  const copy = copyOf(lang);
  const [days, setDays] = useState(30);
  const [data, setData] = useState<SpiritChronicleResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 感（feel）折叠：默认折叠，让「事」占住第一屏。 */
  const [showFeel, setShowFeel] = useState(false);

  const load = useCallback(async () => {
    if (rpc === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc('chronicle-list', { days });
      if (result.ok) setData(result.value);
      else {
        setError(result.error.message);
        setData(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [rpc, days]);

  useEffect(() => {
    void load();
    // refreshToken 只是"重取"的触发令牌，不进依赖语义（0 是初值，不该多拉一次）；
    // 本仓不挂 react-hooks 插件，所以不加 eslint 指令（未定义的规则会让 lint 直接失败）
  }, [load, refreshToken]);

  const locale = lang === undefined ? undefined : lang;
  const api = copy; // 收窄名字，渲染区里少一层

  const itemRow = (item: SpiritChronicleResult['days'][number]['items'][number]): ReturnType<typeof createElement> => {
    const badgeStyle = item.kind === 'work'
      ? WORK_BADGE_STYLE
      : item.kind === 'milestone'
        ? MILESTONE_BADGE_STYLE
        : BADGE_STYLE;
    return createElement(
      'div',
      { key: `${item.kind}:${item.id}`, style: ITEM_STYLE },
      createElement('span', { style: badgeStyle }, api[KIND_LABEL[item.kind]]),
      createElement('span', { style: { ...MUTED_STYLE, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' } }, formatClock(item.tsMs)),
      createElement(
        'div',
        { style: { flex: '1 1 auto', minWidth: 0 } },
        createElement(
          'div',
          { style: item.kind === 'feel' ? FEEL_TEXT_STYLE : TEXT_STYLE },
          item.repeat > 1 ? `${item.text} ×${item.repeat}` : item.text,
        ),
        item.detail !== undefined && item.detail !== ''
          ? createElement('div', { style: DETAIL_STYLE }, item.detail)
          : null,
      ),
      item.echoId !== undefined && onLocateEcho !== undefined
        ? createElement(
          'button',
          {
            key: 'loc',
            type: 'button',
            title: item.echoId,
            style: { ...BUTTON_STYLE, flex: '0 0 auto', fontSize: 11 },
            onClick: () => onLocateEcho(item.echoId as string),
          },
          api['chr.locate'],
        )
        : null,
    );
  };

  const dayBlock = (day: SpiritChronicleResult['days'][number]): ReturnType<typeof createElement> => {
    const visible = showFeel ? day.items : day.items.filter((item) => item.kind !== 'feel');
    const hiddenFeel = day.items.length - visible.length;
    return createElement(
      'section',
      { key: day.day, style: DAY_STYLE },
      createElement(
        'div',
        { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 4 } },
        createElement('span', { style: { fontSize: 12, color: '#9fc1ff', fontVariantNumeric: 'tabular-nums' } }, dayLabel(day.day, locale ?? 'zh-CN')),
        createElement('span', { style: MUTED_STYLE }, `${api['chr.did']} ${day.counts.work} · ${api['chr.felt']} ${day.counts.feel}`),
        hiddenFeel > 0
          ? createElement(
            'button',
            { type: 'button', style: { ...BUTTON_STYLE, fontSize: 11 }, onClick: () => setShowFeel(true) },
            `${api['chr.showFeel']} ${hiddenFeel}`,
          )
          : null,
      ),
      visible.length === 0
        ? createElement('div', { style: MUTED_STYLE }, api['chr.dayOnlyFeel'])
        : visible.map((item) => itemRow(item)),
    );
  };

  return createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, overflowY: 'auto', colorScheme: 'dark' } },
    createElement(
      'header',
      { style: HEAD_STYLE },
      ...WINDOWS.map((win) => createElement(
        'button',
        {
          key: win.days,
          type: 'button',
          style: days === win.days ? BUTTON_ON_STYLE : BUTTON_STYLE,
          onClick: () => setDays(win.days),
        },
        api[win.key],
      )),
      createElement(
        'button',
        { type: 'button', style: showFeel ? BUTTON_ON_STYLE : BUTTON_STYLE, onClick: () => setShowFeel((value) => !value) },
        api['chr.toggleFeel'],
      ),
      createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => void load() }, api['sea.refresh']),
      busy ? createElement('span', { style: MUTED_STYLE }, api['chr.loading']) : null,
      data === null ? null : createElement('span', { style: MUTED_STYLE }, `${api['chr.total']} ${data.total}`),
      error !== null ? createElement('span', { style: { ...MUTED_STYLE, color: '#ff9a9a' } }, `${api['sea.loadFailed']}: ${error}`) : null,
    ),
    data !== null && data.empty
      ? createElement('p', { style: { margin: '18px 14px', ...MUTED_STYLE } }, api['chr.empty'])
      : null,
    ...(data === null ? [] : data.days.map((day) => dayBlock(day))),
  );
}
