/**
 * 星海画布（交互 + 渲染循环）。
 *
 * 四条实现纪律：
 * 1. **渲染循环只读 ref**：props 变化不重建 rAF，否则每次取数都会闪一帧；
 * 2. **卸载即停**：cleanup 里 `cancelAnimationFrame` + 断 ResizeObserver + `renderer.dispose()`。
 *    面板切走还在跑动画是最常见的泄漏形状；
 * 3. **交互全走原生监听**：React 合成事件把 `wheel` 挂成 passive，
 *    `preventDefault()` 会被浏览器忽略（滚轮缩放当场失效），右键平移也要原生 `contextmenu`；
 * 4. **拾取用上一帧的投影结果**（`renderer.pick`），不在事件里重算投影。
 */
import { createElement, useEffect, useRef, useState, type CSSProperties } from 'react';

import type { SpiritSeaEdge, SpiritSeaPoint, } from '../../../src/contract.js';
import type { SeaPole } from './types.js';
import { chooseBackend, createSeaBackend, watchContextLost } from './sea-backend.js';
import type { SeaLayoutMode } from './sea-layout.js';
import { layoutSea, seaPoles } from './sea-layout.js';
import { visibleSubset } from './sea-projection.js';
import { CAM_DEFAULT, DIST_MAX, DIST_MIN, type SeaCam, type SeaFrame, type SeaRenderer, type SeaTheme } from './types.js';

export interface SeaViewProps {
  points: readonly SpiritSeaPoint[];
  edges: readonly SpiritSeaEdge[];
  theme: SeaTheme;
  focus: ReadonlySet<string>;
  focusOnly: boolean;
  showLabels: boolean;
  /** 边总开关（点密时线网会盖过星本身）。 */
  showEdges: boolean;
  selectedId: string | null;
  /** 每变一次把相机拉回初始姿态（顶栏「复位」按钮用）。 */
  resetToken: number;
  /** 允许自动升级到 WebGL2（默认允许）；录屏/驱动异常时可强制关掉。 */
  allowWebgl?: boolean;
  /** 用户显式开「高质量辉光」：不看点数直接走 GL。 */
  preferWebgl?: boolean;
  /** 两极的显示名（图上坐标系的名字，由调用方给文案）。 */
  poleLabels: { self: string; owner: string };
  /** 组织方式（默认 `poles`）：双极胶囊 / 星盘轨道。 */
  layoutMode?: SeaLayoutMode;
  onSelect: (point: SpiritSeaPoint | null) => void;
  style?: CSSProperties;
}

const HOST_STYLE: CSSProperties = { position: 'relative', flex: '1 1 auto', minHeight: 320, overflow: 'hidden' };
const CANVAS_STYLE: CSSProperties = { display: 'block', width: '100%', height: '100%', cursor: 'grab' };
/** 叠加层只负责标签/气泡/环，不能吃鼠标事件（否则画布交互全并失效）。 */
const OVERLAY_STYLE: CSSProperties = { position: 'absolute', inset: 0, display: 'block', pointerEvents: 'none' };

/**
 * 初始相机：星盘得从“斜上方”看，否则一个几乎侧视的盘只会被压成一条线，
 * 旋臂与“越淡越远”完全看不出来（胶囊模式没这个问题，它的信息就在上下）。
 *
 * `dist` 也比胶囊远：盘的半径接近胶囊赤道，拿胶囊的 1200 距离会把近景那半边
 * 透视放大到屏外（真浏览器实测：整个盘挤成屏幕边一团雾）。
 */
export function initialCam(mode: SeaLayoutMode): SeaCam {
  return mode === 'orbits' ? { ...CAM_DEFAULT, pitch: -0.95, dist: 2_200 } : { ...CAM_DEFAULT };
}

interface DragState {
  x: number;
  y: number;
  mode: 'orbit' | 'pan';
  yaw: number;
  pitch: number;
  panX: number;
  panY: number;
  moved: boolean;
}

