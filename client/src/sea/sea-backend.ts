/**
 * 后端选择与降级（**不含 React**，所以能被单测也能被浏览器 harness 直接调）。
 *
 * 为什么单独一个文件：这段判定原本长在 `sea-view.ts` 的 effect 里，于是
 * 「什么时候走 GL / GL 建不起来怎么办」只能在宿主 GUI 里目视验证——而它恰恰是最容易
 * 静默坏掉的地方（上下文拿不到 → 白屏；来回切 → 视角与 buffer 反复重建）。抽出来后
 * 计划里的两条要求（≥1500 点或用户开高质量辉光才升级、contextlost 回退 2D）都能被真调用。
 *
 * 两条不变式：
 * 1. **升级单向**：只有 `canvas2d → webgl2`，降级只由 contextlost 触发；不因点数回落而切回，
 *    否则用户在拖拽中途会看到视角被重建；
 * 2. **拿不到 GL 不抛**：探测通过 ≠ 上下文可得（驱动/软件渲染/上下文数量上限），
 *    所以创建失败时当场退回 2D，只 warn 一次。
 */
import type { SeaRenderer, SeaTheme } from './types.js';
import { createCanvas2dRenderer } from './sea-render-2d.js';
import { isWebgl2Available, tryCreateWebgl2Renderer } from './sea-render-webgl.js';

export type SeaBackendKind = 'canvas2d' | 'webgl2';

/** 超过这个点数才值得自动升级：以下 2D 本就 60fps，多一个上下文只多一份风险。 */
export const GL_POINT_THRESHOLD = 1_500;

export interface SeaBackendChoice {
  /** 当前点数（已按窗口截断后的实际值）。 */
  pointCount: number;
  /** 用户显式开「高质量辉光」：不看点数直接升级。 */
  preferWebgl?: boolean;
  /** 允许用 GL（录屏/驱动异常时可整体关掉）。缺省允许。 */
  allowWebgl?: boolean;
  /** 环境探测结果（注入它是为了可单测；缺省调真探测）。 */
  webglAvailable?: boolean;
}

/** 该用哪个后端（纯判定，不碰 DOM）。 */
export function chooseBackend(choice: SeaBackendChoice): SeaBackendKind {
  if (choice.allowWebgl === false) return 'canvas2d';
  const wants = choice.preferWebgl === true || choice.pointCount >= GL_POINT_THRESHOLD;
  if (!wants) return 'canvas2d';
  const available = choice.webglAvailable ?? isWebgl2Available();
  return available ? 'webgl2' : 'canvas2d';
}

export interface SeaBackend {
  kind: SeaBackendKind;
  renderer: SeaRenderer;
  /**
   * GL 后端时给出上下文，否则 `undefined`。
   *
   * 为什么要递出去：`readPixels` 是验证“GL 真画了东西、且与 2D 一致”的唯一手段
   * （没开 `preserveDrawingBuffer` 时不能事后从 canvas 拿 2D 上下文），
   * 而拿不到它就只能靠目视截图。诊断与自动化验证都需要这个口。
   */
  gl?: WebGL2RenderingContext;
}

/**
 * 按选择的后端建渲染器；GL 建不起来当场降级。
 *
 * @param overlay 标签叠加层（GL 后端必需；2D 后端忽略）
 */
export function createSeaBackend(
  kind: SeaBackendKind,
  canvas: HTMLCanvasElement,
  overlay: HTMLCanvasElement | null,
  theme: SeaTheme,
): SeaBackend {
  if (kind === 'webgl2' && overlay !== null) {
    const handles = tryCreateWebgl2Renderer(canvas, overlay, theme);
    if (handles !== null) return { kind: 'webgl2', renderer: handles.renderer, gl: handles.gl };
    // 探测只是预判，能不能拿到上下文到这一步才算数：不能因为拿不到就把画面留空
    console.warn('[dsh-spirit] WebGL2 上下文不可用，退回 Canvas 2D 渲染');
  }
  const renderer = createCanvas2dRenderer();
  renderer.init(canvas, theme);
  return { kind: 'canvas2d', renderer };
}

/**
 * 监听上下文丢失，回调一次即自动摘监听。
 *
 * 为什么要返回值而不是让调用方自己 remember 监听器：effect cleanup 与"事件已触发"是两条
 * 路径，忘了摘会在下次重建时对同一个 canvas 挂两份监听。
 *
 * `preventDefault()` 是故意的：不取消则上下文永久丢失（不会再发 restored），
 * 取消后浏览器会试恢复——但我们不赌恢复：当场切回 2D，恢复与否都不影响画面。
 */
export function watchContextLost(canvas: HTMLCanvasElement, onLost: () => void): () => void {
  const handler = (event: Event): void => {
    event.preventDefault();
    canvas.removeEventListener('webglcontextlost', handler);
    onLost();
  };
  canvas.addEventListener('webglcontextlost', handler);
  return () => canvas.removeEventListener('webglcontextlost', handler);
}
