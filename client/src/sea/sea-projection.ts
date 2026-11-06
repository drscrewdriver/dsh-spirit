/**
 * 投影与拾取（纯函数，两个渲染后端共用）。
 *
 * 手写三维的理由：3000 点的场景只需要「旋转两次 + 一次透视除法」，
 * 引入矩阵库或 3D 引擎的收益为零，而调试成本与 bundle 成本都是真实的。
 */
import type { SeaCam, SeaPole, SeaPointView, SeaProjected } from './types.js';
import { CAM_DEFAULT, FOCAL } from './types.js';

/** 漂浮幅度（世界单位）：只影响"活着"的感觉，不影响相对位置。 */
export const DRIFT = { x: 6, y: 4, z: 6 } as const;

/** 同一套旋转与透视数学的唯一实现（点与两极共用，所心不能出现两套投影）。 */
function rotateAndProject(
  x: number,
  y: number,
  z: number,
  phase: number,
  cam: SeaCam,
  width: number,
  height: number,
  now: number,
  driftScale = 1,
): { x: number; y: number; f: number; depth: number } {
  const wx = x + cam.panX + Math.sin(now / 3_200 + phase) * DRIFT.x * driftScale;
  const wy = y + cam.panY + Math.cos(now / 4_100 + phase) * DRIFT.y * driftScale;
  const wz = z + Math.sin(now / 2_700 + phase * 1.3) * DRIFT.z * driftScale;

  const cosYaw = Math.cos(cam.yaw);
  const sinYaw = Math.sin(cam.yaw);
  const cosPitch = Math.cos(cam.pitch);
  const sinPitch = Math.sin(cam.pitch);

  const x1 = wx * cosYaw - wz * sinYaw;
  const z1 = wx * sinYaw + wz * cosYaw;
  const y1 = wy * cosPitch - z1 * sinPitch;
  const z2 = wy * sinPitch + z1 * cosPitch;

  const depth = cam.dist + z2;
  const f = FOCAL / Math.max(140, depth);
  return { x: width / 2 + x1 * f, y: height / 2 + y1 * f, f, depth };
}

/**
 * 世界坐标：静态点位用 `x/y/z` + 漂浮；轨道点位每帧重算。
 *
 * 轨道点**不叠加漂浮**：漂浮幅度（±6）与盘厚同量级，叠上去会把旋臂抹成一团雾；
 * 它自己的差速旋转就是“活着”的来源。
 */
export function worldOf(view: SeaPointView, now: number): { x: number; y: number; z: number; phase: number; drift: number } {
  const orbit = view.orbit;
  if (orbit === undefined) {
    return { x: view.x, y: view.y, z: view.z, phase: view.phase, drift: 1 };
  }
  const th = orbit.phase0 + orbit.spiral * orbit.r + (now / 1_000) * orbit.omega;
  return { x: Math.cos(th) * orbit.r, y: orbit.y, z: Math.sin(th) * orbit.r, phase: view.phase, drift: 0 };
}

/**
 * 相机空间投影：先绕 Y（yaw）、再绕 X（pitch）、最后透视除法。
 *
 * 返回的 `f` 同时承担三件事：屏幕缩放、亮度衰减、标签门槛。
 * 三者共用一个系数是有意的——"远"在视觉上就应该同时是"小、暗、不标注"。
 */
export function project(view: SeaPointView, cam: SeaCam, width: number, height: number, now: number): SeaProjected {
  const world = worldOf(view, now);
  const at = rotateAndProject(world.x, world.y, world.z, world.phase, cam, width, height, now, world.drift);
  return { view, ...at };
}

/** 两极的投影（同一数学，不带 SeaPointView 负担）。 */
export function projectPole(
  pole: SeaPole,
  cam: SeaCam,
  width: number,
  height: number,
  now: number,
): { pole: SeaPole; x: number; y: number; f: number; depth: number } {
  const at = rotateAndProject(pole.x, pole.y, pole.z, pole.phase, cam, width, height, now);
  return { pole, ...at };
}

/** 远 → 近：先画远的，后画的压住先画的，才有纵深遮挡。 */
export function sortByDepth(list: readonly SeaProjected[]): SeaProjected[] {
  return [...list].sort((a, b) => b.depth - a.depth);
}

/**
 * 标签预算：缩放越大标得越多（近景给细节，远景给形状）。
 * 上下限是硬的：低于 24 看不出内容，高于 160 就会糊成标签墙。
 */
export function labelBudget(dist: number): number {
  const base = CAM_DEFAULT.dist / Math.max(1, dist);
  return Math.max(24, Math.min(160, Math.round(72 * base)));
}

/**
 * 超窗降级：点数过密时只画“在意的”那些（`salience >= 1`）。
 *
 * 这是有信息损失的取舍，但比掉帧强：宁可少画一批弱条目，也不能让整张图卡在 20fps。
 * 放在 view（布局之后、后端之前）而不是两个后端里，GL 与 2D 才能共享同一个降级行为。
 */
export const SEA_SOFT_POINT_LIMIT = 3_000;

export function visibleSubset(views: readonly SeaPointView[], limit = SEA_SOFT_POINT_LIMIT): SeaPointView[] {
  if (views.length <= limit) return [...views];
  const kept = views.filter((view) => view.point.salience >= 1);
  // 全库都是弱条目时不能画一张空图：退回去画全部
  return kept.length > 0 ? kept : [...views];
}

/** 拾取：屏幕空间最近点（16px 阈值）。3000 点线性扫描在 60fps 下可忽略。 */
export function pickNearest(
  list: readonly SeaProjected[],
  mx: number,
  my: number,
  threshold = 16,
): SeaProjected | null {
  let best: SeaProjected | null = null;
  let bestDistance = threshold;
  for (const item of list) {
    const distance = Math.hypot(item.x - mx, item.y - my);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item;
    }
  }
  return best;
}
