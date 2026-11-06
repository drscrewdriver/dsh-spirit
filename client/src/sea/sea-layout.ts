/**
 * 双极星海布局（纯函数、确定性）。
 *
 * 与 `prime-memory` 的"无固定中心"相反：本布局**强制两个中心**——
 * 她（助手主体）在 +Y 极、主人（用户主体）在 −Y 极，体验点按 `axis` 落在两极之间。
 *
 * 三条设计约束：
 * 1. **确定性**：所有随机量来自 `hash32(id + salt)`，不用 `Math.random`。
 *    同一份数据刷新后位置完全一致——否则"记忆图"每次都变形，用户无法形成记忆。
 * 2. **一个量只编码一次**：高度 = 归属轴，颜色 = 类型，亮度 = 老化，半径 = 在意度。
 *    经度**不再按 trigger 分扇区**（真浏览器实测：那会让同类点排成纬线弧带，
 *    读图者把高度误读成"类型"，而 `axisOf` 本来就按 trigger 给基值 —— 同一量画了两次）。
 *    现在经度以 id 哈希铺满整圈，只留一点同类吸引，簇的倾向靠颜色与 cue 边表达。
 * 3. **胶囊体而非球**：横向半径随 |axis| 收缩（两端收窄、中间饱满），
 *    视觉上"两极有实体、中间是来往"。
 */
import type { SpiritSeaPoint } from '../../../src/contract.js';
import type { TriggerKind } from '../../../src/types.js';
import type { SeaPole, SeaPointView } from './types.js';

/** 哈希盐：改它 = 整张图重新洗牌（版本升级时才有必要动）。 */
const SALT = 'spirit-sea-v1';

/** 世界半径（±Y 极到原点的距离基准）。 */
export const LAYOUT_RADIUS = 620;

/**
 * 组织方式（不是“主题”：主题只改辉光/背景，这里改的是“拿什么当坐标轴”）。
 *
 * - `poles`：双极胶囊。高度 = 归属轴，适合看“这件事离她近还是离主人近”。
 * - `orbits`：星盘。中心 = 她，半径 = 多淡（老化 + 轻重），同会话共扇区，
 *   差速旋转 + 相位滞后自然拧成旋臂；适合看“哪些快被忘掉了”。
 *   参考实现：`3425043187-lang/star-brain`（轨道不是自由物理，而是确定性半径+相位+角速度）。
 */
export type SeaLayoutMode = 'poles' | 'orbits';

/** 组织方式的 localStorage 键（纯视觉偏好，不进 volatile 契约）。 */
export const LAYOUT_STORAGE_KEY = 'dsh-spirit.sea.layout';

interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 读组织方式；只认字面量 `orbits`，其余（含脏值）一律回默认 `poles`。 */
export function loadLayoutMode(storage: FlagStorage | undefined): SeaLayoutMode {
  if (storage === undefined) return 'poles';
  try {
    return storage.getItem(LAYOUT_STORAGE_KEY) === 'orbits' ? 'orbits' : 'poles';
  } catch {
    return 'poles';
  }
}

export function saveLayoutMode(storage: FlagStorage | undefined, mode: SeaLayoutMode): void {
  if (storage === undefined) return;
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, mode);
  } catch {
    /* 忽略：写不进只是下次回到默认 */
  }
}

/**
 * 归属轴增益：真实 `axis` 只落在 ±0.8 以内（trigger 基值最大 0.6 + userChars 0.2），
 * 不放大就看不不出“两极”，只会得到一条挤在中间的带。
 */
export const AXIS_GAIN = 1.6;

/**
 * 6 个事件族的基准经度（弧度）：**只作弱吸引**（见 `ANGLE_TYPE_PULL`），不再分扇区。
 * 保留它是为了让同类在整圈上有一点点邻居倾向，读图时不至于完全找不到同色群。
 */
const TRIGGER_ANGLE: Record<TriggerKind, number> = {
  user_interruption: 0,
  long_gap: Math.PI / 3,
  task_close: (Math.PI * 2) / 3,
  recovery: Math.PI,
  tool_failure: (Math.PI * 4) / 3,
  neutral: (Math.PI * 5) / 3,
};

