/**
 * 顶层「手记」分节（只读投影 + 会话开关）。
 *
 * 三条刻意的克制：
 * 1. **不重复生成设置表单**：0.1.7+ 宿主会按 Config 的 volatile 节自动出表单，
 *    本分节只做"看记录 / 看状态 / 会话开关"，一个字段的编辑都不抢
 *    （抢了就会出现同一插件两份设置入口，姊妹包为此实测回归过）。
 * 2. **标题写明"非事实记录"**：手记是角色的体验，把它排版成事实清单，
 *    用户会拿它当审计记录看。
 * 3. **面板挂载不干重活、不长期轮询**：有活动 2s、静默 5s、卸载即停；
 *    轮询打的是本地 loopback，但每 2 秒一次读库仍然不该在无人看时继续。
 */
import { createElement, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import type { SpiritJournalPage, SpiritSessionStats, SpiritSettingsView } from '../../src/contract.js';
import type { RpcFn } from './rpc.js';
import { copyOf } from './copy.js';
import { sessionIdOf, type SeatProps } from './env.js';

const listStyle: CSSProperties = { listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 8 };
const itemStyle: CSSProperties = { padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsw-border-color, rgba(128,128,128,0.28))' };
const mutedStyle: CSSProperties = { opacity: 0.65, fontSize: 12 };
const hStyle: CSSProperties = { margin: '0 0 4px', fontSize: 14, fontWeight: 600 };

const DRSC_VERDICT_KEYS = { ok: 'panel.drscOk', skipped: 'panel.drscSkipped', warn: 'panel.drscWarn', fail: 'panel.drscFail' } as const;

export function SpiritPanel(props: { rpc?: RpcFn } & SeatProps) {
  const rpc = props.rpc;
  const copy = copyOf(typeof document === 'undefined' ? undefined : document.documentElement.lang);
  const [stats, setStats] = useState<SpiritSessionStats | null>(null);
  const [page, setPage] = useState<SpiritJournalPage | null>(null);
  const [settings, setSettings] = useState<SpiritSettingsView | null>(null);
  const [halfLifeDraft, setHalfLifeDraft] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  // 会话由宿主给就用给的，否则服务端挑最近有活动的（不逼客户端先拉会话列表）
  const seatSessionId = sessionIdOf(props);

  const load = useCallback(async () => {
    if (rpc === undefined) return;
    const token = ++seqRef.current;
    setError(null);
    try {
      // 两段各自成立：统计是**内存注册表**（宿主重启后为空是常态），手记是**库**。
      // 真宿主实测过把它们串成一条链的写法：拿不到统计就连条目都不拉，
      // 于是“昨天发生了什么”在重启后面前是一片空白——那是本末倒置。
      const sessionId = seatSessionId;
      const statsResult = sessionId === '' ? await rpc('session-stats', {}) : await rpc('session-stats', { sessionId });
      if (token !== seqRef.current || !mountedRef.current) return;
      setStats(statsResult.ok ? statsResult.value : null);
      const target = statsResult.ok ? statsResult.value.sessionId : sessionId;
      // 两边都不知道会话时交给服务端按**库**选（库里有条目就读得到，与注册表无关）
      const tail = await rpc('journal-tail', target === '' ? {} : { sessionId: target, offset: 0, limit: 30 });
      if (token !== seqRef.current || !mountedRef.current) return;
      setPage(tail.ok ? tail.value : null);
      // 面板可调腿：读当前生效值（不是静态缺省）；读失败不阻断主数据链
      const s = await rpc('settings-get', {});
      if (token !== seqRef.current || !mountedRef.current) return;
      if (s.ok) {
        setSettings(s.value);
        setHalfLifeDraft(String(Math.round(s.value.fadeHalfLifeMs / 60_000)));
      }
    } catch (err) {
      if (token !== seqRef.current || !mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rpc, seatSessionId, copy]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      // 有活动在 2s、静默 5s：轮询间隔本身就是"面板不该在后台干重活"的兜底
      const busy = (stats?.injectedTurns ?? 0) + (stats?.bypassedTurns ?? 0) > 0;
      timer = setTimeout(async () => {
        await load();
        tick();
      }, busy ? 2_000 : 5_000);
    };
    tick();
    return () => {
      mountedRef.current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [load, stats?.injectedTurns, stats?.bypassedTurns]);

  const [exportNote, setExportNote] = useState<string | null>(null);

  /**
   * 导出。**显式 dryRun:false** 才落盘：部署面 `journal.dryRun` 缺省为 true，
   * 不显式传就会永远只得到"干跑"，按钮看起来像坏了。
   */
  const doExport = (format: 'md' | 'jsonl') => {
    if (rpc === undefined) return;
    setExportNote(null);
    // 会话优先取统计行，没有统计就取**条目页**的会话：真宿主实测过只取前者，
    // 于是重启后“导出失败：还没有任何会话记录可导”，而屏幕上明明列着三条。
    void rpc('journal-export', { sessionId: stats?.sessionId ?? page?.sessionId ?? '', format, dryRun: false })
      .then((result) => {
        if (!result.ok) {
          setExportNote(`${copy['panel.exportFailed']}: ${result.error.message}`);
          return;
        }
        setExportNote(
          result.value.dryRun
            ? copy['panel.exportDry']
            : `${copy['panel.exported']}: ${result.value.dirName}/${result.value.fileName} (${result.value.written})`,
        );
      })
      .catch(() => setExportNote(copy['panel.exportFailed']));
  };

  const items = page?.rows ?? [];
  /**
   * 人工反馈（刀1 反馈腿）：只重排进卡优先序，不改条目本体、不回灌派生分。
   * 两键形态：「这条重要」= 打分；已打过的行给「撤销」=-1（显式动作，不是默认值）。
   */
  const doMark = (entryId: string, score: number) => {
    if (rpc === undefined) return;
    setExportNote(null);
    void rpc('experience-feedback', { entryId, score })
      .then((result) => {
        setExportNote(result.ok ? (score > 0 ? copy['panel.marked'] : copy['panel.unmarked']) : `${copy['panel.markFailed']}: ${result.error.message}`);
        void load();
      })
      .catch(() => setExportNote(copy['panel.markFailed']));
  };
  const fade = stats?.fade;
  /**
   * 写 volatile 三键中的两个（开关 + 半衰期）：反馈闸不常改，只随 fadeEnabled 一起开关。
   * 保存后重拉一次 settings-get 回显真值（update 可能被宿主拒 → 面板不能自报已生效）。
   */
  const saveSettings = (patch: { fadeEnabled?: boolean; fadeHalfLifeMs?: number }) => {
    if (rpc === undefined) return;
    setExportNote(null);
    void rpc('settings-set', patch)
      .then((result) => {
        if (!result.ok) {
          setExportNote(`${copy['panel.settingsFailed']}: ${result.error.message}`);
          return;
        }
        setSettings(result.value);
        setExportNote(result.value.hotUpdatable ? copy['panel.settingsSaved'] : copy['panel.settingsCold']);
      })
      .catch(() => setExportNote(copy['panel.settingsFailed']));
  };
  return createElement(
    'section',
    { style: { padding: '12px 16px' } },
    createElement('h3', { style: hStyle }, copy['panel.title']),
    createElement('p', { style: mutedStyle }, `${copy['panel.hint']} · ${copy['panel.notFact']}`),
    error !== null ? createElement('p', { style: { color: 'var(--dsw-danger-color, inherit)' } }, `${copy['panel.loadFailed']}: ${error}`) : null,
    stats === null
      ? createElement('p', { style: mutedStyle }, copy['panel.noData'])
      : createElement(
        'div',
        null,
        createElement(
          'p',
          null,
          `${copy['panel.mood']}：${stats.moodLabel || '—'}`,
          createElement('span', { style: mutedStyle }, ` · ${copy['panel.entries']} ${stats.entryCount} · ${copy['panel.injected']} ${stats.injectedTurns} · ${copy['panel.bypassed']} ${stats.bypassedTurns}`),
        ),
        stats.degraded ? createElement('p', { style: mutedStyle }, copy['panel.degraded']) : null,
        // 注入数与确认数分开显示：两者不相等就说明卡没真落进上下文，看着“生效”其实没生效
        createElement(
          'p',
          { style: mutedStyle },
          `${copy['panel.injected']} ${stats.injectedTurns} → ${stats.confirmedTurns} · ${stats.lastRecallHits} · ${copy['panel.confirmedHint']}`,
        ),
        createElement('p', { style: mutedStyle }, `${copy['panel.drsc']}：${copy[DRSC_VERDICT_KEYS[stats.drscVerdict]]}`),
        // 淡出指标行（调参 SOP 的读数腿）：只在淡出真跑过时出现，关闸时不占行不编零
        fade !== undefined && fade.pool > 0
          ? createElement('p', { style: mutedStyle }, `${copy['panel.fade']}：${fade.full}/${fade.gist}/${fade.held}${fade.marked > 0 ? ` · ★${fade.marked}` : ''} · ${copy['panel.churn']} ${fade.churn}`)
          : null,
        // 面板可调腿（六腿的写腿）：仅当 volatile 通道可读时出现
        settings === null
          ? null
          : createElement(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 6 } },
            createElement('span', { style: mutedStyle }, copy['panel.fadeSettings']),
            createElement(
              'label',
              { style: { display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12 } },
              createElement('input', { type: 'checkbox', checked: settings.fadeEnabled, onChange: (e: { target: { checked: boolean } }) => saveSettings({ fadeEnabled: e.target.checked }) }),
              copy['panel.fadeOn'],
            ),
            createElement('span', { style: mutedStyle }, copy['panel.fadeHalfLife']),
            createElement('input', {
              type: 'number', min: 0, value: halfLifeDraft, style: { width: 72 },
              onChange: (e: { target: { value: string } }) => setHalfLifeDraft(e.target.value),
              onBlur: () => {
                const minutes = Number.parseFloat(halfLifeDraft);
                if (Number.isFinite(minutes) && Math.round(minutes * 60_000) !== settings.fadeHalfLifeMs) saveSettings({ fadeHalfLifeMs: Math.max(0, Math.round(minutes * 60_000)) });
              },
            }),
            settings.hotUpdatable
              ? null
              : createElement('span', { style: mutedStyle }, copy['panel.settingsCold']),
          ),
      ),
    items.length === 0
      ? null
      : createElement(
        'div',
        null,
        createElement('h4', { style: { ...hStyle, marginTop: 12 } }, copy['panel.recent']),
        createElement(
          'ul',
          { style: listStyle },
            items.map((item) =>
              createElement(
                'li',
                { key: item.id, style: itemStyle },
                createElement('div', null, item.text),
                createElement(
                  'div',
                  { style: mutedStyle },
                  `${copy['panel.turn']} ${item.turnSeq} · ${copy['panel.lane']} ${item.lane === 'drsc' ? copy['panel.laneDrsc'] : copy['panel.laneLive']}`,
                ),
                // 反馈只影响“先进哪条”；已打分的行给撤销入口（显式）
                createElement(
                  'div',
                  { style: { display: 'flex', gap: 8, marginTop: 4 } },
                  typeof item.feedbackScore === 'number' && item.feedbackScore > 0
                    ? createElement('button', { type: 'button', style: mutedStyle, onClick: () => doMark(item.id, -1) }, copy['panel.unmark'])
                    : createElement('button', { type: 'button', style: mutedStyle, onClick: () => doMark(item.id, 5) }, copy['panel.markImportant']),
                ),
              ),
            ),
          ),
        ),
    createElement(
      'div',
      { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
      createElement('button', { type: 'button', style: mutedStyle, onClick: () => void load() }, copy['panel.retry']),
      createElement('button', { type: 'button', style: mutedStyle, onClick: () => doExport('md') }, copy['panel.exportMd']),
      createElement('button', { type: 'button', style: mutedStyle, onClick: () => doExport('jsonl') }, copy['panel.exportJsonl']),
      exportNote !== null ? createElement('span', { style: mutedStyle }, exportNote) : null,
    ),
  );
}
