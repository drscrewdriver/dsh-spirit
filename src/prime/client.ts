/**
 * prime-memory 的只读 HTTP 客户端（主人背景档案的同步数据源）。
 *
 * 与 `drsc/client.ts` 同一套纪律，且**直接复用它的基址解析函数**——
 * 同源优先级（显式 baseUrl > trustedHosts > 宿主 webServer 端口 > 8080）与
 * Host 头回显是宿主 apiFence 的要求，两处各抄一份迟早有一份跟不上。
 *
 * 只走 `dsh-memory/rpc/*` 的 API 面，绝不直读它的 db 文件（跨插件读库文件
 * 等于把对方内部 schema 变成自己的依赖）。prime 未装 ⇒ 一切请求都是
 * transport failure ⇒ {@link PrimeClientError}，调用方据此把同步整段跳过。
 */

import { resolveDrscBaseUrl } from '../drsc/client.js';

/** prime 的 RPC 路由前缀（与实测字面一致；不跨包 import 常量）。 */
export const PRIME_RPC_ROUTE = '/dsh-memory/rpc';

/** 同步取数上限：档案预算装不下更多，8 个实体是展示顶不是检索顶。 */
export const PRIME_PERSON_LIMIT = 8;

/** prime 缺席 / 超时 / 包络破损。调用方据此跳过同步（不覆盖旧段）。 */
export class PrimeClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PrimeClientError';
  }
}

/** person 节点的同步所需字段（其余字段不搬运——L1 原文与边不属于档案面）。 */
export interface PrimePersonNode {
  name: string;
  aliases: readonly string[];
  /** active facts 重建的状态串（`key: value` 逐行），比裸 facts 更接近"当前是什么"。 */
  currentState: string;
  tags: readonly string[];
}

export interface PrimeClientOptions {
  baseUrl?: string;
  trustedHosts?: () => readonly string[] | undefined;
  localPort?: () => number | undefined;
  /** 注入面（单测与工装）；缺省全局 fetch。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class PrimeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: PrimeClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    // loopback 正常 <10ms；沿用 drsc 的 5s 天花板，冷启动不该拖死定时器回调。
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  private base(): { url: string; hostHeader?: string } {
    const trusted = this.options.trustedHosts?.() ?? [];
    const baseUrl = resolveDrscBaseUrl(this.options.baseUrl, trusted, this.options.localPort?.()).replace(/\/+$/u, '');
    const first = trusted.find((entry) => entry.trim() !== '')?.trim();
    return { url: `${baseUrl}${PRIME_RPC_ROUTE}`, ...(first === undefined ? {} : { hostHeader: first }) };
  }

  private async post(op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { url, hostHeader } = this.base();
    let response: Response;
    try {
      response = await this.fetchImpl(`${url}/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(hostHeader === undefined ? {} : { host: hostHeader }) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new PrimeClientError(`prime-memory 不可达(${op})`, { cause: err });
    }
    if (!response.ok) throw new PrimeClientError(`prime-memory HTTP ${response.status}(${op})`);
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new PrimeClientError(`prime-memory 响应非 JSON(${op})`, { cause: err });
    }
    if (typeof body !== 'object' || body === null || (body as { ok?: unknown }).ok !== true) {
      throw new PrimeClientError(`prime-memory 包络异常(${op})`);
    }
    const value = (body as { value?: unknown }).value;
    if (typeof value !== 'object' || value === null) throw new PrimeClientError(`prime-memory 响应缺 value(${op})`);
    return value as Record<string, unknown>;
  }

  /**
   * person 实体检索（同步主路径）。空 query 的行为**以真宿主实测为准**
   * （T2.2）：若 prime 拒空查询或返回空，调用方退 {@link graphPreviewSeeds}。
   */
  async searchPersons(limit: number = PRIME_PERSON_LIMIT): Promise<PrimePersonNode[]> {
    const value = await this.post('graph-search', { query: '', limit: Math.max(1, Math.floor(limit)) });
    const items = Array.isArray(value['items']) ? (value['items'] as Record<string, unknown>[]) : [];
    return items
      .map((item) => this.toPerson(item['node']))
      .filter((node): node is PrimePersonNode => node !== null);
  }