/**
 * 类型对经度的吸引幅度（弧度，作用于 `sin` 的振幅）：0 = 纯按 id 铺满整圈。
 *
 * 用正弦而不是线性插值是有原因的：线性拉（`full + k*(base-full)`）是个压缩映射，
 * 会在基准角对面留出一段**没有任何点**的空弧（单类型实测桶分布 9/26/54/43/39/69）；
 * 而 `full - k*sin(full-base)` 的导数始终在 `1±k` 之间（k<1），是整圆到整圆的同胚：
 * 同类在基准角周围密一点，但永远不会出现空洞。
 */
export const ANGLE_TYPE_PULL = 0.25;

/** FNV-1a 32 位。 */
export function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 稳定伪随机：同串永远同一个值，返回 [0,1)。 */
export function randOf(input: string): number {
  return hash32(input) / 4_294_967_296;
}

export interface SeaLayoutCfg {
  /** 极半径（默认 `LAYOUT_RADIUS`）。 */
  radius?: number;
  /** 组织方式（默认 `poles`）。 */
  mode?: SeaLayoutMode;
}

/* ── 星盘（orbits）参数：权重沿用 star-brain，尺度按本图世界单位重标 ── */

/** 最内圈半径（记得最清楚的也在这）：不给 0，否则会与“她”的光团重叠。 */
export const ORBIT_MIN = 150;
/**
 * 半径可选跨度：`r = ORBIT_MIN + faint^1.45 * ORBIT_SPAN`。
 *
 * 上限故意压在 670（相等于胶囊模式的赤道半径）：真浏览器实测过拿 star-brain 的
 * 1500 跨度，在 `dist 1650` 的相机下半个盘都落在近景，透视把外圈炸到屏外、
 * 剩下的挤成屏幕边上一团雾。星图要能读，尺度得跟相机一起定。
 */
export const ORBIT_SPAN = 520;
/** “多淡”的合成权重：老化占 0.78、不在意度占 0.42（两者相加可 >1，最后钳到 1）。 */
export const FAINT_AGING_WEIGHT = 0.78;
export const FAINT_SALIENCE_WEIGHT = 0.42;
/** 参考半径：在这里转速 == `OMEGA_BASE`。 */
export const DISK_RREF = 260;
/** 差速指数：越大内外圈差得越狠（星系的开普勒旋转近似）。 */
export const DISK_POW = 0.45;
/** 基础角速度（弧度/秒）。 */
export const OMEGA_BASE = 0.035;
/** 每单位半径的相位滞后（旋臂松紧）。 */
export const SPIRAL_K = 0.0012;
/** 窗口内时间轴绕几圈：1 圈看不出臂，太多则相邻时刻挤在一起。 */
export const SPIRAL_TURNS = 2.6;
/** 同一时刻附近的角度抖动（弧度）：不抖动会排成一根射线。 */
export const SPIRAL_JITTER = 0.12;
/** 盘面厚度（固定微偏移，让盘不是一张纸片）。 */
export const DISK_THICK = 22;
/** 归属轴在盘面上的高度增益（星盘里 `axis` 仍可读，只是不再是主轴线）。 */
export const AXIS_LIFT = 110;

