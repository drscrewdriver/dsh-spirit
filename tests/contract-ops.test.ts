/**
 * RPC 端点表对齐门禁（v0.3 六腿之一）。
 *
 * 为什么要单独一条：`SPIRIT_OPS`（契约）→ `ENDPOINTS/SHORT_METHODS`（路由白名单）是
 * 派生关系，但派生只在"有人改了 constants 却忘了 router"时才会暴露。历史教训是
 * 白名单漏一条 = 面板那个功能**静默消失**（客户端把 404 吞进 catch），所以这里把
 * 「契约表 ⇄ 路由白名单」钉成一条断言，并顺带守住"不许出现重复端点"。
 */
import { describe, expect, it } from 'vitest';

import { SPIRIT_OPS, rpcPath } from '../src/contract.js';
import { SPIRIT_RPC_METHODS } from '../src/rpc.js';

describe('契约 op ⇄ 路由白名单', () => {
  it('SPIRIT_OPS 与 SPIRIT_RPC_METHODS 逐项同序', () => {
    expect([...SPIRIT_RPC_METHODS]).toEqual([...SPIRIT_OPS]);
  });

  it('端点无重复（重复会让 register 覆盖前一条）', () => {
    const unique = new Set(SPIRIT_OPS);
    expect(unique.size).toBe(SPIRIT_OPS.length);
  });

  it('每个 op 都能拼出带前缀的路径', () => {
    for (const op of SPIRIT_OPS) {
      expect(rpcPath(op)).toBe(`dsh-spirit/${op}`);
    }
  });

  it('v0.3 五个新端点确实在契约里（缺一即错版）', () => {
    for (const op of ['sea-graph', 'persona-preview', 'persona-set', 'persona-history', 'persona-restore'] as const) {
      expect(SPIRIT_OPS).toContain(op);
    }
  });

  it('v0.3.1 人设 markdown 备份两端点在契约里', () => {
    for (const op of ['persona-export-md', 'persona-import-md'] as const) {
      expect(SPIRIT_OPS).toContain(op);
    }
  });

  it('v0.3.2 主人背景档案四端点在契约里', () => {
    for (const op of ['owner-get', 'owner-set-self', 'owner-sync-now', 'owner-sync-ping'] as const) {
      expect(SPIRIT_OPS).toContain(op);
    }
  });

  it('v0.3.3 翻阅 tab 与做梦六端点在契约里（缺一即错版）', () => {
    for (const op of ['entries-list', 'entries-hide', 'entries-unhide', 'entries-update', 'dream-run', 'dream-report'] as const) {
      expect(SPIRIT_OPS).toContain(op);
    }
  });

  it('v0.3.5 长觉阶梯六端点在契约里（sleep 族 + 主题面 + 碰撞裁决）', () => {
    for (const op of ['sleep-run', 'sleep-status', 'sleep-cancel', 'sleep-report', 'topics-get', 'insight-resolve'] as const) {
      expect(SPIRIT_OPS).toContain(op);
    }
  });

  it('v0.4 事务轨查询面两端点在契约里（时间线 + 资源反查）', () => {
    for (const op of ['timeline-query', 'resource-lookup'] as const) {
      expect(SPIRIT_OPS).toContain(op);
    }
  });

  it('v0.4 长觉模型选择三端点在契约里（读视图 + 列模型 + 写覆盖）', () => {
    for (const op of ['distill-models', 'distill-model-list', 'distill-model-set'] as const) {
      expect(SPIRIT_OPS).toContain(op);
    }
  });

  it('v0.4 本体层查询端点在契约里（evaluation-list）', () => {
    expect(SPIRIT_OPS).toContain('evaluation-list');
  });

  it('v0.4 本体层图/任务查询四端点在契约里（entity-graph/entity-lookup/task-list/task-detail）', () => {
    for (const op of ['entity-graph', 'entity-lookup', 'task-list', 'task-detail'] as const) {
      expect(SPIRIT_OPS).toContain(op);
    }
  });

  it('v0.4 历史回填触发端点在契约里（ontology-backfill-run）', () => {
    expect(SPIRIT_OPS).toContain('ontology-backfill-run');
  });
});
