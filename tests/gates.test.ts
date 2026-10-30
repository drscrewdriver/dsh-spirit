/**
 * 门禁闸（计划 Phase 7 的可机械验证部分）。
 *
 * 每条断言都对应 checklist 里一条"看代码觉得没问题"挡不住的东西：
 * - compat：版本串是人手维护的，漏一条不会有任何地方报错
 * - 语义诚实：浮点情绪值、缺声明，都是"能用但误导"的静默形状
 * - 解耦：只要有一处 import/读路径越界，spirit 就又变回 prime-memory 的下游
 * - 请求形状：注入行形状错了是 400 + durable 永久毒化，代价最大
 * - 零副作用：全关时必须与"未装插件"字节等价，否则旁路开关是假的
 * - 包体/依赖：一旦混进原生依赖，Windows 装机面就会重演 jieba 加载失败的坑
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

import { SPIRIT_DEFAULTS, SPIRIT_OPS, SPIRIT_RPC_ROUTE, type SpiritConfig } from '../src/contract.js';
import { LANE_LIVE, TRIGGER_TOOL_FAILURE } from '../src/types.js';
import { SPIRIT_RPC_METHODS, handleEndpoint, type RpcDeps } from '../src/rpc.js';
import { Spirit } from '../src/spirit.js';
import { SpiritStats } from '../src/stats.js';
import { TurnWatcher } from '../src/experience/watcher.js';
import { ExperienceStore } from '../src/store/experience.js';
import type { SessionModeStore } from '../src/store/session-modes.js';
import { PersonaStore } from '../src/persona/store.js';
import { DEFAULT_PERSONA, sanitizePersona } from '../src/persona/types.js';
import { registerCardPreStep } from '../src/hooks/card-pre-step.js';
import { renderCard } from '../src/slot/render.js';
import { factBits } from '../src/experience/render.js';
import { extractCues } from '../src/experience/cues.js';
import { SCHEMA_FIELD_KEYS } from '../src/config.js';
import { checkCompat } from '../scripts/compat-precheck.mjs';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };

/** 端点分发的最小依赖（三个用例只差 store，不在这里三份拷贝）。 */
function makeDeps(over: Partial<RpcDeps> = {}): RpcDeps {
  return {
    spirit: null as unknown as Spirit,
    stats: new SpiritStats(),
    store: new ExperienceStore({ db: null, logger }),
    modes: { isOff: () => false, isBypass: () => false, set: () => true } as unknown as SessionModeStore,
    personas: new PersonaStore({ dataDir: '', logger }),
    dataDir: '',
    cfg: () => SPIRIT_DEFAULTS,
    drscVerdict: () => 'skipped' as const,
    logger,
    ...over,
  } as unknown as RpcDeps;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(fileURLToPath(new URL(dir, import.meta.url)), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map((f) => `${dir}${f}`);
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|\s)\/\/[^\n]*/gu, '$1');
}

function readSources(): Array<{ file: string; body: string; code: string }> {
  return [...sourceFiles('../src/'), ...sourceFiles('../client/src/')].map((file) => {
    const body = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    return { file, body, code: stripComments(body) };
  });
}

describe('task_7.6 compat 预检', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    engines: { dsh: string; node: string };
    peerDependencies: Record<string, string>;
    peerDependenciesMeta: Record<string, { optional?: boolean }>;
    dependencies: Record<string, string>;
  };
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../dsh.plugin.json', import.meta.url)), 'utf8')) as Record<string, unknown>;

  it('当前声明全绿（6 条宿主线 × engines + peers 双查）', () => {
    expect(checkCompat(pkg, manifest)).toEqual([]);
  });

  it('故意把 engines.dsh 改成含未实测老线 ⇒ 必红', () => {
    const bad = { ...pkg, engines: { ...pkg.engines, dsh: '0.1.7-rc.1 || 0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.4' } };
    expect(checkCompat(bad, { ...manifest, engines: { dsh: bad.engines.dsh } }).length).toBeGreaterThan(0);
  });

  it('故意让某条目标线不在 engines 里 ⇒ 必红', () => {
    const bad = { ...pkg, engines: { ...pkg.engines, dsh: '0.2.0-rc.1 || 0.2.0-rc.2' } };
    expect(checkCompat(bad, { ...manifest, engines: { dsh: bad.engines.dsh } }).length).toBeGreaterThan(0);
  });

  it('peer 忘了标 optional ⇒ 必红（未标会让装配失败变硬失败）', () => {
    const bad = { ...pkg, peerDependenciesMeta: {} };
    expect(checkCompat(bad, manifest).some((p) => p.includes('optional'))).toBe(true);
  });

  it('engines.node 掉了 22.16 门槛 ⇒ 必红（node:sqlite 内置的起点）', () => {
    const bad = { ...pkg, engines: { ...pkg.engines, node: '>=18.0.0' } };
    expect(checkCompat(bad, manifest).some((p) => p.includes('22.16'))).toBe(true);
  });
});

