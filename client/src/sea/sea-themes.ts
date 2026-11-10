/**
 * 星海主题与类型色。
 *
 * **两条硬规则**：
 * 1. 主题只改背景/辉光/暗角，**永远不改类型色相**——换皮之后如果分不出
 *    "工具挂了"和"想起主人"，这张图就没有信息量了；
 * 2. 主题是纯视觉偏好，存 `localStorage`，**不进 `volatile` 契约**：
 *    live 节是六腿契约（schema/settings/ranges/runner/stats/client），
 *    为一个皮肤加键的成本远超收益。
 */
import type { SpiritSeaEdge } from '../../../src/contract.js';
import type { TriggerKind } from '../../../src/types.js';
import type { SeaTheme } from './types.js';

/** localStorage 键（带插件前缀，避免和宿主/姊妹包撞）。 */
export const THEME_STORAGE_KEY = 'dsh-spirit.sea.theme';
/** 辉光倍率的持久化键（纯视觉偏好，不进 volatile 契约）。 */
export const GLOW_STORAGE_KEY = 'dsh-spirit.sea.glow';

/** 辉光倍率边界：0.5 是“还能看见星”，2.5 是“开始糊成一片”之前的上限。 */
export const GLOW_MIN = 0.5;
export const GLOW_MAX = 2.5;
export const GLOW_DEFAULT = 1;

/** 类型色（RGB）：顺序无关，键必须覆盖全部 trigger。 */
export const TRIGGER_RGB: Record<TriggerKind, readonly [number, number, number]> = {
  user_interruption: [255, 205, 140],
  long_gap: [140, 165, 255],
  tool_failure: [255, 130, 130],
  recovery: [130, 230, 200],
  task_close: [190, 165, 255],
  neutral: [150, 190, 255],
};

/** 本体交付点专用色（v0.6）：青绿，和情绪轨六档 trigger 色都拉开。 */
export const DELIVERY_RGB: readonly [number, number, number] = [126, 224, 196];
/** 点色单源：delivery 走专用色，其余按 trigger 词表（两渲染器共用，不分叉）。 */
export function pointRgb(point: { kind?: string; trigger: TriggerKind }): readonly [number, number, number] {
  return point.kind === 'delivery' ? DELIVERY_RGB : TRIGGER_RGB[point.trigger] ?? TRIGGER_RGB.neutral;
}

/** 三套预设：只差"光"的脾气，不差信息。 */
export const SEA_THEMES: Record<string, SeaTheme> = {
  starfield: {
    id: 'starfield',
    bg: '#05060b',
    glow: 1,
    halo: 1,
    linkAlpha: 1,
    labelAlpha: 0.42,
    vignette: 0.45,
    dust: 140,
  },
  aurora: {
    id: 'aurora',
    bg: '#04100e',
    glow: 1.35,
    halo: 1.25,
    linkAlpha: 0.9,
    labelAlpha: 0.5,
    vignette: 0.3,
    dust: 180,
  },
  ink: {
    id: 'ink',
    bg: '#0a0a0c',
    glow: 0.55,
    halo: 0.7,
    linkAlpha: 0.6,
    labelAlpha: 0.55,
    vignette: 0.6,
    dust: 60,
  },
};

export const THEME_IDS: readonly string[] = Object.keys(SEA_THEMES);

/**
 * 边的类型色（0..255）：与 trigger 色同属“信息”，**不进主题表**。
 *
 * 单源在这里而不是各后端各写一份：2D 用 CSS 串、GL 用归一化向量，
 * 两处拄同一张表才不会“2D 里紫色、GL 里青色”。
 */
export const EDGE_RGB: Record<SpiritSeaEdge['kind'], readonly [number, number, number]> = {
  cue: [120, 170, 255],
  time: [180, 200, 230],
  supersede: [190, 165, 255],
  // 因果边（v0.3.5）：暖橙实粗线——图上最该被看见的关系
  causal: [255, 170, 110],
};

