/**
 * 回响的服务端投影（`spiritEcho`）。
 *
 * 消费方是 `dsh-brief-sidebar` 的「回响」页签：它读投影帧，不读 RPC。
 *
 * v0.8.2 起**换源**：从进程内 `EchoLog`（观测灯）换成 `echo_recall` / `echo_step`
 * （v10 两表的持久面）。原因不是性能，是语义——回响是「本会话被 spirit 召回过的段落」，
 * 用户重启后应该还在；而 `EchoLog` 重启归零，拿它当侧栏真值就是在撒谎。
 *
 * 四条边界：
 * 1. **只带被召回的那一句**：帧里的 `segments[].excerpt` 是截断后的召回句（≤240），
 *    不是注入卡正文；全文仍只在会话日志里，星海「翻阅 → 回响」继续走 `inject-echo` RPC。
 * 2. **state 不落文本**：只存 `{sessionId, token}`，checkpoint 回放不会把旧卡当新回响。
 * 3. **O(1) 判脏**：token 库派生（步骤数 × 1e6 + 召回次数和），重启后仍单调，不会因为
 *    进程内计数器归零而误判「没变」。
 * 4. **库不可用即空摘要**：`EchoRecallStore` 降级时返回空，不抛穿 registry。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { EchoRecallSegment, EchoRecallStore } from '../store/echo-recall.js';
import type { EchoRefStore } from '../store/echo-ref.js';

/** 投影 key（消费方 dsh-brief-sidebar 的常量与此刻字面量一致）。 */
export const SPIRIT_ECHO_KEY = 'spiritEcho';

/** 单帧最多回给客户端的条数。 */
const ECHO_VIEW_LIMIT = 20;

/** 一条被召回的回响段（展示面）。 */
export interface SpiritEchoViewSegment {
  excerpt: string;
  firstTs: number;
  lastTs: number;
  times: number;
}

/** 最近一轮的注入决策（回答「这一轮为什么没卡」）。 */
export interface SpiritEchoViewStep {
  /** 条目编号（`echo-<ts_ms>`）：侧栏据此请求 `echo-detail` 拿原文。 */
  id: string;
  at: number;
  kind: 'injected' | 'skipped';
  reason: string;
  /** 卡首 200 字压平（侧栏列表一行）；跳过行为空串。 */
  preview: string;
  /** 内容优先的标题（v5）：如线程任务名 `plugin-9lang-five-dim`；老帧缺省 ⇒ 侧栏退到 preview。 */
  title?: string;
  /** 指向的真源（memid）：把回响挂回具体记忆条目（任务/交付/体验/记忆/目标）。 */
  refs?: Array<{ kind: string; id: string; label: string }>;
}

/** 一条回响记录（v7）：echoId = echo-<uuid>，属于记录本身（progress/done 卡片）。 */
export interface SpiritEchoViewRecord {
  echoId: string;
  sessionId: string;
  kind: string;
  memId: string;
  title: string;
  times: number;
  /** 记录自身时间（展示"记录时间"）。 */
  recordTs: number;
  firstTs: number;
  lastTs: number;
  lastRecallId: string;
}

/** 旧名别名（一版兼容）。 */
export type SpiritEchoViewRef = SpiritEchoViewRecord;

/** 最近一次回响事件（v7）：recall-<uuid>。 */
export interface SpiritEchoViewRecall {
  recallId: string;
  at: number;
  flashback: boolean;
}

/** 语气/状态（v6，特殊格式、非引用）。 */
export interface SpiritEchoViewTone {
  at: number;
  state?: string;
  opening?: string;
}

