/**
 * 让鱼做梦（v0.3.3）：一轮确定性的本地整理 pass + 一份可回看的梦境报告。
 *
 * 三条先钉死，免得后来者把它"顺手升级"成 mini-prime：
 * 1. **零模型调用。** spirit 的整理本体全是确定性计算（等值查重、归档导出、读数汇总）；
 *    prime 的六阶段蒸馏（L0→L1→L2→L3）在本仓不存在，引入 LLM 就要背上
 *    进度轮询/取消/背压/失败态的全量复杂度——那不是做梦，是开工。
 * 2. **不删行。** 合并 = 给重复行置 `superseded_by`（与更正同构，星海幽灵点自然显示）；
 *    归档 = 写 JSONL 不动库。红线闸（全仓无物理删体验行的路径）继续绿。
 * 3. **不依赖 DRSC。** 整理对象全在自家库；唯一交叉点（拿 DRSC 原文补写残句）被
 *    "宁缺毋造"纪律否决（见 recall/form.ts 与 experience/compile.ts 的编译期同源）。
 *
 * 归档尊重部署面 `journal.dryRun`（缺省 true）：做梦不偷偷绕过干跑纪律——
 * 干跑时报告只报"会归档几场"，实写需要用户在配置面显式开启。
 *
 * 报告落 meta 单键 `dream.lastReport`：面板读它说话，**不进系统提示**
 * （不抢 card.maxBytes 预算，见 contract.ts card 节注释的预算互撞教训）。
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { SpiritConfig } from '../contract.js';
import type { MinimalLogger } from '../persona/store.js';
import { formOf, FORM_FULL, FORM_GIST, FORM_HELD, type FadeConfig } from '../recall/form.js';
import { archiveSessions, planRetention } from '../store/journal-retention.js';
import type { ExperienceStore } from '../store/experience.js';

/** 梦境报告在 meta 里的单键（面板「上次梦境」唯一来源）。 */
export const DREAM_META_KEY = 'dream.lastReport';

/** 进程内去重窗：定时器/按钮/（未来）事件推送三入口收敛成至多一次真跑（照 owner 同步先例）。 */
export const DREAM_DEDUP_MS = 60_000;

export interface DreamReport {
  /** 本次做梦时间戳；只进面板状态行，禁进注入文本（稳定区纪律）。 */
  dreamedAt: number;
  /** 查重合并掉的重复行数（被置 superseded_by 的旧行）。 */
  mergedPairs: number;
  archivedSessions: number;
  archivedEntries: number;
  /** 归档当时是否干跑（部署面 journal.dryRun 的原样回执，不粉饰）。 */
  archiveDryRun: boolean;
  /** 在场条目总数（未藏未取代）。 */
  active: number;
  /** 幽灵行数（被取代的历史版本）。 */
  ghosts: number;
  /** 被标过在意（★ ≥ 0）的在场行数。 */
  marked: number;
  tierFull: number;
  tierGist: number;
  tierHeld: number;
}

export interface DreamOutcome {
  updated: boolean;
  reason?: 'dedup-window' | 'running' | 'degraded' | 'failed' | 'disabled';
  report?: DreamReport;
}

function fadeOf(cfg: SpiritConfig): FadeConfig {
  // 与 spirit.ts 的 fadeConfigOf 同一份 recall 节投影（字段单源在 config schema）
  return {
    fadeEnabled: cfg.recall.fadeEnabled,
    feedbackEnabled: cfg.recall.feedbackEnabled,
    fadeHalfLifeMs: cfg.recall.fadeHalfLifeMs,
    fullMinScore: cfg.recall.fadeFullMinScore,
    gistMinScore: cfg.recall.fadeGistMinScore,
    gistMinSalience: cfg.recall.gistMinSalience,
  };
}

