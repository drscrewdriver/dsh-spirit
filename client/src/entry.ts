/**
 * dsh-spirit — 浏览器半边入口（TS 源，scripts/build-client.mjs 经 esbuild 打成 dist/client.js）。
 *
 * 只挂三个座位（其中顶部两席位算一个入口）：
 * 1. `settings.section` → 顶层「手记」分节（只读投影；设置表单交给宿主自动生成的 volatile 面）
 * 2. `conversation.input.left` → 会话情绪开关 pill
 * 3. `sidebar.panellist` + `main` → 顶部「记忆星海」整页入口（v0.3；两席位齐了才挂）
 *
 * ⚠️ **一个插件在一个座位上只能登记一次，且不要同时挂多处**：姊妹包实测过"设置里
 * 出现三份同一面板"的回归——起因是误以为"座位没被声明时 inject 不触发"，实际上
 * 宿主会同时声明多个座位，于是三次注册全部生效。这里结构性地只留两个座位。
 *
 * `slots` 之外的客户端服务一律**不进声明式 inject**：可选服务晚到时，声明式注入会让
 * apply 永久挂起（UI 全静默消失且无任何报错），需要时在调用点 `ctx.get(...)` 懒解析。
 */

import { copyOf } from './copy.js';
import type { CopyKey } from './copy.js';
import { createElement, type ReactElement } from 'react';
import { SeaPanel } from './sea/sea-panel.js';
import { seaIntent } from './sea/sea-intent.js';
import type { SeaIntentTarget } from './sea/sea-intent.js';
import { SpiritPanel } from './panel.js';
import { SpiritPill } from './pill.js';
import { makeRpc } from './rpc.js';
import type { SpiritClientCtx } from './env.js';

export const inject = ['slots'];

export const SETTINGS_SEAT = 'settings.section';
export const PILL_SEAT = 'conversation.input.left';
/** 顶部工具行席位（面板行）与主栏整页席位：两个都有才算一个可用入口。 */
export const TOP_TOOL_SEAT = 'sidebar.panellist';
export const MAIN_SEAT = 'main';
/** 星海入口 id / key（行与页共用同一串，宿主按它配对）。 */
export const SEA_PANEL_ID = 'dsh-spirit-sea';

/** 判定期：够宿主把座位声明出来；过了还没挂上就响亮告警（静默消失最难查）。 */
const SEAT_PROBE_MS = 3_000;

/**
 * 当前语言取词。**每次调用现取**，不在 apply 期算一次存下来：
 * 真宿主实测 client apply 跑在宿主写 `<html lang>` 之前（初始文档是 `lang="en"`），
 * 存下来就会把分节标题永久冻结成英文（导航条出现「Journal」而面板内是中文）。
 */
function currentCopy(): Record<CopyKey, string> {
  return copyOf(typeof document === 'undefined' ? undefined : document.documentElement.lang);
}

/**
 * 跳转回响的同步回执（v0.8.1）。
 *
 * 跨 bundle 的一侧（dsh-brief-sidebar）不能 import 本包，也不能裸调 layout：
 * `selectPanel` 对未注册的 main key 会抛。所以由本包提供面板的 owner 负责
 * 调用与回执，事件 detail 上的 `ack` 是唯一同步答案。
 */
export interface SeaOpenAck {
  ok: boolean;
  reason?: 'unmounted' | 'unregistered';
  /** 诊断面：为什么没能拿到布局服务（只进 title/tooltip，不占正文）。 */
  detail?: string;
}

/** 事件名（与 dsh-brief-sidebar 的发送端同串，文档见本仓 README/计划）。 */
export const OPEN_SEA_EVENT = 'dsh-spirit:open-sea';

/** 布局服务的最小面：宿主 `layout.selectPanel(key)`，未注册 main key 时抛。 */
export interface LayoutLike {
  selectPanel?(key: string | null): unknown;
}

/**
 * 解析布局服务。三条路依次尝试，返回第一条真正可用的并记下失败痕迹：
 *
 * 1. `ctx.inject(['layout'])` 捕获的实例（晚到也能补上，最可靠）；
 * 2. `ctx.layout` 直接属性（部分宿主直接挂上去）；
 * 3. `ctx.get('layout')`（有的宿主线允许但会返 undefined）；
 * 4. `ctx.reflect.get('layout')`（`ctx.get` 被严格代理拦掉时的底层入口）。
 *
 * 四路全空时把每一步的结果拼进 `detail`：回执只给 `unregistered` 一个字，
 * 用户看不出是“没这个服务”还是“服务在但被拦”，排障只能靠猜。
 */
