/**
 * A/B 归因报告（`scripts/ab-report.mjs`）的用例。
 *
 * 关心三件事：
 * 1. **读的是真形状**：durable 日志是多帧 zstd（每事件一帧），且署名在
 *    `data.source`（user 族）与 `data.message.source`（assistant 族）两处——fixture 必须照这个写，
 *    拿自造形状测等于没测（这条形状是真机解出来的）。
 * 2. **分组靠证据**：有卡行=注入组；无卡行但库里有该会话条目=旁路组；都没有=untouched。
 * 3. **本地副本不漂**：脚本是 .mjs 不能 import TS，六个字面量是抄的 ⇒ 必须有闸把它和 src 定义对敲。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { analyzeHome, measureJournal, measureRows } from '../scripts/ab-report.mjs';
import { openSpiritDb } from '../src/db/open.js';
import { ExperienceStore } from '../src/store/experience.js';
import { LANE_LIVE, TRIGGER_TOOL_FAILURE } from '../src/types.js';

const logger = { info: () => undefined, warn: () => undefined };
const CARD_TEXT = '<system-reminder>\n（角色体验快照 · 取代先前快照）\n以下是角色自己的体验记录。\n状态：平常·按平时那样说\n想起：上次那个动作没成\n</system-reminder>';

/** durable 行：user 族把 source 放 data.source。 */
const userRow = (seq: number, turn: number, text: string, kind = 'user') => ({
  type: 'user/message', seq, data: { turn, source: { kind }, content: [{ type: 'text', text }] },
});
/** durable 行：assistant 族把 source 放 data.message.source，usage 也在 data 上。 */
const assistantRow = (seq: number, turn: number, text: string, usage: Record<string, number>) => ({
  type: 'assistant/message', seq, data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } }, usage },
});

function homeFixture(): string {
  const home = mkdtempSync(join(tmpdir(), 'spirit-ab-'));
  const sessionDir = join(home, 'sessions', 'ws1', 'session-inject');
  mkdirSync(sessionDir, { recursive: true });
  const rows = [
    userRow(5, 1, '先读那个不存在的文件'),
    userRow(6, 1, CARD_TEXT, 'plugin:spirit'),
    assistantRow(7, 1, '收到。', { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 800, totalTokens: 1810 }),
    { type: 'turn/end', seq: 8, data: { turn: 1 } },
    // 第二轮开头就带纠正措辞：只应进"纠正候选"，不参与任何判定
    userRow(9, 2, '不对，我说的是先放一放'),
    assistantRow(10, 2, '明白。', { inputTokens: 2000, outputTokens: 5, cacheReadTokens: 1500, totalTokens: 3505 }),
    // 压缩自身的 usage 是一次性开销，混进每轮均值会压低注入组的表观成本
    { type: 'compaction/summary', seq: 11, data: { usage: { inputTokens: 9000, outputTokens: 9, cacheReadTokens: 9000, totalTokens: 18009 } } },
  ];
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), frames(rows));

  const bypassDir = join(home, 'sessions', 'ws1', 'session-bypass');
  mkdirSync(bypassDir, { recursive: true });
  writeFileSync(join(bypassDir, 'session.v4.jsonl.zstd'), frames([
    userRow(1, 1, '只记录，别注入'),
    assistantRow(2, 1, '好。', { inputTokens: 500, outputTokens: 2, cacheReadTokens: 400, totalTokens: 902 }),
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
  ]));

  const idleDir = join(home, 'sessions', 'ws1', 'session-idle');
  mkdirSync(idleDir, { recursive: true });
  writeFileSync(join(idleDir, 'session.v4.jsonl.zstd'), frames([assistantRow(1, 1, '无事。', { inputTokens: 10, outputTokens: 1, totalTokens: 11 })]));

  const dbPath = join(home, 'spirit', 'spirit.db');
  const opened = openSpiritDb(join(home, 'spirit'));
  if (!opened.ok) throw new Error('库应可打开');
  const store = new ExperienceStore({ db: opened.db, logger });
  store.append(
    { id: 'x-1', sessionId: 'session-inject', workspaceId: 'ws1', turnSeq: 1, tsMs: 1_000, personaRevision: 1 },
    { trigger: TRIGGER_TOOL_FAILURE, notice: 'environment', reaction: 'mild', text: '手边的动作没成。', fact: {}, lane: LANE_LIVE },
  );
  store.append(
    { id: 'x-2', sessionId: 'session-bypass', workspaceId: 'ws1', turnSeq: 1, tsMs: 2_000, personaRevision: 1 },
    { trigger: TRIGGER_TOOL_FAILURE, notice: 'environment', reaction: 'mild', text: '又一次没成。', fact: {}, lane: LANE_LIVE },
  );
  // 必须关：WAL 下的只读打开要求写端已关（真机跑报告时宿主不在写事务里）
  opened.db.close();
  expect(dbPath).toBeTruthy();
  return home;
}

