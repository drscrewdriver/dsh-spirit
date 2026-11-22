/**
 * html lang 订阅面守卫（v0.9.2 语言切换重渲染触发）。
 *
 * 审计钉死的缺口：语言切换本身不触发任何重渲染，pill/星海四面的文案跟随全靠
 * 用户交互（∞ 滞留）。use-html-lang.ts 是修复的触发器，这里钉死它的三条语义：
 *
 * 1. **lang 属性变化必须通知订阅者**（观察者挂在 documentElement、只认 lang）；
 * 2. **无 document 环境（node 用例）空订阅不抛**——与 copyOf 的环境守卫同款；
 * 3. **退订后不再通知**（重复 apply/卸载路径不漏挂不叠挂）。
 *
 * vitest node 环境没有真 DOM，也不引 jsdom（测试栈刻意零渲染依赖）：
 * document / MutationObserver 用手卷桩注入，模块级单例（listeners + observer）
 * 用 vi.resetModules + 动态 import 每例换新，互不串台。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 手卷 MutationObserver 桩：记下构造参数与 observe 目标，回调由测试手动触发。 */
function makeFakeObserverCtor() {
  const instances: Array<{
    callback: MutationCallback;
    observeTargets: unknown[];
    observeOptions: unknown[];
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  class FakeMutationObserver {
    callback: MutationCallback;
    disconnect = vi.fn();
    constructor(callback: MutationCallback) {
      this.callback = callback;
      const record = { callback, observeTargets: [] as unknown[], observeOptions: [] as unknown[], disconnect: this.disconnect };
      instances.push(record);
      // eslint 不在测试里跑，但保持与仓内桩风格一致：方法挂原型外
      (this as unknown as { observe(target: unknown, options: unknown): void }).observe = (target: unknown, options: unknown): void => {
        record.observeTargets.push(target);
        record.observeOptions.push(options);
      };
    }
  }
  return { ctor: FakeMutationObserver as unknown as typeof MutationObserver, instances };
}

/** 手卷 document 桩：只给订阅面真正读的两样——documentElement.lang 与 nothing else。 */
function makeFakeDocument(initialLang: string) {
  const element = { lang: initialLang };
  return { documentElement: element } as unknown as Document;
}

async function freshModule() {
  vi.resetModules();
  return await import('../client/src/use-html-lang.js');
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('use-html-lang', () => {
  it('lang 属性变化通知订阅者（观察者挂 documentElement、只认 lang）', async () => {
    const { ctor, instances } = makeFakeObserverCtor();
    vi.stubGlobal('document', makeFakeDocument('en'));
    vi.stubGlobal('MutationObserver', ctor);
    const mod = await freshModule();

    const seen: string[] = [];
    const unsubscribe = mod.subscribeHtmlLang(() => seen.push(mod.readHtmlLang()));
    expect(unsubscribe).toBeTypeOf('function');

    // 观察者只建一枚、挂在 documentElement 上、只过滤 lang 属性
    expect(instances).toHaveLength(1);
    expect(instances[0]!.observeTargets).toEqual([(document as unknown as { documentElement: unknown }).documentElement]);
    expect(instances[0]!.observeOptions).toEqual([{ attributes: true, attributeFilter: ['lang'] }]);

    // 模拟宿主写 <html lang="zh">（晚于 client apply 的实测时序）→ 观察者回调 → 订阅者被通知
    (document as unknown as { documentElement: { lang: string } }).documentElement.lang = 'zh';
    instances[0]!.callback([], instances[0] as unknown as MutationObserver);
    expect(seen).toEqual(['zh']);
  });

  it('第二个订阅者复用同一观察者（防重复 observe）', async () => {
    const { ctor, instances } = makeFakeObserverCtor();
    vi.stubGlobal('document', makeFakeDocument('zh'));
    vi.stubGlobal('MutationObserver', ctor);
    const mod = await freshModule();

    const hits: number[] = [];
    mod.subscribeHtmlLang(() => hits.push(1));
    mod.subscribeHtmlLang(() => hits.push(2));
    expect(instances).toHaveLength(1);

    // 一次 lang 变化，两个订阅者都被通知
    instances[0]!.callback([], instances[0] as unknown as MutationObserver);
    expect(hits).toEqual([1, 2]);
  });

  it('退订后不再通知；退订函数可重复调用不抛', async () => {
    const { ctor, instances } = makeFakeObserverCtor();
    vi.stubGlobal('document', makeFakeDocument('en'));
    vi.stubGlobal('MutationObserver', ctor);
    const mod = await freshModule();

    const hits: number[] = [];
    const unsubscribe = mod.subscribeHtmlLang(() => hits.push(1));
    unsubscribe();
    unsubscribe();
    instances[0]!.callback([], instances[0] as unknown as MutationObserver);
    expect(hits).toEqual([]);
  });

  it('无 document 环境：空订阅不抛、快照返回空串（node 用例的真实运行形态）', async () => {
    // 不 stub 任何全局——vitest node 环境本就没有 document
    const mod = await freshModule();
    const unsubscribe = mod.subscribeHtmlLang(() => {
      throw new Error('无 document 环境不应有通知');
    });
    expect(unsubscribe).toBeTypeOf('function');
    expect(() => unsubscribe()).not.toThrow();
    expect(mod.readHtmlLang()).toBe('');
  });

  it('快照现取：读的是 documentElement.lang 当前值（与 copyOf 同源）', async () => {
    vi.stubGlobal('document', makeFakeDocument('zh-CN'));
    const mod = await freshModule();
    expect(mod.readHtmlLang()).toBe('zh-CN');
    (document as unknown as { documentElement: { lang: string } }).documentElement.lang = 'en';
    expect(mod.readHtmlLang()).toBe('en');
  });
});
