/**
 * Canvas 2D 渲染后端。
 *
 * ⚠️ **性能红线（不做就废）**：光晕必须用**预渲染 sprite + drawImage**，
 * 禁止逐帧 `createRadialGradient`。3000 点逐点建渐变实测级开销在 30–60ms/帧，
 * 而同样 3000 次 drawImage 只有 4–8ms。本文件把所有渐变都收进 `spriteFor()`（带缓存）。
 *
 * 两个刻意保留的"土办法"：
 * - 标签避让用**屏幕格子**（104×14）而不是四叉树：3000 点下够用，且行为可预测；
 * - 拾取是线性扫描（`pickNearest`），不建索引：一帧一次，成本可忽略。
 */
import type { SeaCam, SeaFrame, SeaProjected, SeaRenderer, SeaTheme } from './types.js';
import type { SpiritSeaPoint } from '../../../src/contract.js';
import { labelBudget, pickNearest, project, projectPole, sortByDepth } from './sea-projection.js';
import { EDGE_DASH, EDGE_RGB, LANE_DASH, pointRgb } from './sea-themes.js';

const SPRITE_SIZE = 64;
const LABEL_FONT = '11px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
const BUBBLE_FONT = '12px "Microsoft YaHei", sans-serif';
const LABEL_CELL_W = 104;
const LABEL_CELL_H = 14;
const LABEL_MAX_CHARS = 14;
const MIN_LABEL_F = 0.55;

interface Dust {
  x: number;
  y: number;
  phase: number;
}

export interface Canvas2dOptions {
  /** 背景星尘开关（低端设备/录屏可关）。 */
  dust?: boolean;
}