  /**
   * 种子榜取 person（同步主路径，真宿主实测定案）。
   *
   * ⚠️ `graph-preview` 的 full 块是**轻量形状**（id/name/type/degree，无 currentState/aliases，
   * 真宿主实测定案：只读它拿不到 facts）——所以这里拿 person 清单后逐个 `graph-node-get`
   * 取全量详情（≤8 个 loopback 请求，日级冷路径可忽略）。单节点详情失败退轻量形状
   * （只有名字），不整段丢：名字清单好过空白，也拖不垮整条同步。
   */
  /**
   * 借嵌入配置档位（v0.3.5 长觉阶梯）：prime 的 `embedding-state-get` 回远程档位
   * （baseURL/模型/维度）。调研实锤：prime **没有**「送文本→回向量」的服务端点，
   * apiKey 也不回传只给布尔——所以这里借的是**档位对齐**（两套向量同空间才兼容），
   * 调用权与 key 必须 spirit 自持。解耦口径：`dsh-memory/` 字面量仍只在本文件（G 闸）。
   */
  async embeddingState(): Promise<{ source: string; remote: { baseUrl: string; model: string; dimensions: number } | null }> {
    const value = await this.post('embedding-state-get', {});
    const source = typeof value['source'] === 'string' ? value['source'] : 'off';
    const remoteRaw = value['remote'];
    if (typeof remoteRaw !== 'object' || remoteRaw === null) return { source, remote: null };
    const remote = remoteRaw as Record<string, unknown>;
    return {
      source,
      remote: {
        baseUrl: String(remote['baseURL'] ?? remote['baseUrl'] ?? ''),
        model: String(remote['model'] ?? ''),
        dimensions: typeof remote['dimensions'] === 'number' ? remote['dimensions'] : 0,
      },
    };
  }

  async graphPreviewPersons(limit: number = PRIME_PERSON_LIMIT): Promise<PrimePersonNode[]> {
    const value = await this.post('graph-preview', { mode: 'full' });
    const full = typeof value['full'] === 'object' && value['full'] !== null ? (value['full'] as Record<string, unknown>) : value;
    const lightNodes = Array.isArray(full['nodes']) ? (full['nodes'] as Record<string, unknown>[]) : [];
    const persons = lightNodes
      .filter((node) => node['type'] === 'person' && typeof node['id'] === 'string' && node['id'] !== '')
      .slice(0, Math.max(1, Math.floor(limit)));
    const out: PrimePersonNode[] = [];
    for (const light of persons) {
      const id = String(light['id']);
      let detail: PrimePersonNode | null = null;
      try {
        detail = this.toPerson((await this.post('graph-node-get', { id }))['node']);
      } catch {
        /* 详情拿不到就用轻量形状兜底 */
      }
      if (detail !== null) {
        out.push(detail);
        continue;
      }
      const fallback = this.toPerson(light);
      if (fallback !== null) out.push(fallback);
    }
    return out;
  }

  /** 宽松取 person 字段：非 person / 缺 name ⇒ 整条弃（不猜类型，不补空名）。 */
  private toPerson(raw: unknown): PrimePersonNode | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const node = raw as Record<string, unknown>;
    if (node['type'] !== 'person') return null;
    const name = typeof node['name'] === 'string' ? node['name'].trim() : '';
    if (name === '') return null;
    return {
      name,
      aliases: Array.isArray(node['aliases']) ? node['aliases'].map(String).filter((a) => a.trim() !== '') : [],
      currentState: typeof node['currentState'] === 'string' ? node['currentState'] : '',
      tags: Array.isArray(node['tags']) ? node['tags'].map(String) : [],
    };
  }
}
