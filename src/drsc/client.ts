/**
 * DRSC（dsh-reference-session-collector）HTTP 客户端。
 *
 * 两条纪律写在这里，不在调用方：
 * 1. **只走它的 API 面，绝不直读它的 db 文件**。跨插件读别人的库文件等于把对方的
 *    内部 schema 变成自己的依赖，对方改表就静默坏在这里。
 * 2. **`redact=1` 是硬要求，不是可选项**。collector 的 `session` 缺省是原文臂，
 *    而本仓的体验条目要与人设文本一起进系统提示与注入帧——取原文臂会把脱敏链绕开。
 *
 * 包络：`{ ok: true, ... }`；非 2xx / `ok!==true` / 超时 / 非 JSON ⇒ 抛 {@link DrscClientError}，
 * 由调用方按口径处理（历史路整段省略，不是报错给对话）。
 *
 * ⚠️ `session:null` 的含义是"collector 里没有这个会话"——**这是新会话首轮的常态，不是错误**：
 * "没有内容"与"没拿到"必须分开，前者空段省略，后者才走 DrscClientError。
 *
 * 同源基址：显式 baseUrl > 首个 trustedHosts 条目（补 http://）> 宿主 webServer 端口 > `http://127.0.0.1:8080`。
 * Host 头回显首个 trustedHosts 条目：collector 的信任门是精确匹配，条目省略端口而 URL 带端口会失配。
 * trustedHosts 惰性读取（`webStartup` 可能晚于本插件就绪），每次请求现算，不缓存陈旧值。
 */

import { SPIRIT_DEFAULTS } from '../contract.js';

/** collector API 路径（与其对外声明的字面一致；不跨包 import 常量）。 */
export const DRSC_API_PATH = '/api/dsh-reference-session-collector';

/** loopback 正常 <10ms，5s 是给冷启动/断点的天花板。 */
export const DRSC_DEFAULT_TIMEOUT_MS = SPIRIT_DEFAULTS.drsc.timeoutMs;

/** collector 缺席 / 超时 / 包络破损。调用方据此把历史路整段省略。 */
export class DrscClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DrscClientError';
  }
}

/**
 * 基址优先级：显式 baseUrl > 首个 trustedHosts > **宿主自己的 webServer 端口** > `127.0.0.1:8080`。
 *
 * 第三档是真宿主实测补上的：collector 的 API 就挂在宿主同一个 webServer 上，
 * 而 `dsh web` 的端口是挑的（本次跑在 3080）。只靠 trustedHosts + 8080 缺省，
 * 在非 8080 部署上历史路会**永远 warn**（面板显示成故障，其实只是打错了门）。
 */
export function resolveDrscBaseUrl(
  explicit: string | undefined,
  trustedHosts?: readonly string[],
  localPort?: number | undefined,
): string {
  const trimmed = explicit?.trim() ?? '';
  if (trimmed !== '') return trimmed;
  const pick = trustedHosts?.find((entry) => entry.trim() !== '')?.trim();
  if (pick !== undefined && pick !== '') return /^https?:\/\//u.test(pick) ? pick : `http://${pick}`;
  if (typeof localPort === 'number' && Number.isFinite(localPort) && localPort > 0) return `http://127.0.0.1:${Math.floor(localPort)}`;
  return 'http://127.0.0.1:8080';
}

/** `op=session` 的一行（segments 明细）。 */
export interface DrscSessionRow {
  seq: number;
  turn: number;
  step: number;
  /** 宿主事件类型，如 `user/message` / `assistant/message` / `tool/call`。 */
  kind: string;
  role: string;
  /** 毫秒时间戳（只用于近因排序，不进对外文本）。 */
  time: number;
  /** 脱敏正文（`redact=1` 时）。 */
  text: string;
  /** 1 = 当前仍在模型表面上；0 = 已被摘要取代。字段缺失时为 undefined（不当 0 用）。 */
  onSurface?: number;
}

/** `op=search` 的一个命中。 */
export interface DrscSearchHit {
  sessionId: string;
  seq: number;
  kind: string;
  rank: number;
  snippet: string;
  timeMs: number;
  onSurface: number;
  turn: number;
}

