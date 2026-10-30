import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { ExperienceStore } from '../src/store/experience.js';
import { archiveSessions, planRetention } from '../src/store/journal-retention.js';
import { classifyTrigger, isStructuredOnly, TRIGGER_PRIORITY } from '../src/experience/events.js';
import { extractCues, queryTokens, CUE_LIMITS } from '../src/experience/cues.js';
import { BODY_TABLE, REQUIRED_REACTIONS, factBits, renderExperienceText } from '../src/experience/render.js';
import { compileTurn } from '../src/experience/compile.js';
import { DEFAULT_PERSONA } from '../src/persona/types.js';
import { TRIGGER_KINDS, TRIGGER_TOOL_FAILURE, type PersonaCard, type TurnSignals } from '../src/types.js';
import { NOTICE_WORDS } from '../src/words.js';

import type { DatabaseSync } from 'node:sqlite';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };

/**
 * 本文件打开过的库连接。Windows 上不 `close()` 就会锁住 db 文件，
 * `rmSync` 直接 EBUSY——测试自各红一串，与实现无关。
 */
const openDbs: DatabaseSync[] = [];

function track<T extends DatabaseSync>(db: T): T {
  openDbs.push(db);
  return db;
}

function closeAll(): void {
  for (const db of openDbs.splice(0, openDbs.length)) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
}

function signals(over: Partial<TurnSignals> = {}): TurnSignals {
  return {
    turnSeq: 3,
    hasNewUserMessage: true,
    userChars: 20,
    toolCalls: 0,
    toolFailures: 0,
    recovered: false,
    userInterruption: false,
    gapMs: 0,
    taskClosed: false,
    facts: {},
    ...over,
  };
}

const cfg = { gapThresholdMs: 180_000 };

/** 跨 describe 共用的写入样板（放在模块层：早前写在某个 describe 里会让下面的块引用不到）。 */
const ctxA = { id: 'e1', sessionId: 's1', workspaceId: 'w1', turnSeq: 1, tsMs: 1_000, personaRevision: 1 };
const draft = {
  trigger: TRIGGER_TOOL_FAILURE,
  notice: 'environment' as const,
  reaction: 'mild' as const,
  text: '手边的动作没成，我记着这一下。',
  fact: { tool: 'bash' },
  lane: 'live' as const,
};

describe('事件分类（优先级与边界）', () => {
  it('优先级顺序即语义：插话 > 失败 > 恢复 > 收尾 > 长间隔 > 中性', () => {
    expect([...TRIGGER_PRIORITY]).toEqual([
      'user_interruption',
      'tool_failure',
      'recovery',
      'task_close',
      'long_gap',
      'neutral',
    ]);
    // 同时命中时取高优先级；恢复排在失败之后，"刚恢复"不会被记成"又坏了"
    expect(
      classifyTrigger(signals({ userInterruption: true, toolFailures: 2, recovered: true }), cfg),
    ).toBe('user_interruption');
    expect(classifyTrigger(signals({ toolFailures: 1, recovered: true }), cfg)).toBe('tool_failure');
    expect(classifyTrigger(signals({ recovered: true, taskClosed: true }), cfg)).toBe('recovery');
    expect(classifyTrigger(signals({ gapMs: 500_000 }), cfg)).toBe('long_gap');
    expect(classifyTrigger(signals(), cfg)).toBe('neutral');
  });

  it('信号包带自由文本 ⇒ 整包拒绝（外部内容不得操纵情绪）', () => {
    const tainted = { ...signals(), assistantText: '我很生气', toolOutput: 'boom', userText: '快点' };
    expect(isStructuredOnly(tainted)).toBe(false);
    expect(isStructuredOnly(signals())).toBe(true);
    expect(isStructuredOnly(null)).toBe(false);
    expect(isStructuredOnly({ turnSeq: 1 })).toBe(false);
  });
});