export function SeaView(props: SeaViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const [backend, setBackend] = useState<'canvas2d' | 'webgl2'>('canvas2d');
  const mode = props.layoutMode ?? 'poles';
  const viewsRef = useRef(layoutSea(props.points, { mode }));
  /** 两极锚点：位置固定，label 跟随文案（所以每次 render 重建，成本为零）。 */
  const polesRef = useRef<SeaPole[]>([]);
  polesRef.current = seaPoles({ mode }).map((pole) => ({
    ...pole,
    label: pole.id === 'self' ? props.poleLabels.self : props.poleLabels.owner,
  }));
  /** 上一次布局的输入：数据引用与组织方式任一变了都要重算。 */
  const sourceRef = useRef<{ points: readonly SpiritSeaPoint[]; mode: SeaLayoutMode }>({ points: props.points, mode });
  const camRef = useRef<SeaCam>(initialCam(props.layoutMode ?? 'poles'));
  const rendererRef = useRef<SeaRenderer | null>(null);
  const hoveredRef = useRef<string | null>(null);
  /** 鼠标屏幕坐标（proximity 激活场中心）；离开画布置 null。 */
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const selectRef = useRef(props.onSelect);
  /** 每帧要读的活数据集中在一个 ref 里，避免 rAF 闭包捕获旧 props。 */
  const liveRef = useRef({
    points: props.points,
    edges: props.edges,
    theme: props.theme,
    focus: props.focus,
    focusOnly: props.focusOnly,
    showLabels: props.showLabels,
    showEdges: props.showEdges,
    selectedId: props.selectedId,
  });

  liveRef.current = {
    points: props.points,
    edges: props.edges,
    theme: props.theme,
    focus: props.focus,
    focusOnly: props.focusOnly,
    showLabels: props.showLabels,
    showEdges: props.showEdges,
    selectedId: props.selectedId,
  };
  selectRef.current = props.onSelect;
  // 点位只在数据或组织方式变化时重算（放在 render 期算一次，rAF 里不再算）；超窗时在这里降级
  if (sourceRef.current.points !== props.points || sourceRef.current.mode !== mode) {
    sourceRef.current = { points: props.points, mode };
    viewsRef.current = visibleSubset(layoutSea(props.points, { mode }));
  }

  useEffect(() => {
    rendererRef.current?.setTheme(props.theme);
  }, [props.theme]);

  useEffect(() => {
    camRef.current = initialCam(mode);
  }, [props.resetToken, mode]);

  // 升级单向（判定抽在 sea-backend，能被单测与 harness 真调）：来回切会让拖拽中的
  // 视角与 buffer 反复重建，比慢更糟；降级只由 contextlost 触发。
  useEffect(() => {
    if (backend !== 'canvas2d') return;
    if (chooseBackend({ pointCount: props.points.length, preferWebgl: props.preferWebgl, allowWebgl: props.allowWebgl }) === 'webgl2') {
      setBackend('webgl2');
    }
  }, [backend, props.allowWebgl, props.preferWebgl, props.points.length]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (host === null || canvas === null || overlay === null) return;

    // 建不起来当场降级（不抛）：上面的探测只是预判，能不能拿到上下文到这一步才算数
    const { kind, renderer } = createSeaBackend(backend, canvas, overlay, liveRef.current.theme);
    rendererRef.current = renderer;

    const fit = (): void => {
      // 首帧 clientHeight 可能为 0（挂载即测量），退回默认 300×150 就废了；
      // 兜底链写全（姊妹包踩过的坑：布局②），拿不到也用常量而不是 1
      renderer.resize(
        host.clientWidth || host.offsetWidth || 640,
        host.clientHeight || host.offsetHeight || 420,
        window.devicePixelRatio ?? 1,
      );
    };
    fit();

    /**
     * 单帧绘制（含首帧）。
     *
     * `useEffect` 里启动 rAF 必然比 paint 晚一帧 ⇒ 空画布闪一下；
     * 同步先画一帧再进循环（姊妹包踩过的坑：渲染⑤）。
     */
    const renderOnce = (now: number): void => {
      const live = liveRef.current;
      const seaFrame: SeaFrame = {
        points: viewsRef.current,
        edges: live.edges,
        poles: polesRef.current,
        focus: live.focus,
        focusOnly: live.focusOnly,
        showLabels: live.showLabels,
        showEdges: live.showEdges,
        hovered: hoveredRef.current,
        selected: live.selectedId,
        cursor: cursorRef.current,
        now,
      };
      renderer.draw(seaFrame, camRef.current);
    };
    renderOnce(performance.now());

    let frame = requestAnimationFrame(function tick(now: number): void {
      renderOnce(now);
      frame = requestAnimationFrame(tick);
    });

    const localPoint = (event: MouseEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const onPointerDown = (event: MouseEvent): void => {
      if (event.button !== 0 && event.button !== 2) return;
      event.preventDefault();
      const cam = camRef.current;
      dragRef.current = {
        x: event.clientX,
        y: event.clientY,
        mode: event.button === 2 ? 'pan' : 'orbit',
        yaw: cam.yaw,
        pitch: cam.pitch,
        panX: cam.panX,
        panY: cam.panY,
        moved: false,
      };
      canvas.style.cursor = 'grabbing';
    };

    const onPointerMove = (event: MouseEvent): void => {
      const drag = dragRef.current;
      if (drag !== null) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (Math.hypot(dx, dy) > 4) drag.moved = true;
        const cam = camRef.current;
        if (drag.mode === 'orbit') {
          cam.yaw = drag.yaw + dx * 0.006;
          cam.pitch = Math.max(-1.35, Math.min(1.35, drag.pitch - dy * 0.006));
        } else {
          const k = cam.dist / CAM_DEFAULT.dist;
          cam.panX = drag.panX - dx * k;
          cam.panY = drag.panY - dy * k;
        }
        return;
      }
      const { x, y } = localPoint(event);
      // 只在指针真在画布容器内时激活 proximity 场：mousemove 挂在 window 上，
      // 不守卫的话鼠标在顶栏操作时边缘的星也会跟着闪
      cursorRef.current = event.target instanceof Node && host.contains(event.target) ? { x, y } : null;
      const hit = renderer.pick?.(x, y) ?? null;
      hoveredRef.current = hit;
      canvas.style.cursor = hit !== null ? 'pointer' : 'grab';
    };

    const onHostLeave = (): void => {
      cursorRef.current = null;
      hoveredRef.current = null;
    };

    const onPointerUp = (): void => {
      dragRef.current = null;
      canvas.style.cursor = 'grab';
    };

    const onClick = (event: MouseEvent): void => {
      // 拖过就不算点：否则每次旋转视角都会误开详情卡
      if (dragRef.current?.moved === true) return;
      const { x, y } = localPoint(event);
      const id = renderer.pick?.(x, y) ?? null;
      const found = id === null ? null : liveRef.current.points.find((point) => point.id === id) ?? null;
      selectRef.current(found);
    };

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const cam = camRef.current;
      cam.dist = Math.max(DIST_MIN, Math.min(DIST_MAX, cam.dist * (event.deltaY > 0 ? 1.08 : 0.92)));
    };

    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
    };

    /**
     * 键盘操作（host 可聚焦，tabIndex=0）：方向键平移、Shift+方向键旋转、+/- 缩放。
     * 只吃这几个键，其余不 preventDefault——否则会把页面级快捷键（如 Esc 关详情卡）抢走。
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      const cam = camRef.current;
      const step = 40 * (cam.dist / CAM_DEFAULT.dist);
      const orbit = event.shiftKey;
      const pan = (dx: number, dy: number): void => {
        cam.panX += dx;
        cam.panY += dy;
      };
      switch (event.key) {
        case 'ArrowLeft':
          if (orbit) { cam.yaw -= 0.08; } else { pan(-step, 0); }
          break;
        case 'ArrowRight':
          if (orbit) { cam.yaw += 0.08; } else { pan(step, 0); }
          break;
        case 'ArrowUp':
          if (orbit) { cam.pitch = Math.max(-1.35, cam.pitch - 0.06); } else { pan(0, -step); }
          break;
        case 'ArrowDown':
          if (orbit) { cam.pitch = Math.min(1.35, cam.pitch + 0.06); } else { pan(0, step); }
          break;
        case '+':
        case '=':
          cam.dist = Math.max(DIST_MIN, cam.dist * 0.92);
          break;
        case '-':
        case '_':
          cam.dist = Math.min(DIST_MAX, cam.dist * 1.08);
          break;
        default:
          return; // 其它键交回页面：不拦截不吞事件
      }
      event.preventDefault();
    };

    const observer = new ResizeObserver(fit);
    observer.observe(host);
    const unwatchLost =
      kind === 'webgl2'
        ? watchContextLost(canvas, () => {
            console.warn('[dsh-spirit] WebGL 上下文丢失，已切回 Canvas 2D 渲染');
            setBackend('canvas2d');
          })
        : () => undefined;
    canvas.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    host.addEventListener('keydown', onKeyDown);
    host.addEventListener('mouseleave', onHostLeave);
    window.addEventListener('resize', fit);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      unwatchLost();
      canvas.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', onPointerUp);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      host.removeEventListener('keydown', onKeyDown);
      host.removeEventListener('mouseleave', onHostLeave);
      window.removeEventListener('resize', fit);
      renderer.dispose();
      rendererRef.current = null;
      hoveredRef.current = null;
      dragRef.current = null;
    };
  }, [backend]);

  return createElement(
    'div',
    // tabIndex 让画布容器可聚焦：没有它键盘路径整条不可达（checklist“页面可键盘操作”的后半）
    { ref: hostRef, tabIndex: 0, style: { ...HOST_STYLE, outline: 'none', ...props.style } },
    // key 带上后端：同一张 canvas 拿过 2D 就再也拿不到 GL，切换必须重建元素
    createElement('canvas', { ref: canvasRef, key: backend, style: CANVAS_STYLE }),
    createElement('canvas', { ref: overlayRef, style: OVERLAY_STYLE }),
  );
}
