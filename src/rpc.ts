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

import { SPIRIT_OPS, SPIRIT_RPC_PREFIX, SPIRIT_RPC_ROUTE, type SpiritConfig, type SpiritExportResult, type SpiritJournalPage, type SpiritPersonaView, type SpiritSessionModeResult, type SpiritSessionStats } from './contract.js';
import type { Spirit } from './spirit.js';
import type { SpiritStats } from './stats.js';
import type { SessionModeStore } from './store/session-modes.js';
import type { PersonaStore } from './persona/store.js';
import { composePersonaText } from './persona/render.js';
import { exportSessionEntries } from './store/journal-retention.js';
import type { ExperienceStore } from './store/experience.js';
import type { SpiritVerdict } from './types.js';
import { getService } from './capability.js';

/** 端点全路径（`dsh-spirit/session-stats` ⇄ `/dsh-spirit/rpc/session-stats`）；路由根单源见 `SPIRIT_RPC_ROUTE`。 */
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
  /** 导出件写到哪（数据目录本身）；由 index 传入，不从配置重算。 */
  dataDir: string;
  cfg: () => SpiritConfig;
  /** DRSC 探测结论（面板要如实显示 skipped/warn，不当故障也不当正常）。 */
  drscVerdict: () => SpiritVerdict;
  /**
   * 拿到 webServer 时回调它的监听端口（拿不到形状 ⇒ undefined）。
   * 为什么递出去：collector 的 API 挂在同一个 webServer 上，而 `dsh web` 的端口是挑的；
   * 历史路缺省基址必须跟着这个端口，否则非 8080 部署上它永远 warn（真宿主实测）。
   */
  onWebServerReady?: (port: number | undefined) => void;
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
      let sessionId = str(payload['sessionId']);
      // 省略 ⇒ 库里的最近一个会话（不是注册表的）：重启后看手记是最常用的一眼
      if (sessionId === '') sessionId = deps.store.latestSessionId();
      if (sessionId === '') return err('no-session', '库里还没有任何体验条目');
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
      // 只认单个目录名：任何路径分隔符与绝对路径都拒（这条端点是"能不能往任意目录写"的口子）
      const dirName = str(payload['dirName'], 'export');
      if (dirName.includes('/') || dirName.includes('\\') || dirName.includes('..') || dirName.includes('\0')) {
        return err('bad-request', 'dirName 只接受单个目录名');
      }
      let sessionId = str(payload['sessionId']);
      // 三级兜底：显式传入 → 注册表当前会话 → **库里**最近一个。
      // 只靠注册表会得到“导出失败：还没有任何会话记录可导”，而条目其实都在库里
      //（真宿主实测：重启后看手记是主场景，导出不能先死）。
      if (sessionId === '') sessionId = deps.stats.latest()?.sessionId ?? '';
      if (sessionId === '') sessionId = deps.store.latestSessionId();
      if (sessionId === '') return err('no-session', '库里还没有任何体验条目可导');
      const cfg = deps.cfg();
      const format = str(payload['format'], 'jsonl') === 'md' ? 'md' : 'jsonl';
      // 默认跟随部署面的 dryRun；用户显式 dryRun:false 才落盘（唯一能写文件的端点不默认动手）
      const dryRun = payload['dryRun'] === true ? true : payload['dryRun'] === false ? false : cfg.journal.dryRun;
      const rows = deps.store.page(sessionId, 0, 500, false).rows.map((entry) => ({
        tsMs: entry.tsMs,
        turnSeq: entry.turnSeq,
        trigger: entry.trigger,
        notice: entry.notice,
        reaction: entry.reaction,
        text: entry.text,
        lane: entry.lane,
        sourceRef: entry.sourceRef ?? null,
      }));
      const result = exportSessionEntries({
        dataDir: deps.dataDir,
        dirName,
        sessionId,
        format,
        rows,
        dryRun,
        now: Date.now(),
      });
      return ok({ ...result, sessionId } satisfies SpiritExportResult);
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
  /** 监听端口（宿主产物上存在；老线拿不到就当未知）。 */
  port?: number;
  register(route: {
    kind: 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
  }): (() => void) | Promise<() => void>;
}

/**
 * 挂载（含 webServer 晚到/替换/下线的三种迁移）。
 *
 * ⚠️ 真宿主实测踩到的坑（404 而不是我们自己的 405）：**不能只靠 `ctx.get('webServer')` 探一次**——
 * 未声明授权时属性读会抛（被getService 吞成 undefined），而 `internal/service` 只在**上线/下线/替换**时发；
 * webServer 早已就绪的常规启动下这个事件根本不会再来，路由就永远挂不上。
 * 正解是用 cordis 的作域注入 `ctx.inject(['webServer'], …)`：它等服务就绪后再跑回调，
 * 又不会像顶层 `inject` 那样在没这个服务的宿主线（headless/tui）上把整个插件挂死。
 */
export function registerSpiritRpc(ctx: Context, deps: RpcDeps): void {
  let dispose: () => void = () => {};
  let holding = false;

  const mount = (webServer: WebServerFace): void => {
    if (holding) return;
    holding = true;
    const port = typeof webServer.port === 'number' && Number.isFinite(webServer.port) ? webServer.port : undefined;
    deps.onWebServerReady?.(port);
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
    deps.logger.info(`[spirit] 面板 API 已注册（POST ${SPIRIT_RPC_ROUTE}/<method>）`);
  };

  const tryMount = (): void => {
    const webServer = getService(ctx, 'webServer') as WebServerFace | undefined;
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    mount(webServer);
  };

  // 主路：作域注入。不声明顶层 inject 是为了让没这个服务的宿主线（headless/tui）
  // 仍能装上面板之外的能力；服务就绪时回调会跑，无论它是早就绪还是晚到。
  ctx.inject(['webServer'], (scope) => {
    const svc = scope.get('webServer') as WebServerFace | undefined;
    if (svc !== undefined && typeof svc.register === 'function') mount(svc);
    else tryMount();
  });

  // 补位：服务上线/下线/替换的迁移（常规启动不会重发该事件，不能只靠它）
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
    const svc = impl as WebServerFace;
    if (typeof svc.register === 'function') mount(svc);
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