describe('cues 提取', () => {
  it('只从结构化事实取 token，归一化小写并去重限量', () => {
    const cues = extractCues({ tool: 'Edit', pathBases: ['e:/a/b/Spirit.ts', 'e:/c/Spirit.ts'], exitCode: 1 });
    expect(cues).toContain('edit');
    expect(cues.filter((c) => c === 'spirit.ts')).toHaveLength(1);
    expect(cues.length).toBeLessThanOrEqual(CUE_LIMITS.maxPerEntry);
  });

  it('默认不抽用户原文；显式传入时只取前 4 个词', () => {
    const without = extractCues({ tool: 'bash' });
    expect(without.some((cue) => cue.includes('投递'))).toBe(false);
    const withSnippet = extractCues({ tool: 'bash' }, '帮我把 这个 投递 脚本 再 跑 一次');
    expect(withSnippet.filter((cue) => cue.includes('一次')).length).toBe(0);
    expect(withSnippet.length).toBeLessThanOrEqual(CUE_LIMITS.maxPerEntry);
  });

  it('路径只留 basename，不带目录（防工作区结构外泄）', () => {
    const cues = extractCues({ pathBases: ['e:/secret/workspace/dir/notes.md'] });
    expect(cues).toContain('notes.md');
    expect(cues.some((cue) => cue.includes('secret'))).toBe(false);
    expect(cues.some((cue) => cue.includes('/'))).toBe(false);
  });

  it('查询串与 cues 同一归一口径', () => {
    expect(queryTokens('Edit 那个 Spirit.ts')).toEqual(expect.arrayContaining(['edit', 'spirit.ts']));
    expect(queryTokens('  ')).toEqual([]);
    expect(queryTokens('a')).toEqual([]); // 单字符噪音不参与
  });
});

describe('文案表', () => {
  it('每个事件族的 mild 与 strong 都有句子（缺格 = 那一类永远记不出话）', () => {
    for (const trigger of TRIGGER_KINDS) {
      for (const reaction of REQUIRED_REACTIONS) {
        const cell = BODY_TABLE[trigger];
        expect(typeof cell[reaction], `${trigger}/${reaction}`).toBe('string');
      }
    }
  });

  it('同一输入两次渲染字节全等（同态）', () => {
    const input = {
      trigger: TRIGGER_TOOL_FAILURE,
      notice: 'environment' as const,
      reaction: 'mild' as const,
      fact: { tool: 'bash', exitCode: 1, gapMs: 400_000 },
      detail: true,
      voice: 'plain' as const,
    };
    expect(renderExperienceText(input)).toBe(renderExperienceText(input));
  });

  it('不含伪造的具体性：没有次数、没有分钟数、没有编出来的文件名', () => {
    const text = renderExperienceText({
      trigger: TRIGGER_TOOL_FAILURE,
      notice: 'environment',
      reaction: 'strong',
      fact: { gapMs: 1_200_000 }, // 20 分钟 ⇒ 「隔了一阵」档（<10 分钟是「隔了一会儿」）
      detail: true,
      voice: 'warm',
    });
    expect(text).not.toMatch(/第[一二三四五六七八九十\d]+次/u);
    expect(text).not.toMatch(/\d+\s*(分钟|秒|小时)/u);
    expect(text).toContain('隔了一阵');
  });

  it('detail 只在真有结构事实时追加；无事实就不加括号', () => {
    const bare = renderExperienceText({
      trigger: TRIGGER_TOOL_FAILURE,
      notice: 'environment',
      reaction: 'mild',
      fact: {},
      detail: true,
      voice: 'plain',
    });
    expect(bare).not.toContain('（');
    expect(factBits({})).toEqual([]);
    expect(factBits({ tool: 'bash', pathBases: ['a.ts', 'b.ts', 'c.ts'] }).join('|')).toContain('3 个文件');
  });

  it('正文以关注面词开头，与词表单源一致', () => {
    const text = renderExperienceText({
      trigger: TRIGGER_KINDS[0],
      notice: 'self_mistake',
      reaction: 'mild',
      fact: {},
      detail: false,
      voice: 'plain',
    });
    expect(text.startsWith(`${NOTICE_WORDS.self_mistake}：`)).toBe(true);
  });

  it('reaction none ⇒ 空句（不留空条目）', () => {
    expect(
      renderExperienceText({ trigger: TRIGGER_TOOL_FAILURE, notice: 'environment', reaction: 'none', fact: {}, detail: false, voice: 'plain' }),
    ).toBe('');
  });
});