/** 边的线型：取代链点线；drsc 路的边统一走 `LANE_DASH`。 */
export const EDGE_DASH: Record<SpiritSeaEdge['kind'], readonly number[]> = {
  cue: [],
  time: [],
  supersede: [2, 3],
  // 因果边实线（不是虚线：它是主张不是线索）；粗细靠 alpha 表 confidence
  causal: [],
};

/** 历史补录（drsc 路）的边一律虚线：实时记得的与从历史补的要能分开看。 */
export const LANE_DASH: readonly number[] = [4, 4];

export const DEFAULT_THEME_ID = 'starfield';

/** 最小存储面（参数化便于单测，不依赖 DOM）。 */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 取主题：未知 id 一律退回默认（不抛、不白屏）。 */
export function themeById(id: string | null | undefined): SeaTheme {
  if (typeof id === 'string' && SEA_THEMES[id] !== undefined) return SEA_THEMES[id]!;
  return SEA_THEMES[DEFAULT_THEME_ID]!;
}

/** 读持久化主题 id；坏值/无存储都退回默认。 */
export function loadThemeId(storage: ThemeStorage | undefined): string {
  if (storage === undefined) return DEFAULT_THEME_ID;
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return raw !== null && SEA_THEMES[raw] !== undefined ? raw : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/** 写持久化主题 id；写失败不影响当前会话（只是下次打开回到默认）。 */
export function saveThemeId(storage: ThemeStorage | undefined, id: string): void {
  if (storage === undefined) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, themeById(id).id);
  } catch {
    /* 隐私模式/配额满：忽略，不影响渲染 */
  }
}

/** 读辉光倍率：坏值/越界一律回默认（不能因为一个脏数字把整张图洗白）。 */
export function loadGlowFactor(storage: ThemeStorage | undefined): number {
  if (storage === undefined) return GLOW_DEFAULT;
  try {
    const raw = storage.getItem(GLOW_STORAGE_KEY);
    if (raw === null) return GLOW_DEFAULT;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(GLOW_MAX, Math.max(GLOW_MIN, value)) : GLOW_DEFAULT;
  } catch {
    return GLOW_DEFAULT;
  }
}

export function saveGlowFactor(storage: ThemeStorage | undefined, factor: number): void {
  if (storage === undefined) return;
  try {
    storage.setItem(GLOW_STORAGE_KEY, String(Math.min(GLOW_MAX, Math.max(GLOW_MIN, factor))));
  } catch {
    /* 忽略：写不进只是下次回到默认 */
  }
}

/** 把辉光倍率作用到主题上（只改 glow，其他字段原样）。 */
export function withGlow(theme: SeaTheme, factor: number): SeaTheme {
  const clamped = Number.isFinite(factor) ? Math.min(GLOW_MAX, Math.max(GLOW_MIN, factor)) : GLOW_DEFAULT;
  return { ...theme, glow: theme.glow * clamped };
}

/**
 * “高质量辉光”开关（强走 WebGL2）：与辉光滑杆同属纯视觉偏好，不进 volatile 契约。
 *
 * 为什么需要开关而不是只靠点数阈值：点数未到 1500 时 2D 本就够快，但用户把辉光拉到
 * 2.5 时想要的是 bloom 质感（密集区相加叠亮），那是 GL 的主场 —— 计划里“用户开高质量
 * 辉光”就是这个意思，不能只按点数自动切。
 */
export const HI_GLOW_STORAGE_KEY = 'dsh-spirit.sea.higlow';

export function loadHiGlow(storage: ThemeStorage | undefined): boolean {
  if (storage === undefined) return false;
  try {
    return storage.getItem(HI_GLOW_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveHiGlow(storage: ThemeStorage | undefined, on: boolean): void {
  if (storage === undefined) return;
  try {
    storage.setItem(HI_GLOW_STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* 忽略：写不进只是下次回到默认（2D） */
  }
}

/** 取浏览器 localStorage（不可用时返回 undefined）。 */
export function browserStorage(): ThemeStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
