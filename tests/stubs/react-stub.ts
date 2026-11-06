/**
 * react 运行时桩（仅供 vitest 解析 `client/src/**` 用）。
 *
 * 为什么需要它：本仓库刻意**不装 react 运行时**（只有 `@types/react`，react 由宿主注入，
 * esbuild 侧 external）。而 v0.3 的顶部入口座位判定是纯逻辑、且是"挂多了出现三份面板 /
 * 挂少了整个入口看不见"的静默失败面，必须能被断言 —— 于是把 entry 的依赖链上唯一缺失的
 * 运行时补一个桩，而不是放弃这条门禁。
 *
 * ⚠️ 这里**不做渲染**：`createElement` 只返回普通对象，钩子全是空实现。被测的是
 * "注册了哪些座位、每座几枚、label 是不是 thunk"，不是组件行为（组件行为归真机冒烟）。
 */

export interface StubElement {
  type: unknown;
  props: Record<string, unknown> | null;
  children: unknown[];
}

export function createElement(type: unknown, props: Record<string, unknown> | null = null, ...children: unknown[]): StubElement {
  return { type, props, children };
}

export function useState<T>(initial: T | (() => T)): [T, (next: T) => void] {
  const value = typeof initial === 'function' ? (initial as () => T)() : initial;
  return [value, () => {}];
}

export function useRef<T>(initial: T): { current: T } {
  return { current: initial };
}

export function useEffect(): void {
  /* 渲染期副作用不在本 suite 的验证范围 */
}

export function useMemo<T>(factory: () => T): T {
  return factory();
}

export function useCallback<T>(callback: T): T {
  return callback;
}

export function useSyncExternalStore<T>(): T {
  throw new Error('react-stub: useSyncExternalStore 不参与单测');
}

export default {
  createElement,
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
  useSyncExternalStore,
};
