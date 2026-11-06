/**
 * RPC 面的真装配 HTTP 回环（spirit 的 host 半 + 真 node:http + 真 SQLite）。
 *
 * 比 `handleEndpoint` 直调单测强在哪：这条链上真的发生了
 *   `apply()` → `ctx.inject(['webServer'])` → `webServer.register({kind:'prefix'})`
 *   → HTTP 请求 → `apiFence` 的 Host 校验 → 白名单匹配 → 读库 → 投影 → JSON 响应。
 * 也就是说：路由前缀拼错、白名单漏一条、Host 校验写反、库路径不对——这四类
 * "只在真机暴露"的失败形状，这里都会红。
 *
 * GUI 侧（顶部入口看得见、图能画）不在此文件范围：那需要宿主登录态，归真机冒烟。
 */
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import { apply } from '../src/index.js';
import { SPIRIT_DEFAULTS, SPIRIT_RPC_ROUTE, type SpiritConfig } from '../src/contract.js';
import { openSpiritDb } from '../src/db/open.js';
import { applySchema } from '../src/db/schema.js';
import { ExperienceStore } from '../src/store/experience.js';

type Handler = (...args: never[]) => unknown;

interface PrefixRoute {
  kind: 'prefix';
  path: string;
  handler: (req: unknown, res: unknown) => void | Promise<void>;
}

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-http-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0, dirs.length)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄未放 */
    }
  }
});

/** 造一份带取代链与共享 cue 的库（星海要看的每一件事都在里面）。 */
function seed(dataDir: string, count: number): void {
  const opened = openSpiritDb(dataDir);
  if (!opened.ok) throw new Error('open failed');
  applySchema((sql) => opened.db.exec(sql));
  const store = new ExperienceStore({ db: opened.db, logger: { info: () => {}, warn: () => {} } });
  const triggers = ['user_interruption', 'tool_failure', 'recovery', 'task_close', 'long_gap', 'neutral'] as const;
  const now = Date.now();
  for (let index = 0; index < count; index += 1) {
    store.append(
      { id: `h${index}`, sessionId: 'sess-http', workspaceId: 'ws-http', turnSeq: index + 1, tsMs: now - index * 60_000, personaRevision: 1 },
      {
        trigger: triggers[index % triggers.length] ?? 'neutral',
        notice: 'task_progress',
        reaction: 'mild',
        text: `HTTP 回环第 ${index} 条经历`,
        gist: index % 3 === 0 ? `残句 ${index}` : undefined,
        salience: index % 3,
        fact: { userChars: 120 },
        lane: index % 7 === 0 ? 'drsc' : 'live',
      },
      [`cue-${index % 3}`],
    );
  }
  store.supersede('h1', 'h2');
  store.supersede('h4', 'h5');
  opened.db.close();
}

function makeCtx(webServer: unknown) {
  const handlers = new Map<string, Handler[]>();
  return {
    handlers,
    on(event: string, cb: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    inject(_names: string[], cb: (scope: { get(name: string): unknown }) => void) {
      cb({ get: () => webServer });
    },
    effect() {},
    get: () => undefined,
    logger: { info() {}, warn() {}, error() {} },
  };
}

/** 起一个真 HTTP 服务，把 spirit 注册的前缀路由接上（模拟宿主 webServer 的分发）。 */
async function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  const routes = new Map<string, (req: never, res: never) => void | Promise<void>>();
  const webServer = {
    port: 0,
    register(route: PrefixRoute): () => void {
      routes.set(route.path, route.handler as never);
      return () => routes.delete(route.path);
    },
  };
  const dataDir = tmp();
  seed(dataDir, 12);
  const ctx = makeCtx(webServer);
  const cfg: SpiritConfig = { ...structuredClone(SPIRIT_DEFAULTS), dataDir };
  await apply(ctx as unknown as Parameters<typeof apply>[0], cfg);

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const prefix = [...routes.keys()].find((candidate) => path.startsWith(`${candidate}/`));
    if (prefix === undefined) {
      res.statusCode = 404;
      res.end('{"host404":true}');
      return;
    }
    void routes.get(prefix)?.(req as never, res as never);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  webServer.port = port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

async function postJson(base: string, method: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${SPIRIT_RPC_ROUTE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe('sea-graph 走真 HTTP 装配链', () => {
  it('POST 返回投影：点数/幽灵/边/焦点都在，且 degraded=false', async () => {
    const { url, close } = await serve();
    try {
      const result = await postJson(url, 'sea-graph', { scope: 'all' });
      expect(result.status).toBe(200);
      expect(result.json.ok).toBe(true);
      const value = result.json.value as {
        points: Array<{ id: string; tier: string; superseded: boolean; freshness: number; axis: number }>;
        edges: Array<{ kind: string }>;
        focusIds: string[];
        stats: { loaded: number; ghosts: number; total: number; degraded: boolean; window: number; edges: number };
      };
      // 12 条全在（含 2 条被取代的幽灵点：includeSuperseded 生效）
      expect(value.stats.loaded).toBe(12);
      expect(value.stats.ghosts).toBe(2);
      expect(value.stats.degraded).toBe(false);
      expect(value.stats.window).toBe(3_000);
      // 幽灵点按 ts 升序出现（h4 比 h1 更旧），所以按集合比而不是按写序
      expect(value.points.filter((point) => point.superseded).map((point) => point.id).sort()).toEqual(['h1', 'h4']);
      expect(value.edges.length).toBeGreaterThan(0);
      expect(new Set(value.edges.map((edge) => edge.kind)).size).toBeGreaterThan(0);
      // 老化与归属都算出来了（不是占位 0）
      expect(value.points.some((point) => point.freshness > 0.9)).toBe(true);
      expect(value.points.some((point) => Math.abs(point.axis) > 0.1)).toBe(true);
      expect(value.focusIds.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it('scope=session 缺 sessionId → 业务错，不是 404', async () => {
    const { url, close } = await serve();
    try {
      const result = await postJson(url, 'sea-graph', { scope: 'session' });
      expect(result.status).toBe(200); // 信封式错误走 200 + ok:false
      expect(result.json.ok).toBe(false);
      expect((result.json.error as { code: string }).code).toBe('bad-request');
    } finally {
      await close();
    }
  });

  it('未知 method → 我们自己的 404；GET → 405（不是宿主 404）', async () => {
    const { url, close } = await serve();
    try {
      const missing = await fetch(`${url}${SPIRIT_RPC_ROUTE}/nope-not-an-op`, { method: 'POST', body: '{}' });
      expect(missing.status).toBe(404);
      const wrongVerb = await fetch(`${url}${SPIRIT_RPC_ROUTE}/sea-graph`);
      expect(wrongVerb.status).toBe(405);
    } finally {
      await close();
    }
  });

  it('Host 非 loopback → 403（DNS-rebinding 防护真的在链上生效）', async () => {
    const { url, close } = await serve();
    try {
      const port = new URL(url).port;
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, method: 'POST', path: `${SPIRIT_RPC_ROUTE}/sea-graph`, headers: { Host: 'evil.example.com' } },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end('{}');
      });
      expect(status).toBe(403);
    } finally {
      await close();
    }
  });
});
