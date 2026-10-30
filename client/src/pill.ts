/**
 * 输入栏 pill：本会话的体验卡开关（开 / 只记录 / 不参与）。
 *
 * 三个不显眼但会咬人的细节：
 * 1. **请求序列号**：快速切会话时，慢响应不得覆盖新会话的档位（姊妹包为此加过 seqRef）。
 * 2. **读只读端点**：写端点"两字段都省略"的语义是清除覆盖，用它读会抹掉用户设置。
 * 3. **读失败要显示状态而不是假装"开"**：写回失败还显示原状态，用户会以为改了。
 */
import { createElement, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import type { RpcFn } from './rpc.js';
import { copyOf } from './copy.js';
import { sessionIdOf, type SeatProps } from './env.js';

type Mode = 'on' | 'bypass' | 'off';

const rowStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6 };
const pillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 10px',
  borderRadius: 999,
  fontSize: 12,
  lineHeight: '18px',
  cursor: 'pointer',
  border: '1px solid var(--dsw-border-color, rgba(128,128,128,0.35))',
  color: 'var(--dsw-text-color, inherit)',
  background: 'var(--dsw-bg-color-secondary, transparent)',
};
const menuStyle: CSSProperties = {
  display: 'inline-flex',
  flexDirection: 'column',
  gap: 2,
  padding: 6,
  marginLeft: 6,
  borderRadius: 8,
  border: '1px solid var(--dsw-border-color, rgba(128,128,128,0.35))',
  background: 'var(--dsw-bg-color-secondary, transparent)',
};
const itemStyle = (active: boolean): CSSProperties => ({
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 12,
  textAlign: 'left',
  fontWeight: active ? 700 : 400,
  color: 'var(--dsw-text-color, inherit)',
});

export function SpiritPill(props: { rpc?: RpcFn } & SeatProps) {
  const rpc = props.rpc;
  const sessionId = sessionIdOf(props);
  const copy = copyOf(typeof document === 'undefined' ? undefined : document.documentElement.lang);
  const [mode, setMode] = useState<Mode>('on');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const seqRef = useRef(0);

  const load = useCallback(() => {
    if (rpc === undefined || sessionId === '') return;
    const token = ++seqRef.current;
    rpc('session-mode-get', { sessionId })
      .then((result) => {
        if (token !== seqRef.current) return;
        setError(null);
        setMode(result.ok ? (result.value.off ? 'off' : result.value.bypass ? 'bypass' : 'on') : 'on');
      })
      .catch(() => {
        if (token !== seqRef.current) return;
        setError(copy['panel.loadFailed']);
      });
  }, [rpc, sessionId, copy]);

  useEffect(() => {
    load();
  }, [load]);

  const apply = (target: Mode) => {
    if (rpc === undefined || sessionId === '' || target === mode) {
      setOpen(false);
      return;
    }
    const token = ++seqRef.current;
    setError(null);
    const previous = mode;
    // 乐观更新 + 失败回滚：点了没反应比闪一下再回来更让人以为坏了
    setMode(target);
    setOpen(false);
    rpc('session-mode', { sessionId, off: target === 'off', bypass: target === 'bypass' })
      .then((result) => {
        if (token !== seqRef.current) return;
        if (!result.ok) {
          setMode(previous);
          setError(result.error.message);
          return;
        }
        setMode(result.value.off ? 'off' : result.value.bypass ? 'bypass' : 'on');
        if (!result.value.persisted) setError(copy['panel.degraded']);
      })
      .catch(() => {
        if (token !== seqRef.current) return;
        setMode(previous);
        setError(copy['panel.loadFailed']);
      });
  };

  const label = mode === 'off' ? copy['pill.labelOff'] : mode === 'bypass' ? copy['pill.labelBypass'] : copy['pill.labelOn'];
  return createElement(
    'span',
    { style: rowStyle },
    createElement(
      'button',
      {
        type: 'button',
        style: pillStyle,
        title: error === null ? copy['pill.title'] : `${copy['pill.title']}：${error}`,
        onClick: () => setOpen((v) => !v),
      },
      label,
    ),
    /**
     * 三态菜单而不是一个循环按钮：盲切时用户看不出下一次点过去哪里，
     * 而"只记录不注入"与"完全不参与"是两个意图完全不同的开关，不该靠循环试。
     */
    open
      ? createElement(
        'span',
        { style: menuStyle },
        ...([
          ['on', copy['pill.menuOn']],
          ['bypass', copy['pill.menuBypass']],
          ['off', copy['pill.menuOff']],
        ] as Array<[Mode, string]>).map(([value, text]) =>
          createElement(
            'button',
            { key: value, type: 'button', style: itemStyle(value === mode), onClick: () => apply(value) },
            text,
          ),
        ),
      )
      : null,
  );
}
