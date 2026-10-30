#!/usr/bin/env node
/**
 * 旁路开关 A/B 归因报告（**离线**读 durable 会话日志 + spirit 自库）。
 *
 * 为什么存在：计划把「归因实验可跑」列为交付项，而运行时统计（`session-stats`）是
 * **内存态**，宿主一重启就空——实验通常在跑完若干会话后才复盘，那时内存态已经没了。
 * 所以这条报告只读两份**持久**证据：
 *
 * 1. `$DSH_HOME/sessions/<工区目录>/session-<id>/session.v4.jsonl.zstd`（宿主 durable 日志）
 *    —— 轮次、回复长度、`usage.cacheReadTokens`、自家卡行数与字节、以及卡里有没有「想起：」段
 * 2. `$DSH_HOME/spirit/spirit.db`（自库，只读）—— 该会话的手记条数
 *
 * 分组靠证据，不靠实验者自述：**有卡行 = 注入组**；**无卡行但库里有条目 = 旁路组**
 * （旁路的语义就是"照常入库、只是不出卡"，所以它天然长成这个样子）。
 *
 * 三条诚实约束（不守就等于在编数据）：
 * - `cacheReadTokens` 是**宿主记的数**，provider 是谁就反映谁。用本地 mock provider 跑出来的
 *   数字只能证明**链路可跑**，绝不能当成本机真实缓存成本汇报。
 * - **纠正率不给自动结论**：只报"纠正候选"计数（代理指标，词表命中），最终判读必须人工做。
 *   运行时判定绝不读自由文本，这条纪律不因离线分析而豁免。
 * - 库读不到 ⇒ 该列报 `null` 并写明原因，不填 0（0 会被读成"这组真的没记东西"）。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';

/**
 * 下面六个字面量是 `src/contract.ts` 与 `src/slot/render.ts` 里那些常量的**本地副本**：
 * 本脚本是离线 CLI（`.mjs`），不能 import TS，也不能依赖 `dist/`（`npm run test` 在 build 前跑）。
 * 副本会漂，所以 `tests/ab-report.test.ts` 里有一道闸把这几个串与 src 里的定义逐个核对。
 */
const SPIRIT_CARD_SOURCE_KIND = 'plugin:spirit';
const SPIRIT_CARD_SIGNATURE = '（角色体验快照 · 取代先前快照）';

/** durable 日志每事件一个 zstd 帧（真机实测：整包 sync 解只拿得到首帧）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const LOG_FILE_NAME = 'session.v4.jsonl.zstd';
const CARD_STATE = '状态：';
const CARD_RECENT = '刚刚：';
const CARD_RECALLED = '想起：';
const CARD_TONE = '开场：';

/**
 * 纠正候选的**代理**词表：只用来缩小人工复核范围。
 * 命中不等于"用户在纠正"，更不等于档位该变——那是运行时永不读文本的原因。
 */
const CORRECTION_CUES = ['不是', '不对', '别', '不要', '又', '还是', '我说过', '之前说', '错了', '重来'];

/** durable 行的署名形状有两种：`data.source`（user/system/message 族）与 `data.message.source`（assistant 族）。 */
function kindOf(row) {
  const data = row['data'];
  if (data === null || typeof data !== 'object') return undefined;
  const direct = data['source'];
  if (direct !== null && typeof direct === 'object' && typeof direct['kind'] === 'string') return direct['kind'];
  const nested = data['message'];
  if (nested !== null && typeof nested === 'object') {
    const src = nested['source'];
    if (src !== null && typeof src === 'object' && typeof src['kind'] === 'string') return src['kind'];
  }
  return undefined;
}

function textOf(row) {
  const data = row['data'];
  if (data === null || typeof data !== 'object') return '';
  const holder = typeof data['message'] === 'object' && data['message'] !== null ? data['message'] : data;
  const content = holder['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b !== null && typeof b === 'object' && typeof b['text'] === 'string' ? b['text'] : '')).join('');
  }
  return '';
}

function readFrames(file) {
  const buf = readFileSync(file);
  const starts = [];
  for (let at = buf.indexOf(ZSTD_MAGIC); at !== -1; at = buf.indexOf(ZSTD_MAGIC, at + 1)) starts.push(at);
  if (starts.length === 0) return '';
  return starts.map((at, n) => zstdDecompressSync(buf.subarray(at, starts[n + 1] ?? buf.length)).toString('utf8')).join('\n');
}

function decodeRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') rows.push(parsed);
    } catch { /* 非 JSON 行忽略：日志由宿主写，形状不由我们定 */ }
  }
  return rows;
}

/** 会话目录在工区目录下再一层；整树找，别假设只有一个工区。 */
function findSessionLogs(sessionsRoot) {
  /** @type {Array<{sessionId: string, file: string}>} */
  const out = [];
  if (!existsSync(sessionsRoot)) return out;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === LOG_FILE_NAME) {
        out.push({ sessionId: dir.split(/[\\/]/u).pop() ?? dir, file: full });
      }
    }
  };
  walk(sessionsRoot, 0);
  return out.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 单个会话的 durable 侧度量。纯函数，便于用例直喂 rows。 */
export function measureRows(sessionId, rows) {
  let turns = 0;
  let assistantChars = 0;
  let assistantMessages = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let totalTokens = 0;
  let cardRows = 0;
  let cardBytes = 0;
  let cardRecallHits = 0;
  let cardRecentLines = 0;
  let cardToneRows = 0;
  let cardWithoutState = 0;
  let cardWithoutSignature = 0;
  let correctionCandidates = 0;
  let compactionUsages = 0;

  // 纠正候选：某轮的首条用户消息，且此前已有助手回复
  const firstUserSeqByTurn = new Map();
  let lastAssistantTurn = -1;

  for (const row of rows) {
    const data = row['data'];
    const turn = data !== null && typeof data === 'object' ? num(data['turn']) : 0;
    if (turn > turns) turns = turn;
    const kind = kindOf(row);
    const text = textOf(row);

    if (row['type'] === 'assistant/message') {
      assistantMessages += 1;
      assistantChars += text.length;
      const usage = data !== null && typeof data === 'object' ? data['usage'] : undefined;
      if (usage !== null && typeof usage === 'object') {
        inputTokens += num(usage['inputTokens']);
        outputTokens += num(usage['outputTokens']);
        cacheReadTokens += num(usage['cacheReadTokens']);
        totalTokens += num(usage['totalTokens']);
      }
      if (turn > lastAssistantTurn) lastAssistantTurn = turn;
      continue;
    }

    // 压缩自身也花 token，但它是**一次性**开销，混进每轮均值会压低注入组的表观成本
    if (row['type'] === 'compaction/summary') {
      const usage = data !== null && typeof data === 'object' ? data['usage'] : undefined;
      if (usage !== null && typeof usage === 'object') compactionUsages += 1;
      continue;
    }

    if (kind === SPIRIT_CARD_SOURCE_KIND) {
      cardRows += 1;
      cardBytes += Buffer.byteLength(text, 'utf8');
      if (text.includes(CARD_RECALLED)) cardRecallHits += 1;
      if (text.includes(CARD_TONE)) cardToneRows += 1;
      cardRecentLines += text.split('\n').filter((l) => l.startsWith(CARD_RECENT)).length;
      // 有署名却没有状态段 ⇒ 卡形状漂了（状态段是第一个装的，理论上必在）；如实报数，不静默
      if (!text.includes(CARD_STATE)) cardWithoutState += 1;
      if (!text.includes(SPIRIT_CARD_SIGNATURE)) cardWithoutSignature += 1;
      continue;
    }

    if (kind === 'user') {
      const seen = firstUserSeqByTurn.get(turn);
      if (seen === undefined) {
        firstUserSeqByTurn.set(turn, num(row['seq']));
        if (lastAssistantTurn >= 0 && turn > lastAssistantTurn) {
          if (CORRECTION_CUES.some((cue) => text.includes(cue))) correctionCandidates += 1;
        }
      }
    }
  }

  return {
    sessionId,
    turns,
    assistantMessages,
    assistantChars,
    usage: { inputTokens, outputTokens, cacheReadTokens, totalTokens },
    /** 命中缓存占输入的比例；provider 是谁就反映谁，mock 的数字不是成本结论。 */
    cacheHitRatio: inputTokens > 0 ? Number((cacheReadTokens / inputTokens).toFixed(4)) : null,
    spirit: {
      cardRows,
      cardBytes,
      cardRecallHits,
      cardRecentLines,
      cardToneRows,
      /** 每卡平均字节（注入体积的直接度量；无卡 ⇒ null，不是 0）。 */
      avgCardBytes: cardRows > 0 ? Math.round(cardBytes / cardRows) : null,
      /** 带署名却缺状态段的行数；> 0 说明卡形状与渲染器已不一致，报告数字不可信。 */
      cardWithoutState,
      /** 带署名却缺签名行的行数；同上，它是回声过滤的判据，缺了就代表注入链或读取面错位。 */
      cardWithoutSignature,
    },
    correctionCandidates,
    compactionUsages,
  };
}