describe('task_7.2 语义诚实闸', () => {
  it('src/client 里没有任何 toFixed（情绪一律档位化）', () => {
    const offenders = readSources().filter(({ body }) => /toFixed\s*\(/u.test(body)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('渲染产物与卡片文本都不含浮点数值', () => {
    const card = renderCard({
      mood: { valence: 'neg', arousal: 'high', label: '烦躁压着', revision: 1, updatedAt: 0 },
      recent: ['我出了错：手边的动作没成，我记着这一下。'],
      recalled: ['你上次说先把投递放一放'],
      tone: '上次我们收尾在：事情收到一个段落。',
      maxBytes: 700,
      maxCharsPerEntry: 120,
    });
    expect(card.text).not.toMatch(/[-+]?\d+\.\d/u);
    expect(card.text).toContain('不是客观事实');
    expect(card.text).toContain('不是用户发言');
    expect(card.text).toContain('不覆盖用户的直接指令');
    expect(card.text).toContain('不是医学或心理判断');
  });

  it('spirit 自己产的细节绝不携带目录路径（只留 basename）', () => {
    // 卡体可以引用 DRSC 脱敏片段（那段本来就在上下文里），真正必须守住的是
    // **本插件自己写进 cues / fact 的细节不带目录**——那才是持久化层的意外泄露面。
    expect(factBits({ pathBases: ['e:/secret/dir/deliver.ts'] }).join('|')).toContain('deliver.ts');
    expect(factBits({ pathBases: ['e:/secret/dir/deliver.ts'] }).join('|')).not.toContain('secret');
    expect(extractCues({ pathBases: ['e:/secret/dir/deliver.ts'] })).not.toContain('e:/secret/dir/deliver.ts');
    expect(JSON.stringify(sanitizePersona({ name: 'x', voice: 'plain', salience: {}, focus: [] }).persona)).not.toContain('/');
  });
});

describe('task_7.3 / 7.3b 解耦与不越界', () => {
  it('src 与 client 的**代码**都不引用 prime-memory、不读它的库、不调它的端点', () => {
    // 只扫代码不扫注释：文档里写"同机装了 dsh-memory 会怎样"正是本插件的关键约束，
    // 把它禁止掉会逼人把注释删掉——那是拿安全换门禁变绿。
    const needles = ['dsh-prime-memory', '~/.dsh/memory', 'dsh-memory/'];
    const offenders: string[] = [];
    for (const { file, code } of readSources()) {
      for (const needle of needles) if (code.includes(needle)) offenders.push(`${file} → ${needle}`);
    }
    expect(offenders).toEqual([]);
  });

  it('不直读 DRSC 的库文件（只走它的 op 面）', () => {
    const offenders = readSources()
      .filter(({ code }) => /projection\.db|dsh-reference-session-collector[^']*(db|sqlite)/u.test(code))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
    // 唯一的 collector 字面量只能是 API 路径
    const apiOnly = readSources().filter(({ body }) => body.includes('dsh-reference-session-collector'));
    for (const { body } of apiOnly) expect(body).toContain('/api/dsh-reference-session-collector');
  });

  it('spirit 自己不维护会话索引（会话列表是 DRSC 的地盘）', () => {
    const offenders = readSources().filter(({ code }) => /CREATE TABLE[^;]*sessions/u.test(code)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

describe('task_7.4 / 7.5 请求形状与零副作用', () => {
  /** 最小宿主桩：只收集 handler，不拉真宿主；库走内存降级（消息形状与库无关）。 */
  function makeHost(cfg: Partial<SpiritConfig> = {}, hook: { isAborted?: (payload: unknown) => boolean } = {}) {
    const base = structuredClone(SPIRIT_DEFAULTS);
    const merged: SpiritConfig = { ...base, ...cfg, live: { ...base.live, ...(cfg.live ?? {}) } };
    const handlers: Record<string, (payload: unknown, next?: () => Promise<unknown>) => Promise<unknown>> = {};
    const ctx = {
      on: (name: string, handler: (payload: unknown, next?: () => Promise<unknown>) => Promise<unknown>) => {
        handlers[name] = handler;
      },
    } as unknown as Parameters<typeof registerCardPreStep>[0];
    const store = new ExperienceStore({ db: null, logger });
    const watcher = new TurnWatcher({ gapThresholdMs: 180_000 });
    const modes = {
      isOff: () => false,
      isBypass: () => false,
      set: () => true,
    } as unknown as SessionModeStore;
    const spirit = new Spirit(
      {
        cfg: () => merged,
        live: () => merged.live,
        store,
        watcher,
        modes,
        history: { store },
        logger,
        recentEntries: (sid, k) => store.recent(sid, k),
        previousEntries: () => [],
      },
      DEFAULT_PERSONA,
    );
    registerCardPreStep(ctx, {
      spirit,
      logger,
      ownerOf: () => 's1',
      isSubagent: () => false,
      sessionIdOf: () => 's1',
      workspaceIdOf: () => 'w1',
      ...hook,
    });
    return { handlers, store };
  }

  it('关到最小时：返回的就是 next() 原对象（同一引用，零副作用）', async () => {
    const { handlers } = makeHost({ enabled: false });
    const original = { kind: 'enter' as const, messages: [userMsg('继续')] };
    const out = await handlers['agent/pre-step']?.({ agent: { id: 'a1' } }, async () => original);
    expect(out).toBe(original);
  });

  it('门 7 已被取消的一轮：原样退回 next() 的决定且不记录（注入依赖置真）', async () => {
    const { handlers, store } = makeHost({}, { isAborted: () => true });
    const original = { kind: 'enter' as const, messages: [userMsg('跑到一半被停了')] };
    const out = await handlers['agent/pre-step']?.({ agent: { id: 'a1' }, signal: { aborted: true } }, async () => original);
    expect(out).toBe(original);
    expect(store.count('s1')).toBe(0);
  });

  it('门 7 缺省判据就是真宿主形状（payload.signal.aborted）', async () => {
    // 不传 isAborted 时走缺省实现：那才是真宿主上跑的那条，形状写错就是门 7 形同虚设
    const { handlers, store } = makeHost();
    const original = { kind: 'enter' as const, messages: [userMsg('被取消的一轮')] };
    const cancelled = await handlers['agent/pre-step']?.({ agent: { id: 'a1' }, signal: { aborted: true } }, async () => original);
    expect(cancelled).toBe(original);
    expect(store.count('s1')).toBe(0);
    const normal = await handlers['agent/pre-step']?.({ agent: { id: 'a1' } }, async () => original);
    expect(normal).not.toBe(original);
  });

  it('注入时：原消息逐条保持引用不变，只在尾部追加一条', async () => {
    const { handlers } = makeHost();
    const a = userMsg('第一条');
    const b = userMsg('第二条');
    const original = { kind: 'enter' as const, messages: [a, b] };
    const out = (await handlers['agent/pre-step']?.({ agent: { id: 'a1' } }, async () => original)) as {
      kind: string;
      messages: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
    };
    expect(out.kind).toBe('enter');
    expect(out.messages.length).toBeGreaterThanOrEqual(2);
    expect(out.messages[0]).toBe(a);
    expect(out.messages[1]).toBe(b);
    if (out.messages.length === 3) {
      const card = out.messages[2];
      expect(card?.role).toBe('user');
      const blocks = card?.content ?? [];
      expect(blocks.length).toBe(1);
      expect(blocks[0]?.type).toBe('text');
      expect((blocks[0]?.text ?? '').length).toBeGreaterThan(0);
      // 绝不携带工具块：那才是踩 400（tool_use 无 tool_result）的形状
      expect(blocks.some((block) => block.type !== 'text')).toBe(false);
      // 不设 startsRequestSeries（它会强制系统提示重新准入并打断请求系列）
      expect((out as Record<string, unknown>)['startsRequestSeries']).toBeUndefined();
    }
  });

  it('连续 5 轮：每轮最多新增一条注入行，且不改动历史消息', async () => {
    const { handlers } = makeHost();
    let prior: Array<unknown> = [];
    for (let i = 0; i < 5; i += 1) {
      const fresh = userMsg(`第 ${i} 轮`);
      const original = { kind: 'enter' as const, messages: [fresh] };
      const out = (await handlers['agent/pre-step']?.({ agent: { id: 'a1' } }, async () => original)) as { messages: unknown[] };
      expect(out.messages.length).toBeLessThanOrEqual(2);
      expect(out.messages[0]).toBe(fresh);
      // 上一轮的消息对象不许被就地修改（history 里出现"同一 id 内容变了"是最难查的）
      for (const kept of prior) expect(out.messages).not.toContain(kept);
      prior = [fresh];
    }
  });
});

describe('task_7.7 包体与依赖口径', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    dependencies: Record<string, string>;
    files: string[];
  };

  it('运行时依赖只有 schemastery（无 jieba / sqlite-vec / undici 等原生或重依赖）', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@deepseek-ai/schemastery']);
  });

  it('files 白名单不含截图资产（展示型图片不进包）', () => {
    expect(pkg.files).toContain('dist');
    expect(pkg.files).not.toContain('screenshots.json');
  });
});

describe('contract 面完整（五方对齐的剩余腿）', () => {
  it('每个声明的端点都能被分发到（不返回 unknown endpoint）', async () => {
    const deps = makeDeps();
    for (const op of SPIRIT_OPS) {
      const result = await handleEndpoint(`dsh-spirit/${op}`, { sessionId: 'nope' }, deps);
      // 允许业务性 no-session / bad-request，但不能是"这个端点我根本不认识"
      if (!result.ok) expect(result.error.code, op).not.toBe('not-found');
    }
  });

  it('journal-export 的路径注入面被拒，且缺省 dryRun 不写盘', async () => {
    const deps = makeDeps();
    const bad = await handleEndpoint('dsh-spirit/journal-export', { sessionId: 's1', dirName: '../escape' }, deps);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('bad-request');
    const dry = await handleEndpoint('dsh-spirit/journal-export', { sessionId: 's1' }, deps);
    expect(dry.ok).toBe(true);
    if (dry.ok) expect((dry.value as { dryRun?: boolean }).dryRun).toBe(true);
  });

  it('journal-tail 省略会话 ⇒ 退到**库里**最近一个（而不是注册表）', async () => {
    // 真宿主实测：面板把 stats 与 tail 串成一条链时，宿主重启后手记整块变空白——
    // 因为 stats 是内存注册表。条目在库里，默认视图就必须能从库里选会话。
    const store = new ExperienceStore({ db: null, logger });
    store.append(
      { id: 'e1', sessionId: 's-old', workspaceId: 'w1', turnSeq: 1, tsMs: 1_000, personaRevision: 1 },
      { trigger: TRIGGER_TOOL_FAILURE, notice: 'environment', reaction: 'mild', text: '手边的动作没成。', fact: {}, lane: LANE_LIVE },
    );
    const deps = makeDeps({ store });
    const omitted = await handleEndpoint('dsh-spirit/journal-tail', {}, deps);
    expect(omitted.ok).toBe(true);
    if (omitted.ok) expect((omitted.value as { sessionId: string }).sessionId).toBe('s-old');
    const empty = await handleEndpoint('dsh-spirit/journal-tail', {}, makeDeps({ store: new ExperienceStore({ db: null, logger }) }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('no-session');
  });

  it('host 白名单与契约端点逐项一致（漏一条 = 面板功能静默 404）', () => {
    expect([...SPIRIT_RPC_METHODS].sort()).toEqual([...SPIRIT_OPS].sort());
  });

  it('defaults ⇄ schema ⇄ live 三面键集一致', () => {
    const flat = (value: unknown, prefix = ''): string[] =>
      value === null || typeof value !== 'object' || Array.isArray(value)
        ? [prefix]
        : Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => flat(v, prefix === '' ? k : `${prefix}.${k}`));
    expect(flat(SPIRIT_DEFAULTS).sort()).toEqual([...SCHEMA_FIELD_KEYS].sort());
  });
});

describe('task_7.9 路由根两腿对敲', () => {
  /**
   * 真机实测踩到的坑：`/${PREFIX.replace(/\/$/, '')}rpc` 把尾斜杠剥掉后直接粘了
   * `rpc`，路由挂到了 `/dsh-spiritrpc`。而浏览器半 fetch 的是 `/dsh-spirit/rpc/…`，
   * 于是单测全绿（测的是 handleEndpoint，不经 URL）但真机拿到的是**宿主 404**。
   * 所以这一组断言只守一件事：两腿共用一个常量，且没人再写第二份字面量。
   */
  it('路由根就是 /dsh-spirit/rpc（拼接式回归即红）', () => {
    expect(SPIRIT_RPC_ROUTE).toBe('/dsh-spirit/rpc');
  });

  it('两半的代码里都不存在第二份路由字面量（只允许共享常量）', () => {
    const read = (rel: string): string =>
      stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));
    expect(read('../client/src/rpc.ts')).toContain('SPIRIT_RPC_ROUTE');
    for (const rel of ['../client/src/rpc.ts', '../src/rpc.ts']) {
      expect(read(rel), rel).not.toContain('/dsh-spirit/rpc');
    }
  });

  it('每个端点拼出的 URL 能被宿主同一条切片逻辑解回短方法名', () => {
    for (const method of SPIRIT_RPC_METHODS) {
      const url = `${SPIRIT_RPC_ROUTE}/${method}`;
      expect(url.slice(SPIRIT_RPC_ROUTE.length + 1)).toBe(method);
      expect(SPIRIT_RPC_METHODS).toContain(url.slice(SPIRIT_RPC_ROUTE.length + 1));
    }
  });
});

/** 造一条宿主形状的用户消息（与真实 createUserMessage 同一条路径，不自己拼字面量）。 */
function userMsg(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' } as never,
  });
}
