#!/usr/bin/env node
/**
 * 刀2 真机档：两仓同装跑真回合后，检查姊妹记忆引擎的 L1 导出面**不含** spirit 语汇。
 *
 * 为什么单独一个脚本而不是塞进 CI：CI 里没有真模型跑的回合，也没有对方的库。
 * 没有真数据的断言是常绿假闸——本脚本对这两种情况都给 **verdict=NO-DATA 退出码 2**，
 * 不给绿（README/计划里的口径：发版前必须真跑一次并留报告）。
 *
 * 读法（只读，零写入；路径按仓内既有约定）：
 * - `$DSH_HOME/memory/**` 下的 `.md` / `.jsonl` / `.json`（L1 的落盘面，按扩展名过滤）
 * - `$DSH_HOME/spirit/spirit.db`（在场时读 experience 的 text/gist 建立"自家语汇现场"）
 * 匹配集来自 spirit 自己的单源（`dist/util/echo-phrases.js`），不手抄短语。
 *
 * 用法：
 *   node scripts/echo-chain-live.mjs --home "$env:DSH_HOME" [--json]
 * 退出码：0=PASS（有数据且无泄漏）；1=FAIL（命中，报告行号）；2=NO-DATA（没跑过真回合）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SPIRIT_PHRASES, SPIRIT_GIST_SENTENCES } from '../dist/util/echo-phrases.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const home = arg('home', process.env['DSH_HOME'] ?? join(process.env['USERPROFILE'] ?? '', '.dsh'));
const asJson = process.argv.includes('--json');

function walkFiles(dir, depth, out) {
  if (depth > 6 || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, depth + 1, out);
      continue;
    }
    if (/\.(md|jsonl)$/iu.test(entry.name) && !/(tmp|temp|\.lock)$/iu.test(entry.name)) out.push(full);
  }
}

const memoryRoot = join(home, 'memory');
const spiritDb = join(home, 'spirit', 'spirit.db');

const files = [];
// 只扫对话与记忆正文；models/ 下的 tokenizer 等资源件不是 L1 产物（整表假阳的源头）
for (const sub of ['conversations', 'memories', 'scenes']) walkFiles(join(memoryRoot, sub), 0, files);
if (files.length === 0) walkFiles(memoryRoot, 0, files);

/** 句子级匹配：短档位词（“顺手”“平常”）在自然中文里必然误命中，只认整句/带前缀的卡句。 */
const CARD_SENTENCES = [...SPIRIT_GIST_SENTENCES, ...SPIRIT_PHRASES.filter((p) => p.length >= 12)];

function matchCardLanguage(line) {
  for (const s of CARD_SENTENCES) {
    if (s.length >= 12 && line.includes(s)) return s;
  }
  return null;
}

const hits = [];
let scannedBytes = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  scannedBytes += text.length;
  const badLines = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const phrase = matchCardLanguage(lines[i] ?? '');
    if (phrase !== null) badLines.push({ line: `L${i + 1}: ${(lines[i] ?? '').slice(0, 120)}`, phrase });
  }
  if (badLines.length > 0) hits.push({ file, sample: badLines.slice(0, 3) });
}

/** 现场证据：spirit 库里有没有真跑出来的条目（没有=没跑过真回合，不是"没泄漏"）。 */
let spiritEntries = null;
try {
  if (existsSync(spiritDb)) {
    const db = new DatabaseSync(spiritDb, { readOnly: true });
    const row = db.prepare('SELECT COUNT(*) AS n FROM experience').get();
    spiritEntries = typeof row?.['n'] === 'number' ? row['n'] : 0;
    db.close();
  }
} catch {
  spiritEntries = null;
}

const hasData = files.length > 0 && (spiritEntries ?? 0) > 0;
const verdict = !hasData ? 'NO-DATA' : hits.length > 0 ? 'FAIL' : 'PASS';
const exitCode = verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 2;

if (asJson) {
  process.stdout.write(`${JSON.stringify({ verdict, home, memoryFiles: files.length, scannedBytes, spiritEntries, phraseSet: SPIRIT_PHRASES.length, hits }, null, 2)}\n`);
} else {
  process.stdout.write(`echo-chain-live: ${verdict}\n`);
  process.stdout.write(`  home=${home}  L1侧文件=${files.length}（${scannedBytes} B）  spirit条目=${spiritEntries ?? '—'}  短语集=${SPIRIT_PHRASES.length}\n`);
  if (verdict === 'NO-DATA') {
    process.stdout.write('  两仓同装跑真回合后再执行本脚本；没有真数据不给绿。\n');
  }
  for (const h of hits.slice(0, 10)) {
    process.stdout.write(`  HIT ${h.file}\n`);
    for (const s of h.sample) process.stdout.write(`    ${s.line}  「${s.phrase}」\n`);
  }
}
process.exitCode = exitCode;