/** 自库侧度量：只读，读不到就 null + 原因（0 会被当成"这组真没记"）。 */
export function measureJournal(dbFile, sessionId) {
  if (!existsSync(dbFile)) return { entries: null, reason: '库里没有这个会话的表文件（spirit.db 缺席）' };
  let db = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM experience WHERE session_id = ? AND superseded_by IS NULL')
      .get(sessionId);
    const lanes = db
      .prepare('SELECT lane, COUNT(*) AS n FROM experience WHERE session_id = ? AND superseded_by IS NULL GROUP BY lane')
      // 必须绑参：未绑定的 `?` 在 node:sqlite 里当 NULL，不报错也不匹任何东西，
      // 于是 lane 分布永远为空（上一版就在这里静默拿到了空表）。
      .all(sessionId);
    const entries = row !== null && typeof row === 'object' ? num(row['n']) : 0;
    const byLane = {};
    for (const l of lanes) {
      if (l !== null && typeof l === 'object' && typeof l['lane'] === 'string') byLane[l['lane']] = num(l['n']);
    }
    return { entries, byLane };
  } catch (error) {
    return { entries: null, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      db?.close();
    } catch { /* 已关 */ }
  }
}

function groupOf(session) {
  if (session.spirit.cardRows > 0) return 'injected';
  if (session.journal.entries !== null && session.journal.entries > 0) return 'bypassed';
  if (session.journal.entries === null) return 'unknown';
  return 'untouched';
}

