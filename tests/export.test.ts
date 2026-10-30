import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SPIRIT_DEFAULTS, type SpiritConfig, type SpiritLiveSettings } from '../src/contract.js';
import { effectiveCfg, readLiveRef, resolveLive } from '../src/config.js';
import { exportSessionEntries, type ExportRow } from '../src/store/journal-retention.js';

const rows: ExportRow[] = [
  { tsMs: 20, turnSeq: 2, trigger: 'tool_failure', notice: 'self_mistake', reaction: 'mild', text: '我出了错：第二个。', lane: 'live' },
  { tsMs: 10, turnSeq: 1, trigger: 'task_close', notice: 'task_progress', reaction: 'strong', text: '事情收到一个段落。', lane: 'live' },
];

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-export-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('手记导出（真实写盘）', () => {
  it('干跑不写任何文件，但报出会写的文件名与条数', () => {
    const result = exportSessionEntries({ dataDir: dir, dirName: 'export', sessionId: 's1', format: 'md', rows, dryRun: true, now: 1_700_000_000_000 });
    expect(result.written).toBe(2);
    expect(result.fileName).toMatch(/^spirit-[0-9a-f]+-\d{4}-\d{2}-\d{2}\.md$/u);
    expect(existsSync(join(dir, 'export'))).toBe(false);
  });

  it('实跑写文件：md 带"非事实记录"说明并按时间正序', () => {
    const result = exportSessionEntries({ dataDir: dir, dirName: 'export', sessionId: 's1', format: 'md', rows, dryRun: false, now: 1_700_000_000_000 });
    const body = readFileSync(join(dir, 'export', result.fileName), 'utf8');
    expect(body).toContain('不是客观事实清单');
    expect(body.indexOf('事情收到一个段落')).toBeLessThan(body.indexOf('第二个'));
  });

  it('jsonl 一行一条且可解析', () => {
    const result = exportSessionEntries({ dataDir: dir, dirName: 'export', sessionId: 's1', format: 'jsonl', rows, dryRun: false, now: 1_700_000_000_000 });
    const lines = readFileSync(join(dir, 'export', result.fileName), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(typeof JSON.parse(line)).toBe('object');
  });

  it('同名不覆盖：第二次导出加序号（导出件是给人拿走的产物，覆盖等于掉数据）', () => {
    const args = { dataDir: dir, dirName: 'export', sessionId: 's1', format: 'jsonl' as const, rows, dryRun: false, now: 1_700_000_000_000 };
    const first = exportSessionEntries(args);
    const second = exportSessionEntries(args);
    expect(second.fileName).not.toBe(first.fileName);
    expect(readdirSync(join(dir, 'export')).length).toBe(2);
  });

  it('会话 id 绝不进文件名：含路径分隔符的 id 也只产生安全名（路径注入面在这里关掉）', () => {
    const nasty = exportSessionEntries({
      dataDir: dir,
      dirName: 'export',
      sessionId: '../../../../etc/passwd',
      format: 'jsonl',
      rows,
      dryRun: false,
      now: 1_700_000_000_000,
    });
    expect(nasty.fileName).not.toContain('..');
    expect(nasty.fileName).not.toContain('/');
    expect(existsSync(join(dir, 'export', nasty.fileName))).toBe(true);
  });
});

describe('live 节必须真的能改到生效配置（防"开关是装饰品"）', () => {
  const base = structuredClone(SPIRIT_DEFAULTS);

  /** 每个 live 键都构造一个"与默认不同"的值，断言 effectiveCfg 之后对应路径确实变了。 */
  const cases: Array<{ key: keyof SpiritLiveSettings; value: boolean | number; path: string; expect: unknown }> = [
    { key: 'cardMaxBytes', value: 111, path: 'card.maxBytes', expect: 111 },
    { key: 'recentK', value: 5, path: 'card.recentK', expect: 5 },
    { key: 'crossSessionM', value: 0, path: 'card.crossSessionM', expect: 0 },
    { key: 'recallTimeoutMs', value: 7, path: 'recall.timeoutMs', expect: 7 },
    { key: 'halfLifeMs', value: 8, path: 'recall.halfLifeMs', expect: 8 },
    { key: 'recallMaxResults', value: 9, path: 'recall.maxResults', expect: 9 },
    { key: 'tierStepCap', value: 2, path: 'tier.stepCap', expect: 2 },
    { key: 'staleAfterMs', value: 3, path: 'tier.staleAfterMs', expect: 3 },
    { key: 'retentionDays', value: 4, path: 'journal.retentionDays', expect: 4 },
    { key: 'drscEnabled', value: false, path: 'drsc.enabled', expect: false },
    { key: 'personaEnabled', value: false, path: 'persona.enabled', expect: false },
    { key: 'cardEnabled', value: false, path: 'card.maxBytes', expect: 0 },
  ];

  for (const item of cases) {
    it(`${String(item.key)} → ${item.path}`, () => {
      const live: SpiritLiveSettings = { ...SPIRIT_DEFAULTS.live, [item.key]: item.value } as SpiritLiveSettings;
      const merged = effectiveCfg(structuredClone(base) as SpiritConfig, live) as unknown as Record<string, Record<string, unknown>>;
      const section = item.path.split('.')[0] ?? '';
      const field = item.path.split('.')[1] ?? '';
      expect(merged[section]?.[field], item.path).toEqual(item.expect);
    });
  }

  it('resolveLive 对缺键/脏值逐键退默认（少一个键就少一处静默）', () => {
    expect(resolveLive({})).toEqual(SPIRIT_DEFAULTS.live);
    expect(resolveLive(null)).toEqual(SPIRIT_DEFAULTS.live);
    expect(resolveLive({ cardMaxBytes: 'abc', bypass: 'yes' })).toEqual(SPIRIT_DEFAULTS.live);
    // 老线（无 .volatile()）拿到的是配置本体，没有 .get()：不能报 ref.get is not a function
    expect(readLiveRef({ ...SPIRIT_DEFAULTS.live }).bypass).toBe(false);
    expect(readLiveRef({ get: () => ({ ...SPIRIT_DEFAULTS.live, bypass: true }) }).bypass).toBe(true);
    expect(readLiveRef(undefined).cardMaxBytes).toBe(SPIRIT_DEFAULTS.live.cardMaxBytes);
  });
});
