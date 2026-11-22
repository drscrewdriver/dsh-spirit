/**
 * 连击冷却窗（v0.9.1 · capture.cooldownMs）的记录路径门。
 *
 * 守三件事：
 * 1. 同 workspace 窗内同 trigger 的第二条失败**不落库**（星图不再被同一句话刷屏）；
 * 2. 窗过恢复记录（冷却不是失忆）；
 * 3. `cooldownMs=0` 关闭冷却（退回每轮必记的老行为）。
 * 真库夹具（openSpiritDb）：db=null 降级面按设计不冷却，那条在 experience.test.ts 的
 * lastTsByTrigger 单元断言里守。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { Spirit, type PreStepInput } from '../src/spirit.js';
import { TurnWatcher } from '../src/experience/watcher.js';
import { ExperienceStore } from '../src/store/experience.js';
import { DEFAULT_PERSONA } from '../src/persona/types.js';
import { SPIRIT_DEFAULTS, type SpiritConfig } from '../src/contract.js';
import { openSpiritDb } from '../src/db/open.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
const BASE = 1_700_000_000_000;

function cfgWithCooldown(cooldownMs: number): () => SpiritConfig {
  const base: SpiritConfig = structuredClone(SPIRIT_DEFAULTS);
  base.capture.cooldownMs = cooldownMs;
  return () => base;
}

const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened.splice(0, opened.length)) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
});

interface Harness {
  spirit: Spirit;
  store: ExperienceStore;
  db: DatabaseSync;
  input: (over: Partial<PreStepInput>) => PreStepInput;
  dispose: () => void;
}

function harness(cooldownMs: number): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-cooldown-'));
  const got = openSpiritDb(dir);
  if (!got.ok) throw new Error('库应打开成功');
  opened.push(got.db);
  const store = new ExperienceStore({ db: got.db, logger });
  const cfg = cfgWithCooldown(cooldownMs);
  const spirit = new Spirit(
    {
      cfg,
      live: () => cfg().live,
      store,
      watcher: new TurnWatcher({ gapThresholdMs: cfg().capture.gapThresholdMs }),
      modes: { isOff: () => false, isBypass: () => false },
      history: { store },
      logger,
      recentEntries: (sessionId, k) => store.recent(sessionId, k),
      previousEntries: () => [],
    },
    DEFAULT_PERSONA,
  );
  return {
    spirit,
    store,
    db: got.db,
    input: (over) => ({
      agentId: 'a1', sessionId: 's1', workspaceId: 'w1', ownerId: 's1', isSubagent: false,
      newUserText: '继续', messageCount: 1, now: BASE, ...over,
    }),
    dispose: () => {
      // 先关连接再删目录：Windows 上开着句柄 unlink 会 EBUSY
      try {
        got.db.close();
      } catch {
        /* 已关 */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 按 trigger 精确计数（未取代未藏）：避开轮间隔触发的 long_gap 干扰。 */
function triggerCount(h: Harness, trigger: string): number {
  const row = h.db
    .prepare(`SELECT COUNT(*) AS n FROM experience WHERE trigger = ? AND superseded_by IS NULL AND hidden_at IS NULL`)
    .get(trigger) as { n?: number };
  return typeof row.n === 'number' ? row.n : 0;
}

/** 跑一个"工具失败轮"：pre-step 建轮上下文，事件流喂 watcher，turn/end 结算落库。 */
async function failTurn(h: Harness, at: number): Promise<void> {
  await h.spirit.onPreStep(h.input({ now: at }));
  h.spirit.observeEvent('s1', { type: 'turn/start', data: { turn: 1 } }, at);
  h.spirit.observeEvent('s1', { type: 'tool/call', data: { callId: `c-${at}`, name: 'bash' } }, at + 100);
  h.spirit.observeEvent('s1', { type: 'tool/result', data: { message: { toolCallId: `c-${at}`, isError: true } } }, at + 200);
  h.spirit.observeEvent('s1', { type: 'turn/end', data: { turn: 1 } }, at + 300);
}

describe('连击冷却窗（capture.cooldownMs）', () => {
  it('窗内第二条同族失败不落库；窗过恢复记录', async () => {
    const h = harness(600_000);
    try {
      await failTurn(h, BASE);
      expect(triggerCount(h, 'tool_failure')).toBe(1);
      // 2 分钟后又踩同一个坑：窗内 ⇒ 跳过落库
      await failTurn(h, BASE + 120_000);
      expect(triggerCount(h, 'tool_failure'), '冷却窗内不该刻第二道同样的疤').toBe(1);
      // 距上次**落库**的失败 11 分钟后：窗过 ⇒ 恢复记录
      await failTurn(h, BASE + 11 * 60_000);
      expect(triggerCount(h, 'tool_failure')).toBe(2);
    } finally {
      h.dispose();
    }
  });

  it('cooldownMs=0 ⇒ 关闭冷却，每轮必记（老行为）', async () => {
    const h = harness(0);
    try {
      await failTurn(h, BASE);
      await failTurn(h, BASE + 5_000);
      expect(triggerCount(h, 'tool_failure')).toBe(2);
    } finally {
      h.dispose();
    }
  });

  it('lastTsByTrigger：幽灵与藏行不算数，降级面（db=null）返回 undefined', () => {
    const memoryStore = new ExperienceStore({ db: null, logger });
    expect(memoryStore.lastTsByTrigger('w1', 'tool_failure', 0)).toBeUndefined();
    const h = harness(600_000);
    try {
      const seed = (id: string, ts: number, trigger = 'tool_failure') =>
        seedEntry(h.store, id, ts, trigger);
      seed('x1', BASE);
      expect(h.store.lastTsByTrigger('w1', 'tool_failure', BASE - 1)).toBe(BASE);
      expect(h.store.lastTsByTrigger('w1', 'tool_failure', BASE + 1)).toBeUndefined();
      expect(h.store.lastTsByTrigger('w2', 'tool_failure', BASE - 1)).toBeUndefined();
      // 藏起来的行不再给冷却背书
      h.store.setHidden(['x1'], true);
      expect(h.store.lastTsByTrigger('w1', 'tool_failure', BASE - 1)).toBeUndefined();
    } finally {
      h.dispose();
    }
  });
});

function seedEntry(store: ExperienceStore, id: string, tsMs: number, trigger: string): void {
  store.append(
    { id, sessionId: 'sx', workspaceId: 'w1', turnSeq: 1, tsMs, personaRevision: 1 },
    { trigger: trigger as never, notice: 'environment', reaction: 'mild', text: '种子句', fact: {}, lane: 'live' },
  );
}
