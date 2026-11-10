/**
 * WebGL2 渲染后端（可选加速层）。
 *
 * 分工与 2D 后端一致，只是把发光交给 GPU：
 * - GL 层：边（LINES，正常混合）+ 点两通道（光晕加法、核心正常混合）——与 2D 的
 *   source-over 边 / `lighter` 光晕 / source-over 核心逐层同构，两边对拍才不会一边糊白；
 * - 2D 叠加层：中文标签、悬浮气泡、强调环——字形图集不划算，环用 GPU 画反而更麻烦。
 *
 * 三条实现取舍：
 * 1. 不引任何库：两个 program、约 40 行 GLSL，比装 three 便宜两个数量级；
 * 2. 每帧重传 buffer：3000 点 x 7 float 约 84KB，bufferData 一次拷进去比维护 VBO 增量简单；
 * 3. context lost 不在这里自愈：由上层（sea-view）监听事件并切回 2D。
 */
import type { SeaCam, SeaFrame, SeaProjected, SeaRenderer, SeaTheme } from './types.js';
import { drawSeaBubble, drawSeaLabels, drawSeaPoles, glowStrength, pointAlpha, proxBoost } from './sea-render-2d.js';
import { project, projectPole, sortByDepth } from './sea-projection.js';
import { EDGE_DASH, EDGE_RGB, LANE_DASH, pointRgb } from './sea-themes.js';

const POINT_VS = [
  '#version 300 es',
  'in vec2 a_pos;',
  'in float a_glow_size;',
  'in float a_core_size;',
  'in float a_glow_alpha;',
  'in float a_core_alpha;',
  'in vec3 a_color;',
  'uniform float u_mode;', // 0 = 光晕通道，1 = 核心通道
  'out vec3 v_color;',
  'out float v_alpha;',
  'void main() {',
  '  gl_Position = vec4(a_pos, 0.0, 1.0);',
  '  gl_PointSize = mix(a_glow_size, a_core_size, u_mode);',
  '  v_color = a_color;',
  '  v_alpha = mix(a_glow_alpha, a_core_alpha, u_mode);',
  '}',
].join('\n');

const POINT_FS = [
  '#version 300 es',
  'precision mediump float;',
  'in vec3 v_color;',
  'in float v_alpha;',
  // 两端精度必须逐字一致：VS 的 float 缺省 highp、FS 缺省 mediump，
  // 不显式标 highp 会在链接期报 "Precisions of uniform 'u_mode' differ"（真浏览器实测）。
  'uniform highp float u_mode;',
  'out vec4 out_color;',
  'void main() {',
  '  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;',
  '  // 光晕通道：平滑衰减；核心通道：实心圆盘（边缘抗锯齿）——与 2D 的 sprite+实心圆同构',
  '  float shape = mix(pow(max(0.0, 1.0 - d), 2.5), 1.0 - smoothstep(0.72, 1.0, d), u_mode);',
  '  float a = v_alpha * shape;',
  '  out_color = vec4(v_color * a, a);',
  '}',
].join('\n');

const LINE_VS = [
  '#version 300 es',
  'in vec2 a_pos;',
  'in float a_alpha;',
  'in vec3 a_color;',
  'out float v_alpha;',
  'out vec3 v_color;',
  'void main() {',
  '  gl_Position = vec4(a_pos, 0.0, 1.0);',
  '  v_alpha = a_alpha;',
  '  v_color = a_color;',
  '}',
].join('\n');

const LINE_FS = [
  '#version 300 es',
  'precision mediump float;',
  'in float v_alpha;',
  'in vec3 v_color;',
  'out vec4 out_color;',
  'void main() {',
  '  out_color = vec4(v_color * v_alpha, v_alpha);',
  '}',
].join('\n');