/** 投影帧的 wire 形状。 */
export interface SpiritEchoView {
  token: number;
  /** 本会话被召回过的段落总数（去重后）。 */
  total: number;
  /** 本会话最近被召回的段落，最新在前，≤20。 */
  segments: SpiritEchoViewSegment[];
  /** 本会话最近几轮回响条目（含跳过），最新在前，≤5。 */
  steps: SpiritEchoViewStep[];
  lastStep?: SpiritEchoViewStep;
  /** 记录聚合（v7 主数据）：每行 = 一条被想起的记录（echo-<uuid>）。 */
  records?: SpiritEchoViewRecord[];
  /** 旧名别名（一版兼容，内容同 records）。 */
  refs?: SpiritEchoViewRecord[];
  /** 最近一次回响事件（recall-<uuid>）。 */
  recall?: SpiritEchoViewRecall;
  /** 语气/状态（特殊格式）：最近一条含状态/开场的轮次。 */
  tone?: SpiritEchoViewTone;
}

/** 持久态：只有会话 id 与令牌，绝不含回响正文。 */
export interface SpiritEchoProjectionState {
  sessionId: string;
  token: number;
}

/** registry 只需要 `parse`（与 prime-memory 自实现 schema 同一纪律，不引 zod）。 */
interface SchemaLike<T> {
  parse(value: unknown): T;
}

function invalid(what: string, detail: string): never {
  throw new Error(`${what}: ${detail}`);
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(what, '期望普通对象');
  return value as Record<string, unknown>;
}

function requireCounter(value: unknown, what: string, field: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(what, `${field} 必须是非负整数`);
  }
}

/** 持久态校验：registry 在回放 checkpoint 前调用；不合法整行丢弃。 */
export const stateSchema: SchemaLike<SpiritEchoProjectionState> = {
  parse: (value) => {
    const root = requireRecord(value, 'spiritEcho.state');
    if (typeof root['sessionId'] !== 'string') invalid('spiritEcho.state', 'sessionId 必须是字符串');
    requireCounter(root['token'], 'spiritEcho.state', 'token');
    return value as SpiritEchoProjectionState;
  },
};

/**
 * wire view 校验：合法原样返回同一引用（registry 按 Object.is 比较），非法抛错
 *（静默透传会把越界帧带进客户端）。未知键容忍：新增字段不得打断整条驱动链。
 */
export const viewSchema: SchemaLike<SpiritEchoView> = {
  parse: (value) => {
    const root = requireRecord(value, 'spiritEcho.view');
    requireCounter(root['token'], 'spiritEcho.view', 'token');
    requireCounter(root['total'], 'spiritEcho.view', 'total');
    if (!Array.isArray(root['segments'])) invalid('spiritEcho.view', 'segments 必须是数组');
    (root['segments'] as unknown[]).forEach((raw, index) => {
      const at = `spiritEcho.view.segments[${index}]`;
      const item = requireRecord(raw, at);
      if (typeof item['excerpt'] !== 'string') invalid(at, 'excerpt 必须是字符串');
      requireCounter(item['firstTs'], at, 'firstTs');
      requireCounter(item['lastTs'], at, 'lastTs');
      requireCounter(item['times'], at, 'times');
    });
    const step = root['lastStep'];
    if (step !== undefined) parseStep(step, 'spiritEcho.view.lastStep');
    if (!Array.isArray(root['steps'])) invalid('spiritEcho.view', 'steps 必须是数组');
    (root['steps'] as unknown[]).forEach((raw, index) => {
      parseStep(raw, `spiritEcho.view.steps[${index}]`);
    });
    // v7 新增：records / recall 存在才校验（缺字段的老帧仍合法）
    for (const key of ['records', 'refs'] as const) {
      if (root[key] === undefined) continue;
      if (!Array.isArray(root[key])) invalid('spiritEcho.view', `${key} 必须是数组`);
      (root[key] as unknown[]).forEach((raw, index) => {
        const at = `spiritEcho.view.${key}[${index}]`;
        const row = requireRecord(raw, at);
        for (const field of ['echoId', 'refId', 'sessionId', 'kind', 'memId', 'title', 'lastRecallId', 'lastEchoStepId'] as const) {
          if (row[field] !== undefined && typeof row[field] !== 'string') invalid(at, `${field} 必须是字符串`);
        }
        for (const field of ['times', 'firstTs', 'lastTs'] as const) {
          requireCounter(row[field], at, field);
        }
        if (row['recordTs'] !== undefined) requireCounter(row['recordTs'], at, 'recordTs');
      });
    }
    if (root['recall'] !== undefined) {
      const recall = requireRecord(root['recall'], 'spiritEcho.view.recall');
      if (typeof recall['recallId'] !== 'string' || recall['recallId'] === '') invalid('spiritEcho.view.recall', 'recallId 必须是非空字符串');
      requireCounter(recall['at'], 'spiritEcho.view.recall', 'at');
      if (typeof recall['flashback'] !== 'boolean') invalid('spiritEcho.view.recall', 'flashback 必须是布尔值');
    }
    if (root['tone'] !== undefined) {
      const tone = requireRecord(root['tone'], 'spiritEcho.view.tone');
      requireCounter(tone['at'], 'spiritEcho.view.tone', 'at');
      if (tone['state'] !== undefined && typeof tone['state'] !== 'string') invalid('spiritEcho.view.tone', 'state 必须是字符串');
      if (tone['opening'] !== undefined && typeof tone['opening'] !== 'string') invalid('spiritEcho.view.tone', 'opening 必须是字符串');
    }
    return value as SpiritEchoView;
  },
};

