/**
 * 长觉与重建使用 LLM 能力（费用提示 + 本地端点建议）——星海「做梦」tab 与设置面的
 * **第一区块**。
 *
 * 原则（2026-11-25 用户裁定）：凡用到 LLM 的处理，费用提示与本地端点建议永远排第一；
 * 样式美化排其次。spirit 没有插件原生直连通道（蒸馏走宿主 llm），所以建议的落点是
 * "把蒸馏模型钉到宿主里注册的本地供应商小模型，或部署面 distill pin"，而不是直连 baseURL。
 *
 * 可关闭（两步）：点「我已知晓」→ 弹窗二次确认（确定/取消）→ 确定才隐藏。
 * 状态存**专门 flag**（独立键，不与引导跳过标记混用），跨两个挂载点经 window 事件同步。
 * 颜色全部走继承/中性值，浅色设置面与深色星海都成立。
 */
import { createElement, useEffect, useState, type CSSProperties } from 'react';

import type { SpiritDistillRouteView } from '../../src/contract.js';
import { copyOf, type CopyKey } from './copy.js';

const BOX: CSSProperties = {
  margin: '0 0 12px',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid rgba(127,127,127,.35)',
  borderLeft: '4px solid #d08a2e',
  background: 'rgba(208,138,46,.08)',
  display: 'grid',
  gap: 6,
  color: 'inherit',
};
const HEAD: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
const TITLE: CSSProperties = { margin: 0, fontSize: 13.5, fontWeight: 650, color: 'inherit' };
const NOTE: CSSProperties = { margin: 0, fontSize: 12, opacity: 0.78, lineHeight: 1.55 };
const WARN: CSSProperties = { margin: 0, fontSize: 12, color: '#c07a10', lineHeight: 1.55 };
const BTN: CSSProperties = {
  appearance: 'none', font: 'inherit', fontSize: 11, padding: '2px 8px', borderRadius: 999,
  border: '1px solid rgba(127,127,127,.45)', background: 'transparent', cursor: 'pointer', color: 'inherit',
};

const HIDDEN_FLAG = 'dsh.llm-notice.spirit.hidden.v1';
const SYNC_EVENT = 'dsh-llm-notice-spirit';

function readHidden(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(HIDDEN_FLAG) === '1'; } catch { return false; }
}

const SOURCE_KEYS: Record<NonNullable<SpiritDistillRouteView['effective']>['source'], CopyKey> = {
  deployPinned: 'sleep.srcPinned',
  runtimeOverride: 'sleep.srcOverride',
  hostDefault: 'sleep.srcHostDefault',
};

export function LlmNotice(props: { route: SpiritDistillRouteView | null }): ReturnType<typeof createElement> | null {
  const copy = copyOf(typeof document === 'undefined' ? undefined : document.documentElement.lang);
  const [hidden, setHidden] = useState(() => readHidden());

  // 两处挂载（做梦 tab / 设置面）共享隐藏状态
  useEffect(() => {
    const sync = (): void => setHidden(readHidden());
    try {
      window.addEventListener(SYNC_EVENT, sync);
      return () => window.removeEventListener(SYNC_EVENT, sync);
    } catch {
      return undefined;
    }
  }, []);

  if (hidden) return null;

  const effective = props.route?.effective ?? null;
  const routeLine = effective === null
    ? copy['llm.routeNone']
    : `${effective.provider}/${effective.model} · ${copy[SOURCE_KEYS[effective.source]]}`;

  const head = createElement(
    'div',
    { style: HEAD },
    createElement('h4', { style: TITLE }, copy['llm.title']),
    createElement(
      'span',
      { style: { marginLeft: 'auto', display: 'inline-flex', gap: 6 } },
      createElement('button', {
        type: 'button',
        style: BTN,
        onClick: () => {
          // 两步：先确认（弹窗），确定后才写专门 flag 隐藏
          let ok: boolean;
          try { ok = typeof window !== 'undefined' && window.confirm(copy['llm.confirmHide']); } catch { ok = false; }
          if (!ok) return;
          try {
            localStorage.setItem(HIDDEN_FLAG, '1');
            window.dispatchEvent(new Event(SYNC_EVENT));
          } catch { /* storage 禁用时仅本挂载点隐藏 */ }
          setHidden(true);
        },
      }, copy['llm.ack']),
    ),
  );

  return createElement(
    'section',
    { style: BOX, 'aria-label': copy['llm.title'] },
    head,
    createElement('p', { style: NOTE }, copy['llm.recommend']),
    createElement('p', { style: NOTE }, `${copy['llm.route']}${routeLine}`),
    effective !== null && effective.source === 'hostDefault'
      ? createElement('p', { style: WARN, role: 'note' }, copy['llm.hostWarn'])
      : null,
    createElement('p', { style: NOTE }, copy['llm.hint']),
  );
}