/**
 * 星海渲染层的共享类型（client 半）。
 *
 * 分工：
 * - `host` 给**语义**（`axis` 归属、`freshness` 老化、`salience` 轻重）；
 * - 本目录给**几何与外观**（球面位置、投影、主题）。
 *
 * 因此 `SeaRenderer` 只吃 `SeaFrame`，不知道 RPC 存在；`sea-panel` 只负责取数，
 * 不知道投影公式。这样换后端（2D ⇄ WebGL2）不改数据层，换主题不改布局。
 */
import type { SpiritSeaEdge, SpiritSeaPoint } from '../../../src/contract.js';

/** 焦距常数：越大越"平"（正交感），越小越鱼眼。 */
export const FOCAL = 1_100;

/** 相机默认姿态（与 3d-memory-sea 的取值同源，观感已验证）。 */
export const CAM_DEFAULT = { yaw: 0.45, pitch: -0.3, dist: 1_200, panX: 0, panY: 0 } as const;

/** 缩放边界：太近会穿模，太远全挤在中间。 */
export const DIST_MIN = 380;
export const DIST_MAX = 3_200;

export interface SeaCam {
  yaw: number;
  pitch: number;
  dist: number;
  panX: number;
  panY: number;
}

/**
 * 轨道参数（只在“星盘”组织方式下有）：给了它，点位就不再是静态坐标，
 * 而是每帧由 `phase0 + spiral*r + t*omega` 算出的旋转位置。
 *
 * 差速旋转（`omega` 随半径变小）与相位滞后（`spiral`）是“旋臂”的成因：
 * 刚体旋转只会让整张图原地打转，看不出结构。
 */
export interface SeaOrbit {
  /** 轨道半径（世界单位）：越淡越远。 */
  r: number;
  /** 起始相位（弧度，由会话 + id 哈希定）。 */
  phase0: number;
  /** 角速度（弧度/秒），已按差速指数算好。 */
  omega: number;
  /** 每单位半径的相位滞后（旋臂松紧）。 */
  spiral: number;
  /** 盘面高度（含归属轴与盘厚）：不再叠加漂浮量，否则旋臂会被抹糊。 */
  y: number;
}

/** 布局输出：点位（未投影）。 */
export interface SeaPointView {
  point: SpiritSeaPoint;
  x: number;
  y: number;
  z: number;
  /** 基础半径（世界单位；绘制时再乘透视系数）。 */
  radius: number;
  /** 漂浮相位（每点固定，来自 id 哈希）。 */
  phase: number;
  /** 有它就走轨道运动（每帧重算世界坐标）。 */
  orbit?: SeaOrbit;
}

/**
 * 两极锚点（不是数据点）：她 +Y、主人 −Y。
 *
 * 它们必须**真的画出来**：只把点沿 axis 偏开而不画中心，得到的是一团带子，
 * 而不是“两个中心之间来往”的形状（真浏览器第一版就坑在这）。label 由调用方给（文案属于视图层）。
 */
export interface SeaPole {
  id: 'self' | 'owner';
  x: number;
  y: number;
  z: number;
  phase: number;
  label: string;
}

/** 投影输出：屏幕坐标 + 透视系数。 */
export interface SeaProjected {
  view: SeaPointView;
  x: number;
  y: number;
  /** 透视系数（远小近大），同时用作亮度与标签筛选依据。 */
  f: number;
  /** 相机空间深度（越大越远）。 */
  depth: number;
}

/** 一帧的全部输入（渲染器不知道数据从哪来）。 */
export interface SeaFrame {
  points: readonly SeaPointView[];
  edges: readonly SpiritSeaEdge[];
  /** 两极锚点（可选：没给就不画中心，退成普通散点图）。 */
  poles?: readonly SeaPole[];
  /** 本轮进卡 / 被高亮的点 id。 */
  focus: ReadonlySet<string>;
  /** 「只看焦点」模式：非焦点压暗到几乎不可见（对应 3d-memory-sea 的 high-light focus）。 */
  focusOnly: boolean;
  /** 标签总开关（关掉后整张图只剩形状，适合录屏/截图）。 */
  showLabels: boolean;
  /** 边总开关：点密时线网会盖过星海本身，所以“只看星”必须是可及的。 */
  showEdges: boolean;
  /**
   * 鼠标位置（屏幕坐标）：proximity 激活场的中心。
   *
   * 姊妹包 prime-memory 的图是“鼠标靠近一片节点就点亮脉冲”，而我们原本只有
   * 16px 单点拾取——星与星之间的空档里鼠标什么都激活不了。这个字段把
   * “靠近”变成一等公民：半径内的星拿脉冲辉光（见 `proxBoost`）。
   */
  cursor?: { x: number; y: number } | null;
  hovered: string | null;
  selected: string | null;
  /** 动画时钟（ms）；用外部时钟便于测试与暂停。 */
  now: number;
}

/** 主题：只管观感，**不含任何类型色相**（否则换皮后类型不可辨）。 */
export interface SeaTheme {
  id: string;
  /** 背景色（CSS 颜色串）。 */
  bg: string;
  /** 辉光强度倍率（0..2）。 */
  glow: number;
  /** 光晕半径倍率（0..3）。 */
  halo: number;
  /** 连线透明度倍率（0..2）。 */
  linkAlpha: number;
  /** 标签基础透明度（0..1）。 */
  labelAlpha: number;
  /** 暗角强度（0..1）。 */
  vignette: number;
  /** 背景星尘数量。 */
  dust: number;
}

/** 渲染后端接口：2D 与 WebGL2 各实现一份，其余代码只认这个。 */
export interface SeaRenderer {
  readonly kind: 'canvas2d' | 'webgl2';
  /**
   * @param overlay 可选的 2D 叠加层：**中文标签不能画在 WebGL 里**（要自备字形图集），
   *                所以 GL 后端拿它画标签/气泡/强调环；2D 后端忽略它。
   */
  init(canvas: HTMLCanvasElement, theme: SeaTheme, overlay?: HTMLCanvasElement): void;
  setTheme(theme: SeaTheme): void;
  resize(width: number, height: number, dpr: number): void;
  draw(frame: SeaFrame, cam: SeaCam): void;
  /** 用上一帧的投影结果做拾取（可选：没实现就由调用方自己投影）。 */
  pick?(x: number, y: number): string | null;
  dispose(): void;
}