function aggregate(list) {
  const n = list.length;
  if (n === 0) return null;
  const sum = (pick) => list.reduce((acc, s) => acc + pick(s), 0);
  const ratios = list.map((s) => s.cacheHitRatio).filter((r) => typeof r === 'number');
  return {
    sessions: n,
    turns: sum((s) => s.turns),
    assistantChars: sum((s) => s.assistantChars),
    inputTokens: sum((s) => s.usage.inputTokens),
    cacheReadTokens: sum((s) => s.usage.cacheReadTokens),
    cardRows: sum((s) => s.spirit.cardRows),
    cardBytes: sum((s) => s.spirit.cardBytes),
    cardRecallHits: sum((s) => s.spirit.cardRecallHits),
    /** 形状漂掉的行数（缺状态段或缺签名行）；不为 0 时本组数字不可信。 */
    shapeDriftRows: sum((s) => s.spirit.cardWithoutState + s.spirit.cardWithoutSignature),
    journalEntries: sum((s) => s.journal.entries ?? 0),
    correctionCandidates: sum((s) => s.correctionCandidates),
    /** 组内均值：每轮输入 token 与缓存命中率。样本量写在旁边，别让它被当显著结论。 */
    meanInputTokensPerTurn: Math.round(sum((s) => s.usage.inputTokens) / Math.max(1, sum((s) => s.turns))),
    meanCacheHitRatio: ratios.length > 0 ? Number((ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(4)) : null,
  };
}

/** 主入口：给定 DSH_HOME，出双会话对照报告。 */
export function analyzeHome(homeDir) {
  const sessionsRoot = join(homeDir, 'sessions');
  const dbFile = join(homeDir, 'spirit', 'spirit.db');
  const sessions = findSessionLogs(sessionsRoot).map(({ sessionId, file }) => {
    let rows = [];
    let readError = null;
    try {
      rows = decodeRows(readFrames(file));
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
    const base = measureRows(sessionId, rows);
    const journal = readError === null ? measureJournal(dbFile, sessionId) : { entries: null, reason: readError };
    const session = { ...base, journal };
    // 分组要同时看两张证据（卡行 + 库条目），所以先装配完再判：
    // 上一版把 group 写在同一个对象字面量里自引用，直接 TDZ 报错。
    return { ...session, group: groupOf(session) };
  });

  const pick = (name) => sessions.filter((s) => s.group === name);
  const injected = pick('injected');
  const bypassed = pick('bypassed');
  return {
    home: homeDir,
    spiritDbPresent: existsSync(dbFile),
    sessions,
    groups: {
      injected: aggregate(injected),
      bypassed: aggregate(bypassed),
      untouched: pick('untouched').map((s) => s.sessionId),
      unknown: pick('unknown').map((s) => s.sessionId),
    },
    notes: [
      '分组靠证据：有 plugin:spirit 卡行 = 注入组；无卡行但自库有该会话条目 = 旁路组。',
      'cacheReadTokens 由宿主按 provider 记录；用 mock provider 跑出的数字只能证明链路可跑，不是本机真实缓存成本。',
      'correctionCandidates 是词表代理（命中≠用户在纠正），最终纠正率必须人工判读；运行时判定绝不读自由文本。',
      'journal.entries 为 null 表示读不到库（缺席/被锁），不是 0 条。',
    ],
  };
}

function renderText(report) {
  const lines = [];
  lines.push(`DSH_HOME=${report.home}`);
  lines.push(`spirit.db=${report.spiritDbPresent ? '在场' : '缺席'} 会话数=${report.sessions.length}`);
  lines.push('');
  lines.push('会话                                        组别      轮次  回复字符  输入tok  缓存读tok  命中率   卡行 卡字节 想起 手记');
  for (const s of report.sessions) {
    lines.push(
      `${s.sessionId.padEnd(42)} ${s.group.padEnd(9)} ${String(s.turns).padStart(4)} ${String(s.assistantChars).padStart(9)} `
      + `${String(s.usage.inputTokens).padStart(8)} ${String(s.usage.cacheReadTokens).padStart(9)} `
      + `${(s.cacheHitRatio ?? Number.NaN).toString().padStart(8)} ${String(s.spirit.cardRows).padStart(4)} `
      + `${String(s.spirit.cardBytes).padStart(6)} ${String(s.spirit.cardRecallHits).padStart(4)} `
      + `${(s.journal.entries ?? '—').toString().padStart(5)}`,
    );
  }
  for (const [name, agg] of [['注入组', report.groups.injected], ['旁路组', report.groups.bypassed]]) {
    lines.push('');
    if (agg === null) {
      lines.push(`${name}：没有符合条件的会话（需要两组都跑过才能对照）`);
      continue;
    }
    lines.push(
      `${name}：会话 ${agg.sessions} · 轮次 ${agg.turns} · 回复 ${agg.assistantChars} 字符 · `
      + `输入 ${agg.inputTokens} tok（均值 ${agg.meanInputTokensPerTurn}/轮） · 缓存读 ${agg.cacheReadTokens} tok（均值命中率 ${agg.meanCacheHitRatio ?? '—'}）`,
    );
    lines.push(`  卡行 ${agg.cardRows}（${agg.cardBytes} B，其中带「想起」${agg.cardRecallHits}） · 手记 ${agg.journalEntries} 条 · 纠正候选 ${agg.correctionCandidates}`);
    if (agg.shapeDriftRows > 0) lines.push(`  ⚠ ${agg.shapeDriftRows} 行卡形状与渲染器不一致（缺状态段或签名行）——本组数字不可信`);
  }
  if (report.groups.injected !== null && report.groups.bypassed !== null) {
    const a = report.groups.injected;
    const b = report.groups.bypassed;
    lines.push('');
    lines.push(
      `Δ（注入 − 旁路）：每轮输入 ${a.meanInputTokensPerTurn - b.meanInputTokensPerTurn} tok · `
      + `缓存命中率 ${((a.meanCacheHitRatio ?? 0) - (b.meanCacheHitRatio ?? 0)).toFixed(4)} · `
      + `每轮注入体积 ${a.turns > 0 ? Math.round(a.cardBytes / a.turns) : 0} B`,
    );
    lines.push('  ↑ 这两行是**观察值**，不是结论：样本、provider、会话长度都会翻转它；纠正率仍需人工判读。');
  }
  lines.push('');
  lines.push('说明：');
  for (const n of report.notes) lines.push(`- ${n}`);
  return `${lines.join('\n')}\n`;
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('\\').join('/'));
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i < 0 ? undefined : argv[i + 1];
  };
  const home = flag('home') ?? process.env.DSH_HOME;
  if (typeof home !== 'string' || home === '') {
    console.error('用法：node scripts/ab-report.mjs --home <DSH_HOME> [--json] [--out <file>]');
    process.exit(2);
  }
  const report = analyzeHome(home);
  // 开关名写全：上一版这里是 argv.includes('json')，漏了前缀，于是 --json 永远不生效
  const text = argv.includes('--json') ? JSON.stringify(report, null, 2) : renderText(report);
  const out = flag('out');
  if (typeof out === 'string' && out !== '') writeFileSync(out, `${text}\n`, 'utf8');
  else console.log(text);
}