function countWhere(db: DatabaseSync, clause: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM experience WHERE ${clause}`).get() as Record<string, SQLOutputValue> | undefined;
    const n = row?.['n'];
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export class DreamRunner {
  private lastRunAt = 0;
  private running = false;

  constructor(private readonly deps: {
    store: ExperienceStore;
    /** db 取用现走闭包：装配期库可能还没开成（降级链），每轮现判。 */
    db: () => DatabaseSync | null;
    dataDir: string;
    cfg: () => SpiritConfig;
    logger: MinimalLogger;
  }) {}

  /** 上次梦境报告（meta 读回；坏 JSON/缺键 ⇒ null，面板退"还没做过梦"）。 */
  lastReport(): DreamReport | null {
    const db = this.deps.db();
    if (db === null) return null;
    try {
      const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(DREAM_META_KEY) as Record<string, SQLOutputValue> | undefined;
      const raw = row?.['value'];
      if (typeof raw !== 'string' || raw === '') return null;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const p = parsed as Record<string, unknown>;
      if (typeof p['dreamedAt'] !== 'number') return null;
      return p as unknown as DreamReport;
    } catch {
      return null;
    }
  }

  /**
   * 做一次梦：①等值查重合并 ②归档淡出（尊重 dryRun）③汇总报告落 meta。
   * 幂等由去重窗 + running 单标志兜住（短任务同步，不需要 prime 那套双标志+取消链）。
   */
  run(): DreamOutcome {
    // 双闸（部署面总闸 ∧ live 热更闸，cfg 即 eff 视图）：设置面关掉后定时器与手动都拒
    if (!this.deps.cfg().dream.enabled) return { updated: false, reason: 'disabled' };
    const db = this.deps.db();
    if (db === null) return { updated: false, reason: 'degraded' };
    const now = Date.now();
    if (this.running) return { updated: false, reason: 'running' };
    if (now - this.lastRunAt < DREAM_DEDUP_MS) return { updated: false, reason: 'dedup-window' };
    this.running = true;
    try {
      this.lastRunAt = now;

      // ① 查重合并：每组保留最新，其余置 superseded_by 指向保留者（插标记不插行）
      let mergedPairs = 0;
      for (const group of this.deps.store.dreamDuplicateGroups()) {
        const keep = group[0];
        if (keep === undefined) continue;
        for (const dup of group.slice(1)) {
          if (this.deps.store.supersede(dup.id, keep.id)) mergedPairs += 1;
        }
      }

      // ② 归档淡出：计划纯读先算，写不写由部署面 dryRun 说话（缺省只报数）
      const cfg = this.deps.cfg();
      const plan = planRetention({ db, retentionDays: cfg.journal.retentionDays, now, dryRun: cfg.journal.dryRun });
      const archive = archiveSessions({
        db,
        logger: this.deps.logger,
        dataDir: this.deps.dataDir,
        plan,
        loadSession: (sessionId) => this.deps.store.allForSession(sessionId),
      });

      // ③ 报告读数（在场行的淡出档位分布 + 三计数）
      const fade = fadeOf(cfg);
      const sample = this.deps.store.listRecent(500);
      let tierFull = 0;
      let tierGist = 0;
      let tierHeld = 0;
      for (const entry of sample) {
        const form = formOf(entry, now, fade);
        if (form === FORM_FULL) tierFull += 1;
        else if (form === FORM_GIST) tierGist += 1;
        else if (form === FORM_HELD) tierHeld += 1;
      }
      const report: DreamReport = {
        dreamedAt: now,
        mergedPairs,
        archivedSessions: archive.files.length,
        archivedEntries: archive.written,
        archiveDryRun: plan.dryRun,
        active: this.deps.store.countAll(),
        ghosts: countWhere(db, 'superseded_by IS NOT NULL'),
        marked: countWhere(db, 'feedback_score >= 0 AND superseded_by IS NULL AND hidden_at IS NULL'),
        tierFull,
        tierGist,
        tierHeld,
      };
      db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(DREAM_META_KEY, JSON.stringify(report));
      return { updated: true, report };
    } catch (err) {
      // 失败不编报告：读数半截的「梦境」比没做过梦更误导人；重试由下个周期自然带来
      this.deps.logger.warn(`[spirit] 做梦失败（本轮跳过，不编报告）：${err instanceof Error ? err.message : String(err)}`);
      return { updated: false, reason: 'failed' };
    } finally {
      this.running = false;
    }
  }
}
