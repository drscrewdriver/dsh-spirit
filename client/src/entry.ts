/**
 * dsh-spirit — 浏览器半边入口（TS 源，scripts/build-client.mjs 经 esbuild 打成 dist/client.js）。
 *
 * 只挂两个座位，各一个：
 * 1. `settings.section` → 顶层「手记」分节（只读投影；设置表单交给宿主自动生成的 volatile 面）
 * 2. `conversation.input.left` → 会话情绪开关 pill
 *
 * ⚠️ **一个插件在一个座位上只能登记一次，且不要同时挂多处**：姊妹包实测过"设置里
 * 出现三份同一面板"的回归——起因是误以为"座位没被声明时 inject 不触发"，实际上
 * 宿主会同时声明多个座位，于是三次注册全部生效。这里结构性地只留两个座位。
 *
 * `slots` 之外的客户端服务一律**不进声明式 inject**：可选服务晚到时，声明式注入会让
 * apply 永久挂起（UI 全静默消失且无任何报错），需要时在调用点 `ctx.get(...)` 懒解析。
 */

import { copyOf } from './copy.js';
import { SpiritPanel } from './panel.js';
import { SpiritPill } from './pill.js';
import { makeRpc } from './rpc.js';
import type { SpiritClientCtx } from './env.js';

export const inject = ['slots'];

export const SETTINGS_SEAT = 'settings.section';
export const PILL_SEAT = 'conversation.input.left';

/** 判定期：够宿主把座位声明出来；过了还没挂上就响亮告警（静默消失最难查）。 */
const SEAT_PROBE_MS = 3_000;

export function apply(ctx: SpiritClientCtx): void {
  const rpc = makeRpc();
  const copy = copyOf(typeof document === 'undefined' ? undefined : document.documentElement.lang);
  let settingsMounted = false;
  let pillMounted = false;

  try {
    ctx.slots.inject(SETTINGS_SEAT, () => {
      settingsMounted = true;
      try {
        return ctx.slots.register(
          { name: SETTINGS_SEAT, id: 'dsh-spirit', order: 260, label: copy['section.label'], inject: () => ({ rpc }) },
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
  }, SEAT_PROBE_MS);
}
