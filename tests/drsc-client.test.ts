import { describe, expect, it } from 'vitest';

import { DrscClient, DrscClientError, resolveDrscBaseUrl } from '../src/drsc/client.js';

/** 记录每次请求 URL 与 headers 的 fetch 替身。 */
function recorder(response: () => { ok: boolean; json: () => Promise<unknown> }) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return response();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const jsonOk = (body: unknown) => ({ ok: true, json: async () => body });

describe('基址解析', () => {
  it('显式 baseUrl > 首个 trustedHosts（补 http://）> 127.0.0.1:8080', () => {
    expect(resolveDrscBaseUrl(undefined, undefined)).toBe('http://127.0.0.1:8080');
    expect(resolveDrscBaseUrl('https://example.test/base', ['127.0.0.1:9000'])).toBe('https://example.test/base');
    expect(resolveDrscBaseUrl('', ['10.0.0.5:8080'])).toBe('http://10.0.0.5:8080');
    expect(resolveDrscBaseUrl('', ['http://10.0.0.5'])).toBe('http://10.0.0.5');
    expect(resolveDrscBaseUrl('', ['  ', 'x:1'])).toBe('http://x:1');
  });

  it('Host 头回显首个 trustedHosts 原串（信任门是精确匹配，改端口就失配）', async () => {
    const { fetchImpl, calls } = recorder(() => jsonOk({ ok: true, session: null, rows: [] }));
    const client = new DrscClient({ fetchImpl, trustedHosts: () => ['10.0.0.5:8080'] });
    await client.sessionTail('s1', 5);
    expect(calls[0]?.headers['host']).toBe('10.0.0.5:8080');
  });

  it('trustedHosts 每次现取（webStartup 可能晚于装配，缓存就永远拿不到）', async () => {
    let hosts: string[] | undefined = undefined;
    const { fetchImpl, calls } = recorder(() => jsonOk({ ok: true, session: null, rows: [] }));
    const client = new DrscClient({ fetchImpl, trustedHosts: () => hosts });
    await client.sessionTail('s1', 1);
    hosts = ['10.1.1.1:8080'];
    await client.sessionTail('s1', 1);
    expect(calls[0]?.url).toContain('127.0.0.1:8080');
    expect(calls[1]?.url).toContain('10.1.1.1:8080');
  });
});

describe('op 分发与 redact 硬要求', () => {
  it('session 类与 search 类都恒带 redact=1（缺省是原文臂，会绕开脱敏链）', async () => {
    const { fetchImpl, calls } = recorder(() => jsonOk({ ok: true, session: null, rows: [], hits: [] }));
    const client = new DrscClient({ fetchImpl });
    await client.sessionTail('会话 A', 3);
    await client.sessionAll('会话 A');
    await client.search('q&特殊', 5);
    for (const call of calls) expect(call.url).toContain('redact=1');
    expect(calls[0]?.url).toContain('tail=3');
    expect(calls[1]?.url).not.toContain('tail=');
    expect(calls[2]?.url).toContain('q=q%26%E7%89%B9%E6%AE%8A');
  });

  it('路径与 op 名逐字对齐 collector 对外面', async () => {
    const { fetchImpl, calls } = recorder(() => jsonOk({ ok: true }));
    const client = new DrscClient({ fetchImpl });
    await client.status();
    expect(calls[0]?.url).toContain('/api/dsh-reference-session-collector?op=status');
  });
});

describe('包络解读', () => {
  it('session:null ⇒ 空数组，且**不当成错误**（新会话首轮的常态）', async () => {
    const { fetchImpl } = recorder(() => jsonOk({ ok: true, session: null }));
    const client = new DrscClient({ fetchImpl });
    expect(await client.sessionTail('s', 5)).toEqual([]);
  });

  it('session 行按蛇形字段映射，snake 与 camel 两种命名都能落到 onSurface', async () => {
    const { fetchImpl } = recorder(() =>
      jsonOk({
        ok: true,
        session: 's1',
        rows: [
          { seq: 3, turn: 2, step: 1, kind: 'user/message', role: 'user', time: 1_700_000_000_000, text: ' 你好 ', on_surface: 1 },
          { seq: 4, turn: 2, step: 2, kind: 'assistant/message', role: 'assistant', time: 1_700_000_000_500, text: '在', onSurface: 0 },
          { seq: 5, turn: 3, step: 1, kind: 'tool/call', role: '', time: 1_700_000_001_000, text: '{}' },
        ],
      }),
    );
    const rows = await new DrscClient({ fetchImpl }).sessionTail('s1', 10);
    expect(rows[0]?.text).toBe(' 你好 ');
    expect(rows[0]?.onSurface).toBe(1);
    expect(rows[1]?.onSurface).toBe(0);
    // 字段缺失时是 undefined，不能当 0 用（0 的含义是"已被取代"）
    expect(rows[2]?.onSurface).toBeUndefined();
  });

  it('status 只取本仓真会用的字段，原始包络留在 raw 里供面板展开', async () => {
    const { fetchImpl } = recorder(() => jsonOk({ ok: true, session_count: 12, last_sync_ms: 999, extra: 'x' }));
    const status = await new DrscClient({ fetchImpl }).status();
    expect(status.sessionCount).toBe(12);
    expect(status.lastSyncMs).toBe(999);
    expect(status.raw['extra']).toBe('x');
  });

  it('listSessions 的 total 与行都读出来，limit 被钳在 1..500', async () => {
    const { fetchImpl, calls } = recorder(() =>
      jsonOk({ ok: true, total: 40, rows: [{ session_id: 'a', title: 'T', cwd: '/w', event_count: 5, turn_count: 2, last_time_ms: 1 }] }),
    );
    const page = await new DrscClient({ fetchImpl }).listSessions(0, 5_000);
    expect(page.total).toBe(40);
    expect(page.rows[0]?.sessionId).toBe('a');
    expect(calls[0]?.url).toContain('limit=500');
  });
});

describe('失败口径：一律抛 DrscClientError，由调用方把历史路整段省略', () => {
  it('非 2xx ⇒ 抛', async () => {
    const { fetchImpl } = recorder(() => ({ ok: false, json: async () => ({}) }));
    await expect(new DrscClient({ fetchImpl }).status()).rejects.toBeInstanceOf(DrscClientError);
  });

  it('ok:false ⇒ 抛并带上 collector 给的原因', async () => {
    const { fetchImpl } = recorder(() => jsonOk({ ok: false, error: 'db locked' }));
    await expect(new DrscClient({ fetchImpl }).status()).rejects.toThrow(/db locked/u);
  });

  it('fetch 直接失败（未安装/端口不通）⇒ 抛，不重试不静默', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(new DrscClient({ fetchImpl }).status()).rejects.toBeInstanceOf(DrscClientError);
  });

  it('响应不是 JSON ⇒ 抛（半截响应不能被当成"没有历史"）', async () => {
    const { fetchImpl } = recorder(() => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } }));
    await expect(new DrscClient({ fetchImpl }).status()).rejects.toBeInstanceOf(DrscClientError);
  });
});