function rgba(rgb: readonly [number, number, number], alpha: number): string {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * 亮度等级的不透明顶盖。
 *
 * 地板不能压得太狠：`tier` 用的是**注意力窗口**尺度（小时），跨月的库里几乎
 * 全部条目都是 `held`。若顶盖取 0.38、光晕地板取 0.22，叠上天尺度老化后整片海会直接看不见
 * （真浏览器实测：1000 点只剩一张线网）。遗忘是“沉下去”，不是“消失”。
 */
const TIER_ALPHA_CAP: Record<SpiritSeaPoint['tier'], number> = { full: 1, gist: 0.8, held: 0.55 };

/** 幽灵点（已被更正的旧版本）的硬顶：看得见、但不参与发光。 */
const GHOST_ALPHA_CAP = 0.25;

/** 光晕等级的地板：等级只轻微调光，主发光量给天尺度的 `freshness`。 */
const TIER_GLOW_FLOOR: Record<SpiritSeaPoint['tier'], number> = { full: 1, gist: 0.75, held: 0.5 };

/**
 * 核心不透明度 = 老化权重给渐变，亮度等级给顶盖。
 *
 * 抽成导出函数是为了能被断言（“亮度与老化单调正相关”是验收项，藏在绘制循环里就没人测得到）；
 * 两个后端都走它，不会出现“2D 里暗星是暗的、GL 里不是”这种分叉。
 */
/**
 * 核心不透明度 = **基座 0.45 + 老化渐变 0.55**，再由亮度等级封顶。
 *
 * 基座不是可调装饰：指数衰减的动态范围极大（跨月库 ÷ 7 天尺度 = 15 个半衰期，
 * 0.5^15.9 ≈ 3e-5），若从 0 起算则绝大多数条目 alpha≈0.12，在暗背景上直接不可见
 * （真浏览器实测：整张图只剩一张线网）。所以“沉下去”靠**光晕变小 + 亮度相对变暗**
 * 来表达，而不是靠看不见。`tier` 顶盖仍保留：held 再新也超不过 0.55。
 */
export function pointAlpha(point: SpiritSeaPoint, dimmed: boolean): number {
  const cap = point.superseded ? GHOST_ALPHA_CAP : TIER_ALPHA_CAP[point.tier];
  return Math.min(cap, (0.45 + 0.55 * clamp01(point.freshness)) * (dimmed ? 0.1 : 1));
}

/**
 * 光晕强度 = **亮度等级（tier）门控 × 老化权重（freshness）× 在意度 × 主题倍率**。
 *
 * 这就是“辉光和亮度等级关联”的那一条：`held`（已滑出注意力窗口）几乎不发光，
 * `full` 且刚发生的条目最亮；hot（焦点/悬停/选中）只在此基础上叠加强调，
 * 不再是光晕的唯一入口。
 */
export function glowStrength(point: SpiritSeaPoint, f: number, hot: boolean, dimmed: boolean, theme: SeaTheme, prox = 0): number {
  // 幽灵点不发光：“已被更正”的条目不应该在图上与作数的条目争亮度
  if (point.superseded) return 0;
  const weight = 0.35 + 0.65 * clamp01(point.salience / 2);
  // 光晕基座同样不能从 0 起：否则老条目连“小光晕”都拿不到，图就变成纯点阵
  const base = TIER_GLOW_FLOOR[point.tier] * (0.4 + 0.6 * clamp01(point.freshness)) * weight;
  const depth = 0.6 + 0.4 * clamp01(f); // 远处不发光：否则整团糊成一片
  // prox（靠近激活）与 hot 同路叠加：鼠标拂过一片星时它们逐个“眨眼”，
  // 而不是只有被 16px 拾取命中的那一颗有反应（对照 prime-memory 的 proximity 激活）
  const value = (base + (hot ? 0.85 : 0) + prox * 0.7) * theme.glow * depth * (dimmed ? 0.1 : 1);
  return Math.min(1.6, value);
}

/** proximity 激活半径（屏幕 px）：再大就会“整片海跟着鼠标亮”，失去指向性。 */
export const PROXIMITY_PX = 110;

/**
 * 靠近激活的脉冲量（0..1）：离鼠标越近越强，再乘一个慢脉冲（“眨眼”）。
 *
 * 脉冲相位用每点固定的 `phase`：同半径内的星不同步闪，才是“拂过”的感觉；
 * 齐闪会像加载动画（姊妹包踩过的观感坑）。
 */
export function proxBoost(item: SeaProjected, frame: SeaFrame): number {
  const cursor = frame.cursor;
  if (cursor === undefined || cursor === null) return 0;
  const d = Math.hypot(item.x - cursor.x, item.y - cursor.y);
  if (d >= PROXIMITY_PX) return 0;
  const near = 1 - d / PROXIMITY_PX;
  const pulse = 0.5 + 0.5 * Math.sin(frame.now / 260 + item.view.phase);
  return near * pulse;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * 标签层（两个后端共用）：按权重挑、按屏幕格子避让，缩放越大标得越多。
 *
 * 为什么抽成模块级函数：WebGL2 后端画不了中文（字形图集不划算），
 * 它的标签要拿同一套逻辑画在叠加的 2D 层上——两处各写一份迟早会对不齐。
 */
export function drawSeaLabels(
  ctx: CanvasRenderingContext2D,
  projected: SeaProjected[],
  frame: SeaFrame,
  theme: SeaTheme,
  cam: SeaCam,
  width: number,
): void {
  if (!frame.showLabels) return;
  const budget = labelBudget(cam.dist);
  const rank = (item: SeaProjected): number => {
    const point = item.view.point;
    return (
      (frame.focus.has(point.id) ? 4 : 0) +
      (point.id === frame.selected ? 4 : 0) +
      (point.id === frame.hovered ? 4 : 0) +
      point.salience
    );
  };
  const candidates = projected
    .filter((item) => {
      if (item.f < MIN_LABEL_F) return false;
      if (item.view.point.text.length < 2) return false;
      if (frame.focusOnly && frame.focus.size > 0) {
        return frame.focus.has(item.view.point.id) || item.view.point.id === frame.hovered || item.view.point.id === frame.selected;
      }
      return true;
    })
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, budget);

  ctx.font = LABEL_FONT;
  ctx.textAlign = 'left';
  const occupied = new Set<string>();
  for (const item of candidates) {
    const label = clip(item.view.point.text, LABEL_MAX_CHARS);
    const w = ctx.measureText(label).width;
    const x = Math.round(item.x + 7);
    const y = Math.round(item.y - 5);
    if (x + w > width - 4 || x < -2) continue;
    const cell = `${Math.floor(x / LABEL_CELL_W)}:${Math.floor(y / LABEL_CELL_H)}`;
    if (occupied.has(cell)) continue;
    occupied.add(cell);
    const point = item.view.point;
    const hot = frame.hovered === point.id || frame.selected === point.id || frame.focus.has(point.id);
    ctx.globalAlpha = hot ? 0.95 : theme.labelAlpha;
    ctx.fillStyle = hot ? '#e6efff' : '#93a3c4';
    ctx.fillText(label, x, y);
    if (hot) {
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#78aaff';
      ctx.fillRect(x - 3, y - 9, 1.2, 11);
    }
  }
  ctx.globalAlpha = 1;
}

/** 悬浮气泡（也共用）：拿上一帧的投影结果定位，不重新投影。 */
export function drawSeaBubble(
  ctx: CanvasRenderingContext2D,
  projected: SeaProjected[],
  frame: SeaFrame,
  width: number,
): void {
  if (frame.hovered === null) return;
  const hit = projected.find((item) => item.view.point.id === frame.hovered);
  if (hit === undefined) return;
  const label = clip(hit.view.point.text, 24);
  ctx.font = BUBBLE_FONT;
  const textWidth = ctx.measureText(label).width;
  const boxWidth = textWidth + 18;
  const x = Math.min(Math.max(4, hit.x + 12), Math.max(4, width - boxWidth - 4));
  const y = Math.max(6, hit.y - 26);
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = 'rgba(8,11,20,0.88)';
  ctx.fillRect(x, y, boxWidth, 22);
  ctx.strokeStyle = 'rgba(120,160,255,0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, boxWidth - 1, 21);
  ctx.fillStyle = '#dfe8ff';
  ctx.fillText(label, x + 9, y + 15);
  ctx.globalAlpha = 1;
}

/** 已投影的两极（供两个后端共用同一套画法）。 */
export interface SeaPoleScreen {
  kind: 'self' | 'owner';
  x: number;
  y: number;
  f: number;
  label: string;
}

/**
 * 两极与主轴：这张图的坐标系。**不画它们就看不出“她 ↔ 主人”**，
 * 而只是“一堆按颜色分类的点”——真浏览器第一版就是这个形状。
 *
 * 每帧只建 2 个渐变（不是每点），所以逐帧 `createRadialGradient` 在这里不越红线。
 */
export function drawSeaPoles(ctx: CanvasRenderingContext2D, poles: readonly SeaPoleScreen[], theme: SeaTheme): void {
  if (poles.length === 0) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  // 主轴只在两极都在时画：星盘模式只有一个中心，拉一条线会把“半径=多淡”误读成“半径=归属”
  if (poles.length >= 2) {
    const [first, second] = [poles[0]!, poles[1]!];
    ctx.strokeStyle = `rgba(150,180,255,${0.18 * theme.linkAlpha})`;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    ctx.lineTo(second.x, second.y);
    ctx.stroke();
  }

  for (const pole of poles) {
    const radius = Math.max(5, 15 * pole.f);
    const gradient = ctx.createRadialGradient(pole.x, pole.y, 0, pole.x, pole.y, radius * 3);
    gradient.addColorStop(0, `rgba(214,228,255,${0.5 * theme.glow})`);
    gradient.addColorStop(0.4, `rgba(150,180,255,${0.18 * theme.glow})`);
    gradient.addColorStop(1, 'rgba(150,180,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(pole.x, pole.y, radius * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(190,210,255,0.55)';
    ctx.beginPath();
    ctx.arc(pole.x, pole.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    // 坐标轴名字不受“标签”开关控制：关掉标签后图仍然可读
    ctx.font = BUBBLE_FONT;
    ctx.textAlign = 'center';
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#cfe0ff';
    ctx.fillText(pole.label, pole.x, pole.y - radius - 6);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

export function createCanvas2dRenderer(options: Canvas2dOptions = {}): SeaRenderer {
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let theme: SeaTheme | null = null;
  let width = 0;
  let height = 0;
  let dpr = 1;
  const sprites = new Map<string, HTMLCanvasElement>();
  let dust: Dust[] = [];
  let dustCount = 0;
  let lastProjected: SeaProjected[] = [];
  const showDust = options.dust !== false;

  /** 预渲染光晕（按颜色缓存）：中心亮、边缘透明的径向渐变。 */
  function spriteFor(rgb: readonly [number, number, number]): HTMLCanvasElement | null {
    const key = `${rgb[0]},${rgb[1]},${rgb[2]}`;
    const cached = sprites.get(key);
    if (cached !== undefined) return cached;
    if (canvas === null) return null;
    const doc = canvas.ownerDocument;
    const off = doc.createElement('canvas');
    off.width = SPRITE_SIZE;
    off.height = SPRITE_SIZE;
    const offCtx = off.getContext('2d');
    if (offCtx === null) return null;
    const radius = SPRITE_SIZE / 2;
    const gradient = offCtx.createRadialGradient(radius, radius, 0, radius, radius, radius);
    gradient.addColorStop(0, rgba(rgb, 0.9));
    gradient.addColorStop(0.35, rgba(rgb, 0.35));
    gradient.addColorStop(1, rgba(rgb, 0));
    offCtx.fillStyle = gradient;
    offCtx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    sprites.set(key, off);
    return off;
  }

  function ensureDust(count: number): void {
    if (count === dustCount) return;
    dustCount = count;
    dust = Array.from({ length: count }, (_, index) => ({
      x: ((index * 2654435761) % 1000) / 1000,
      y: ((index * 40503 * 7) % 1000) / 1000,
      phase: (index % 17) * 0.37,
    }));
  }

  function drawBackground(now: number): void {
    if (ctx === null || theme === null) return;
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);

    if (theme.vignette > 0) {
      const gradient = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.2, width / 2, height / 2, Math.max(width, height) * 0.75);
      gradient.addColorStop(0, 'rgba(0,0,0,0)');
      gradient.addColorStop(1, `rgba(0,0,0,${theme.vignette})`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }

    if (!showDust || theme.dust <= 0) return;
    ensureDust(theme.dust);
    for (const star of dust) {
      const alpha = 0.04 + ((Math.sin(now / 2_600 + star.phase) + 1) / 2) * 0.12;
      ctx.fillStyle = `rgba(150,180,255,${alpha})`;
      ctx.fillRect(star.x * width, star.y * height, 1, 1);
    }
  }

  function drawEdges(projected: SeaProjected[], frame: SeaFrame): void {
    if (ctx === null || theme === null || !frame.showEdges) return;
    const pos = new Map<string, SeaProjected>();
    for (const item of projected) pos.set(item.view.point.id, item);

    /**
     * 按（线型组, alpha 档）分桶，同桶合并成一条 path 一次 stroke。
     *
     * 逐边 `setLineDash + beginPath + stroke` 在 3000 条时就是帧率杀手
     * （真浏览器实测 1000 点 2fps）。分桶后状态变更从 O(边) 降到 O(桶)，
     * 而量化到 20 档的透明度在视觉上不可区分。
     */
    const buckets = new Map<string, { rgb: readonly [number, number, number]; dash: readonly number[]; alpha: number; segs: number[] }>();
    for (const edge of frame.edges) {
      const a = pos.get(edge.a);
      const b = pos.get(edge.b);
      if (a === undefined || b === undefined) continue;
      if (frame.focusOnly && frame.focus.size > 0 && !(frame.focus.has(edge.a) && frame.focus.has(edge.b))) continue;
      const near = (a.f + b.f) / 2;
      const alpha = Math.min(0.5, (0.03 + edge.score * 0.18) * near * 1.7 * theme.linkAlpha);
      if (alpha <= 0.004) continue;
      const fromHistory = a.view.point.lane === 'drsc' || b.view.point.lane === 'drsc';
      const dash = fromHistory ? LANE_DASH : (EDGE_DASH[edge.kind] ?? EDGE_DASH.cue);
      const rgb = EDGE_RGB[edge.kind] ?? EDGE_RGB.cue;
      const quantized = Math.round(alpha * 20) / 20;
      const key = `${fromHistory ? 'lane' : edge.kind}|${quantized}`;
      const bucket = buckets.get(key) ?? { rgb, dash, alpha: quantized, segs: [] };
      bucket.segs.push(a.x, a.y, b.x, b.y);
      buckets.set(key, bucket);
    }

    ctx.lineWidth = 1;
    for (const bucket of buckets.values()) {
      ctx.strokeStyle = `rgba(${bucket.rgb[0]},${bucket.rgb[1]},${bucket.rgb[2]},${bucket.alpha})`;
      ctx.setLineDash([...bucket.dash]);
      ctx.beginPath();
      for (let index = 0; index + 3 < bucket.segs.length; index += 4) {
        ctx.moveTo(bucket.segs[index]!, bucket.segs[index + 1]!);
        ctx.lineTo(bucket.segs[index + 2]!, bucket.segs[index + 3]!);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function drawPoints(projected: SeaProjected[], frame: SeaFrame): void {
    if (ctx === null || theme === null) return;
    const order = sortByDepth(projected);

    // 第一遍：光晕层。`lighter` 是“星海”而不是“散点图”的关键——密集区会自己叠亮；
    // 全部走预渲染 sprite，绝不在此处建渐变。
    ctx.globalCompositeOperation = 'lighter';
    for (const item of order) {
      const point = item.view.point;
      const hot = frame.focus.has(point.id) || frame.hovered === point.id || frame.selected === point.id;
      const dimmed = frame.focusOnly && frame.focus.size > 0 && !hot;
      const strength = glowStrength(point, item.f, hot, dimmed, theme, proxBoost(item, frame));
      if (strength <= 0.06) continue;
      const sprite = spriteFor(pointRgb(point));
      if (sprite === null) continue;
      const size = Math.max(8, item.view.radius * item.f * 1.75 * (4 + 6 * Math.min(1, strength)) * theme.halo);
      ctx.globalAlpha = Math.min(0.8, strength * 0.5);
      ctx.drawImage(sprite, item.x - size / 2, item.y - size / 2, size, size);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // 第二遍：核心。非 hot 点按（颜色, alpha 档）分桶合并成一次 fill；
    // hot 点单独画（数量 = 焦点 + 悬停 + 选中，个位数），因为它半径要额外放大。
    const dotBuckets = new Map<string, { fill: string; items: SeaProjected[] }>();
    const hotOnes: Array<{ item: SeaProjected; rgb: readonly [number, number, number]; alpha: number }> = [];
    const starred: SeaProjected[] = [];
    for (const item of order) {
      const point = item.view.point;
      const hot = frame.focus.has(point.id) || frame.hovered === point.id || frame.selected === point.id;
      const rgb = pointRgb(point);
      const dimmed = frame.focusOnly && frame.focus.size > 0 && !hot;
      const alpha = pointAlpha(point, dimmed);
      if (alpha <= 0.01) continue;
      if (point.feedback !== null && point.feedback > 0) starred.push(item);
      if (hot) {
        hotOnes.push({ item, rgb, alpha });
        continue;
      }
      const key = `${rgb[0]},${rgb[1]},${rgb[2]}|${Math.round(alpha * 16) / 16}`;
      const bucket = dotBuckets.get(key) ?? { fill: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.round(alpha * 16) / 16})`, items: [] };
      bucket.items.push(item);
      dotBuckets.set(key, bucket);
    }

    ctx.fillStyle = '';
    for (const bucket of dotBuckets.values()) {
      ctx.fillStyle = bucket.fill;
      ctx.beginPath();
      for (const item of bucket.items) {
        const base = Math.max(0.8, item.view.radius * item.f * 1.75);
        ctx.moveTo(item.x + base, item.y);
        ctx.arc(item.x, item.y, base, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // ★ 人工标记环（与焦点光晕分家，避免两套语义混在一起）
    ctx.strokeStyle = 'rgba(255,226,150,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const item of starred) {
      const base = Math.max(0.8, item.view.radius * item.f * 1.75) * 2.6;
      ctx.moveTo(item.x + base, item.y);
      ctx.arc(item.x, item.y, base, 0, Math.PI * 2);
    }
    ctx.stroke();

    // hot：单独核心 + 呼吸环（节奏慢才不会像加载动画）
    for (const entry of hotOnes) {
      const base = Math.max(0.8, entry.item.view.radius * 1.9 * entry.item.f * 1.75);
      ctx.globalAlpha = entry.alpha;
      ctx.fillStyle = rgba(entry.rgb, 1);
      ctx.beginPath();
      ctx.arc(entry.item.x, entry.item.y, base, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = rgba(entry.rgb, 0.45 + 0.25 * Math.sin(frame.now / 600));
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(entry.item.x, entry.item.y, base * 1.7, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  return {
    kind: 'canvas2d',

    init(nextCanvas: HTMLCanvasElement, nextTheme: SeaTheme, _overlay?: HTMLCanvasElement): void {
      // 2D 后端自己画标签，overlay 对它没有意义（接口对齐用）
      canvas = nextCanvas;
      ctx = nextCanvas.getContext('2d');
      theme = nextTheme;
      sprites.clear();
      dust = [];
      dustCount = 0;
    },

    setTheme(nextTheme: SeaTheme): void {
      theme = nextTheme;
      // 星尘数量随主题变，重建一次；颜色 sprite 与主题无关，不重建
      dustCount = -1;
    },

    resize(nextWidth: number, nextHeight: number, nextDpr: number): void {
      width = Math.max(1, Math.floor(nextWidth));
      height = Math.max(1, Math.floor(nextHeight));
      dpr = Math.min(2, Math.max(1, nextDpr));
      if (canvas !== null) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      if (ctx !== null) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },

    draw(frame: SeaFrame, cam: SeaCam): void {
      if (ctx === null || theme === null) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBackground(frame.now);
      const projected = frame.points.map((view) => project(view, cam, width, height, frame.now));
      lastProjected = projected;
      if (frame.poles !== undefined && frame.poles.length > 0) {
        drawSeaPoles(
          ctx,
          frame.poles.map((pole) => {
            const at = projectPole(pole, cam, width, height, frame.now);
            return { kind: pole.id, x: at.x, y: at.y, f: at.f, label: pole.label };
          }),
          theme,
        );
      }
      drawEdges(projected, frame);
      drawPoints(projected, frame);
      drawSeaLabels(ctx, projected, frame, theme, cam, width);
      drawSeaBubble(ctx, projected, frame, width);
    },

    pick(x: number, y: number): string | null {
      return pickNearest(lastProjected, x, y)?.view.point.id ?? null;
    },

    dispose(): void {
      sprites.clear();
      dust = [];
      dustCount = 0;
      lastProjected = [];
      canvas = null;
      ctx = null;
      theme = null;
    },
  };
}