/** `op=sessions` 的会话摘要行。 */
export interface DrscSessionSummary {
  sessionId: string;
  title: string;
  cwd: string;
  eventCount: number;
  turnCount: number;
  /** 末条消息时间（collector 按它降序排，用的时候注意反转）。 */
  lastTimeMs: number;
}

/**
 * `op=status` 的解读结果。
 *
 * 字段名以**真宿主同装时的实探响应为准**（findings 的 DRSC 探针）：
 * `{ok, sessions, segments, replaces, schema_version, generations, cache,
 *   last_sync:{ok,busy,totalDiscovered,updated,skipped,failures,durationMs}, syncing}`
 * —— 注意 `last_sync` 是个**结果对象**且整个响应里**没有任何时间戳字段**，
 * 所以新鲜度只能报“在不在同步 / 上次同步成没成”，不能报“多久之前”。
 */
export interface DrscStatusView {
  /** 已投影的会话数（>0 说明它真的在工作）。 */
  sessionCount?: number;
  /** 已投影的 segment 数（0 = 装了但还没内容，不是故障）。 */
  segmentCount?: number;
  /** collector 自己的投影 schema 版本（如 `"5"`）。 */
  schemaVersion?: string;
  /** 正在同步（`syncing` 或 `last_sync.busy`）。 */
  syncing: boolean;
  /** 上次同步是否成功（`last_sync.ok`）；读不到 ⇒ undefined（**未知**，不当 false 用）。 */
  lastSyncOk?: boolean;
  /** 原始包络，供诊断面板展开看（不参与逻辑判断）。 */
  raw: Readonly<Record<string, unknown>>;
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optNum(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function rowsOf(body: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const raw = body[key];
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

/** 从包络里挑一个数值字段，兼容 snake_case 与 camelCase 两种写法（不猜语义，只兼容命名）。 */
function pickNum(body: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const found = optNum(body[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

export interface DrscClientOptions {
  /** 显式基址（缺省走 trustedHosts → 127.0.0.1:8080）。 */
  baseUrl?: string;
  /** trustedHosts 惰性读取，每次请求现取。 */
  trustedHosts?: () => readonly string[] | undefined;
  /**
   * 宿主 webServer 监听端口（惰性：服务可能晚于本插件就绪，拿到前返回 undefined）。
   * 只在显式基址与 trustedHosts 都没给时用——它把“collector 与面板同服务器”这个事实说清楚。
   */
  localPort?: () => number | undefined;
  /** 注入面（单测）；缺省全局 fetch。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class DrscClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: DrscClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DRSC_DEFAULT_TIMEOUT_MS;
  }

  private base(): { url: string; hostHeader?: string } {
    const trusted = this.options.trustedHosts?.() ?? [];
    const baseUrl = resolveDrscBaseUrl(this.options.baseUrl, trusted, this.options.localPort?.()).replace(/\/+$/u, '');
    const first = trusted.find((entry) => entry.trim() !== '')?.trim();
    return { url: `${baseUrl}${DRSC_API_PATH}`, ...(first !== undefined ? { hostHeader: first } : {}) };
  }

  private async getJson(query: string): Promise<Record<string, unknown>> {
    const { url, hostHeader } = this.base();
    let response: Response;
    try {
      response = await this.fetchImpl(`${url}${query}`, {
        headers: { accept: 'application/json', ...(hostHeader === undefined ? {} : { host: hostHeader }) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DrscClientError(`collector 不可达(${query})`, { cause: err });
    }
    if (!response.ok) {
      // collector 的错误是 400 + `{ok:false,error:"…"}`（error 是**字符串**），
      // 不拆体就会把“session parameter required”这类真因报成光溜的 HTTP 400。
      let detail = '';
      try {
        const bad: unknown = await response.json();
        if (typeof bad === 'object' && bad !== null) detail = String((bad as { error?: unknown }).error ?? '');
      } catch {
        /* 非 JSON 就不带细节 */
      }
      throw new DrscClientError(`collector HTTP ${response.status}${detail === '' ? '' : `(${detail})`}(${query})`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new DrscClientError(`collector 响应非 JSON(${query})`, { cause: err });
    }
    if (typeof body !== 'object' || body === null || (body as { ok?: unknown }).ok !== true) {
      const reason =
        typeof body === 'object' && body !== null ? String((body as { error?: unknown }).error ?? 'ok=false') : '响应非对象';
      throw new DrscClientError(`collector 包络异常(${query}): ${reason}`);
    }
    return body as Record<string, unknown>;
  }

  /** 可用性与同步状态探测。 */
  async status(): Promise<DrscStatusView> {
    const body = await this.getJson('?op=status');
    const sync = typeof body['last_sync'] === 'object' && body['last_sync'] !== null
      ? body['last_sync'] as Record<string, unknown>
      : undefined;
    return {
      sessionCount: pickNum(body, 'sessions', 'session_count', 'sessionCount'),
      segmentCount: pickNum(body, 'segments', 'segment_count', 'segmentCount'),
      schemaVersion: typeof body['schema_version'] === 'string' ? body['schema_version'] : undefined,
      syncing: body['syncing'] === true || sync?.['busy'] === true,
      ...(sync === undefined || typeof sync['ok'] !== 'boolean' ? {} : { lastSyncOk: sync['ok'] }),
      raw: body,
    };
  }

  /**
   * 会话尾窗：`op=session&session=<id>&tail=N&redact=1`（升序）。
   * collector 无此会话 ⇒ 空数组（新会话首轮的常态）。
   */
  async sessionTail(sessionId: string, tail: number): Promise<DrscSessionRow[]> {
    const body = await this.getJson(
      `?op=session&session=${encodeURIComponent(sessionId)}&tail=${Math.max(0, Math.floor(tail))}&redact=1`,
    );
    return parseSessionRows(body);
  }

  /** 整会话正文（不带 `tail` ⇒ collector 侧全量升序）。历史回溯与导出用。 */
  async sessionAll(sessionId: string): Promise<DrscSessionRow[]> {
    const body = await this.getJson(`?op=session&session=${encodeURIComponent(sessionId)}&redact=1`);
    return parseSessionRows(body);
  }

  /** 会话枚举（`limit` 由 collector 侧钳到 1..500）。 */
  async listSessions(
    offset: number,
    limit: number,
  ): Promise<{ total: number; rows: DrscSessionSummary[] }> {
    const body = await this.getJson(
      `?op=sessions&offset=${Math.max(0, Math.floor(offset))}&limit=${Math.max(1, Math.min(500, Math.floor(limit)))}`,
    );
    return {
      total: num(body['total']),
      rows: rowsOf(body, 'rows').map((r) => ({
        sessionId: String(r['session_id'] ?? r['sessionId'] ?? ''),
        title: String(r['title'] ?? ''),
        cwd: String(r['cwd'] ?? ''),
        eventCount: num(r['event_count']),
        turnCount: num(r['turn_count']),
        lastTimeMs: num(r['last_time_ms']),
      })),
    };
  }

  /** 全文检索面：`op=search&q=&limit=&redact=1`。 */
  async search(query: string, limit: number): Promise<DrscSearchHit[]> {
    const body = await this.getJson(
      `?op=search&q=${encodeURIComponent(query)}&limit=${Math.max(1, Math.floor(limit))}&redact=1`,
    );
    return rowsOf(body, 'hits').map((h) => ({
      sessionId: String(h['session_id'] ?? h['sessionId'] ?? ''),
      seq: num(h['seq']),
      kind: String(h['kind'] ?? ''),
      rank: num(h['rank']),
      snippet: String(h['snippet'] ?? ''),
      timeMs: num(h['time']),
      onSurface: num(h['on_surface']),
      turn: num(h['turn']),
    }));
  }
}

/** `op=session` 包络 → 行数组（`session:null` = 无此会话 ⇒ 空数组，不是错误）。 */
function parseSessionRows(body: Record<string, unknown>): DrscSessionRow[] {
  if (body['session'] === null || body['session'] === undefined) return [];
  return rowsOf(body, 'rows').map((r) => ({
    seq: num(r['seq']),
    turn: num(r['turn']),
    step: num(r['step']),
    kind: String(r['kind'] ?? ''),
    role: String(r['role'] ?? ''),
    time: num(r['time']),
    text: String(r['text'] ?? ''),
    onSurface: optNum(r['on_surface'] ?? r['onSurface']),
  }));
}
