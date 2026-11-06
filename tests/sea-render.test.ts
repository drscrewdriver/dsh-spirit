/**
 * 星海几何层门禁（纯函数）。
 *
 * 三条一定要钉住的：
 * 1. 布局**确定性**（同数据刷新不变形）；
 * 2. 双极方向（axis 极值分居 ±Y）；
 * 3. 主题**不含类型色**（换皮不换色相）。
 */
import { describe, expect, it } from 'vitest';

import type { SpiritSeaPoint } from '../src/contract.js';
import { CAM_DEFAULT, DIST_MAX, DIST_MIN, FOCAL } from '../client/src/sea/types.js';
import type { SeaFrame, SeaProjected } from '../client/src/sea/types.js';
import { layoutSea, randOf, loadLayoutMode, saveLayoutMode, seaPoles, faintOf, ORBIT_MIN, ORBIT_SPAN, AXIS_LIFT, DISK_THICK, SPIRAL_TURNS, SPIRAL_JITTER, LAYOUT_STORAGE_KEY, type SeaLayoutMode } from '../client/src/sea/sea-layout.js';
import { labelBudget, pickNearest, project, sortByDepth, visibleSubset, worldOf } from '../client/src/sea/sea-projection.js';
import { glowStrength, pointAlpha, proxBoost, PROXIMITY_PX } from '../client/src/sea/sea-render-2d.js';
import { GL_POINT_THRESHOLD, chooseBackend } from '../client/src/sea/sea-backend.js';
import {
  DEFAULT_THEME_ID,
  GLOW_STORAGE_KEY,
  HI_GLOW_STORAGE_KEY,
  SEA_THEMES,
  THEME_IDS,
  TRIGGER_RGB,
  browserStorage,
  loadGlowFactor,
  loadHiGlow,
  loadThemeId,
  saveGlowFactor,
  saveHiGlow,
  saveThemeId,
  themeById,
  withGlow,
} from '../client/src/sea/sea-themes.js';

function pointOf(over: Partial<SpiritSeaPoint> & { id: string }): SpiritSeaPoint {
  return {
    t: 1_760_000_000_000,
    sessionId: 's1',
    turnSeq: 1,
    trigger: 'neutral',
    lane: 'live',
    text: '一条经历',
    gist: null,
    salience: 1,
    freshness: 0.8,
    tier: 'full',
    axis: 0,
    feedback: null,
    cues: [],
    superseded: false,
    ...over,
  };
}

describe('layoutSea（双极 + 确定性）', () => {
  it('同输入两次布局逐字节一致', () => {
    const points = [pointOf({ id: 'a' }), pointOf({ id: 'b', axis: 0.8, trigger: 'tool_failure' })];
    expect(JSON.stringify(layoutSea(points))).toBe(JSON.stringify(layoutSea(points)));
  });

  it('axis 极值分居 ±Y', () => {
    const [toSelf, toOwner] = layoutSea([
      pointOf({ id: 'self', axis: -1 }),
      pointOf({ id: 'owner', axis: 1 }),
    ]);
    expect(toSelf!.y).toBeGreaterThan(0);
    expect(toOwner!.y).toBeLessThan(0);
    expect(Math.abs(toSelf!.y)).toBeGreaterThan(300);
    expect(Math.abs(toOwner!.y)).toBeGreaterThan(300);
  });

  it('同一 trigger 的点铺满整圈（经度不再按类型分扇区）', () => {
    // 旧实现把 6 个类型各分一个 60° 扇区，而 axis 又按 trigger 给基值 ⇒
    // 同一量画了两次，同类点排成纬线弧带、高度被误读成“类型”。
    // 这里钉住修正结果：单类型的 240 个点必须大致均匀地占满 6 个经度桶。
    const views = layoutSea(
      Array.from({ length: 240 }, (_, index) => pointOf({ id: `t${index}`, trigger: 'tool_failure', axis: 0 })),
    );
    const bins = [0, 0, 0, 0, 0, 0];
    for (const view of views) {
      const angle = Math.atan2(view.z, view.x); // 含 depthJitter，不影响桶均匀性
      const normalized = angle < 0 ? angle + Math.PI * 2 : angle;
      const at = Math.min(5, Math.floor((normalized / (Math.PI * 2)) * 6));
      bins[at] = (bins[at] ?? 0) + 1;
    }
    for (const bin of bins) {
      expect(bin, `经度桶分布：${bins.join('/')}`).toBeGreaterThanOrEqual(24);
    }
  });

  it('点半径随 salience 增大，且无 NaN', () => {
    const views = layoutSea([pointOf({ id: 'x', salience: 0 }), pointOf({ id: 'y', salience: 2 })]);
    expect(views[1]!.radius).toBeGreaterThan(views[0]!.radius);
    for (const view of views) {
      expect(Number.isFinite(view.x)).toBe(true);
      expect(Number.isFinite(view.y)).toBe(true);
      expect(Number.isFinite(view.z)).toBe(true);
    }
  });

  it('伪随机稳定且落在 [0,1)', () => {
    expect(randOf('same')).toBe(randOf('same'));
    expect(randOf('same')).toBeGreaterThanOrEqual(0);
    expect(randOf('same')).toBeLessThan(1);
    expect(randOf('a')).not.toBe(randOf('b'));
  });
});