function clampUnit(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * “多淡”：老化占主、不在意度占辅。
 *
 * 单看强度不够——“强度还行但已经过了半年”也该往外圈走（与 star-brain 同一推法）。
 * 两者相加可以 > 1，所以最后钳到 1：外圈是“快被忘了”，不是“已删除”。
 */
export function faintOf(point: SpiritSeaPoint): number {
  const aging = (1 - clamp01(point.freshness)) * FAINT_AGING_WEIGHT;
  const soft = (1 - Math.min(2, Math.max(0, point.salience)) / 2) * FAINT_SALIENCE_WEIGHT;
  return clamp01(aging + soft);
}

/**
 * 星盘布局：中心 = 她，**相位 = 时间次序**，半径 = 多淡，差速旋转拧成旋臂。
 *
 * 为什么不用“会话分扇区”（真浏览器实测出的错）：spirit 库里会话大小极不均，
 * 一个主会话可以占 97% 的条目，按会话分扇区会把几千颗挤进一个 1.8 弧的楔形里
 * （截图上就是屏幕边一团雾 + 一张跨全图的线网）。而输入已按 `ts_ms` 升序，
 * 用数组下标定相位刚好让“旋臂 = 时间轴”：时间边变短，cue 边才是图上真正有信息量的长线。
 * 会话归属不在图上编码（一个量只编码一次），要看它在详情卡里。
 */
function layoutOrbits(points: readonly SpiritSeaPoint[]): SeaPointView[] {
  const last = Math.max(1, points.length - 1);
  return points.map((point, index) => {
    const r = ORBIT_MIN + Math.pow(faintOf(point), 1.45) * ORBIT_SPAN;
    // 时间轴 → 角度（窗口内绕 SPIRAL_TURNS 圈），再加一点哈希抖动避免同刻排成射线
    const jitter = (randOf(`${point.id}:${SALT}:a`) - 0.5) * 2 * SPIRAL_JITTER;
    const phase0 = (index / last) * Math.PI * 2 * SPIRAL_TURNS + jitter;
    const omega = OMEGA_BASE * Math.pow(DISK_RREF / Math.max(1, r), DISK_POW);
    const th0 = phase0 + SPIRAL_K * r;
    const y = clampUnit(point.axis) * AXIS_LIFT + (randOf(`${point.id}:${SALT}:z`) - 0.5) * 2 * DISK_THICK;
    return {
      point,
      // x/z 与 `worldOf(view, 0)` 一致：拿它当静态回退值，不能与轨道公式两套算法
      x: Math.cos(th0) * r,
      y,
      z: Math.sin(th0) * r,
      radius: 1.2 + Math.min(2, Math.max(0, point.salience)) * 1.3,
      phase: randOf(`${point.id}:${SALT}:p`) * Math.PI * 2,
      orbit: { r, phase0, omega, spiral: SPIRAL_K, y },
    };
  });
}

/**
 * 锚点：胶囊模式给两个（她 +Y、主人 −Y），星盘模式只给一个中心（她）。
 *
 * 星盘里“主人”不再是一极：归属改由盘面高度表达，再画一条中心到中心的轴线
 * 会把“半径 = 多淡”误读成“半径 = 归属”。
 */
export function seaPoles(cfg: SeaLayoutCfg = {}): Array<Omit<SeaPole, 'label'>> {
  const radius = Math.max(120, cfg.radius ?? LAYOUT_RADIUS);
  if ((cfg.mode ?? 'poles') === 'orbits') {
    return [{ id: 'self', x: 0, y: 0, z: 0, phase: 0 }];
  }
  const y = radius * 0.85;
  return [
    { id: 'self', x: 0, y, z: 0, phase: 0 },
    { id: 'owner', x: 0, y: -y, z: 0, phase: 0.7 },
  ];
}

/**
 * 布局入口。`mode='poles'`（默认）：`axis=+1` 落在 +Y（主人），`axis=-1` 落在 −Y（她）。
 *
 * @param points 场景点（顺序不重要，位置只由 id / axis / trigger / salience / sessionId 决定）
 */
export function layoutSea(points: readonly SpiritSeaPoint[], cfg: SeaLayoutCfg = {}): SeaPointView[] {
  if ((cfg.mode ?? 'poles') === 'orbits') return layoutOrbits(points);
  const radius = Math.max(120, cfg.radius ?? LAYOUT_RADIUS);
  return points.map((point) => {
    const axis = Math.max(-1, Math.min(1, point.axis));
    // 胶囊体：两端收窄（0.45），赤道最宽
    const shrink = Math.sqrt(1 - axis * axis * 0.55);
    const spread = 0.18 + Math.pow(randOf(`${point.id}:${SALT}:r`), 0.7) * 0.62;
    const lateral = spread * radius * shrink;
    // 圆周混合：主体按 id 铺满整圈，只向本类型基准角偏移少量弧度（振幅见 ANGLE_TYPE_PULL）
    const full = randOf(`${point.id}:${SALT}:a`) * Math.PI * 2;
    const base = TRIGGER_ANGLE[point.trigger] ?? 0;
    const angle = full - ANGLE_TYPE_PULL * Math.sin(full - base);
    // 轻微的时间纵深：新记忆略靠前（+z），旧记忆略靠后，但不参与 axis 语义
    const depthJitter = (randOf(`${point.id}:${SALT}:z`) - 0.5) * 120;
    return {
      point,
      x: Math.cos(angle) * lateral,
      y: -clampUnit(axis * AXIS_GAIN) * radius * 0.85,
      z: Math.sin(angle) * lateral + depthJitter,
      radius: 1.2 + Math.min(2, Math.max(0, point.salience)) * 1.3,
      phase: randOf(`${point.id}:${SALT}:p`) * Math.PI * 2,
    };
  });
}
