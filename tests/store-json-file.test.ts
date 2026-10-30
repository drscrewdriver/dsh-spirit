import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readJsonTolerant,
  withFileLock,
  writeEnvelopedJson,
  writeFileAtomic,
  writeJsonAtomic,
  type ReadResult,
} from '../src/store/json-file.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-json-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 收窄到 ok:true 再取 value（未收窄就点是 union 类型错误，测试自己先得合法）。 */
function unwrap<T>(result: ReadResult<T>): T {
  if (!result.ok) throw new Error(`read failed: ${result.reason}`);
  return result.value;
}

describe('原子写与编码', () => {
  it('写出的 JSON 无 BOM 且是合法 UTF-8 中文', () => {
    const path = join(dir, 'a.json');
    writeJsonAtomic(path, { 名称: '状态' });
    const bytes = readFileSync(path);
    const head = bytes.subarray(0, 3).toString('hex');
    // efbbbf 是 UTF-8 BOM：带上它，下一次 JSON.parse 直接抛
    expect(head).not.toBe('efbbbf');
    expect(unwrap(readJsonTolerant<{ 名称: string }>(path)).名称).toBe('状态');
  });

  it('换行是 LF（CRLF 会让 digest 与仓内产物对不上）', () => {
    const path = join(dir, 'b.json');
    writeFileAtomic(path, 'line1\nline2\n');
    const text = readFileSync(path, 'utf8');
    expect(text).toBe('line1\nline2\n');
    expect(text).not.toContain('\r\n');
  });

  it('成功后目录里不留任何 tmp 残留（半文件被读到就是把状态当成空）', () => {
    const path = join(dir, 'c.json');
    writeJsonAtomic(path, { x: 1 });
    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });
});

describe('宽容载入（损坏不抛）', () => {
  it('文件不存在 ⇒ ok:false reason:missing', () => {
    expect(readJsonTolerant(join(dir, 'nope.json'))).toEqual({ ok: false, reason: 'missing' });
  });

  it('半文件 / 垃圾内容 ⇒ ok:false reason:corrupt，不抛穿启动', () => {
    const path = join(dir, 'bad.json');
    writeFileAtomic(path, '{"x": 1');
    expect(readJsonTolerant(path)).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('别人写的 BOM 也能读（读侧兜住，不指望对方守规矩）', () => {
    const path = join(dir, 'bom.json');
    writeFileAtomic(path, '{"x":1}');
    const body = readFileSync(path);
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
    expect(unwrap(readJsonTolerant<{ x: number }>(path))).toEqual({ x: 1 });
  });

  it('版本不符 ⇒ 拒读并如实报出读到的版本（不静默按旧形状读）', () => {
    const path = join(dir, 'env.json');
    writeEnvelopedJson(path, 7, { hello: 'world' });
    expect(readJsonTolerant<{ hello: string }>(path, 9)).toEqual({ ok: false, reason: 'version:7' });
    expect(unwrap(readJsonTolerant<{ hello: string }>(path, 7))).toEqual({ hello: 'world' });
  });
});

describe('withFileLock', () => {
  it('能拿到锁、执行、释放；再次获取照常', () => {
    const lockDir = join(dir, 'locks');
    expect(withFileLock(lockDir, 'session-modes', () => 'ran', { waitMs: 50 })).toBe('ran');
    expect(withFileLock(lockDir, 'session-modes', () => 2)).toBe(2);
    expect(existsSync(join(lockDir, 'session-modes.lock'))).toBe(false);
  });

  it('fn 抛错也会释放锁（否则一次异常把后续写入全卡死）', () => {
    const lockDir = join(dir, 'locks2');
    expect(() =>
      withFileLock(lockDir, 'x', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(join(lockDir, 'x.lock'))).toBe(false);
  });

  it('锁被他人占用且未过期 ⇒ 等完预算返回 undefined（不抛、不死等）', () => {
    const lockDir = join(dir, 'locks4');
    mkdirSync(lockDir, { recursive: true });
    const heldPath = join(lockDir, 'z.lock');
    // 造一把“刚刚创建”的锁（mtime 为真实当前时间，staleMs 给到很大 ⇒ 不应当被接管）
    writeFileSync(heldPath, '');
    const t0 = Date.now();
    const got = withFileLock(lockDir, 'z', () => 'should-not-run', { waitMs: 80, staleMs: 60_000 });
    const waited = Date.now() - t0;
    expect(got, '锁未过期时不得抢到').toBeUndefined();
    expect(waited).toBeGreaterThanOrEqual(50);
    expect(waited, '预算耗尽就该放手，不能死等').toBeLessThan(2_000);
    expect(existsSync(heldPath), '等待者不该把别人的锁删掉').toBe(true);
  });

  it('死锁接管：mtime 超过 staleMs 的锁被清掉，写入继续（持有者崩了不留永久阻塞）', () => {
    const lockDir = join(dir, 'locks3');
    mkdirSync(lockDir, { recursive: true });
    const stalePath = join(lockDir, 'y.lock');
    // 直接在外层造一把“一小时前”的锁（不能在持锁回调里改时间戳：那把锁会在 finally 里被释放）
    writeFileSync(stalePath, '');
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(stalePath, past, past);
    expect(withFileLock(lockDir, 'y', () => 'stolen', { waitMs: 50, staleMs: 10_000 })).toBe('stolen');
  });
});
