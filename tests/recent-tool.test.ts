/**
 * 生涯回顾入口（v0.8.22）：时间性查询走 spirit_history，不再靠关键词 recall。
 * - recent 纯函数：按 days 选档 + 关键词过滤 + 限量
 * - 工具注册：spirit_history 存在、描述里写明与 memory_search 分工、execute 返回档行
 */
import { describe, expect, it } from 'vitest';

import type { DistillDigestRow } from '../src/contract.js';
import { SPIRIT_TOOL_PREFIX } from '../src/contract.js';
import { recentLines, selectRecentDigests } from '../src/prime/recent.js';
import { registerMemoryTools } from '../src/tools/memory.js';
import type { Context } from '@deepseek-ai/cordis';

function digest(tier: DistillDigestRow['tier'], summary: string): DistillDigestRow {
  return { category: 'procedural', tier, periodKey: `${tier}-k`, windowDays: 7, generatedAt: 1, count: 1, summary, entities: [] };
}

const DIGESTS: DistillDigestRow[] = [
  digest('week', '2026-11-10 · work_task · 修好了回响列表\n2026-11-09 · work_task · 9 语收口'),
  digest('month', '2026-10-28 · work_task · 生涯档立项'),
  digest('milestone', '2026-11-08 · work_task · 18/18 推送完成'),
];

describe('recent 选档', () => {
  it('≤7 天：week + milestone；≤30 天：加 month；排序 week→month→milestone', () => {
    expect(selectRecentDigests(DIGESTS, 7).map((row) => row.tier)).toEqual(['week', 'milestone']);
    expect(selectRecentDigests(DIGESTS, 30).map((row) => row.tier)).toEqual(['week', 'month', 'milestone']);
  });

  it('关键词过滤与上限', () => {
    expect(recentLines(DIGESTS, { days: 7 }).length).toBe(3);
    expect(recentLines(DIGESTS, { days: 7, q: '9 语' }).map((line) => line.line)).toEqual(['2026-11-09 · work_task · 9 语收口']);
    expect(recentLines(DIGESTS, { days: 30, limit: 2 }).length).toBe(2);
  });
});

describe('工具注册：spirit_history', () => {
  function captureTools() {
    const definitions: Array<Record<string, unknown>> = [];
    const tools = { register: (tool: unknown) => { definitions.push(tool as Record<string, unknown>); return () => undefined; } };
    const ctx = { inject: (_names: string[], callback: (scope: { get: (key: string) => unknown }) => void) => callback({ get: () => tools }) } as unknown as Context;
    const memory = {
      recent: () => [{ id: 'm1', scope: 'life', kind: 'bond', text: '与主人的约定', pinned: true, updatedAt: Date.now() }],
      search: () => [],
      write: (input: { scope: string; kind: string; text: string }) => ({ ok: true, row: { id: 'mem-new', scope: input.scope, kind: input.kind, text: input.text } }),
      pin: () => false,
      forget: () => false,
    };
    const goals = { add: () => ({ ok: false, reason: 'n/a' }), setStatus: () => false, list: () => [] };
    registerMemoryTools(ctx, { memory, goals, logger: { warn: () => undefined, info: () => undefined }, digests: () => DIGESTS } as never);
    return definitions;
  }

  it('注册出 spirit_history；描述写明与 memory_search 的分工；execute 返回档行', async () => {
    const definitions = captureTools();
    const names = definitions.map((tool) => String(tool['name']));
    expect(names).toContain(`${SPIRIT_TOOL_PREFIX}history`);
    const history = definitions.find((tool) => tool['name'] === `${SPIRIT_TOOL_PREFIX}history`);
    const description = String(history?.['description'] ?? '');
    expect(description).toContain('memory_search');
    expect(description).toContain('不占');
    const execute = history?.['execute'] as (args: Record<string, unknown>) => Promise<{ ok: boolean; notice: string; items: Array<{ kind: string; source: string }> }>;
    const result = await execute({ days: 7 });
    expect(result.ok).toBe(true);
    expect(result.items.some((item) => item.source === 'digest' && item.kind === 'week')).toBe(true);
    expect(result.notice).toContain('近 7 天');
    // 回归：注册对象必须是宿主 defineTool 规范化后的 JSON Schema（不得裸传字段表⇒上游 400）
    const params = history?.['parameters'] as { type?: string; properties?: Record<string, unknown>; required?: string[] };
    expect(params.type).toBe('object');
    expect(Object.keys(params.properties ?? {})).toEqual(expect.arrayContaining(['days', 'q', 'limit']));
    expect(params.required ?? []).not.toContain('days');
    const memoryParams = (definitions.find((tool) => tool['name'] === `${SPIRIT_TOOL_PREFIX}memory`)?.['parameters'] ?? {}) as { type?: string; required?: string[] };
    expect(memoryParams.type).toBe('object');
    expect(memoryParams.required ?? []).toContain('action');
  });

  it('spirit_memory 也支持 action=recent（兼容旧入口）', async () => {
    const definitions = captureTools();
    const memoryTool = definitions.find((tool) => tool['name'] === `${SPIRIT_TOOL_PREFIX}memory`);
    const execute = memoryTool?.['execute'] as (args: Record<string, unknown>) => Promise<{ ok: boolean; items: unknown[] }>;
    const result = await execute({ action: 'recent', days: 30 });
    expect(result.ok).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('agent 可用 spirit_memory 记对话细节（scope=episode / kind=detail）', async () => {
    const definitions = captureTools();
    const memoryTool = definitions.find((tool) => tool['name'] === `${SPIRIT_TOOL_PREFIX}memory`);
    const execute = memoryTool?.['execute'] as (args: Record<string, unknown>) => Promise<{ ok: boolean; notice: string }>;
    const result = await execute({ action: 'write', scope: 'episode', kind: 'detail', text: '主人说：先把旧会话蒸馏清掉，重建改读 L1' });
    expect(result.ok).toBe(true);
    expect(result.notice).toContain('已记进');
  });
});
