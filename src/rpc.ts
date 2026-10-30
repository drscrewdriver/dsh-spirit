/**
 * 面板数据通道（宿主半侧）：向 `webServer` 注册**前缀路由** `POST /dsh-spirit/rpc/<method>`。
 *
 * 为什么不走 `connection.rpc.handle()`：姊妹包实测该前缀通道在 webServer 分发层
 * **静默 405**（讨论区 #6377），而 `/api` 共享通道的 interceptor 是**单槽**、会被别的
 * 插件抢占。自有精确前缀路由按路径 key 共存，分发优先于 interceptor。
 *
 * 三条边界：
 * 1. **白名单硬编码**：不在 `SPIRIT_OPS` 里的方法名一律 404。漏一条 = 面板那个功能
 *    静默消失（客户端把 404 吞进 catch），所以白名单与契约表由 `contract-keys` 对敲。
 * 2. **同源 DNS-rebinding 防护**：Host 头必须是 loopback；机密字段不经本通道出
 *    （本插件没有任何密钥类数据，`journal-export` 也**只收目录名、不收任意路径**）。
 * 3. **服务可能晚于本插件就绪**（webServer 是可选服务）：先探一次，缺席就监听
 *    `internal/service` 的上线/下线/替换三种迁移，不假设它一定在。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SPIRIT_OPS, SPIRIT_RPC_PREFIX, type SpiritConfig, type SpiritExportResult, type SpiritJournalPage, type SpiritPersonaView, type SpiritSessionModeResult, type SpiritSessionStats } from './contract.js';
import type { Spirit } from './spirit.js';
import type { SpiritStats } from './stats.js';
import type { SessionModeStore } from './store/session-modes.js';
import type { PersonaStore } from './persona/store.js';
import { composePersonaText } from './persona/render.js';
import type { ExperienceStore } from './store/experience.js';
import type { SpiritVerdict } from './types.js';
import { getService } from './capability.js';

/** 路由前缀：`dsh-spirit/session-stats` → `/dsh-spirit/rpc/session-stats`。 */
export const SPIRIT_RPC_ROUTE = `/${SPIRIT_RPC_PREFIX.replace(/\/$/, '')}rpc`;
const ENDPOINTS = SPIRIT_OPS.map((op) => `${SPIRIT_RPC_PREFIX}${op}`);
const SHORT_METHODS: readonly string[] = ENDPOINTS.map((e) => e.slice(SPIRIT_RPC_PREFIX.length));

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

/** 只允许 loopback 的 Host 头（同源浏览器的 rebinding 防护，与宿主 /api 网关同语义）。 */
export function apiFence(req: IncomingMessage): boolean {
  const host = req.headers['host'];
  if (typeof host !== 'string' || host === '') return false;
  const bare = host.replace(/^\[|\]$/g, '').split(':')[0] ?? '';
  return /^(127(?:\.\d+){3}|localhost|::1)$/iu.test(bare.split('%')[0] ?? '');
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(text));
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // 有顶：面板请求不该是任意大的东西
    if (size > 64 * 1024) throw new Error('请求体过大');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

export interface RpcDeps {
  spirit: Spirit;
  stats: SpiritStats;
  store: ExperienceStore;
  modes: SessionModeStore;
  personas: PersonaStore;
  cfg: () => SpiritConfig;
  /** DRSC 探测结论（面板要如实显示 skipped/warn，不当故障也不当正常）。 */
  drscVerdict: () => SpiritVerdict;
  logger: { warn(message: string): void; info(message: string): void };
}

const ok = <T>(value: T): RpcResult<T> => ({ ok: true, value });
const err = (code: string, message: string): RpcResult<never> => ({ ok: false, error: { code, message } });

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function int(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}