function parseStep(value: unknown, at: string): void {
  const row = requireRecord(value, at);
  if (typeof row['id'] !== 'string' || row['id'] === '') invalid(at, 'id 必须是非空字符串');
  requireCounter(row['at'], at, 'at');
  if (row['kind'] !== 'injected' && row['kind'] !== 'skipped') invalid(at, 'kind 必须是 injected/skipped');
  if (typeof row['reason'] !== 'string') invalid(at, 'reason 必须是字符串');
  if (typeof row['preview'] !== 'string') invalid(at, 'preview 必须是字符串');
  // 新增字段「存在才校验」（与 prime-memory slots 同一兼容纪律：
  // 缺字段的老帧仍合法，否则历史 checkpoint 会被整条丢弃。）
  if (row['title'] !== undefined && typeof row['title'] !== 'string') invalid(at, 'title 必须是字符串');
  if (row['refs'] !== undefined) {
    if (!Array.isArray(row['refs'])) invalid(at, 'refs 必须是数组');
    (row['refs'] as unknown[]).forEach((raw, index) => {
      const ref = requireRecord(raw, `${at}.refs[${index}]`);
      if (typeof ref['kind'] !== 'string' || ref['kind'] === '') invalid(`${at}.refs[${index}]`, 'kind 必须是非空字符串');
      if (typeof ref['id'] !== 'string' || ref['id'] === '') invalid(`${at}.refs[${index}]`, 'id 必须是非空字符串');
      if (typeof ref['label'] !== 'string') invalid(`${at}.refs[${index}]`, 'label 必须是字符串');
    });
  }
}

