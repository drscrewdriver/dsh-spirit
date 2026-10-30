/**
 * 小型 JSON 文件读写：原子写 + 跨进程文件锁 + 宽容载入。
 *
 * 三条纪律都来自姊妹包的真事故，不是防御性铺张：
 * 1. **UTF-8 无 BOM**：带 BOM 的 JSON 让 `JSON.parse` 直接抛，而 profile 里并发写
 *    同一个文件时最容易写出 BOM（表现为"改值不生效"，查不到根因）。
 * 2. **原子写**：`tmp + rename`。半文件状态被读到 ⇒ 载入失败 ⇒ 状态被当成空。
 * 3. **宽容载入**：损坏文件返回 `ok:false` 让调用方退默认，**不抛**——抛穿宿主启动
 *    是最坏的失败方式（一个 json 坏掉不该让插件起不来）。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 落盘信封：版本号与数据同文件，跨代载入可据此判定要不要迁移或拒读。 */
export interface FileEnvelope<T> {
  version: number;
  data: T;
}

export type ReadResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** 缺省锁等待预算：单宿主进程内几乎不竞争，这里是给"两个实例同时开"留的余地。 */
export const LOCK_WAIT_MS = 2_000;
/** 超过此时长视为死锁（持有进程已崩），允许接管。 */
export const LOCK_STALE_MS = 10_000;

/** 去掉 UTF-8 BOM（读侧兜住别人写的 BOM，不指望对方也守规矩）。 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 原子写文本（调用方负责内容已是 LF、无 BOM 的字符串）。 */
export function writeFileAtomic(path: string, text: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  // 显式 'utf8'：Windows 默认 cp936 会把中文写成不可读字节
  writeFileSync(tmp, text, { encoding: 'utf8' });
  renameSync(tmp, path);
}

export function writeJsonAtomic<T>(path: string, value: T): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeEnvelopedJson<T>(path: string, version: number, data: T): void {
  writeJsonAtomic<FileEnvelope<T>>(path, { version, data });
}

/** 宽容读 JSON：不存在 / 解析失败 / 版本不符 一律返回 ok:false，不抛。 */
export function readJsonTolerant<T>(path: string, expectVersion?: number): ReadResult<T> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // ENOENT 在 **err.code** 上（不是 name）：拿 name 判会把"不存在"误报成"不可读"，
    // 面板上就成了一个并不存在的故障。
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    return { ok: false, reason: code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  if (expectVersion !== undefined) {
    const version = typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
    if (version !== expectVersion) return { ok: false, reason: `version:${String(version)}` };
    return { ok: true, value: (parsed as FileEnvelope<T>).data };
  }
  return { ok: true, value: parsed as T };
}

/** 同步睡眠（避免为一次锁等待把整条调用链改成 async）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 锁文件的 mtime；不存在（刚被释放）⇒ 0，让下一轮重试立即抢到。 */
function lockMtime(lockPath: string): number {
  try {
    return statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 在 `lockDir` 上持名为 `name` 的锁跑 `fn`；拿不到锁返回 `undefined`（**不抛**）。
 *
 * 语义边界：这只防"同机多进程同时重写一个 json"，不是 OS 级隔离，也不防恶意进程。
 * 死锁接管条件是 mtime 超过 `staleMs`——进程崩在持锁期间不至于永久卡死后续写入。
 */
export function withFileLock<T>(
  lockDir: string,
  name: string,
  fn: () => T,
  options: { waitMs?: number; staleMs?: number; now?: () => number } = {},
): T | undefined {
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const now = options.now ?? Date.now;
  if (!existsSync(lockDir)) mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, `${name}.lock`);
  const deadline = now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      break;
    } catch {
      // 已存在：先看是不是死锁（持有者崩在持锁期间）
      if (now() - lockMtime(lockPath) > staleMs) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          /* 竞争接管，下一轮再说 */
        }
        continue;
      }
      if (now() >= deadline) return undefined;
      sleepSync(20);
    }
  }
  // 走到这里一定持有锁（未拿到时上面已经 return）
  try {
    return fn();
  } finally {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* 已被清理 */
    }
  }
}
