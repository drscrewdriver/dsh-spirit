/**
 * 浏览器半的数据通道：直连宿主半注册的 `POST /dsh-spirit/rpc/<method>`。
 *
 * 不走 `connection.rpc`：那条前缀通道在 webServer 分发层静默 405（姊妹包实测），
 * `/api` interceptor 又是单槽会被抢。自有精确前缀路由可共存。
 *
 * 信封语义：`ok:false` 走 resolve 不走 reject（业务错误也要抵达调用方，面板要能说出
 * "该会话还没有数据"）；只有传输层失败（网络/HTTP 非 2xx）才 reject。
 */
import type { SpiritEndpoint, SpiritRequestMap, SpiritResponseMap } from '../../src/contract.js';
import { SPIRIT_RPC_PREFIX, SPIRIT_RPC_ROUTE } from '../../src/contract.js';

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export type RpcFn = <K extends SpiritEndpoint>(endpoint: K, payload?: SpiritRequestMap[K]) => Promise<RpcResult<SpiritResponseMap[K]>>;

/** `dsh-spirit/session-stats` → `session-stats`（宿主半按前缀拼回）。 */
function shortMethod(endpoint: string): string {
  return endpoint.startsWith(SPIRIT_RPC_PREFIX) ? endpoint.slice(SPIRIT_RPC_PREFIX.length) : endpoint;
}

export function makeRpc(): RpcFn {
  return (async (endpoint, payload) => {
    let response: Response;
    try {
      // 路由根用共享常量而不是字面量：与宿主半注册的前缀不同 = 面板只能拿到宿主 404
      response = await fetch(`${SPIRIT_RPC_ROUTE}/${shortMethod(endpoint)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
    } catch (err) {
      // 带 cause 重抛：只知"transport failure"而丢了底层错（DNS/TLS/abort）会很难定位
      throw new Error(`transport failure for ${endpoint}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!response.ok) throw new Error(`transport failure for ${endpoint}: HTTP ${response.status}`);
    return (await response.json()) as RpcResult<never>;
  }) as RpcFn;
}