describe('每轮编译的三种出口', () => {
  it('人格不在意 ⇒ 不记（ok:true, draft:undefined）', () => {
    const persona: PersonaCard = { ...DEFAULT_PERSONA, salience: { ...DEFAULT_PERSONA.salience, tool_failure: 0 } };
    const result = compileTurn(signals({ toolFailures: 1 }), persona, cfg);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.draft).toBeUndefined();
  });

  it('信号越界 ⇒ ok:false 并给出原因', () => {
    const result = compileTurn({ ...signals(), toolOutput: 'x' } as TurnSignals, DEFAULT_PERSONA, cfg);
    expect(result.ok).toBe(false);
  });

  it('中性轮默认不记（缺省 salience.neutral=0，避免退化成逐轮流水账）', () => {
    const result = compileTurn(signals(), DEFAULT_PERSONA, cfg);
    expect(result.ok && result.draft).toBeUndefined();
  });

  it('在意的事 ⇒ 出草稿，带 lane=live 与结构化事实', () => {
    const result = compileTurn(signals({ toolFailures: 1, facts: { tool: 'bash', exitCode: 2 } }), DEFAULT_PERSONA, cfg);
    expect(result.ok).toBe(true);
    if (!result.ok || result.draft === undefined) throw new Error('应有草稿');
    expect(result.draft.lane).toBe('live');
    expect(result.draft.fact.tool).toBe('bash');
    expect(result.draft.text.length).toBeGreaterThan(0);
  });
});

describe('ExperienceStore', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spirit-exp-'));
  });
  afterEach(() => {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  function opened() {
    const result = openSpiritDb(dir);
    if (!result.ok) throw new Error('库应可打开');
    return track(result.db);
  }

  it('写入后可读回，fact 分列保存', () => {
    const store = new ExperienceStore({ db: opened(), logger });
    store.append(ctxA, draft);
    const rows = store.recent('s1', 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('e1');
    expect(rows[0]?.fact.tool).toBe('bash');
    expect(rows[0]?.supersededBy).toBeUndefined();
    expect(store.count('s1')).toBe(1);
  });

  it('取代是软标记：旧行仍在（可回滚），但默认读不到', () => {
    const db = opened();
    const store = new ExperienceStore({ db, logger });
    store.append(ctxA, draft);
    store.append({ ...ctxA, id: 'e2', turnSeq: 2, tsMs: 2_000 }, { ...draft, text: '第二次记的' });
    expect(store.supersede('e1', 'e2')).toBe(true);
    expect(store.recent('s1', 5).map((e) => e.id)).toEqual(['e2']);
    // 反查：被取代的行还在，且知道被谁取代
    const page = store.page('s1', 0, 10, true);
    const old = page.rows.find((e) => e.id === 'e1');
    expect(old?.supersededBy).toBe('e2');
    // 重复取代不生效（一次取代只能有一个指向）
    expect(store.supersede('e1', 'e3')).toBe(false);
  });

  it('cues 进索引，检索能命中工具名', () => {
    const store = new ExperienceStore({ db: opened(), logger });
    store.append(ctxA, { ...draft, fact: { tool: 'pnpm-build', pathBases: ['deliver.ts'] } });
    expect(store.searchLocal('pnpm-build', { limit: 5 }).length).toBe(1);
    expect(store.searchLocal('deliver.ts', { limit: 5 }).length).toBe(1);
    expect(store.searchLocal('nothing-here', { limit: 5 })).toEqual([]);
    expect(store.searchLocal('  ', { limit: 5 })).toEqual([]);
  });

  it('跨会话：只取上一个会话的末尾几条，不含本会话', () => {
    const store = new ExperienceStore({ db: opened(), logger });
    store.append({ ...ctxA, id: 'o1', sessionId: 's0', tsMs: 500 }, draft);
    store.append({ ...ctxA, id: 'o2', sessionId: 's0', tsMs: 600 }, { ...draft, text: '上一会话第二条' });
    store.append({ ...ctxA, id: 'n1', sessionId: 's1', tsMs: 900 }, draft);
    const prev = store.previousSessionEntries('w1', 's1', 1);
    expect(prev.map((e) => e.id)).toEqual(['o2']);
    // 排除 s0 时，剩下的那个会话就是本工作区唯一的来处 ⇒ 应该拿到它的条目（不是空）
    expect(store.previousSessionEntries('w1', 's0', 5).map((e) => e.id)).toEqual(['n1']);
    expect(store.previousSessionEntries('w1', 's1', 0)).toEqual([]);
    // 完全陌生的工作区 ⇒ 空（不拿旧工作区的条目垫场）
    expect(store.previousSessionEntries('w-else', 's1', 5)).toEqual([]);
  });

  it('分页不越界、含被取代项，且 total 与实读一致', () => {
    const store = new ExperienceStore({ db: opened(), logger });
    for (let i = 0; i < 12; i += 1) {
      store.append({ ...ctxA, id: `x${i}`, tsMs: 1_000 + i }, { ...draft, text: `第 ${i} 条` });
    }
    const first = store.page('s1', 0, 5);
    expect(first.total).toBe(12);
    expect(first.rows).toHaveLength(5);
    expect(first.rows[0]?.id).toBe('x11'); // 倒序
    expect(store.page('s1', 0, 9_999).rows).toHaveLength(12);
  });

  it('库不可用 ⇒ 退内存镜像，读写照常且不抛（角色当下不该取决于 SQLite）', () => {
    const store = new ExperienceStore({ db: null, logger });
    expect(store.persistent).toBe(false);
    store.append(ctxA, draft);
    expect(store.recent('s1', 3).map((e) => e.id)).toEqual(['e1']);
    expect(store.count('s1')).toBe(1);
    expect(store.searchLocal('bash', { limit: 3 })).toEqual([]);
    expect(store.supersede('e1', 'e9')).toBe(true);
    expect(store.recent('s1', 3)).toEqual([]);
  });

  it('内存镜像有顶（无顶就是无界增长）', () => {
    const store = new ExperienceStore({ db: null, logger });
    for (let i = 0; i < 260; i += 1) store.append({ ...ctxA, id: `m${i}`, tsMs: i }, draft);
    expect(store.count('s1')).toBeLessThanOrEqual(200);
  });

  it('fact_json 坏了只丢细节，不丢这条经历', () => {
    const db = opened();
    const store = new ExperienceStore({ db, logger });
    store.append(ctxA, draft);
    db.prepare(`UPDATE experience SET fact_json = '{' WHERE id = 'e1'`).run();
    const rows = store.recent('s1', 3);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fact).toEqual({});
    expect(rows[0]?.text.length).toBeGreaterThan(0);
  });
});

