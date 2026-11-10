/**
 * 长觉蒸馏模型的**运行时覆盖**（Phase：面板可切换模型）。
 *
 * 为什么用 meta 而不是把 distill.provider/model 升成 volatile 设置面：
 * - 后者要动六腿（defaults/RANGES/schema/settings-set/…）且把部署面纪律改成热更面，代价与风险都不小；
 * - 覆盖存 meta 是 spirit 自有运行态（照 sleep.watermark 先例），优先级清清楚楚：
 *   **部署面 pin（cfg.distill.provider+model 双齐）> 本覆盖 > agentDefaultModel**（由编排层组合 defaultModel getter 实现，见 index.ts）。
 *
 * 三条纪律：
 * 1. **只在成对时写**：{provider,model} 要么都有要么都无（半配 = 配错，宁缺毋造），与 resolveDistillRoute 同口径。
 * 2. **降级面休眠**：db=null（存储不可用）⇒ 读返回 undefined、写返回 false，不抛穿、不攒内存镜像（覆盖无回灌路径）。
 * 3. **清除=DELETE**：把选择收回、回到跟宿主默认，是删键不是写空串（空串会被当成半配拒）。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { DistillRoute } from './llm.js';

/** meta 单键：运行时蒸馏路由覆盖（JSON `{provider,model}`）。 */
export const RUNTIME_ROUTE_KEY = 'distill.runtimeRoute';

const READ_SQL = `SELECT value FROM meta WHERE key = ?`;
const UPSERT_SQL = `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
const DELETE_SQL = `DELETE FROM meta WHERE key = ?`;

function cleanPart(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 200) : '';
}

/** 读运行时覆盖；缺键/坏 JSON/半配/降级面 ⇒ undefined（调用方据此回宿主默认）。 */
export function readRuntimeRoute(db: DatabaseSync | null): DistillRoute | undefined {
  if (db === null) return undefined;
  try {
    const row = db.prepare(READ_SQL).get(RUNTIME_ROUTE_KEY) as { value?: unknown } | undefined;
    const raw = row?.value;
    if (typeof raw !== 'string' || raw === '') return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const shape = parsed as Record<string, unknown>;
    const provider = cleanPart(shape['provider']);
    const model = cleanPart(shape['model']);
    // 成对才算数：半配按“没配”处理（回宿主默认），绝不用半个路由隐式改选。
    if (provider === '' || model === '') return undefined;
    return { provider, model };
  } catch {
    return undefined;
  }
}

/**
 * 写运行时覆盖：route=null ⇒ 清除回宿主默认；provider/model 非成对 ⇒ 拒（返回 false）。
 * 降级面（db=null）⇒ 无法持久，返回 false（不落内存镜像：面板要能如实说“没存上”）。
 */
export function writeRuntimeRoute(db: DatabaseSync | null, route: DistillRoute | null): boolean {
  if (db === null) return false;
  try {
    if (route === null) {
      db.prepare(DELETE_SQL).run(RUNTIME_ROUTE_KEY);
      return true;
    }
    const provider = cleanPart(route.provider);
    const model = cleanPart(route.model);
    if (provider === '' || model === '') return false;
    db.prepare(UPSERT_SQL).run(RUNTIME_ROUTE_KEY, JSON.stringify({ provider, model }));
    return true;
  } catch {
    return false;
  }
}
