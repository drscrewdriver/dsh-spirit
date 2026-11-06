/**
 * 长觉阶梯派生层（v0.3.5）：主题分区、洞察碰撞、因果边两源。
 * 真库夹具；重点覆盖用户点名的「碰撞检查三层」与工作记忆正交性。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { ExperienceStore } from '../src/store/experience.js';
import { TopicStore, TOPIC_CAP, TOPIC_GENERAL } from '../src/store/topics.js';
import { InsightStore } from '../src/store/insights.js';
import { EdgeStore, heuristicEdges, isCausalRelation } from '../src/store/edges.js';
import { SPIRIT_CAUSAL_RELATIONS } from '../src/types.js';
import { TRIGGER_RECOVERY, TRIGGER_TOOL_FAILURE } from '../src/types.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
const openDbs: DatabaseSync[] = [];

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-ladder-'));
});
afterEach(() => {
  for (const db of openDbs.splice(0, openDbs.length)) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error('库应打开成功');
  openDbs.push(opened.db);
  const db = opened.db;
  const store = new ExperienceStore({ db, logger });
  return {
    db,
    store,
    topics: new TopicStore({ db: () => db, logger }),
    insights: new InsightStore({ db: () => db, logger }),
    edges: new EdgeStore({ db: () => db, logger }),
  };
}

function putEntry(store: ExperienceStore, id: string, trigger: string, tsMs: number, sessionId = 's1') {
  store.append(
    { id, sessionId, workspaceId: 'w1', turnSeq: 1, tsMs, personaRevision: 1 },
    { trigger: trigger as typeof TRIGGER_TOOL_FAILURE, notice: 'environment', reaction: 'mild', text: `${id} 的一句话`, fact: { tool: 'bash' }, lane: 'live' },
  );
}

describe('主题分区（确定性骨架 + 改判）', () => {
  it('heuristic 回填：有 cue 的条目按首 cue 聚桶；无 cue 不强塞', () => {
    const h = harness();
    putEntry(h.store, 'a1', TRIGGER_TOOL_FAILURE, 1000);
    putEntry(h.store, 'a2', TRIGGER_TOOL_FAILURE, 2000);
    const entries = h.store.listRecent(50).map((e) => ({ id: e.id, trigger: e.trigger, cues: h.store.cuesFor([e.id]).get(e.id) ?? [] }));
    const assigned = h.topics.heuristicBackfill(entries, Date.now());
    expect(assigned).toBe(2);
    const topics = h.topics.topicsWithCounts();
    expect(topics).toHaveLength(1); // 同 cue ⇒ 同桶
    expect(topics[0]?.entries).toBe(2);
  });

  it('改判=写新行不抹历史：distilled 覆盖 heuristic 归属，旧关联行进 superseded 态', () => {
    const h = harness();
    const now = Date.now();
    putEntry(h.store, 'e1', TRIGGER_TOOL_FAILURE, now); // 主题计数只认在场条目（正交性：幽灵/藏行不算）
    const t1 = h.topics.ensureTopic('bash 的事', 'heuristic', now);
    const t2 = h.topics.ensureTopic('深水区', 'distilled', now);
    h.topics.assign('e1', t1.id, 'heuristic', now);
    expect(h.topics.assign('e1', t1.id, 'heuristic', now)).toBe(false); // 同题幂等
    expect(h.topics.assign('e1', t2.id, 'distilled', now + 1)).toBe(true); // 改判
    const counts = h.topics.topicsWithCounts();
    expect(counts.find((c) => c.topic.id === t2.id)?.entries).toBe(1);
    expect(counts.find((c) => c.topic.id === t1.id)?.entries).toBe(0);
  });

  it('topicCap 有顶：32 个之后新主题归并到兜底位 general', () => {
    const h = harness();
    const now = Date.now();
    for (let i = 0; i < TOPIC_CAP + 5; i += 1) h.topics.ensureTopic(`主题${i}`, 'heuristic', now);
    const overflow = h.topics.ensureTopic('第 33 个', 'distilled', now);
    expect(overflow.name).toBe(TOPIC_GENERAL);
    // 32 个业务名额 + 1 个兜底位（兜底位不占业务名额，cap 的语义是「主题不长成长尾」）
    expect(h.topics.topicsWithCounts().length).toBe(TOPIC_CAP + 1);
  });
});

describe('碰撞检查三层（用户点名 R7）', () => {
  it('conflict 双留 + 人工裁决「信这条」：败方 supersede 到胜方，胜方回 active 语义面', () => {
    const h = harness();
    const now = Date.now();
    const t = h.topics.ensureTopic('投递', 'heuristic', now);
    const rows = h.insights.insertBatch(now, 'run-1', [
      { topicId: t.id, text: '投递这条线一直是放一放的', evidenceIds: ['a1'] },
      { topicId: t.id, text: '投递这条线其实在推进', evidenceIds: ['a2'] },
    ]);
    expect(rows).toHaveLength(2);
    expect(h.insights.markConflict([rows[0]!.id, rows[1]!.id], now)).toBe(2);
    const conflicts = h.insights.conflictList();
    expect(conflicts).toHaveLength(2); // 双留：谁都没被删
    expect(h.insights.resolveKeep(rows[1]!.id, rows[0]!.id, now + 1)).toBe(true);
    expect(h.insights.conflictList()).toHaveLength(1); // 败方退出冲突清单
    expect(h.insights.byTopic(t.id).map((r) => r.id)).toEqual([rows[1]!.id]); // superseded 不在展示面
  });

  it('stale 传播（读侧 join）：证据全被更正 ⇒ 展示为 stale；条目回场即自愈', () => {
    const h = harness();
    const now = Date.now();
    putEntry(h.store, 'a1', TRIGGER_TOOL_FAILURE, now - 5000);
    putEntry(h.store, 'a2', TRIGGER_TOOL_FAILURE, now - 4000);
    const t = h.topics.ensureTopic('bash 的事', 'heuristic', now);
    h.insights.insertBatch(now, 'run-1', [{ topicId: t.id, text: '这条线卡在 bash 上', evidenceIds: ['a1', 'a2'] }]);
    expect(h.insights.byTopic(t.id)[0]?.status).toBe('active');
    h.store.setHidden(['a1', 'a2'], true); // 证据全藏 ⇒ stale
    expect(h.insights.byTopic(t.id)[0]?.status).toBe('stale');
    h.store.setHidden(['a1'], false); // 回场一条 ⇒ 自愈回 active（库值从未动过）
    expect(h.insights.byTopic(t.id)[0]?.status).toBe('active');
  });

  it('dedup pass 的落子面：merge 由调用方表达为「新行 store + 旧行 supersede」，存储层不自动删', () => {
    const h = harness();
    const now = Date.now();
    const t = h.topics.ensureTopic('投递', 'heuristic', now);
    const first = h.insights.insertBatch(now, 'run-1', [{ topicId: t.id, text: '旧表述', evidenceIds: ['a1'] }]);
    const second = h.insights.insertBatch(now + 1, 'run-2', [{ topicId: t.id, text: '合并后的新表述', evidenceIds: ['a1', 'a2'] }]);
    expect(h.insights.resolveKeep(second[0]!.id, first[0]!.id, now + 2)).toBe(true);
    const live = h.insights.byTopic(t.id);
    expect(live).toHaveLength(1);
    expect(live[0]?.text).toBe('合并后的新表述');
  });
});

describe('因果边：两源同表 + 单源词表', () => {
  it('启发式打底：同会话 失败→恢复 相邻对给「导致」边；乱序不产边', () => {
    const h = harness();
    const now = Date.now();
    putEntry(h.store, 'f1', TRIGGER_TOOL_FAILURE, now - 3000);
    putEntry(h.store, 'r1', TRIGGER_RECOVERY, now - 2000);
    putEntry(h.store, 'r2', TRIGGER_RECOVERY, now - 4000); // 恢复在失败之前 ⇒ 不连
    const edges = heuristicEdges(h.store.listRecent(50, { includeSuperseded: false }));
    expect(edges).toEqual([{ from: 'f1', to: 'r1', relation: '导致' }]);
    expect(h.edges.backfillHeuristic(edges, now)).toBe(1);
    expect(h.edges.backfillHeuristic(edges, now)).toBe(1); // REPLACE 幂等
    expect(h.edges.forSea()).toHaveLength(1);
    expect(isCausalRelation('导致')).toBe(true);
    expect(isCausalRelation('顺手')).toBe(false);
    expect([...SPIRIT_CAUSAL_RELATIONS]).toEqual(['导致', '因为', '修复了', '取代']);
  });

  it('LLM 边：无 evidence 拒收；同对覆盖 heuristic；relation 钳长度', () => {
    const h = harness();
    const now = Date.now();
    h.edges.backfillHeuristic([{ from: 'f1', to: 'r1', relation: '导致' }], now);
    expect(h.edges.insertLlm('run-1', [{ from: 'f1', to: 'r1', relation: '因为', evidenceIds: [] }], now)).toBe(0); // 无证据拒收
    expect(h.edges.insertLlm('run-1', [{ from: 'f1', to: 'r1', relation: '关系'.repeat(30), evidenceIds: ['f1', 'r1'], confidence: 900 }], now)).toBe(1);
    const sea = h.edges.forSea();
    expect(sea).toHaveLength(1); // llm 覆盖 heuristic 同对
    expect(sea[0]?.origin).toBe('llm');
    expect(sea[0]?.relation.length).toBeLessThanOrEqual(24);
  });
});