describe('chooseBackend（后端选择：计划 §2 的两条升级触发）', () => {
  it('点数不到阈值且未开高质量辉光 ⇒ 留在 2D', () => {
    expect(chooseBackend({ pointCount: GL_POINT_THRESHOLD - 1, webglAvailable: true })).toBe('canvas2d');
  });

  it('到阈值自动升级；用户开高质量辉光时不看点数也升级', () => {
    expect(chooseBackend({ pointCount: GL_POINT_THRESHOLD, webglAvailable: true })).toBe('webgl2');
    expect(chooseBackend({ pointCount: 12, preferWebgl: true, webglAvailable: true })).toBe('webgl2');
  });

  it('环境没有 GL / allowWebgl=false ⇒ 一律 2D（不抛）', () => {
    expect(chooseBackend({ pointCount: 3_000, webglAvailable: false })).toBe('canvas2d');
    expect(chooseBackend({ pointCount: 3_000, preferWebgl: true, allowWebgl: false, webglAvailable: true })).toBe('canvas2d');
  });

  it('未注入探测结果时在无 DOM 环境也不抛（node 里走真探测）', () => {
    expect(chooseBackend({ pointCount: 3_000 })).toBe('canvas2d');
  });
});

describe('layoutSea mode=orbits（星盘：越淡越远 + 差速旋转）', () => {
  const of = (over: Partial<SpiritSeaPoint> & { id: string }): SpiritSeaPoint => pointOf(over);

  it('半径随“多淡”单调外扩，且不离中心无限远', () => {
    const views = layoutSea(
      [of({ id: 'near', freshness: 1, salience: 2 }), of({ id: 'mid', freshness: 0.5, salience: 1 }), of({ id: 'far', freshness: 0.02, salience: 0 })],
      { mode: 'orbits' },
    );
    const rs = views.map((view) => view.orbit!.r);
    expect(rs[0]!).toBeLessThan(rs[1]!);
    expect(rs[1]!).toBeLessThan(rs[2]!);
    expect(rs[0]!).toBeGreaterThanOrEqual(ORBIT_MIN);
    expect(rs[2]!).toBeLessThanOrEqual(ORBIT_MIN + ORBIT_SPAN + 1);
  });

  it('内圈转得快（差速，不是刚体一起转）', () => {
    const views = layoutSea([of({ id: 'in', freshness: 1, salience: 2 }), of({ id: 'out', freshness: 0, salience: 0 })], { mode: 'orbits' });
    const [inner, outer] = views;
    expect(inner!.orbit!.r).toBeLessThan(outer!.orbit!.r);
    expect(inner!.orbit!.omega).toBeGreaterThan(outer!.orbit!.omega);
  });

  it('相位按时间次序铺成螺旋（而不是按会话分扇区）', () => {
    // 回归用：真浏览器实测过“会话分扇区”的错——一个主会话占 97% 条目时，
    // 几千颗会被挤进一个 1.8 弧的楔形（屏幕上就是屏幕边一团雾）。
    // 所以拿 400 条全入同一个会话：它们仍必须铺满整圈以上（螺旋转 2.6 圈）。
    const views = layoutSea(
      Array.from({ length: 400 }, (_, index) => of({ id: `t${index}`, sessionId: 'sess-main' })),
      { mode: 'orbits' },
    );
    const phases = views.map((view) => view.orbit!.phase0);
    const span = Math.max(...phases) - Math.min(...phases);
    expect(span).toBeGreaterThan(Math.PI * 2 * 2); // 至少绕满两圈
    // 时间邻接：相邻下标的角度差有界（时间边因此不会跳成跨图长线）
    const step = (Math.PI * 2 * SPIRAL_TURNS) / (views.length - 1);
    for (let index = 1; index < phases.length; index += 1) {
      expect(Math.abs(phases[index]! - phases[index - 1]!)).toBeLessThan(step + SPIRAL_JITTER * 2 + 1e-9);
    }
    // 前 10% 与后 10% 的中心方位分开（时间次序在角度上可辨）
    const mean = (list: number[]) => list.reduce((x, y) => x + y, 0) / list.length;
    expect(mean(phases.slice(0, 40))).toBeLessThan(mean(phases.slice(-40)));
  });

  it('盘是“扁”的：y 幅度远小于胶囊的轴跨度', () => {
    const disk = layoutSea([of({ id: 'up', axis: 1 }), of({ id: 'down', axis: -1 })], { mode: 'orbits' });
    const gap = Math.abs(disk[0]!.y - disk[1]!.y);
    expect(gap).toBeGreaterThan(AXIS_LIFT); // 归属仍可读
    expect(gap).toBeLessThan(2 * AXIS_LIFT + 2 * DISK_THICK + 1);
    const capsule = layoutSea([of({ id: 'up', axis: 1 }), of({ id: 'down', axis: -1 })], { mode: 'poles' });
    expect(Math.abs(capsule[0]!.y - capsule[1]!.y)).toBeGreaterThan(gap * 3);
  });

  it('轨道点每帧换位置（会自转），胶囊点不挂 orbit', () => {
    const [disk] = layoutSea([of({ id: 'o' })], { mode: 'orbits' });
    const at0 = worldOf(disk!, 0);
    const at10 = worldOf(disk!, 10_000);
    expect(at0.x).not.toBeCloseTo(at10.x, 3);
    // 轨道点不叠加漂浮（否则旋臂会被抹糊）
    expect(at0.drift).toBe(0);
    const [capsule] = layoutSea([of({ id: 'p' })], { mode: 'poles' });
    expect(capsule!.orbit).toBeUndefined();
    expect(worldOf(capsule!, 0).drift).toBe(1);
  });

  it('锚点：胶囊两个中心、星盘只给一个（不能拿轴线误读半径）', () => {
    expect(seaPoles({ mode: 'poles' })).toHaveLength(2);
    const one = seaPoles({ mode: 'orbits' });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe('self');
    expect(one[0]!.y).toBe(0);
  });

  it('两种组式都确定且无 NaN；faintOf 钉在 0..1', () => {
    const points = [of({ id: 'x', freshness: 0.3, salience: 1.4 }), of({ id: 'y', freshness: 0.9, salience: 0, trigger: 'tool_failure' })];
    expect(JSON.stringify(layoutSea(points, { mode: 'orbits' }))).toBe(JSON.stringify(layoutSea(points, { mode: 'orbits' })));
    for (const view of layoutSea(points, { mode: 'orbits' })) {
      for (const key of ['x', 'y', 'z', 'radius'] as const) expect(Number.isFinite(view[key])).toBe(true);
      expect(Number.isFinite(view.orbit!.r)).toBe(true);
      expect(Number.isFinite(view.orbit!.omega)).toBe(true);
    }
    expect(faintOf(of({ id: 'f', freshness: 0, salience: 0 }))).toBe(1);
    expect(faintOf(of({ id: 'g', freshness: 1, salience: 2 }))).toBe(0);
  });

  it('组织方式持久化：只认 orbits，脏值/无存储回 poles', () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
    };
    expect(loadLayoutMode(storage)).toBe('poles');
    saveLayoutMode(storage, 'orbits' satisfies SeaLayoutMode);
    expect(memory.get(LAYOUT_STORAGE_KEY)).toBe('orbits');
    expect(loadLayoutMode(storage)).toBe('orbits');
    memory.set(LAYOUT_STORAGE_KEY, 'spinning');
    expect(loadLayoutMode(storage)).toBe('poles');
    expect(loadLayoutMode(undefined)).toBe('poles');
  });
});

