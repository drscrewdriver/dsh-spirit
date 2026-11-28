/**
 * settingsWrite 纯核（从 index.ts 抽出，便于钉死 ns 对齐 / volatile 逐键回退 / 读回校验）。
 *
 * 宿主事实（dsh-settings/src/index.ts）：describe() 的 row.ns = entry.options.id，
 * mutate() 也按 entry.options.id 精确匹配并校验 isVolatilePath(schema, path)。
 * 所以写路径必须按真实 entry id 找 row —— 回退常量（cordis 插件名）永不命中。
 */
import type { SpiritLiveSettings } from './contract.js';

export interface SettingsRow { ns?: unknown; value?: unknown }
export interface SettingsServiceLike {
  describe(): SettingsRow[];
  mutate(ns: string, ops: Array<{ op: string; path: string[]; value: unknown }>, fiber?: unknown): Promise<unknown>;
}

/** entryId 解析链：运行时 fiber → 编译期 entry id → cordis 插件名。 */
export function entryIdOf(fiberEntryId: unknown, fallbackEntry: string, fallbackPlugin: string): string {
  if (typeof fiberEntryId === 'string' && fiberEntryId !== '') return fiberEntryId;
  return fallbackEntry || fallbackPlugin;
}

const unwrap = (v: unknown): unknown => (
  v !== null && typeof v === 'object' && typeof (v as { get?: unknown }).get === 'function'
    ? (v as { get: () => unknown }).get()
    : v
);

const liveOf = (row: SettingsRow | undefined): unknown => {
  const value = row?.value;
  if (value === null || typeof value !== 'object') return undefined;
  return unwrap((value as Record<string, unknown>)['live']);
};

const isNotVolatile = (e: unknown): boolean => {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('not volatile') || msg.includes('is not volatile');
};

export interface WriteResult { ok: boolean; error?: string }

/**
 * 写 live 节并读回校验。ns 按 entryId 精确匹配，失败信息带已知 ns 列表；
 * 整对象 path:['live'] 抛 not volatile 时自动逐键 path:['live', key] 回退。
 */
export async function writeLiveSettings(opts: {
  svc: SettingsServiceLike | undefined;
  entryId: string;
  patch: Partial<SpiritLiveSettings>;
}): Promise<WriteResult> {
  const { svc, entryId, patch } = opts;
  if (svc === undefined) return { ok: false, error: '宿主 settings 服务不可用（改值需重启）' };
  const rows = svc.describe();
  const knownNs = rows.map((r) => String(r.ns)).filter((n) => n !== 'undefined');
  const row = rows.find((r) => String(r.ns) === entryId)
    ?? rows.find((r) => {
      const v = liveOf(r);
      return v !== null && typeof v === 'object';
    });
  if (row === undefined) {
    return {
      ok: false,
      error: `settings.describe() 找不到 dsh-spirit 的 live 节（entryId=${entryId}，已知 ns=[${knownNs.join(', ')}]）`,
    };
  }
  const ns = String(row.ns);
  const rawLive = liveOf(row);
  const merged = {
    ...(rawLive !== null && typeof rawLive === 'object' ? rawLive as Record<string, unknown> : {}),
    ...patch,
  };
  let usedPerKey = false;
  try {
    await svc.mutate(ns, [{ op: 'set', path: ['live'], value: merged }], undefined);
  } catch (e) {
    if (!isNotVolatile(e)) return { ok: false, error: e instanceof Error ? e.message : String(e) };
    usedPerKey = true;
    try {
      for (const [key, value] of Object.entries(patch)) {
        await svc.mutate(ns, [{ op: 'set', path: ['live', key], value }], undefined);
      }
    } catch (e2) {
      return { ok: false, error: e2 instanceof Error ? e2.message : String(e2) };
    }
  }
  const after = svc.describe().find((r) => String(r.ns) === ns);
  const afterLive = liveOf(after);
  if (afterLive === null || typeof afterLive !== 'object') return { ok: false, error: 'read-back-mismatch: live 节读回为空' };
  for (const [k, v] of Object.entries(patch)) {
    if ((afterLive as Record<string, unknown>)[k] !== v) return { ok: false, error: `read-back-mismatch: ${k} 未落地` };
  }
  // usedPerKey 仅用于诊断标记（保留变量以明示两种形状都走过读回）
  void usedPerKey;
  return { ok: true };
}
