/**
 * 迁移登记处（v0.1：空表，但**接口先立起来**）。
 *
 * 为什么空文件也要有：跨版本混用库是真实故障源（"旧插件无法打开新 schema，请勿混用版本"）。
 * 一旦 Phase 之后要加第二条 schema 版本，必须在这里登记 `from → to` 的**可回滚**迁移：
 * - 迁移前必须先落一份库快照（复制文件即可，本库无外部依赖）；
 * - 迁移失败 ⇒ 回滚快照，不允许"改一半就报成功"；
 * - 只允许向前迁移，禁止降级（降级会静默丢新列的数据）。
 */

import { SPIRIT_DB_SCHEMA_VERSION } from '../contract.js';

/** `from → to` 的迁移步骤（对库文件做快照后再跑）。 */
export interface MigrationStep {
  from: number;
  to: number;
  /** 一句人话说明这步改什么，日志与面板都要能看懂。 */
  note: string;
}

/** v0.1 无任何迁移：只有 schema 版本 1。 */
export const MIGRATIONS: readonly MigrationStep[] = [];

/**
 * 判断能否从 `stored` 升到本包版本。
 *
 * @returns `ok:true` 时 `steps` 为待执行序列（可能为空）；`ok:false` 时调用方**必须拒读**，
 *          不允许"先按现有表凑合读"——那正是丢数据的开始。
 */
export function planMigration(stored: number): { ok: true; steps: MigrationStep[] } | { ok: false; reason: string } {
  if (stored === SPIRIT_DB_SCHEMA_VERSION) return { ok: true, steps: [] };
  // 先看方向：高于本包 ⇒ 该升级插件，而不是找迁移路径
  if (stored > SPIRIT_DB_SCHEMA_VERSION) {
    return { ok: false, reason: `库版本 ${stored} 高于本插件支持的 ${SPIRIT_DB_SCHEMA_VERSION}：请升级插件` };
  }
  // 低于本包 ⇒ 只允许向前逐跳，链断即拒读（不猜、不凑合读）
  const chain: MigrationStep[] = [];
  let cursor = stored;
  for (;;) {
    const next = MIGRATIONS.find((step) => step.from === cursor);
    if (next === undefined) {
      return { ok: false, reason: `库版本 ${stored} 没有可达 ${SPIRIT_DB_SCHEMA_VERSION} 的迁移路径：拒绝按现有表凑合读（那正是丢数据的开始）` };
    }
    chain.push(next);
    cursor = next.to;
    if (cursor === SPIRIT_DB_SCHEMA_VERSION) return { ok: true, steps: chain };
    if (cursor > SPIRIT_DB_SCHEMA_VERSION) {
      return { ok: false, reason: `迁移链会越过本插件支持的 ${SPIRIT_DB_SCHEMA_VERSION}：拒执行` };
    }
  }
}