describe('project / sortByDepth', () => {
  const [view] = layoutSea([pointOf({ id: 'p', axis: 0 })]);

  it('相机中心投影到画布中心（扣除漂浮量）', () => {
    const cam = { ...CAM_DEFAULT, yaw: 0, pitch: 0, panX: 0, panY: 0 };
    const originView = { ...view!, x: 0, y: 0, z: 0, phase: 0 };
    // now=0：x/z 用 sin ⇒ 漂移为 0；y 用 cos ⇒ 恰好多出 +DRIFT.y。这里把它计入期望值，
    // 而不是把漂移当噪声：漂移幅度是写死的常量，测试要能盯住它被误改。
    const projected = project(originView, cam, 800, 600, 0);
    const f = FOCAL / CAM_DEFAULT.dist;
    expect(projected.x).toBeCloseTo(400, 6);
    expect(projected.y).toBeCloseTo(300 + 4 * f, 6);
    expect(projected.f).toBeCloseTo(f, 6);
  });

  it('越远 f 越小', () => {
    const cam = { ...CAM_DEFAULT, yaw: 0, pitch: 0 };
    const near = project({ ...view!, x: 0, y: 0, z: -400, phase: 0 }, cam, 800, 600, 0);
    const far = project({ ...view!, x: 0, y: 0, z: 400, phase: 0 }, cam, 800, 600, 0);
    expect(near.f).toBeGreaterThan(far.f);
    expect(near.depth).toBeLessThan(far.depth);
  });

  it('排序返回远 → 近', () => {
    const cam = { ...CAM_DEFAULT, yaw: 0, pitch: 0 };
    const list = [
      project({ ...view!, x: 0, y: 0, z: -300, phase: 0 }, cam, 800, 600, 0),
      project({ ...view!, x: 0, y: 0, z: 300, phase: 0 }, cam, 800, 600, 0),
    ];
    const sorted = sortByDepth(list);
    expect(sorted[0]!.depth).toBeGreaterThan(sorted[1]!.depth);
  });
});