function resolveLayout(
  ctx: SpiritClientCtx,
  captured: LayoutLike | undefined,
): { svc?: LayoutLike; why: string } {
  if (captured?.selectPanel !== undefined) return { svc: captured, why: 'inject' };
  const notes: string[] = [];
  try {
    if (ctx.layout?.selectPanel !== undefined) return { svc: ctx.layout, why: 'prop' };
    notes.push('prop=empty');
  } catch (err) {
    notes.push(`prop=${(err as Error).message}`);
  }
  try {
    const viaGet = ctx.get('layout') as LayoutLike | undefined;
    if (viaGet?.selectPanel !== undefined) return { svc: viaGet, why: 'get' };
    notes.push('get=empty');
  } catch (err) {
    notes.push(`get=${(err as Error).message}`);
  }
  try {
    const viaReflect = ctx.reflect?.get?.('layout') as LayoutLike | undefined;
    if (viaReflect?.selectPanel !== undefined) return { svc: viaReflect, why: 'reflect' };
    notes.push('reflect=empty');
  } catch (err) {
    notes.push(`reflect=${(err as Error).message}`);
  }
  return { why: notes.join('; ') || 'no-layout-service' };
}

/**
 * 当前 apply 的控制器：监听只绑一次，控制器随 apply 替换。
 * 这样 HMR/重复 apply 不会叠加监听，也不会把旧闭包里的 seaMounted 当成真相。
 */
let openSeaController: ((target: SeaIntentTarget) => SeaOpenAck) | undefined;
let openSeaBound = false;