/** 每点 9 个 float：x, y, glowSize, coreSize, glowAlpha, coreAlpha, r, g, b 。 */
const POINT_FLOATS = 9;
/** 每顶点 6 个 float：x, y, alpha, r, g, b（每条边两个顶点）。 */
const LINE_FLOATS = 6;
const LINK_BASE_ALPHA = 0.03;
const PICK_THRESHOLD_PX = 16;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // 必须报出 info log：只返回 null 的话上层只能看到“默默降级”，分不清是环境没 GL 还是着色器写坏
    console.warn(`[dsh-spirit] GL 着色器编译失败：${gl.getShaderInfoLog(shader) ?? '无日志'}`);
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource);
  if (vs === null || fs === null) return null;
  const program = gl.createProgram();
  if (program === null) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn(`[dsh-spirit] GL 程序链接失败：${gl.getProgramInfoLog(program) ?? '无日志'}`);
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/** 十六进制颜色转 0..1 三元组（GL 不接受 CSS 颜色串）。 */
function hexToNormalizedRgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/iu.exec(hex.trim());
  if (match === null) return [0.02, 0.02, 0.04];
  const value = Number.parseInt(match[1]!, 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/**
 * 环境能不能用 WebGL2。
 *
 * 必须拿临时 canvas 探测：同一张 canvas 先要了 2D 上下文就再也拿不到 GL，
 * 用真实画布探测会让"能否升级后端"永远返回 false。
 */
export function isWebgl2Available(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    return document.createElement('canvas').getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

export interface GlRendererHandles {
  renderer: SeaRenderer;
  gl: WebGL2RenderingContext;
}

/**
 * 创建 WebGL2 后端；拿不到上下文或着色器链接失败时返回 null，
 * 由调用方（sea-view）退回 Canvas2D。这里不抛——"没有 GL"是正常环境。
 */
export function tryCreateWebgl2Renderer(
  canvas: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  theme: SeaTheme,
): GlRendererHandles | null {
  const glContext = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true });
  const overlayContext = overlay.getContext('2d');
  if (glContext === null || overlayContext === null) return null;
  // 判空后换个名字再用：闭包里 TS 不保留对同一 const 的 null 窄化，
  // 到处写感叹号是把类型问题藏起来，改名才是解决它。
  const gl: WebGL2RenderingContext = glContext;
  const overlayCtx: CanvasRenderingContext2D = overlayContext;

  const pointProgram = link(gl, POINT_VS, POINT_FS);
  const lineProgram = link(gl, LINE_VS, LINE_FS);
  if (pointProgram === null || lineProgram === null) return null;

  const pointLoc = {
    pos: gl.getAttribLocation(pointProgram, 'a_pos'),
    glowSize: gl.getAttribLocation(pointProgram, 'a_glow_size'),
    coreSize: gl.getAttribLocation(pointProgram, 'a_core_size'),
    glowAlpha: gl.getAttribLocation(pointProgram, 'a_glow_alpha'),
    coreAlpha: gl.getAttribLocation(pointProgram, 'a_core_alpha'),
    color: gl.getAttribLocation(pointProgram, 'a_color'),
  };
  const pointMode = gl.getUniformLocation(pointProgram, 'u_mode');
  const lineLoc = {
    pos: gl.getAttribLocation(lineProgram, 'a_pos'),
    alpha: gl.getAttribLocation(lineProgram, 'a_alpha'),
    color: gl.getAttribLocation(lineProgram, 'a_color'),
  };
  const pointBuffer = gl.createBuffer();
  const lineBuffer = gl.createBuffer();
  if (pointBuffer === null || lineBuffer === null) return null;

  let currentTheme = theme;
  let width = 1;
  let height = 1;
  let dpr = 1;
  let lastProjected: SeaProjected[] = [];
  let pointData = new Float32Array(0);
  let lineData = new Float32Array(0);

  /** clip space 换算（屏幕 px 转 [-1,1]，y 轴翻转）。 */
  const toClipX = (x: number): number => (x / width) * 2 - 1;
  const toClipY = (y: number): number => 1 - (y / height) * 2;

  /** 叠加层：强调环 + 人工标记环 + 标签 + 气泡（中文只能这么画）。 */
  function drawOverlayLayer(projected: SeaProjected[], frame: SeaFrame, cam: SeaCam): void {
    // 每帧重新声明变换：给画布设 `width` 会连带重置它的变换矩阵（包括被外部代码改），
    // 而叠加层与主画布必须同源——真浏览器实测过一次：变换丢了，标签就停在左上角
    // 而盘在屏幕中心，看起来像“GL 后端画错了”，其实是尺寸被外部重置。
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayCtx.clearRect(0, 0, width, height);
    for (const item of projected) {
      const point = item.view.point;
      const hot = frame.focus.has(point.id) || frame.hovered === point.id || frame.selected === point.id;
      const rgb = pointRgb(point);
      const base = Math.max(0.8, item.view.radius * (hot ? 1.9 : 1) * item.f * 1.75);
      if (hot) {
        overlayCtx.globalAlpha = 1;
        overlayCtx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.45 + 0.25 * Math.sin(frame.now / 600)})`;
        overlayCtx.lineWidth = 1.2;
        overlayCtx.beginPath();
        overlayCtx.arc(item.x, item.y, base * 3.2, 0, Math.PI * 2);
        overlayCtx.stroke();
      }
      if (point.feedback !== null && point.feedback > 0) {
        overlayCtx.globalAlpha = 0.8;
        overlayCtx.strokeStyle = 'rgba(255,226,150,0.75)';
        overlayCtx.lineWidth = 1;
        overlayCtx.beginPath();
        overlayCtx.arc(item.x, item.y, base * 2.6, 0, Math.PI * 2);
        overlayCtx.stroke();
      }
    }
    overlayCtx.globalAlpha = 1;
    if (frame.poles !== undefined && frame.poles.length > 0) {
      drawSeaPoles(
        overlayCtx,
        frame.poles.map((pole) => {
          const at = projectPole(pole, cam, width, height, frame.now);
          return { kind: pole.id, x: at.x, y: at.y, f: at.f, label: pole.label };
        }),
        currentTheme,
      );
    }
    drawSeaLabels(overlayCtx, projected, frame, currentTheme, cam, width);
    drawSeaBubble(overlayCtx, projected, frame, width);
  }

  const renderer: SeaRenderer = {
    kind: 'webgl2',

    init(): void {
      // 资源在工厂函数里已建好；保留方法只为对齐接口
    },

    setTheme(nextTheme: SeaTheme): void {
      currentTheme = nextTheme;
    },

    resize(nextWidth: number, nextHeight: number, nextDpr: number): void {
      width = Math.max(1, Math.floor(nextWidth));
      height = Math.max(1, Math.floor(nextHeight));
      dpr = Math.min(2, Math.max(1, nextDpr));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      overlay.width = canvas.width;
      overlay.height = canvas.height;
      overlay.style.width = `${width}px`;
      overlay.style.height = `${height}px`;
      overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gl.viewport(0, 0, canvas.width, canvas.height);
    },

    draw(frame: SeaFrame, cam: SeaCam): void {
      const [bgR, bgG, bgB] = hexToNormalizedRgb(currentTheme.bg);
      gl.clearColor(bgR, bgG, bgB, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);

      const projected = frame.points.map((view) => project(view, cam, width, height, frame.now));
      lastProjected = projected;

      // 边用**正常混合**（premultiplied source-over）：2D 里的边也是 source-over，
      // 若这里走加法，5997 条边会在密集区叠成一张白网盖过星本身（真浏览器实测差异）。
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const posById = new Map(projected.map((item) => [item.view.point.id, item]));
      const lineCapacity = frame.edges.length * LINE_FLOATS * 2;
      if (lineData.length < lineCapacity) lineData = new Float32Array(lineCapacity);
      let lineVertices = 0;
      for (const edge of frame.showEdges ? frame.edges : []) {
        const a = posById.get(edge.a);
        const b = posById.get(edge.b);
        if (a === undefined || b === undefined) continue;
        if (frame.focusOnly && frame.focus.size > 0 && !(frame.focus.has(edge.a) && frame.focus.has(edge.b))) continue;
        const near = (a.f + b.f) / 2;
        let alpha = Math.min(0.5, (LINK_BASE_ALPHA + edge.score * 0.18) * near * 1.7 * currentTheme.linkAlpha);
        // 2D 里点线/虚线边只画得出占空比那一段；GL 的 LINES 画不了虚线，
        // 不折减就会比 2D 密一倍——对拍截图实测过（整张网偏亮）。用同表算占空比。
        const fromHistory = a.view.point.lane === 'drsc' || b.view.point.lane === 'drsc';
        const dash = fromHistory ? LANE_DASH : (EDGE_DASH[edge.kind] ?? EDGE_DASH.cue);
        if (dash.length >= 2) alpha *= dash[0]! / (dash[0]! + dash[1]!);
        if (alpha <= 0.004) continue;
        // 边色与 2D 后端同一张表：否则“2D 里紫色的取代链”在 GL 里变成另一种颜色
        const rgb = EDGE_RGB[edge.kind] ?? EDGE_RGB.cue;
        const offset = lineVertices * LINE_FLOATS;
        lineData[offset] = toClipX(a.x);
        lineData[offset + 1] = toClipY(a.y);
        lineData[offset + 2] = alpha;
        lineData[offset + 3] = rgb[0] / 255;
        lineData[offset + 4] = rgb[1] / 255;
        lineData[offset + 5] = rgb[2] / 255;
        lineData[offset + 6] = toClipX(b.x);
        lineData[offset + 7] = toClipY(b.y);
        lineData[offset + 8] = alpha;
        lineData[offset + 9] = rgb[0] / 255;
        lineData[offset + 10] = rgb[1] / 255;
        lineData[offset + 11] = rgb[2] / 255;
        lineVertices += 2;
      }
      if (lineVertices > 0) {
        gl.useProgram(lineProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, lineData.subarray(0, lineVertices * LINE_FLOATS), gl.DYNAMIC_DRAW);
        const lineStride = LINE_FLOATS * 4;
        gl.enableVertexAttribArray(lineLoc.pos);
        gl.vertexAttribPointer(lineLoc.pos, 2, gl.FLOAT, false, lineStride, 0);
        gl.enableVertexAttribArray(lineLoc.alpha);
        gl.vertexAttribPointer(lineLoc.alpha, 1, gl.FLOAT, false, lineStride, 8);
        gl.enableVertexAttribArray(lineLoc.color);
        gl.vertexAttribPointer(lineLoc.color, 3, gl.FLOAT, false, lineStride, 12);
        gl.drawArrays(gl.LINES, 0, lineVertices);
      }

      // 点分两通道，与 2D 同构：光晕走加法混合（密集区叠亮），核心走正常混合（实心不溶色）。
      // 单通道加法会把核心颜色一起叠白——真浏览器对拍截图实测：2D 的红/绿分群在 GL 里糊成蓝白。
      const order = sortByDepth(projected);
      const pointCapacity = order.length * POINT_FLOATS;
      if (pointData.length < pointCapacity) pointData = new Float32Array(pointCapacity);
      let pointCount = 0;
      for (const item of order) {
        const point = item.view.point;
        const hot = frame.focus.has(point.id) || frame.hovered === point.id || frame.selected === point.id;
        const dimmed = frame.focusOnly && frame.focus.size > 0 && !hot;
        const strength = glowStrength(point, item.f, hot, dimmed, currentTheme, proxBoost(item, frame));
        const coreAlpha = pointAlpha(point, dimmed);
        const glowAlpha = Math.min(1, strength * 0.85);
        if (coreAlpha <= 0.02 && glowAlpha <= 0.02) continue;
        const coreSize = Math.max(1.6, item.view.radius * item.f * 1.75 * (hot ? 1.9 : 1)) * 2 * dpr;
        const glowSize = Math.max(coreSize, coreSize * (4 + 6 * Math.min(1, strength)) * currentTheme.halo);
        const rgb = pointRgb(point);
        const offset = pointCount * POINT_FLOATS;
        pointData[offset] = toClipX(item.x);
        pointData[offset + 1] = toClipY(item.y);
        pointData[offset + 2] = glowSize;
        pointData[offset + 3] = coreSize;
        pointData[offset + 4] = glowAlpha;
        pointData[offset + 5] = coreAlpha;
        pointData[offset + 6] = rgb[0] / 255;
        pointData[offset + 7] = rgb[1] / 255;
        pointData[offset + 8] = rgb[2] / 255;
        pointCount += 1;
      }
      if (pointCount > 0) {
        gl.useProgram(pointProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, pointData.subarray(0, pointCount * POINT_FLOATS), gl.DYNAMIC_DRAW);
        const stride = POINT_FLOATS * 4;
        gl.enableVertexAttribArray(pointLoc.pos);
        gl.vertexAttribPointer(pointLoc.pos, 2, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(pointLoc.glowSize);
        gl.vertexAttribPointer(pointLoc.glowSize, 1, gl.FLOAT, false, stride, 8);
        gl.enableVertexAttribArray(pointLoc.coreSize);
        gl.vertexAttribPointer(pointLoc.coreSize, 1, gl.FLOAT, false, stride, 12);
        gl.enableVertexAttribArray(pointLoc.glowAlpha);
        gl.vertexAttribPointer(pointLoc.glowAlpha, 1, gl.FLOAT, false, stride, 16);
        gl.enableVertexAttribArray(pointLoc.coreAlpha);
        gl.vertexAttribPointer(pointLoc.coreAlpha, 1, gl.FLOAT, false, stride, 20);
        gl.enableVertexAttribArray(pointLoc.color);
        gl.vertexAttribPointer(pointLoc.color, 3, gl.FLOAT, false, stride, 24);
        // 先光晕（加法）后核心（正常）：顺序与 2D 一致，核心盖在光晕上才是“星”而不是“雾”
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.uniform1f(pointMode, 0);
        gl.drawArrays(gl.POINTS, 0, pointCount);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform1f(pointMode, 1);
        gl.drawArrays(gl.POINTS, 0, pointCount);
      }

      drawOverlayLayer(order, frame, cam);
    },

    pick(x: number, y: number): string | null {
      let best: string | null = null;
      let bestDistance = PICK_THRESHOLD_PX;
      for (const item of lastProjected) {
        const distance = Math.hypot(item.x - x, item.y - y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = item.view.point.id;
        }
      }
      return best;
    },

    dispose(): void {
      gl.deleteProgram(pointProgram);
      gl.deleteProgram(lineProgram);
      gl.deleteBuffer(pointBuffer);
      gl.deleteBuffer(lineBuffer);
      lastProjected = [];
      pointData = new Float32Array(0);
      lineData = new Float32Array(0);
    },
  };

  return { gl, renderer };
}