describe('labelBudget / pickNearest', () => {
  it('预算在 24..160 之间且随缩放增大', () => {
    expect(labelBudget(CAM_DEFAULT.dist)).toBe(72);
    expect(labelBudget(10_000)).toBe(24);
    expect(labelBudget(DIST_MIN)).toBeLessThanOrEqual(160);
    expect(labelBudget(DIST_MAX)).toBeGreaterThanOrEqual(24);
  });

  it('16px 内命中最近点，空白处返回 null', () => {
    const [view] = layoutSea([pointOf({ id: 'p' })]);
    const cam = { ...CAM_DEFAULT, yaw: 0, pitch: 0 };
    const projected = [project({ ...view!, x: 0, y: 0, z: 0, phase: 0 }, cam, 800, 600, 0)];
    expect(pickNearest(projected, 402, 301)?.view.point.id).toBe('p');
    expect(pickNearest(projected, 500, 500)).toBeNull();
  });
});

describe('辉光×亮度等级关联（用户提的那一条）', () => {
  const theme = themeById('starfield');
  const of = (over: Partial<SpiritSeaPoint> & { id: string }): number => glowStrength(pointOf(over), 1, false, false, theme);

  it('held < gist < full，但 held 不被压到看不见（地板校准）', () => {
    const full = of({ id: 'g1', tier: 'full', freshness: 1, salience: 2 });
    const gist = of({ id: 'g2', tier: 'gist', freshness: 1, salience: 2 });
    const held = of({ id: 'g3', tier: 'held', freshness: 1, salience: 2 });
    expect(full).toBeGreaterThan(gist);
    expect(gist).toBeGreaterThan(held);
    // tier 用的是小时尺度的注意力窗口，跨月的库几乎全是 held：
    // 地板压到 0.22 会让整片海不发光（真浏览器实测），所以要求 held 仍拿到过半的光
    expect(held).toBeGreaterThan(full * 0.45);
  });

  it('同等级内老化越深越不亮（单调）', () => {
    const fresh = of({ id: 'f1', tier: 'full', freshness: 1, salience: 2 });
    const old = of({ id: 'f2', tier: 'full', freshness: 0.1, salience: 2 });
    expect(fresh).toBeGreaterThan(old);
  });

  it('幽灵点（已被更正）不发光、亮度有硬顶', () => {
    const theme = themeById('starfield');
    const ghost = pointOf({ id: 'gh', tier: 'full', freshness: 1, salience: 2, superseded: true });
    expect(glowStrength(ghost, 1, false, false, theme)).toBe(0);
    // hot 也不能把幽灵点亮起来（发光门控在等级之前）
    expect(glowStrength(ghost, 1, true, false, theme)).toBe(0);
    expect(pointAlpha(ghost, false)).toBeLessThanOrEqual(0.25);
  });

  it('主题 glow 倍率真参与计算，dimmed 会压下去', () => {
    const point = pointOf({ id: 'x', tier: 'full', freshness: 1, salience: 2 });
    const bright = glowStrength(point, 1, false, false, themeById('aurora'));
    const dark = glowStrength(point, 1, false, false, themeById('ink'));
    expect(bright).toBeGreaterThan(dark);
    expect(glowStrength(point, 1, false, true, theme)).toBeLessThan(bright * 0.2);
    expect(glowStrength(point, 1, true, false, theme)).toBeGreaterThan(bright);
  });
});

