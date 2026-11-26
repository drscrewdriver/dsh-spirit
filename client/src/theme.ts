/**
 * 设置面板主题令牌 + 组件样式表（仿 dsh-prime-memory/client/src/theme.ts）。
 *
 * inline style 表达不了 @keyframes/伪类/媒体查询，所以惰性注入一份一次性样式表
 * （固定 id 防重复注入；皮肤切换只换 html 属性不重写表）。
 *
 * - 令牌前缀 `--dsh-spirit-*`；中性色引用真实 dsw 令牌（缺失用自带 fallback 兜底），
 *   强调色取 DeepSeek 品牌蓝。浅/暗两套，auto 跟宿主 `body[data-ds-dark-theme]`。
 * - 只作用于设置面板与其内嵌 LlmNotice；pill / 记忆星海不受影响（各有自己的主题）。
 */
import { effectiveSkin, getSkin, type Skin } from './skin.js';

export const THEME_STYLE_ID = 'dsh-spirit-theme-style';

// ── 令牌（浅色）：中性色选真实存在的 dsw 令牌，缺则用 fallback ──
const LIGHT_TOK: string[] = [
  '  --dsh-spirit-accent: #4d6bfe;',
  '  --dsh-spirit-accent-text: #3d5be0;',
  '  --dsh-spirit-accent-weak: rgba(77,107,254,0.10);',
  '  --dsh-spirit-bg-card: var(--dsw-alias-bg-layer-2, #ffffff);',
  '  --dsh-spirit-bg-inset: var(--dsw-alias-bg-overlay, #e9ecf2);',
  '  --dsh-spirit-bg-hover: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,0.06));',
  '  --dsh-spirit-border: var(--dsw-alias-border-l2, rgba(0,0,0,0.10));',
  '  --dsh-spirit-border-strong: var(--dsw-alias-border-l3, rgba(0,0,0,0.12));',
  '  --dsh-spirit-text-1: var(--dsw-alias-label-primary, #0f1115);',
  '  --dsh-spirit-text-2: var(--dsw-alias-label-secondary, #61666b);',
  '  --dsh-spirit-text-3: var(--dsw-alias-label-tertiary, #6e7781);',
  '  --dsh-spirit-danger: var(--dsw-alias-state-error-primary, #d0403f);',
  '  --dsh-spirit-warn: #a86412;',
  '  --dsh-spirit-warn-bg: rgba(208,138,46,.08);',
  '  --dsh-spirit-warn-border: rgba(210,160,30,.45);',
  '  --dsh-spirit-shadow: var(--dsw-shadow-lv1, 0 2px 4px 0 rgba(0,0,0,0.05));',
];

// ── 令牌（暗色）──
const DARK_TOK: string[] = [
  '  --dsh-spirit-accent: #6e85ff;',
  '  --dsh-spirit-accent-text: #7b90ff;',
  '  --dsh-spirit-accent-weak: rgba(110,133,255,0.14);',
  '  --dsh-spirit-bg-card: var(--dsw-alias-bg-layer-2, #2c2c2e);',
  '  --dsh-spirit-bg-inset: var(--dsw-alias-bg-layer-1, #232324);',
  '  --dsh-spirit-bg-hover: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08));',
  '  --dsh-spirit-border: var(--dsw-alias-border-l2, rgba(255,255,255,0.12));',
  '  --dsh-spirit-border-strong: var(--dsw-alias-border-l3, rgba(255,255,255,0.16));',
  '  --dsh-spirit-text-1: var(--dsw-alias-label-primary, #f9fafb);',
  '  --dsh-spirit-text-2: var(--dsw-alias-label-secondary, #cfd3d6);',
  '  --dsh-spirit-text-3: var(--dsw-alias-label-tertiary, #8892a6);',
  '  --dsh-spirit-danger: var(--dsw-alias-state-error-primary, #f4707b);',
  '  --dsh-spirit-warn: #e3b341;',
  '  --dsh-spirit-warn-bg: rgba(227,179,65,.10);',
  '  --dsh-spirit-warn-border: rgba(227,179,65,.40);',
  '  --dsh-spirit-shadow: var(--dsw-shadow-lv1, 0 2px 4px 0 rgba(0,0,0,0.3));',
];

