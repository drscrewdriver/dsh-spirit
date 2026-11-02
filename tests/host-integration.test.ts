/**
 * 端到端集成：通过真实的 `apply(ctx, config)` 与真实的 cordis 事件注册链，
 * 断言 `agent/pre-step` 处理函数真的把一条 `plugin:spirit` 行追加到 decision.messages 尾部，
 * 且关闸/旁路臂真的零追加。
 *
 * 为什么单独立这份文件：unit 用例直接调 `spirit.onPreStep`，绕过 index 的装配与 hook 注册。
 * 这条链（`apply()` 里 `registerCardPreStep` 用 `ctx.on('agent/pre-step', …)` 登记的处理器、
 * createUserMessage 的真实 import、可选服务缺席时的降级）只有在跑过真实 apply() 才照得出来。
 * 它是"注入 E2E + 零字节门"在**没有 LLM 凭据**环境下能拿到的最强离线证据。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { apply } from '../src/index.js';
import { SPIRIT_DEFAULTS, SPIRIT_SOURCE_KIND, type SpiritConfig, type SpiritLiveSettings } from '../src/contract.js';

/** 注入行的最小心智模型（不依赖宿主消息类型）；Decision = pre-step 的 enter 形状。 */
interface Message {
  role?: string;
  source?: { kind?: string; form?: string };
  content?: unknown;
}
type Decision = { kind: string; messages: Message[] };
type PreStepHandler = (payload: unknown, next: () => Promise<Decision>) => Promise<Decision>;
type Handler = (...args: never[]) => unknown;

interface CtxStub {
  on(event: string, cb: Handler): void;
  inject(names: string[], cb: (scope: { get(name: string): unknown }) => void): void;
  effect(fn: () => void): void;
  get(name: string): unknown;
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
  handlers: Map<string, Handler[]>;
}

function makeCtx(): CtxStub {
  const handlers = new Map<string, Handler[]>();
  const ctx: CtxStub = {
    handlers,
    on(event, cb) {
      const arr = handlers.get(event) ?? [];
      arr.push(cb);
      handlers.set(event, arr);
    },
    // 只声明 webServer；回调按缺席处理（不挂面板），与 headless 真宿主同形
    inject(_names, cb) {
      cb({ get: () => undefined });
    },
    effect(_fn) { /* 生命周期，测试内不触发 */ },
    get() { return undefined; },
    logger: { info() {}, warn() {}, error() {} },
  };
  // capability 的属性读兜底：未声明服务时直接属性读会 undefined（不抛即可）
  return ctx;
}

function cfg(dataDir: string, patch: { enabled?: boolean; live?: Partial<SpiritLiveSettings> } = {}): SpiritConfig {
  const base: SpiritConfig = structuredClone(SPIRIT_DEFAULTS);
  const live: SpiritLiveSettings = { ...base.live, ...patch.live };
  return { ...base, enabled: patch.enabled ?? true, dataDir, live } as SpiritConfig;
}

function userMessage(text: string): Message {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

function preStepPayload(): Record<string, unknown> {
  // host-shape 取值器容忍缺失字段；这里给一个非子代理、有会话与 workspace 的 agent 形状
  return {
    agent: {
      id: 'agent-1',
      session: { id: 'session-1', workspace: { path: '/tmp/ws' } },
    },
    signal: { aborted: false },
  };
}

async function prime(ctx: CtxStub, config: SpiritConfig): Promise<void> {
  await apply(ctx as unknown as Parameters<typeof apply>[0], config);
}

/** 取已注册的 pre-step 处理器（缺失即抛；类型按测试实际的 (payload,next)→decision 形） */
function preStepHandler(ctx: CtxStub): PreStepHandler {
  const handler = ctx.handlers.get('agent/pre-step')?.[0];
  if (typeof handler !== 'function') throw new Error('pre-step 处理器未注册');
  return handler as unknown as PreStepHandler;
}

describe('apply() 装配 → agent/pre-step 注入链（真实事件分发，无 LLM）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0, dirs.length)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* win 句柄未放时静默 */ }
    }
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'spirit-int-'));
    dirs.push(d);
    return d;
  };

  it('注入臂：pre-step 真把 plugin:spirit 快照行追加到 messages 尾部', async () => {
    const ctx = makeCtx();
    await prime(ctx, cfg(tmp()));
    const handler = preStepHandler(ctx);
    const original = [userMessage('继续')];
    const decision = { kind: 'enter', messages: original };
    const out = await handler(preStepPayload(), async () => decision);
    expect(out.kind).toBe('enter');
    expect(out.messages.length).toBeGreaterThan(original.length);
    const appended = out.messages[out.messages.length - 1];
    expect(appended?.source?.kind).toBe(SPIRIT_SOURCE_KIND);
    expect(appended?.source?.form).toBe('snapshot');
    const text = JSON.stringify(appended?.content ?? '');
    expect(text).toContain('状态：');
    // 原数组未被就地改写（是追加新数组，不是 push 进 next() 的对象）
    expect(original.length).toBe(1);
  });

  it('旁路臂（live.bypass）：照常装载但 pre-step 零追加，且不改 next() 内容', async () => {
    const ctx = makeCtx();
    await prime(ctx, cfg(tmp(), { live: { bypass: true } }));
    const handler = preStepHandler(ctx);
    const original = [userMessage('继续')];
    const decision = { kind: 'enter', messages: original };
    const out = await handler(preStepPayload(), async () => decision);
    // 旁路：不注入——返回的消息里不得有 plugin:spirit 行
    expect(out.messages.some((m) => m.source?.kind === SPIRIT_SOURCE_KIND)).toBe(false);
  });

  it('关闸臂（enabled=false）：pre-step 处理器原样透传 next() 返回对象（字面零字节）', async () => {
    const ctx = makeCtx();
    await prime(ctx, cfg(tmp(), { enabled: false }));
    const handler = preStepHandler(ctx);
    const decision = { kind: 'enter', messages: [userMessage('继续')] };
    const out = await handler(preStepPayload(), async () => decision);
    // 关闸必须把 next() 的原对象透传回来（同一引用 = 真的零改动、零注入）
    expect(out).toBe(decision);
  });
});
