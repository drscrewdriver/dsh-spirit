/**
 * `spiritEcho` 服务端投影（v0.8.2 换源后）：注册形状 / 会话隔离 / 令牌判脏 / 引用稳定 / schema。
 *
 * 这一份钉的是「侧栏读的是什么」：
 * - state 只存 `{sessionId, token}`，绝不落回响文本（checkpoint 回放不会撒谎）；
 * - view 的 segments 只含**本会话被召回**的句子，total 也是本会话口径（不再是全局缓冲）；
 * - 判脏令牌由库派生，重启后仍单调——不会因为进程内计数器归零而误判「没变」。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';

import { openSpiritDb } from '../src/db/open.js';
import {
  SPIRIT_ECHO_KEY,
  registerEchoProjection,
  stateSchema,
  viewSchema,
} from '../src/projection/echo.js';
import type { SpiritEchoProjectionState, SpiritEchoView } from '../src/projection/echo.js';
import { EchoRecallStore } from '../src/store/echo-recall.js';
import { EchoRefStore } from '../src/store/echo-ref.js';
import { resolveEchoId } from '../src/echo/identity.js';

interface CapturedDef {
  key: string;
  stateVersion: number;
  stateSchema: { parse(value: unknown): unknown };
  init(header: unknown): SpiritEchoProjectionState;
  apply(state: SpiritEchoProjectionState, event: { type: string; data: unknown }): SpiritEchoProjectionState;
  wire: { viewSchema: { parse(value: unknown): unknown }; view(state: SpiritEchoProjectionState): SpiritEchoView };
  schema: { parse(value: unknown): unknown };
  view(state: SpiritEchoProjectionState): SpiritEchoView;
}

let dir = '';
let db: DatabaseSync | undefined;
let store: EchoRecallStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-echo-proj-'));
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error(`库应打开成功：${String(opened.err)}`);
  db = opened.db;
  store = new EchoRecallStore({ db: () => db });
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* 已关闭 */
  }
  db = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** 伪注册表：只实现我们依赖的 `register`，并记录注入请求。 */
function fakeCtx(service: unknown): { ctx: Context; defs: CapturedDef[]; injectCalls: string[][] } {
  const defs: CapturedDef[] = [];
  const injectCalls: string[][] = [];
  const ctx = {
    inject: (deps: string[], callback: (injected: unknown) => void) => {
      injectCalls.push(deps);
      callback({ sessionProjections: service });
    },
  } as unknown as Context;
  return { ctx, defs, injectCalls };
}

function captured(): CapturedDef {
  const { ctx, defs } = fakeCtx({ register: (def: CapturedDef) => { defs.push(def); return () => {}; } });
  registerEchoProjection(ctx, store);
  const def = defs[0];
  if (def === undefined) throw new Error('未捕获到 projection 定义');
  return def;
}

const SESSION = 'session-a';
const OTHER = 'session-b';

function recall(sessionId: string, excerpts: string[], at: number): void {
  store.record({ sessionId, agentId: 'agent', at, kind: 'injected', fingerprint: `fp-${at}`, excerpts });
}