/** 从宿主 header 取会话 id；形状不符 → 空串（读不到就返回空段，不抛）。 */
function sessionIdOf(header: unknown): string {
  if (typeof header !== 'object' || header === null) return '';
  const id = (header as { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

function toViewSegment(segment: EchoRecallSegment): SpiritEchoViewSegment {
  return {
    excerpt: segment.excerpt,
    firstTs: segment.firstTs,
    lastTs: segment.lastTs,
    times: segment.times,
  };
}

function buildState(store: EchoRecallStore, sessionId: string): SpiritEchoProjectionState {
  return { sessionId, token: sessionId === '' ? 0 : store.summary(sessionId, 1).token };
}

function toViewStep(row: { id: string; at: number; kind: 'injected' | 'skipped'; reason: string; preview: string; title: string; refs: ReadonlyArray<{ kind: string; id: string; label: string }> }): SpiritEchoViewStep {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    reason: row.reason,
    preview: row.preview,
    ...(row.title === '' ? {} : { title: row.title }),
    ...(row.refs.length === 0 ? {} : { refs: row.refs.map((ref) => ({ kind: ref.kind, id: ref.id, label: ref.label })) }),
  };
}

/**
 * 同一 state 连续两次 view() 返回同一引用（registry 据此判脏）。
 * state 是不可变引用，WeakMap 按 state 复用到同一 view。
 */
const viewMemo = new WeakMap<SpiritEchoProjectionState, SpiritEchoView>();
function makeView(state: SpiritEchoProjectionState, store: EchoRecallStore, refStore?: EchoRefStore): SpiritEchoView {
  const memoized = viewMemo.get(state);
  if (memoized !== undefined) return memoized;
  const summary = store.summary(state.sessionId, ECHO_VIEW_LIMIT, 5);
  const refs = state.sessionId === '' || refStore === undefined
    ? undefined
    : refStore.list({ sessionId: state.sessionId, limit: ECHO_VIEW_LIMIT });
  const tone = state.sessionId === '' || refStore === undefined ? undefined : refStore.toneOf(state.sessionId);
  // 最近一次回响事件（recall 号 + flashback 标）：从轮次观测里取最新一轮。
  const latestStep = summary.lastStep ?? summary.steps[0];
  const recall: SpiritEchoViewRecall | undefined = latestStep === undefined
    ? undefined
    : { recallId: latestStep.id, at: latestStep.at, flashback: latestStep.flashback };
  const next: SpiritEchoView = {
    token: summary.token,
    total: summary.total,
    segments: summary.segments.map(toViewSegment),
    steps: summary.steps.map((row) => toViewStep(row)),
    ...(summary.lastStep === undefined
      ? {}
      : { lastStep: toViewStep(summary.lastStep) }),
    ...(refs === undefined ? {} : { records: refs.rows, refs: refs.rows }),
    ...(recall === undefined ? {} : { recall }),
    ...(tone === undefined ? {} : { tone }),
  };
  viewMemo.set(state, next);
  return next;
}

interface ProjectionRegistryLike {
  register(definition: {
    key: string;
    stateSchema: { parse(value: unknown): unknown };
    init(header: unknown, inheritedEventCount?: number): SpiritEchoProjectionState;
    apply(state: SpiritEchoProjectionState, event: { type: string; data: unknown }): SpiritEchoProjectionState;
    wire: { viewSchema: { parse(value: unknown): unknown }; view(state: SpiritEchoProjectionState): SpiritEchoView };
    stateVersion: number;
  }): () => void;
}

/**
 * 注册 `spiritEcho` 投影。
 *
 * 双代平面（与 prime-memory 的 slots/recall 同判别式）：0.1.0-rc.8 的 registry 读
 * `def.schema.parse(def.view(state))`，0.1.1+ 读 `wire:{viewSchema,view}`；两个形状
 * 都挂上，两代各取所需。
 *
 * @param ctx - 宿主上下文（node 半）。
 * @param store - 回响落档（v10 两表的读写层）。
 */
export function registerEchoProjection(ctx: Context, store: EchoRecallStore, refStore?: EchoRefStore): void {
  ctx.inject(['sessionProjections'], (injected) => {
    const registry = (injected as unknown as { sessionProjections?: ProjectionRegistryLike }).sessionProjections;
    if (registry === undefined || typeof registry.register !== 'function') return;
    const definition = {
      key: SPIRIT_ECHO_KEY,
      stateSchema,
      init: (header: unknown) => buildState(store, sessionIdOf(header)),
      apply: (state: SpiritEchoProjectionState) => {
        // 只比令牌：unchanged ⇒ 同引用；changed ⇒ 读当前真值重建。
        if (state.sessionId === '') return state;
        if (store.summary(state.sessionId, 1).token === state.token) return state;
        return buildState(store, state.sessionId);
      },
      wire: { viewSchema, view: (state: SpiritEchoProjectionState) => makeView(state, store, refStore) },
      schema: viewSchema,
      view: (state: SpiritEchoProjectionState) => makeView(state, store, refStore),
      // v7：帧补记录聚合 records[]（echo-<uuid>）+ 回响事件 recall（recall-<uuid>）。
      stateVersion: 7,
    } as unknown as Parameters<ProjectionRegistryLike['register']>[0];
    registry.register(definition);
  });
}
