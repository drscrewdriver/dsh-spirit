/**
 * `<html lang>` 属性变化的 React 订阅面（语言真相源 = documentElement.lang，见 copy.ts）。
 *
 * 为什么单独成文件：取词（copy.ts）必须零 React 依赖——client-copy.test.ts 这类
 * 纯 node 用例要 import 它，React 订阅面放这里（与 prime-memory 的 i18n-react.ts 同构）。
 *
 * 真相源为什么是 html lang 而不是宿主 locale 服务：spirit 刻意不声明宿主服务
 * （声明式 inject 的挂起风险见 entry.ts 头注），且多线宿主适配下 MutationObserver
 * 全宿主可用——零新服务依赖，与 copyOf 现取的真相源同一条。
 *
 * 审计背景（v0.9.2）：语言切换本身不触发任何重渲染，跟随全靠各面自驱重渲染
 * （panel 轮询 ≤5s / 做梦 tab 轮询 ≤30s）或用户交互（pill / 星海四面=∞ 滞留）。
 * 本订阅面给不达标面一个确定性触发；启动期冻结（宿主写 lang 晚于 client apply，
 * entry.ts 头注实测）也由这条通知唤醒。
 */
import { useSyncExternalStore } from 'react';

type Listener = () => void;

const listeners = new Set<Listener>();
/** 单例观察者：首个订阅者出现时建一次（防重复 observe），随进程存活。 */
let observer: MutationObserver | undefined;

/** 快照现取：与 copyOf 的取词源同一条；无 document 环境（node 用例/桩）返回空串。 */
function readLang(): string {
  return typeof document === 'undefined' ? '' : document.documentElement.lang;
}

/** 挂观察者：只认 documentElement 上的 lang 属性变化，其余属性不碰。 */
function ensureObserved(): void {
  if (observer !== undefined) return;
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return;
  const root = document.documentElement;
  if (root === null) return;
  observer = new MutationObserver(() => {
    // 拷贝后再遍历：通知途中订阅/退订不改锁步（Set 迭代期修改会抛）
    for (const listener of [...listeners]) listener();
  });
  observer.observe(root, { attributes: true, attributeFilter: ['lang'] });
}

/** 稳定引用的订阅器：避免每次渲染换函数导致 useSyncExternalStore 反复重订阅。 */
export function subscribeHtmlLang(onChange: Listener): () => void {
  // node 环境（无 document）空订阅：语义是「永不通知」，与 copyOf 的环境守卫同款
  if (typeof document === 'undefined') return () => {};
  ensureObserved();
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** useSyncExternalStore 的快照读法（getSnapshot 与 getServerSnapshot 同形）。 */
export function readHtmlLang(): string {
  return readLang();
}

/**
 * 订阅 html lang 变化以触发重渲染。接线形态：`const copy = copyOf(useHtmlLang())`。
 * 每个不达标面各自调用（面数少、订阅廉价，且不依赖父面级联——未来谁加 React.memo 不破）。
 */
export function useHtmlLang(): string {
  return useSyncExternalStore(subscribeHtmlLang, readHtmlLang, readHtmlLang);
}