/** 组件样式表：只引用 var()，与皮肤无关；圆角 8 / 卡片 10 / 胶囊 999。 */
export const COMPONENT_CSS: string[] = [
  '.dsh-spirit-root { color: var(--dsh-spirit-text-1); font-size: 13px; }',
  '.dsh-spirit-root, .dsh-spirit-root * { transition: background-color .18s ease, border-color .18s ease, color .18s ease; }',
  '.dsh-spirit-h { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: var(--dsh-spirit-text-1); }',
  '.dsh-spirit-h4 { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsh-spirit-text-1); }',
  '.dsh-spirit-muted { opacity: .72; font-size: 12px; color: var(--dsh-spirit-text-2); }',
  '.dsh-spirit-block { display: grid; gap: 4px; margin-top: 10px; }',
  '.dsh-spirit-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 6px; }',
  '.dsh-spirit-label { display: inline-flex; gap: 5px; align-items: center; font-size: 12px; color: var(--dsh-spirit-text-1); cursor: pointer; }',
  '.dsh-spirit-hint-box {',
  '  margin: 6px 0; padding: 8px 10px; border-radius: 10px; display: grid; gap: 6px;',
  '  border: 1px solid var(--dsh-spirit-warn-border); background: var(--dsh-spirit-warn-bg);',
  '}',
  '.dsh-spirit-input, .dsh-spirit-select {',
  '  padding: 3px 8px; font-size: 12px; border-radius: 8px; color: var(--dsh-spirit-text-1);',
  '  border: 1px solid var(--dsh-spirit-border); background: var(--dsh-spirit-bg-card);',
  '  transition: border-color .15s ease, box-shadow .15s ease;',
  '}',
  '.dsh-spirit-input:focus-visible, .dsh-spirit-select:focus-visible { outline: 2px solid var(--dsh-spirit-accent); outline-offset: 1px; }',
  '.dsh-spirit-btn, .dsh-spirit-link {',
  '  font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 8px; cursor: pointer;',
  '  border: 1px solid var(--dsh-spirit-border); background: var(--dsh-spirit-bg-card); color: var(--dsh-spirit-text-1);',
  '  transition: background-color .15s ease, border-color .15s ease;',
  '}',
  '.dsh-spirit-btn:hover:not(:disabled) { background: var(--dsh-spirit-bg-hover); border-color: var(--dsh-spirit-border-strong); }',
  '.dsh-spirit-btn:focus-visible, .dsh-spirit-link:focus-visible { outline: 2px solid var(--dsh-spirit-accent); outline-offset: 1px; }',
  '.dsh-spirit-link { border: none; background: none; padding: 0; color: var(--dsh-spirit-accent-text); text-decoration: underline; }',
  '.dsh-spirit-skin-picker { display: inline-flex; gap: 4px; align-items: center; margin-left: auto; }',
  '.dsh-spirit-skin-opt { font-size: 11px; padding: 2px 8px; border-radius: 999px; cursor: pointer;',
  '  border: 1px solid var(--dsh-spirit-border); background: transparent; color: var(--dsh-spirit-text-2); }',
  '.dsh-spirit-skin-opt-on { border-color: var(--dsh-spirit-accent); background: var(--dsh-spirit-accent-weak); color: var(--dsh-spirit-accent-text); }',
  '.dsh-spirit-error { color: var(--dsh-spirit-danger); font-size: 12px; }',
  // ── LlmNotice（费用提示 / 本地端点建议）──
  '.dsh-spirit-notice {',
  '  margin: 0 0 12px; padding: 10px 12px; border-radius: 10px; display: grid; gap: 6px;',
  '  border: 1px solid var(--dsh-spirit-border); border-left: 4px solid var(--dsh-spirit-warn);',
  '  background: var(--dsh-spirit-warn-bg); color: var(--dsh-spirit-text-1);',
  '}',
  '.dsh-spirit-notice-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
  '.dsh-spirit-notice-title { margin: 0; font-size: 13.5px; font-weight: 650; color: var(--dsh-spirit-text-1); }',
  '.dsh-spirit-notice-note { margin: 0; font-size: 12px; opacity: .82; line-height: 1.55; color: var(--dsh-spirit-text-2); }',
  '.dsh-spirit-notice-warn { margin: 0; font-size: 12px; line-height: 1.55; color: var(--dsh-spirit-warn); }',
  '.dsh-spirit-notice-ack { appearance: none; font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 999px;',
  '  border: 1px solid var(--dsh-spirit-border-strong); background: transparent; color: var(--dsh-spirit-text-1); cursor: pointer; }',
  '.dsh-spirit-notice-restore { font-size: 11px; opacity: .5; padding: 2px 0; }',
];

/** 构造完整样式表（auto 兜底走 :root 浅 / body 暗，显式皮肤后置覆写）。 */
export function buildStyleSheet(): string {
  return [
    ':root {',
    ...LIGHT_TOK,
    '}',
    'body[data-ds-dark-theme] {',
    ...DARK_TOK,
    '}',
    // 与宿主暗色块同特异度（元素+属性），后置声明胜出，能压过宿主强切明暗。
    'html[data-dsh-spirit-skin="light"] {',
    ...LIGHT_TOK,
    '}',
    'html[data-dsh-spirit-skin="dark"] {',
    ...DARK_TOK,
    '}',
    ...COMPONENT_CSS,
  ].join('\n');
}

/** 注入一次性样式表 + 按生效皮肤刷新 html 属性（可重入）。 */
export function ensureThemeStyle(skin?: Skin): void {
  const eff = effectiveSkin(skin ?? getSkin());
  if (typeof document === 'undefined') return;
  if (document.getElementById(THEME_STYLE_ID) === null) {
    const el = document.createElement('style');
    el.id = THEME_STYLE_ID;
    el.textContent = buildStyleSheet();
    document.head.appendChild(el);
  }
  document.documentElement.setAttribute('data-dsh-spirit-skin', eff);
}