describe('spiritEcho 投影（v10 落档源）', () => {
  it('以 key=spiritEcho、stateVersion=7 注册，并走 sessionProjections 注入', () => {
    const { ctx, defs, injectCalls } = fakeCtx({ register: (def: CapturedDef) => { defs.push(def); return () => {}; } });
    registerEchoProjection(ctx, store);
    expect(injectCalls[0]).toEqual(['sessionProjections']);
    expect(defs[0]?.key).toBe(SPIRIT_ECHO_KEY);
    expect(defs[0]?.stateVersion).toBe(7);
  });

  it('v7 帧：records[]（echo-uuid）+ recall（recall-uuid）+ tone；老帧仍过 schema 校验', () => {
    const { ctx, defs } = fakeCtx({ register: (def: CapturedDef) => { defs.push(def); return () => {}; } });
    const refs = new EchoRefStore({ db: () => db });
    const echoId = resolveEchoId(db!, 'task', 'task-a')!;
    refs.upsert({ sessionId: SESSION, echoId, kind: 'task', memId: 'task-a', title: 'plugin-9lang-five-dim', at: 2_000, recordTs: 1_500, lastRecallId: 'recall-2000' });
    store.record({ sessionId: SESSION, agentId: 'agent', at: 2_000, kind: 'injected', id: 'recall-2000', preview: '状态：平常', text: '状态：平常·按平时那样说\n线程：plugin-9lang-five-dim · 进行中' });
    registerEchoProjection(ctx, store, refs);
    const def = defs[0];
    if (def === undefined) throw new Error('未捕获到 projection 定义');
    const view = def.view(def.init({ id: SESSION }));
    expect(view.records?.map((row) => row.echoId)).toEqual([echoId]);
    expect(view.records?.[0]?.title).toBe('plugin-9lang-five-dim');
    expect(view.records?.[0]?.recordTs).toBe(1_500);
    expect(view.records?.[0]?.lastRecallId).toBe('recall-2000');
    expect(view.recall?.recallId).toBe('recall-2000');
    expect(view.tone?.state).toBe('平常·按平时那样说');
    // 老帧仍合法（存在才校验），records/recall/tone 缺失不丢整帧
    expect(viewSchema.parse({ token: 1, total: 0, segments: [], steps: [] })).toBeTruthy();
  });

  it('init 取 header.id；state 只含 sessionId + token，序列化后不含任何召回文本', () => {
    recall(SESSION, ['不该进 state 的句子'], 1000);
    const def = captured();
    const state = def.init({ id: SESSION });
    expect(state.sessionId).toBe(SESSION);
    expect(state.token).toBeGreaterThan(0);
    expect(JSON.stringify(state)).not.toContain('不该进 state 的句子');
    expect(Object.keys(state).sort()).toEqual(['sessionId', 'token']);
  });

  it('view 只含本会话段落，最新在前，total 也是本会话口径', () => {
    recall(SESSION, ['本会话第一段'], 1000);
    recall(SESSION, ['本会话第二段'], 2000);
    recall(OTHER, ['别人的段落'], 3000);
    const def = captured();
    const view = def.view(def.init({ id: SESSION }));
    expect(view.segments.map((seg) => seg.excerpt)).toEqual(['本会话第二段', '本会话第一段']);
    expect(view.total).toBe(2);
  });

  it('令牌不变 ⇒ apply 返回同引用；有新写入 ⇒ 返回新 state 且令牌变大', () => {
    recall(SESSION, ['一句'], 1000);
    const def = captured();
    const state = def.init({ id: SESSION });
    expect(def.apply(state, { type: 'session/event', data: {} })).toBe(state);
    recall(SESSION, ['又一句'], 2000);
    const next = def.apply(state, { type: 'session/event', data: {} });
    expect(next).not.toBe(state);
    expect(next.token).toBeGreaterThan(state.token);
  });

  it('同一 state 连续两次 view 返回同一引用（registry 据此判脏）', () => {
    recall(SESSION, ['稳定引用'], 1000);
    const def = captured();
    const state = def.init({ id: SESSION });
    expect(def.view(state)).toBe(def.view(state));
  });

  it('lastStep 反映最近一轮决策：跳过只因门名落地，不产生段落', () => {
    store.record({ sessionId: SESSION, agentId: 'agent', at: 2000, kind: 'skipped', reason: 'unchanged' });
    const def = captured();
    const view = def.view(def.init({ id: SESSION }));
    expect(view.segments).toEqual([]);
    expect(view.total).toBe(0);
    expect(view.lastStep).toEqual({ id: 'recall-2000', at: 2000, kind: 'skipped', reason: 'unchanged', preview: '' });
    expect(view.steps).toHaveLength(1);
  });

  it('会话 id 缺失：空态而非跨会话兜底', () => {
    recall(OTHER, ['别人的'], 1000);
    const def = captured();
    expect(def.init({}).sessionId).toBe('');
    expect(def.view(def.init({})).segments).toEqual([]);
    expect(def.apply({ sessionId: '', token: 0 }, { type: 'x', data: {} })).toEqual({ sessionId: '', token: 0 });
  });

  it('stateSchema 拒收缺 token / 负数的 state', () => {
    expect(() => stateSchema.parse({ sessionId: SESSION })).toThrow();
    expect(() => stateSchema.parse({ sessionId: SESSION, token: -1 })).toThrow();
    expect(stateSchema.parse({ sessionId: SESSION, token: 3 })).toEqual({ sessionId: SESSION, token: 3 });
  });

  it('viewSchema 拒收坏形状（缺 token / kind 越界），合法帧原样返回', () => {
    expect(() => viewSchema.parse({ total: 0, segments: [], steps: [] })).toThrow();
    expect(() => viewSchema.parse({ token: 1, total: 0, segments: [], steps: [], lastStep: { at: 1, kind: 'x', reason: '' } })).toThrow();
    const ok: SpiritEchoView = {
      token: 1,
      total: 1,
      segments: [{ excerpt: '一句', firstTs: 1, lastTs: 2, times: 1 }],
      steps: [{ id: 'echo-2', at: 2, kind: 'injected', reason: 'injected', preview: '状态：平常' }],
      lastStep: { id: 'recall-2', at: 2, kind: 'injected', reason: 'injected', preview: '状态：平常' },
    };
    expect(viewSchema.parse(ok)).toBe(ok);
  });

  it('库不可用：视图退化为空摘要而不抛', () => {
    const dead = new EchoRecallStore({ db: () => undefined });
    const { ctx, defs } = fakeCtx({ register: (def: CapturedDef) => { defs.push(def); return () => {}; } });
    registerEchoProjection(ctx, dead);
    const def = defs[0];
    if (def === undefined) throw new Error('未捕获到 projection 定义');
    const view = def.view(def.init({ id: SESSION }));
    expect(view).toEqual({ token: 0, total: 0, segments: [], steps: [] });
  });
});