/** 每行一帧（真 durable 日志就是追加型多帧，整包一次解只拿得到首帧）。 */
function frames(rows: readonly unknown[]): Buffer {
  return Buffer.concat(rows.map((row) => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`, 'utf8'))));
}

let home = '';
afterEach(() => {
  if (home !== '') rmSync(home, { recursive: true, force: true });
  home = '';
});

describe('measureRows：durable 形状与度量口径', () => {
  it('按真形状读两族署名，usage 只算每轮消息', () => {
    home = '';
    const rows = [
      userRow(5, 1, '先读那个不存在的文件'),
      userRow(6, 1, CARD_TEXT, 'plugin:spirit'),
      assistantRow(7, 1, '收到。', { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 800, totalTokens: 1810 }),
      { type: 'compaction/summary', seq: 11, data: { usage: { inputTokens: 9000, outputTokens: 9, cacheReadTokens: 9000, totalTokens: 18009 } } },
    ];
    const m = measureRows('s1', rows);
    expect(m.usage).toEqual({ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 800, totalTokens: 1810 });
    expect(m.compactionUsages).toBe(1);
    expect(m.cacheHitRatio).toBe(0.8);
    expect(m.spirit.cardRows).toBe(1);
    expect(m.spirit.cardRecallHits).toBe(1);
    expect(m.spirit.cardWithoutState).toBe(0);
    expect(m.spirit.cardWithoutSignature).toBe(0);
    expect(m.spirit.avgCardBytes).toBe(Buffer.byteLength(CARD_TEXT, 'utf8'));
  });

  it('署名与状态段缺一 ⇒ 漂移动作数报出来（报告数字的可信度开关）', () => {
    const m = measureRows('s1', [userRow(1, 1, '（角色体验快照）没有状态段', 'plugin:spirit')]);
    expect(m.spirit.cardRows).toBe(1);
    expect(m.spirit.cardWithoutState).toBe(1);
    expect(m.spirit.cardWithoutSignature).toBe(1);
  });

  it('纠正候选只统计"助手回复之后的新用户轮"，首轮不算', () => {
    const m = measureRows('s1', [
      userRow(1, 1, '不对，先放一放'),
      assistantRow(2, 1, '好。', { inputTokens: 1 }),
      userRow(3, 2, '还是别动它'),
      assistantRow(4, 2, '嗯。', { inputTokens: 1 }),
    ]);
    expect(m.correctionCandidates).toBe(1);
    expect(m.turns).toBe(2);
  });

  it('无 usage 或全零 usage ⇒ 命中率是 null 而不是 0（0 会被读成"缓存全miss"）', () => {
    expect(measureRows('s1', [assistantRow(1, 1, 'x', {})]).cacheHitRatio).toBeNull();
  });
});

describe('measureJournal：读不到就说读不到', () => {
  it('有库有条目 ⇒ 条数；库缺席 ⇒ entries=null + 原因（不是 0）', () => {
    home = mkdtempSync(join(tmpdir(), 'spirit-ab-miss-'));
    const missing = measureJournal(join(home, 'spirit', 'spirit.db'), 'session-inject');
    expect(missing.entries).toBeNull();
    expect(missing.reason).toBeTruthy();
  });

  it('真库（写端已关）只读打开能拿到条数与 lane 分布', () => {
    home = homeFixture();
    const j = measureJournal(join(home, 'spirit', 'spirit.db'), 'session-inject');
    expect(j.entries).toBe(1);
    expect(j.byLane?.[LANE_LIVE]).toBe(1);
    expect(measureJournal(join(home, 'spirit', 'spirit.db'), 'session-nope').entries).toBe(0);
  });
});

describe('analyzeHome：分组靠证据', () => {
  it('注入/旁路/未参与三组按"有没有卡行 + 库里有没有条目"分', () => {
    home = homeFixture();
    const report = analyzeHome(home);
    const byId = new Map(report.sessions.map((s) => [s.sessionId, s]));
    expect(byId.get('session-inject')?.group).toBe('injected');
    expect(byId.get('session-bypass')?.group).toBe('bypassed');
    expect(byId.get('session-idle')?.group).toBe('untouched');
    expect(report.groups.injected?.cardRows).toBe(1);
    expect(report.groups.injected?.journalEntries).toBe(1);
    // 旁路组：条目照常、注入字节为 0 —— 这正是对照组要的形状
    expect(report.groups.bypassed?.cardBytes).toBe(0);
    expect(report.groups.bypassed?.journalEntries).toBe(1);
    expect(report.groups.unknown).toEqual([]);
  });

  it('报告自带的三条诚实约束写在 notes 里（不靠口头纪律）', () => {
    home = homeFixture();
    const notes = analyzeHome(home).notes.join('\n');
    expect(notes).toContain('mock provider');
    expect(notes).toContain('人工判读');
    expect(notes).toContain('不是 0 条');
  });
});

describe('本地副本不漂（.mjs 不能 import TS，所以必须对敲）', () => {
  const script = readFileSync(new URL('../scripts/ab-report.mjs', import.meta.url), 'utf8');
  const contract = readFileSync(new URL('../src/contract.ts', import.meta.url), 'utf8');
  const render = readFileSync(new URL('../src/slot/render.ts', import.meta.url), 'utf8');

  /** 从两边源码里抠出 `NAME = '值'` 的值。 */
  const literalOf = (source: string, name: string): string => {
    const hit = new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(source);
    const value = hit?.[1];
    if (value === undefined) throw new Error(`找不到 ${name} 的字面量`);
    return value;
  };

  it('署名与卡签名与 src 定义逐字相等', () => {
    expect(literalOf(script, 'SPIRIT_CARD_SOURCE_KIND')).toBe(literalOf(contract, 'SPIRIT_SOURCE_KIND'));
    expect(literalOf(script, 'SPIRIT_CARD_SIGNATURE')).toBe(literalOf(render, 'SPIRIT_CARD_SIGNATURE'));
  });

  it('四个分段前缀在渲染器里仍是模板字面量的开头（改文案会撞红这条）', () => {
    for (const prefix of ['状态：', '刚刚：', '想起：', '开场：']) {
      expect(render).toContain('`' + prefix);
      expect(script).toContain(`'${prefix}'`);
    }
  });

  it('--json 开关必须带前缀判断（漏了 `--` 就永远不生效，真踩过）', () => {
    expect(script).toContain("argv.includes('--json')");
  });
});