/** 单个端点的分发（与 HTTP 层解耦，便于单测直调）。 */
export async function handleEndpoint(endpoint: string, payload: Record<string, unknown>, deps: RpcDeps): Promise<RpcResult<unknown>> {
  const name = endpoint.startsWith(SPIRIT_RPC_PREFIX) ? endpoint.slice(SPIRIT_RPC_PREFIX.length) : endpoint;
  switch (name) {
    case 'session-stats': {
      let sessionId = str(payload['sessionId']);
      // 省略 sessionId ⇒ 取最近有活动的会话（设置页分节拿不到会话上下文）
      if (sessionId === '') sessionId = deps.stats.latest()?.sessionId ?? '';
      if (sessionId === '') return err('no-session', '还没有任何会话记录');
      const agentId = deps.stats.agentOfSession(sessionId) ?? '';
      const mode = { off: deps.modes.isOff(sessionId), bypass: deps.modes.isBypass(sessionId) };
      const snapshot: SpiritSessionStats | null = agentId === '' ? null : deps.stats.snapshot(agentId, mode);
      if (snapshot === null) return err('no-session', '该会话尚无运行数据（未注入过或已销毁）');
      return ok({ ...snapshot, sessionId });
    }
    case 'journal-tail': {
      const sessionId = str(payload['sessionId']);
      if (sessionId === '') return err('bad-request', 'sessionId 必填');
      const page: SpiritJournalPage = { sessionId, rows: [], total: 0, offset: 0, limit: 0 };
      const result = deps.store.page(
        sessionId,
        int(payload['offset'], 0),
        int(payload['limit'], 30),
        payload['includeSuperseded'] === true,
      );
      return ok({
        ...page,
        total: result.total,
        offset: int(payload['offset'], 0),
        limit: int(payload['limit'], 30),
        rows: result.rows.map((entry) => ({
          id: entry.id,
          tsMs: entry.tsMs,
          turnSeq: entry.turnSeq,
          trigger: entry.trigger,
          notice: entry.notice,
          reaction: entry.reaction,
          text: entry.text,
          lane: entry.lane,
          sourceRef: entry.sourceRef ?? null,
        })),
      } satisfies SpiritJournalPage);
    }
    case 'journal-export': {
      // 只认归档目录名：任何路径分隔符或绝对路径都拒（这条端点是"能不能往任意目录写"的口子）
      const dirName = str(payload['dirName'], 'archive');
      if (dirName.includes('/') || dirName.includes('\\') || dirName.includes('..')) {
        return err('bad-request', 'dirName 只接受单个目录名');
      }
      const cfg = deps.cfg();
      const format = str(payload['format'], 'jsonl') === 'md' ? 'md' : 'jsonl';
      const dryRun = payload['dryRun'] !== true ? cfg.journal.dryRun : true;
      const result: SpiritExportResult = { dirName, format, written: 0, dryRun };
      return ok(result);
    }
    case 'persona-get': {
      const card = deps.personas.current();
      const cfg = deps.cfg();
      const view: SpiritPersonaView = {
        id: card.id,
        revision: card.revision,
        name: card.name,
        voice: card.voice,
        salience: { ...card.salience },
        focus: [...card.focus],
        values: [...card.values],
        boundaries: [...card.boundaries],
        projectedText: composePersonaText(card, cfg.persona.budgetBytes),
      };
      return ok(view);
    }
    case 'session-mode-get': {
      // 只读：不碰写入面（写端点"两个字段都省"语义是清除覆盖，混用会抹掉用户设置）
      const sessionId = str(payload['sessionId']);
      if (sessionId === '') return err('bad-request', 'sessionId 必填');
      return ok({
        sessionId,
        off: deps.modes.isOff(sessionId),
        bypass: deps.modes.isBypass(sessionId),
        persisted: true,
      } satisfies SpiritSessionModeResult);
    }
    case 'session-mode': {
      const sessionId = str(payload['sessionId']);
      if (sessionId === '') return err('bad-request', 'sessionId 必填');
      const persisted = deps.modes.set(sessionId, {
        ...(typeof payload['off'] === 'boolean' ? { off: payload['off'] } : {}),
        ...(typeof payload['bypass'] === 'boolean' ? { bypass: payload['bypass'] } : {}),
      });
      const result: SpiritSessionModeResult = {
        sessionId,
        off: deps.modes.isOff(sessionId),
        bypass: deps.modes.isBypass(sessionId),
        persisted,
      };
      return ok(result);
    }
    default:
      return err('not-found', `unknown endpoint ${endpoint}`);
  }
}

interface WebServerFace {
  register(route: {
    kind: 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
  }): (() => void) | Promise<() => void>;
}

/** 挂载（含 webServer 晚到/替换/下线的三种迁移）。 */
export function registerSpiritRpc(ctx: Context, deps: RpcDeps): void {
  let dispose: () => void = () => {};
  let holding = false;

  const mount = (webServer: WebServerFace): void => {
    if (holding) return;
    holding = true;
    const registered = webServer.register({
      kind: 'prefix',
      path: SPIRIT_RPC_ROUTE,
      handler: async (req, res) => {
        if (!apiFence(req)) {
          writeJson(res, 403, err('forbidden', 'forbidden'));
          return;
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, err('method-error', 'method not allowed'));
          return;
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
        if (!pathname.startsWith(`${SPIRIT_RPC_ROUTE}/`)) {
          writeJson(res, 404, err('not-found', 'unknown api path'));
          return;
        }
        const method = pathname.slice(SPIRIT_RPC_ROUTE.length + 1);
        if (method.includes('/') || !SHORT_METHODS.includes(method)) {
          writeJson(res, 404, err('not-found', `unknown api method "${method}"`));
          return;
        }
        try {
          const payload = await readJsonBody(req);
          writeJson(res, 200, await handleEndpoint(`${SPIRIT_RPC_PREFIX}${method}`, payload, deps));
        } catch (e) {
          writeJson(res, 400, err('bad-request', e instanceof Error ? e.message : String(e)));
        }
      },
    });
    void Promise.resolve(registered).then((fn) => {
      dispose = typeof fn === 'function' ? fn : () => {};
    });
    deps.logger.info('[spirit] 面板 API 已注册（POST /dsh-spirit/rpc/<method>）');
  };

  const tryMount = (): void => {
    const webServer = getService(ctx, 'webServer') as WebServerFace | undefined;
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    mount(webServer);
  };

  // webServer 是可选服务且可能晚于本插件就绪：监听服务上线/下线
  ctx.on('internal/service', (name: unknown, impl: unknown) => {
    if (name !== 'webServer') return;
    if (impl === undefined) {
      try {
        dispose();
      } catch {
        /* 已释放 */
      }
      holding = false;
      return;
    }
    tryMount();
  });
  tryMount();

  ctx.effect(() => () => {
    try {
      dispose();
    } catch {
      /* 宿主已下线 */
    }
  });
}

/** 白名单导出（门禁核对 client 与 host 两端一致）。 */
export const SPIRIT_RPC_METHODS: readonly string[] = SHORT_METHODS;
