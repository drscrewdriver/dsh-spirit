#!/usr/bin/env node
/**
 * 回声链检测闸（v19 / B-2，**只读**）。
 *
 * 背景：spirit 的注入卡若被上游（dsh-prime-memory）的证据面当成 assistant 发言收下，
 * 会沿「复述 → 蒸馏 → 画像」把体验洗成"事实"。README 自述这条链 spirit 单方面修不了，
 * 只能靠语汇纪律 + CI 断言；本脚本把"纪律"变成可观测的闸：
 *
 * 1. 读 spirit 库 `echo_step`（kind='injected'）拿每张卡的**首行片段**；
 * 2. 读上游 `memory.db` 的 `l1_records.content` 看有没有这些片段；
 * 3. 命中 ⇒ 退出码 1 并打印样本（说明上游把卡行收成了知识）。
 *
 * 边界：只读打开两个库（`readOnly: true`），不写任何一边、不修改上游。
 *
 * 用法：
 *   node scripts/echo-gate.mjs [--home <DSH_HOME>] [--spirit-db <path>] [--prime-db <path>] [--limit 500] [--json]
 *
 * 退出码：0 = 干净；1 = 发现回声；2 = 无法检查（库/表缺失，不是脏）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function parseArgs(argv) {
  const out = { limit: 500, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--json') {
      out.json = true;
      continue;
    }
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) continue;
    out[name] = value;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const home = String(args.home ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
const spiritDbPath = String(args['spirit-db'] ?? path.join(home, 'spirit', 'spirit.db'));
const primeDbPath = String(args['prime-db'] ?? path.join(home, 'memory', 'memory.db'));
const limit = Math.max(1, Math.min(5000, Number.parseInt(String(args.limit ?? '500'), 10) || 500));

/** 无法检查（不是脏）：库不存在 / 表不存在 / 上游未装。 */
const SKIP = 2;

function readOnlyOpen(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return new DatabaseSync(filePath, { readOnly: true });
  } catch {
    return undefined;
  }
}

function tableExists(db, table) {
  try {
    db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

function main() {
  const spirit = readOnlyOpen(spiritDbPath);
  if (spirit === undefined) return { code: SKIP, reason: `spirit 库不存在：${spiritDbPath}` };
  if (!tableExists(spirit, 'echo_step')) {
    spirit.close();
    return { code: SKIP, reason: 'spirit 库没有 echo_step（旧版本/未迁移）' };
  }

  let cards;
  try {
    cards = spirit
      .prepare(`SELECT session_id, ts_ms, text FROM echo_step WHERE kind = 'injected' AND text <> '' ORDER BY ts_ms DESC LIMIT ?`)
      .all(limit);
  } catch (err) {
    spirit.close();
    return { code: SKIP, reason: `读 echo_step 失败：${err instanceof Error ? err.message : String(err)}` };
  }
  spirit.close();

  // 每张卡取一条"最能代表它"的首行（跳过 <system-reminder> 壳与空行）
  const fragments = [];
  const seen = new Set();
  for (const row of cards) {
    const lines = String(row.text ?? '').split('\n');
    const first = lines.map((line) => line.trim()).find((line) => line !== '' && !line.startsWith('<system-reminder'));
    if (first === undefined) continue;
    const fragment = Array.from(first).slice(0, 40).join('');
    if (fragment === '' || seen.has(fragment)) continue;
    seen.add(fragment);
    fragments.push({ sessionId: String(row.session_id ?? ''), ts: Number(row.ts_ms ?? 0), fragment });
  }

  const prime = readOnlyOpen(primeDbPath);
  if (prime === undefined) {
    return { code: SKIP, reason: `上游库不存在（未装 prime-memory）：${primeDbPath}`, cards: cards.length };
  }
  if (!tableExists(prime, 'l1_records')) {
    prime.close();
    return { code: SKIP, reason: '上游库没有 l1_records（未蒸馏/未迁移）', cards: cards.length };
  }

  const hits = [];
  try {
    const stmt = prime.prepare(`SELECT record_id, type FROM l1_records WHERE content LIKE ? LIMIT 3`);
    for (const item of fragments) {
      const rows = stmt.all(`%${item.fragment}%`);
      if (rows.length === 0) continue;
      hits.push({
        sessionId: item.sessionId,
        ts: item.ts,
        fragment: item.fragment,
        upstream: rows.map((row) => ({ recordId: String(row.record_id ?? ''), type: String(row.type ?? '') })),
      });
    }
  } catch (err) {
    prime.close();
    return { code: SKIP, reason: `查上游失败：${err instanceof Error ? err.message : String(err)}` };
  }
  prime.close();

  return { code: hits.length === 0 ? 0 : 1, cards: cards.length, fragments: fragments.length, hits: hits.slice(0, 10), total: hits.length };
}

const result = main();
if (args.json) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (result.code === 0) {
  process.stdout.write(`[echo-gate] 干净：${result.cards} 张注入卡 / ${result.fragments} 个片段，上游 l1_records 未收下任何卡行\n`);
} else if (result.code === SKIP) {
  process.stdout.write(`[echo-gate] 跳过：${result.reason}\n`);
} else {
  process.stdout.write(`[echo-gate] 发现回声 ${result.total} 处（上游把卡行收成了知识）：\n`);
  for (const hit of result.hits) {
    process.stdout.write(`  - ${hit.sessionId} @${hit.ts} 「${hit.fragment}」→ ${hit.upstream.map((u) => `${u.type}:${u.recordId}`).join(', ')}\n`);
  }
}
process.exit(result.code);
