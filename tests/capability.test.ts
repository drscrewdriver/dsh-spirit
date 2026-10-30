import { describe, expect, it } from 'vitest';

import { detectSessionEventsShape, getService, probeCapabilities, readSessionEvents } from '../src/capability.js';

/** 模拟 cordis 代理：**未声明 inject** 时属性读直接抛，不是给个 undefined。 */
function throwingCtx(names: string[]): Record<string, unknown> {
  const store = new Map<string, unknown>();
  for (const name of names) store.set(name, { section: () => undefined });
  return {
    get(key: string) {
      return store.get(key);
    },
    get systemPrompt(): never {
      throw new Error('cannot get property "systemPrompt" without inject');
    },
  };
}

describe('getService（属性读抛错也要拿到服务）', () => {
  it('属性读可用时走属性读', () => {
    const svc = { section() {} };
    expect(getService({ systemPrompt: svc }, 'systemPrompt')).toBe(svc);
  });

  it('属性读抛错时退到 ctx.get', () => {
    const ctx = throwingCtx(['systemPrompt']);
    expect(getService(ctx, 'systemPrompt')).toBeDefined();
  });

  it('两者都没有 ⇒ undefined，不抛', () => {
    expect(getService({}, 'sessions')).toBeUndefined();
    expect(getService(null, 'sessions')).toBeUndefined();
    expect(getService('ctx', 'sessions')).toBeUndefined();
  });
});

describe('probeCapabilities', () => {
  it('空 ctx ⇒ 全 false（缺能力就是停用，不是报错）', () => {
    expect(probeCapabilities({})).toEqual({
      systemPromptSection: false,
      sessionsService: false,
      registerMessageProjection: false,
      rpcSurface: false,
    });
  });

  it('section 是函数才算有；同名但不是函数的字段不算', () => {
    expect(probeCapabilities({ systemPrompt: { section: 'x' } }).systemPromptSection).toBe(false);
    expect(probeCapabilities({ systemPrompt: { section: () => undefined } }).systemPromptSection).toBe(true);
  });

  it('webServer 或 connection 任一存在即算有 RPC 面', () => {
    expect(probeCapabilities({ connection: {} }).rpcSurface).toBe(true);
    expect(probeCapabilities({ webServer: {} }).rpcSurface).toBe(true);
  });
});

describe('会话事件双面形状', () => {
  it('数组属性 / snapshotEvents() 方法 / 都没有，三种形状各自判对', () => {
    expect(detectSessionEventsShape({ events: [] })).toBe('events');
    expect(detectSessionEventsShape({ snapshotEvents: () => [] })).toBe('snapshotEvents');
    expect(detectSessionEventsShape({})).toBe('none');
    expect(detectSessionEventsShape(null)).toBe('none');
  });

  it('读事件按优先级取形，方法抛错退空数组而不抛', () => {
    expect(readSessionEvents({ events: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(readSessionEvents({ snapshotEvents: () => [{ b: 2 }] })).toEqual([{ b: 2 }]);
    expect(readSessionEvents({ snapshotEvents: () => { throw new Error('boom'); } })).toEqual([]);
    // 返回非数组也退空，不把垃圾形状留给调用方
    expect(readSessionEvents({ snapshotEvents: () => 42 })).toEqual([]);
    expect(readSessionEvents(undefined)).toEqual([]);
  });
});