describe('保留与归档：一行都不删', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spirit-ret-'));
  });
  afterEach(() => {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retentionDays<=0 ⇒ 空计划；过期判定按会话末条时间', () => {
    const db = openSpiritDb(dir);
    if (!db.ok) throw new Error('库应可打开');
    const handle = track(db.db);
    const store = new ExperienceStore({ db: handle, logger });
    store.append({ ...ctxA, id: 'old1', sessionId: 'so', tsMs: 10 }, draft);
    store.append({ ...ctxA, id: 'new1', sessionId: 'sn', tsMs: 9 * 86_400_000 }, draft);
    expect(planRetention({ db: handle, retentionDays: 0, now: 10 * 86_400_000, dryRun: true }).staleSessions).toBe(0);
    const plan = planRetention({ db: handle, retentionDays: 7, now: 10 * 86_400_000, dryRun: true });
    expect(plan.staleSessions).toBe(1);
    expect(plan.buckets[0]?.sessionId).toBe('so');
    expect(plan.deletedRows).toBe(0);
  });

  it('干跑不写文件；实跑只新增归档文件，库里的行一条不少', () => {
    const openedDb = openSpiritDb(dir);
    if (!openedDb.ok) throw new Error('库应可打开');
    const db = track(openedDb.db);
    const store = new ExperienceStore({ db, logger });
    store.append({ ...ctxA, id: 'old1', sessionId: 'so', tsMs: 10 }, draft);
    const plan = planRetention({ db, retentionDays: 7, now: 10 * 86_400_000, dryRun: true });
    const dry = archiveSessions({ db, logger, dataDir: dir, plan, loadSession: (s) => store.page(s, 0, 50, true).rows });
    expect(dry.written).toBe(0);
    expect(readdirSync(dir).some((name) => name === 'archive')).toBe(false);

    const wet = archiveSessions({
      db,
      logger,
      dataDir: dir,
      plan: { ...plan, dryRun: false },
      loadSession: (s) => store.page(s, 0, 50, true).rows,
    });
    expect(wet.written).toBe(1);
    expect(wet.deletedRows).toBe(0);
    expect(store.count('so')).toBe(1); // 一行没少
    const archived = readFileSync(wet.files[0] as string, 'utf8');
    expect(archived).toContain(draft.text);
    expect(readdirSync(join(dir, 'archive')).length).toBe(1);
  });

  it('全仓不存在删除体验行的 SQL（红线机械核对）', () => {
    const files = readdirSync(join(process.cwd(), 'src'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    const offenders: string[] = [];
    for (const file of files) {
      const body = readFileSync(join(process.cwd(), 'src', file), 'utf8');
      if (/DELETE\s+FROM\s+experience/iu.test(body)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
