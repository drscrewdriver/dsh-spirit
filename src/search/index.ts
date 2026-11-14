/**
 * 检索索引的编排面（v19）：戳判定 → 全量回填 → 写戳；失败整链禁用。
 *
 * 三条纪律：
 * 1. **只在"表空 / 分词器戳变 / 未回填"时跑全量**——开库路径是同步的，不能每次都扫全库；
 * 2. **单事务**：半途失败必须回滚，否则会留下"半个索引"，那比没有索引更糟（静默漏召回）；
 * 3. **失败即判死**：`markSearchIndexUnusable` 让本进程后续查询一律回落 LIKE，不返回残缺结果。
 *
 * ⚠️ 本文件不得出现 `FROM experience` 或本体表名（TA.6(b) 泛扫）：真正的读表都在
 * `backfill-exp.ts` / `backfill-onto.ts` 两个分文件里。
 */
import type { DatabaseSync } from 'node:sqlite';

import {
  clearSearchIndex,
  ensureSearchFtsTable,
  markSearchIndexUnusable,
  searchIndexMeta,
  searchIndexStats,
  writeSearchIndexMeta,
} from './fts.js';
import { backfillExperienceIndex } from './backfill-exp.js';
import { backfillOntologyIndex } from './backfill-onto.js';
import { describeTokenizer, tokenizerMode, tokenizerStamp } from './tokenizer.js';

export interface EnsureSearchResult {
  state: 'ok' | 'skipped' | 'rebuilt' | 'failed';
  /** 索引里的文档数（ok 时是现存数，rebuilt 时是本次写入数）。 */
  docs: number;
  /** 本次耗时（ms）；ok 直接命中时为 0。 */
  ms: number;
  /** 分词模式（jieba / bigram），日志与面板用。 */
  mode: string;
  reason?: string;
}

/**
 * 保证索引与本机分词器一致（幂等）。
 *
 * @param opts.warn 诊断输出（回填失败/降级时调用一次；不传则静默）
 */
export function ensureSearchIndex(
  db: DatabaseSync | null | undefined,
  opts: { warn?: (message: string) => void; force?: boolean } = {},
): EnsureSearchResult {
  const started = Date.now();
  const mode = tokenizerMode();
  if (db === null || db === undefined) return { state: 'skipped', docs: 0, ms: 0, mode, reason: '无库' };
  if (!ensureSearchFtsTable(db)) {
    return { state: 'skipped', docs: 0, ms: 0, mode, reason: 'FTS 不可用（已回落 LIKE）' };
  }
  const stamp = tokenizerStamp();
  const meta = searchIndexMeta(db);
  if (opts.force !== true && meta.stamp === stamp && meta.backfilled) {
    return { state: 'ok', docs: searchIndexStats(db).docs, ms: 0, mode };
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    let written = 0;
    try {
      clearSearchIndex(db);
      written += backfillExperienceIndex(db);
      written += backfillOntologyIndex(db).written;
      writeSearchIndexMeta(db, stamp);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败也只能继续走判死 */
      }
      throw err;
    }
    return { state: 'rebuilt', docs: written, ms: Date.now() - started, mode };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    markSearchIndexUnusable(db, `回填失败：${reason}`);
    opts.warn?.(`[spirit] 检索索引回填失败，本次降到 LIKE：${reason}`);
    return { state: 'failed', docs: 0, ms: Date.now() - started, mode, reason };
  }
}

/** 强制全量重建（诊断/测试/改分词器后手动触发）。 */
export function rebuildSearchIndex(
  db: DatabaseSync | null | undefined,
  opts: { warn?: (message: string) => void } = {},
): EnsureSearchResult {
  return ensureSearchIndex(db, { ...opts, force: true });
}

/** 一行诊断（启动横幅用）：分词模式 + 索引文档数 + 本次耗时。 */
export function describeSearchIndex(result: EnsureSearchResult): string {
  const base = `${describeTokenizer()} · 索引 ${result.docs} 篇`;
  if (result.state === 'rebuilt') return `${base}（本次重建 ${result.ms}ms）`;
  if (result.state === 'failed') return `${base}（回填失败，已回落 LIKE：${result.reason ?? '未知'}）`;
  if (result.state === 'skipped') return `${base}（${result.reason ?? '跳过'}）`;
  return base;
}