describe('proxBoost（靠近激活：对照 prime-memory 的 proximity 闪烁）', () => {
  const item = { x: 100, y: 100, f: 1, view: { point: pointOf({ id: 'pb', tier: 'full', freshness: 1, salience: 2 }), x: 0, y: 0, z: 0, radius: 2, phase: 0 } } as unknown as SeaProjected;
  const frameOf = (cursor: { x: number; y: number } | null | undefined, now: number): SeaFrame =>
    ({ points: [], edges: [], focus: new Set(), focusOnly: false, showLabels: true, showEdges: true, hovered: null, selected: null, cursor, now }) as SeaFrame;

  it('无 cursor / 超出半径 ⇒ 0；半径内 >0 且 ≤1', () => {
    expect(proxBoost(item, frameOf(undefined, 0))).toBe(0);
    expect(proxBoost(item, frameOf(null, 0))).toBe(0);
    expect(proxBoost(item, frameOf({ x: 100 + PROXIMITY_PX + 5, y: 100 }, 0))).toBe(0);
    const near = proxBoost(item, frameOf({ x: 100, y: 100 }, 260 * Math.PI / 2)); // sin=1 ⇒ pulse=1
    expect(near).toBeGreaterThan(0.99);
    expect(near).toBeLessThanOrEqual(1);
  });

  it('脉冲随时间变化且不同步（相位用每点 phase）：齐闪会像加载动画', () => {
    const other = { ...item, view: { ...item.view, phase: Math.PI } } as unknown as SeaProjected;
    const cursor = { x: 100, y: 100 };
    const peak = 260 * Math.PI * 0.5; // sin=1 ⇒ pulse=1
    const trough = 260 * Math.PI * 1.5; // sin=-1 ⇒ pulse=0
    const a = proxBoost(item, frameOf(cursor, peak));
    const b = proxBoost(item, frameOf(cursor, trough));
    expect(a - b).toBeGreaterThan(0.9);
    // 反相位的邻居在同一时刻拿到互补的脉冲 ⇒ 不同步闪
    const c = proxBoost(other, frameOf(cursor, peak));
    expect(a - c).toBeGreaterThan(0.9);
  });

  it('prox 真进辉光公式：同点同条件下 prox>0 比 prox=0 亮', () => {
    const theme = themeById('starfield');
    const p = pointOf({ id: 'gprox', tier: 'held', freshness: 0.2, salience: 0 });
    expect(glowStrength(p, 1, false, false, theme, 0.8)).toBeGreaterThan(glowStrength(p, 1, false, false, theme, 0));
  });
});

