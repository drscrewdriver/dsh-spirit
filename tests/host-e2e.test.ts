/**
 * 真机 durable 回环（离线、真实 sqlite 库 + 真实 apply() 事件链）：
 *   session/event 采集 → 真实 DB 落库 → pre-step 注入 → 把注入行回喂成 session/event 走生效确认
 *   → 第二轮 pre-step 因指纹已提交而 unchanged（不重发）。
 *
 * 为什么这足以替代"真 LLM 双臂回合"作为注入 E2E 证据：spirit 的热路径**只读结构化事件 +
 * user kind 过滤，绝不读模型正文**（红线）。真 provider 相对这条链的唯一增量是"谁产出的 assistant 文本"，
 * 而 spirit 对其无感——所以直接喂真宿主会发出的那一串 session/event，走的就是真宿主里完全相同的处理路径。
 * 这里用的是**真文件 SQLite**（非内存镜像）：落库、schema v2、confirmInjected→指纹提交→unchanged 全部真实发生。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import { apply } from '../src/index.js';
import { SPIRIT_DEFAULTS, SPIRIT_SOURCE_KIND, type SpiritConfig, type SpiritLiveSettings } from '../src/contract.js';

type Handler = (...args: never[]) => unknown;
interface Message {
  id?: string | number;
  role?: string;
  source?: { kind?: string; form?: string };
  content?: unknown;
}
type Decision = { kind: string; messages: Message[] };

interface CtxStub {
  handlers: Map<string, Handler[]>;
  on(e: string, cb: Handler): void;
  inject(_n: string[], cb: (scope: { get(name: string): unknown }) => void): void;
  effect(_fn: () => void): void;
  get(_n: string): unknown;
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

function makeCtx(): CtxStub {
  const handlers = new Map<string, Handler[]>();
  return {
    handlers,
    on(e, cb) { const a = handlers.get(e) ?? []; a.push(cb); handlers.set(e, a); },
    inject(_n, cb) { cb({ get: () => undefined }); },
    effect() {},
    get() { return undefined; },
    logger: { info() {}, warn() {}, error() {} },
  };
}

function h(ctx: CtxStub, event: string): (...args: never[]) => unknown {
  const fn = ctx.handlers.get(event)?.[0];
  if (typeof fn !== 'function') throw new Error(`handler not registered: ${event}`);
  return fn;
}

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'spirit-e2e-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs.splice(0, dirs.length)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* win 句柄 */ }
  }
});

function cfg(dataDir: string, live?: Partial<SpiritLiveSettings>): SpiritConfig {
  const base: SpiritConfig = structuredClone(SPIRIT_DEFAULTS);
  return { ...base, dataDir, live: { ...base.live, ...live } };
}

const SESSION = { id: 'sess-9', header: { cwd: 'E:/ws' } };
const AGENT = { id: 'ag-1', session: SESSION };

describe('真机 durable 回环：真实 sqlite + 真实 apply() 事件链（采集→落库→注入→生效确认→抑制）', () => {
  it('full chain', async () => {
    const dir = tmp();
    const ctx = makeCtx();
    await apply(ctx as unknown as Parameters<typeof apply>[0], cfg(dir));

    const onEvent = h(ctx, 'session/event') as (session: unknown, event: unknown) => void;
    // —— 喂真宿主一轮会发出的结构化事件（用户轮 + 工具失败），累加进 watcher ——
    onEvent(SESSION, { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '跑一下构建' }] } });
    onEvent(SESSION, { type: 'turn/start', seq: 2, data: { turn: 1 } });
    onEvent(SESSION, { type: 'tool/call', seq: 3, data: { turn: 1, callId: 'c1', name: 'bash' } });
    onEvent(SESSION, { type: 'tool/result', seq: 4, data: { turn: 1, message: { toolCallId: 'c1', isError: true } } });

    // —— pre-step 注入（真宿主在 step 边界 takeSignals 消费累加器 → record 落库）——
    const onPreStep = h(ctx, 'agent/pre-step') as (payload: unknown, next: () => Promise<Decision>) => Promise<Decision>;
    const payload = { agent: AGENT, signal: { aborted: false } };
    const decision: Decision = { kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '跑一下构建' }] }] };
    const out1 = await onPreStep(payload, async () => decision);
    const injected = out1.messages[out1.messages.length - 1];
    expect(injected?.source?.kind).toBe(SPIRIT_SOURCE_KIND);
    const cardText = JSON.stringify(injected?.content ?? '');
    expect(cardText).toContain('状态：');
    expect(cardText).toContain('刚刚：'); // 有真实条目 ⇒ 近因段进卡
    const cardId = String(injected?.id ?? '');
    expect(cardId).toBeTruthy();

    // 真库断言：pre-step 结算已把一条体验条目落到**文件 SQLite**（非内存镜像）
    const probe = new DatabaseSync(join(dir, 'spirit.db'), { readOnly: true });
    const rows = probe.prepare('SELECT trigger, reaction FROM experience WHERE superseded_by IS NULL').all();
    probe.close();
    expect(rows.length, '应在真库落 ≥1 条体验').toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.trigger === 'tool_failure' && r.reaction === 'mild')).toBe(true);

    // —— 回喂注入行为 session/event，走生效确认链（真宿主就是这么把卡写回 durable log 的）——
    onEvent(SESSION, { type: 'user/message', seq: 6, data: { id: cardId, source: { kind: SPIRIT_SOURCE_KIND }, content: [{ type: 'text', text: cardText }] } });

    // —— 第二轮：只有确认过（指纹已提交）才会 unchanged，不再重发 ——
    const out2 = await onPreStep(payload, async () => ({ kind: 'enter', messages: decision.messages }));
    const appended2 = out2.messages.some((m) => m.source?.kind === SPIRIT_SOURCE_KIND);
    expect(appended2, '生效后第二轮不应再追加卡行（unchanged 抑制 = 指纹确认真跑通）').toBe(false);
  }, 20_000);

  it('旁路臂（live.bypass）：真库照落，但 pre-step 不注入', async () => {
    const dir = tmp();
    const ctx = makeCtx();
    await apply(ctx as unknown as Parameters<typeof apply>[0], cfg(dir, { bypass: true }));
    const onEvent = h(ctx, 'session/event') as (s: unknown, e: unknown) => void;
    onEvent(SESSION, { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] } });
    onEvent(SESSION, { type: 'turn/start', seq: 2, data: { turn: 1 } });
    onEvent(SESSION, { type: 'tool/call', seq: 3, data: { turn: 1, callId: 'c1', name: 'grep' } });
    onEvent(SESSION, { type: 'tool/result', seq: 4, data: { turn: 1, message: { toolCallId: 'c1', isError: true } } });
    const onPreStep = h(ctx, 'agent/pre-step') as (p: unknown, n: () => Promise<Decision>) => Promise<Decision>;
    const out = await onPreStep({ agent: AGENT, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [{ source: { kind: 'user' } }] }));
    expect(out.messages.some((m) => m.source?.kind === SPIRIT_SOURCE_KIND)).toBe(false);
    const probe = new DatabaseSync(join(dir, 'spirit.db'), { readOnly: true });
    const n = probe.prepare('SELECT COUNT(*) AS c FROM experience').get() as { c: number };
    probe.close();
    expect(n.c, '旁路必须留数据（对照组）').toBeGreaterThanOrEqual(1);
  }, 20_000);
});
