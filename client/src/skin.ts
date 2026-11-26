/**
 * 设置面板皮肤（纯表现层，仿 dsh-prime-memory/client/src/skin.ts）。
 *
 * - 偏好存 localStorage 键 `dsh-spirit-skin`，**不进 config / volatile 键集**
 *   （避免 config 缺键丢用户值的红线）。
 * - `auto` = 跟随宿主 `body[data-ds-dark-theme]` + 系统 `prefers-color-scheme`。
 * - `light`/`dark` = 在 `html[data-dsh-spirit-skin]` 上强制令牌覆写（theme.ts 声明），
 *   与宿主暗色块同特异度但后置声明胜出。
 */
export type Skin = 'light' | 'dark' | 'auto';

const SKIN_KEY = 'dsh-spirit-skin';

function lsGet(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(SKIN_KEY) : null;
  } catch {
    return null;
  }
}

function lsSet(v: Skin): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SKIN_KEY, v);
  } catch {
    /* 隐私模式等：本次会话内仍生效，不持久化 */
  }
}

function hostDark(): boolean {
  return typeof document !== 'undefined' && document.body.hasAttribute('data-ds-dark-theme');
}

function sysDark(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** 生效外观：light|dark 显式；auto 取宿主暗色属性，否则取系统偏好。 */
export function effectiveSkin(skin: Skin): 'light' | 'dark' {
  if (skin === 'light') return 'light';
  if (skin === 'dark') return 'dark';
  return hostDark() || sysDark() ? 'dark' : 'light';
}

/** 读取持久化皮肤偏好（缺省 auto）。 */
export function getSkin(): Skin {
  const v = lsGet();
  return v === 'light' || v === 'dark' ? v : 'auto';
}

/** 写皮肤偏好。 */
export function setSkin(skin: Skin): void {
  lsSet(skin);
}