function bindOpenSeaEvent(): void {
  // 测试/宿主桩可能只有 window 对象没有 addEventListener：能力探测不靠 `typeof window`。
  if (openSeaBound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  openSeaBound = true;
  window.addEventListener(OPEN_SEA_EVENT, (event: Event) => {
    handleOpenSeaEvent(event as unknown as OpenSeaEventLike);
  });
}

/** 事件的最小结构面（测试可直接传对象，不必造 DOM 事件）。 */
interface OpenSeaEventLike {
  detail: unknown;
  preventDefault(): void;
}

/**
 * 处理一次「打开星海」请求：校验 detail、调当前控制器、写回执。
 *
 * 两个目标：`echo`（缺省，翻阅 → 回响）与 `graph`（星海星图）。detail 两种写法都接：
 * - 新：`{ target: 'graph' | 'echo' }`
 * - 旧：`{ tab: 'records', view: 'echo' }`（v0.8.1 的发送端）
 *
 * 抽成纯入口便于在 node 环境单测（本 suite 不拉 DOM）；绑定层只做转递。
 * @param event - 带 detail 与 preventDefault 的事件形状。
 */
export function handleOpenSeaEvent(event: OpenSeaEventLike): void {
  const detail = event.detail;
  if (typeof detail !== 'object' || detail === null) return;
  const record = detail as Record<string, unknown>;
  const target = seaTargetOf(record);
  if (target === undefined) return;
  const ack = openSeaController?.(target) ?? { ok: false, reason: 'unmounted' as const };
  record['ack'] = ack;
  if (ack.ok) event.preventDefault();
}

/** detail → 目标；认不出就是非法请求（返回 undefined，静默忽略）。 */
function seaTargetOf(record: Record<string, unknown>): SeaIntentTarget | undefined {
  const target = record['target'];
  if (target === 'graph' || target === 'echo') return target;
  if (record['tab'] === 'records' && record['view'] === 'echo') return 'echo';
  if (record['tab'] === 'sea') return 'graph';
  return undefined;
}

export function apply(ctx: SpiritClientCtx): void {
  const rpc = makeRpc();
  let settingsMounted = false;
  let pillMounted = false;
  // 布局服务：先试可选注入（晚到不阻塞 apply），拿不到再在调用点三路懒解析。
  let layoutSvc: LayoutLike | undefined;
  try {
    ctx.inject?.(['layout'], (scope: Record<string, unknown>) => {
      const svc = scope['layout'] as LayoutLike | undefined;
      if (svc?.selectPanel !== undefined) layoutSvc = svc;
    }, 'dsh-spirit: layout service');
  } catch (err) {
    console.warn('[dsh-spirit] layout 可选注入未建立（回退到调用点解析）:', err);
  }
  // 顶部两席位的落位标记（声明在前，下面的 3s 诊断与 mountSea 都读它们）
  let seaRowSeat = false;
  let seaMainSeat = false;
  let seaMounted = false;

  try {
    ctx.slots.inject(SETTINGS_SEAT, () => {
      settingsMounted = true;
      try {
        return ctx.slots.register(
          // label 传 **thunk**：宿主契约明写“thunk 跟随当前语言”（resolveSlotLabel），
          // 传字符串 = 标题冻结在注册那一刻的语言。
          { name: SETTINGS_SEAT, id: 'dsh-spirit', order: 260, label: () => currentCopy()['section.label'], inject: () => ({ rpc }) },
          SpiritPanel,
        );
      } catch (err) {
        console.warn('[dsh-spirit] settings.section 注册失败:', err);
        return () => {};
      }
    });
  } catch (err) {
    console.warn('[dsh-spirit] settings.section 槽位未声明:', err);
  }

  try {
    ctx.slots.inject(PILL_SEAT, () => {
      pillMounted = true;
      try {
        return ctx.slots.register(
          {
            name: PILL_SEAT,
            id: 'dsh-spirit-mode',
            order: 110,
            // 宿主实测把 owner 作为裸 sessionId 字符串传进来；不同线也可能给 { session } 形状
            inject: (sessionId: string) => ({ sessionId, rpc }),
          },
          SpiritPill,
        );
      } catch (err) {
        console.warn('[dsh-spirit] conversation.input.left 注册失败:', err);
        return () => {};
      }
    });
  } catch (err) {
    console.warn('[dsh-spirit] conversation.input.left 槽位未声明:', err);
  }

  setTimeout(() => {
    if (!settingsMounted) console.warn('[dsh-spirit] 「手记」分节未挂载：该宿主线可能没有声明 settings.section（pill 不受影响）');
    if (!pillMounted) console.warn('[dsh-spirit] 输入栏 pill 未挂载：该宿主线可能没有声明 conversation.input.left（分节不受影响）');
    if (!seaRowSeat && !seaMainSeat) {
      // 老宿主没这两席位是预期形态（不是故障），但入口确实会看不见，仍要说出来：
      // eslint 只放行 warn/error，所以把“可忽略”写进文案而不是降级成 info。
      console.warn('[dsh-spirit] 宿主未提供顶部工具槽位（sidebar.panellist/main）：本次不挂「记忆星海」入口（可忽略，手记分节不受影响）');
    }
  }, SEAT_PROBE_MS);

  // ── 顶部「记忆星海」整页入口 ──────────────────────────────────────
  // 判定走 inject 探测而不是 specDynamic：服务面不保证暴露它（姊妹包实测教训）。
  // 两席位齐了才挂：只挂行不挂页 = 点了没反应；回落底栏 = 与设置分节形成两个入口。
  const closeSea = (): void => {
    const { svc, why } = resolveLayout(ctx, layoutSvc);
    try {
      svc?.selectPanel?.(null);
    } catch (err) {
      console.warn('[dsh-spirit] 关闭星海失败:', why, err);
    }
  };

  const mountSea = (): void => {
    if (seaMounted || !seaRowSeat || !seaMainSeat) return;
    seaMounted = true;
    try {
      ctx.slots.inject(
        MAIN_SEAT,
        () => ctx.slots.register(
          { name: MAIN_SEAT, key: SEA_PANEL_ID },
          (seatProps: Record<string, unknown>) => createElement(SeaPanel, { ...seatProps, rpc, onClose: closeSea }),
        ),
        'dsh-spirit: sea page',
      );
      ctx.slots.inject(
        TOP_TOOL_SEAT,
        () => ctx.slots.register(
          // label 同样传 thunk：顶部行标题也要跟随当前语言
          { name: TOP_TOOL_SEAT, id: SEA_PANEL_ID, order: 6, label: () => currentCopy()['sea.entry'] },
          SeaToolIcon,
        ),
        'dsh-spirit: sea tool row',
      );
    } catch (err) {
      console.warn('[dsh-spirit] 星海入口注册失败:', err);
    }
  };

  try {
    ctx.slots.inject(TOP_TOOL_SEAT, () => {
      seaRowSeat = true;
      mountSea();
      return () => {
        seaRowSeat = false;
      };
    }, 'dsh-spirit: probe sea row seat');
    ctx.slots.inject(MAIN_SEAT, () => {
      seaMainSeat = true;
      mountSea();
      return () => {
        seaMainSeat = false;
      };
    }, 'dsh-spirit: probe sea main seat');
  } catch (err) {
    console.warn('[dsh-spirit] 顶部席位探测失败（不影响其余三个座位）:', err);
  }

  // ── 回响深链（v0.8.1）───────────────────────────────────────
  // 先落意图再切面板：页面已挂载时 subscribe 当场生效；未挂载时 take() 在
  // SeaPanel 挂载时补上。selectPanel 失败（宿主没注册 main key）只回 ack，不抛。
  openSeaController = (target: SeaIntentTarget): SeaOpenAck => {
    if (!seaMounted) return { ok: false, reason: 'unmounted' };
    seaIntent.request(target === 'graph' ? { tab: 'sea' } : { tab: 'records', view: 'echo' });
    const { svc, why } = resolveLayout(ctx, layoutSvc);
    if (svc?.selectPanel === undefined) return { ok: false, reason: 'unregistered', detail: why };
    try {
      svc.selectPanel(SEA_PANEL_ID);
      return { ok: true };
    } catch (err) {
      console.warn('[dsh-spirit] 打开星海回响失败:', why, err);
      return { ok: false, reason: 'unregistered', detail: `via ${why}; ${(err as Error).message}` };
    }
  };
  bindOpenSeaEvent();
}

/** 顶部行图标：一颗主星 + 四颗散星（16×16，随行字色）。 */
function SeaToolIcon({ size }: { size?: number }): ReactElement {
  const edge = size ?? 16;
  return createElement(
    'svg',
    { width: edge, height: edge, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    createElement('circle', { cx: 8, cy: 8, r: 2.3, fill: 'currentColor' }),
    createElement('circle', { cx: 3, cy: 4, r: 1.1, fill: 'currentColor' }),
    createElement('circle', { cx: 13, cy: 3.5, r: 1, fill: 'currentColor' }),
    createElement('circle', { cx: 12.5, cy: 12, r: 1.2, fill: 'currentColor' }),
    createElement('circle', { cx: 3.5, cy: 12.5, r: 0.9, fill: 'currentColor' }),
  );
}
