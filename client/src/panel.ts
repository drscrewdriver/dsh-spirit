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

import type { SpiritJournalPage, SpiritSessionStats } from '../../src/contract.js';
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
      const statsResult = await rpc('session-stats', seatSessionId === '' ? {} : { sessionId: seatSessionId });
      if (token !== seqRef.current || !mountedRef.current) return;
      if (!statsResult.ok) {
        // 业务性"还没有数据"不是错误，如实显示空态即可
        setStats(null);
        setPage(null);
        return;
      }
      setStats(statsResult.value);
      const tail = await rpc('journal-tail', { sessionId: statsResult.value.sessionId, offset: 0, limit: 30 });
      if (token !== seqRef.current || !mountedRef.current) return;
      setPage(tail.ok ? tail.value : null);
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

  const items = page?.rows ?? [];
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
        createElement('p', { style: mutedStyle }, `${copy['panel.drsc']}：${copy[DRSC_VERDICT_KEYS[stats.drscVerdict]]}`),
      ),
    items.length === 0
      ? null
      : createElement(
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
          ),
        ),
      ),
    createElement('button', { type: 'button', style: mutedStyle, onClick: () => void load() }, copy['panel.retry']),
  );
}