describe('pointAlpha（亮度等级顶盖）与 visibleSubset（超窗降级）', () => {
  it('亮度随 freshness 单调上升，held 有顶盖，dimmed 压到接近不可见', () => {
    const alphas = [0.05, 0.3, 0.6, 0.85, 1].map((freshness) =>
      pointAlpha(pointOf({ id: 'p', freshness, tier: 'full', salience: 2 }), false),
    );
    for (let index = 1; index < alphas.length; index += 1) {
      expect(alphas[index]!, `freshness=${index}`).toBeGreaterThan(alphas[index - 1]!);
    }
    expect(pointAlpha(pointOf({ id: 'h', freshness: 1, tier: 'held', salience: 2 }), false)).toBeLessThanOrEqual(0.55);
    expect(pointAlpha(pointOf({ id: 'h2', freshness: 1, tier: 'held', salience: 2 }), false)).toBeGreaterThan(0.5);
    expect(pointAlpha(pointOf({ id: 'd', freshness: 1, tier: 'full', salience: 2 }), true)).toBeLessThan(0.15);
  });

  it('超窗只保留 salience>=1；全弱时退回全部（不能画空图）', () => {
    const views = Array.from({ length: 5 }, (_, index) => ({
      point: pointOf({ id: `v${index}`, salience: index % 2 }),
      x: 0,
      y: 0,
      z: 0,
      radius: 1,
      phase: 0,
    }));
    expect(visibleSubset(views, 10)).toHaveLength(5); // 未超窗：原样返回
    expect(visibleSubset(views, 3).map((view) => view.point.salience)).toEqual([1, 1]);
    const allWeak = Array.from({ length: 4 }, (_, index) => ({
      point: pointOf({ id: `w${index}`, salience: 0 }),
      x: 0,
      y: 0,
      z: 0,
      radius: 1,
      phase: 0,
    }));
    expect(visibleSubset(allWeak, 2)).toHaveLength(4);
  });
});

describe('主题（换皮不换色相）', () => {
  it('三套预设齐全，未知 id 退回默认', () => {
    expect(THEME_IDS).toHaveLength(3);
    expect(themeById('aurora').id).toBe('aurora');
    expect(themeById('nope').id).toBe(DEFAULT_THEME_ID);
    expect(themeById(null).id).toBe(DEFAULT_THEME_ID);
  });

  it('类型色覆盖 6 个 trigger，且主题里不含颜色字段', () => {
    expect(Object.keys(TRIGGER_RGB)).toHaveLength(6);
    for (const theme of Object.values(SEA_THEMES)) {
      const serialized = JSON.stringify(theme);
      expect(serialized.includes('rgb')).toBe(false);
      expect(theme.glow).toBeGreaterThan(0);
      expect(theme.halo).toBeGreaterThan(0);
    }
  });

  it('高质量辉光开关：只认 "1"，写回同步，无存储退 false', () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
    };
    expect(loadHiGlow(storage)).toBe(false);
    saveHiGlow(storage, true);
    expect(loadHiGlow(storage)).toBe(true);
    expect(memory.get(HI_GLOW_STORAGE_KEY)).toBe('1');
    memory.set(HI_GLOW_STORAGE_KEY, 'yes');
    expect(loadHiGlow(storage)).toBe(false); // 脏值不自作聪明当 true
    saveHiGlow(storage, false);
    expect(loadHiGlow(storage)).toBe(false);
    expect(loadHiGlow(undefined)).toBe(false);
  });

  it('辉光倍率：读写一致、越界夹住、坏值退默认，且只改 glow 不改其他字段', () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
    };
    expect(loadGlowFactor(storage)).toBe(1);
    saveGlowFactor(storage, 1.8);
    expect(loadGlowFactor(storage)).toBe(1.8);
    saveGlowFactor(storage, 99);
    expect(loadGlowFactor(storage)).toBe(2.5);
    memory.set(GLOW_STORAGE_KEY, 'abc');
    expect(loadGlowFactor(storage)).toBe(1);
    expect(loadGlowFactor(undefined)).toBe(1);

    const base = themeById('starfield');
    const boosted = withGlow(base, 2);
    expect(boosted.glow).toBe(base.glow * 2);
    expect(boosted.bg).toBe(base.bg);
    expect(boosted.halo).toBe(base.halo);
    expect(withGlow(base, Number.NaN).glow).toBe(base.glow);
    // 原对象不能被动到：主题是共享常量，改它会全局渗漂
    expect(base.glow).toBe(1);
  });

  it('存读一致，坏值/异常存储都不抛', () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
    };
    saveThemeId(storage, 'ink');
    expect(loadThemeId(storage)).toBe('ink');
    saveThemeId(storage, 'not-a-theme');
    expect(loadThemeId(storage)).toBe(DEFAULT_THEME_ID);

    const broken = {
      getItem: () => {
        throw new Error('boom');
      },
      setItem: () => {
        throw new Error('boom');
      },
    };
    expect(loadThemeId(broken)).toBe(DEFAULT_THEME_ID);
    expect(() => saveThemeId(broken, 'aurora')).not.toThrow();
    expect(loadThemeId(undefined)).toBe(DEFAULT_THEME_ID);
    expect(browserStorage()).toBeUndefined(); // node 环境无 localStorage
  });
});
