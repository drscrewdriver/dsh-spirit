/**
 * 远程 embeddings 通道（v0.3.5 向量能力位）：OpenAI 兼容 /embeddings，纯 fetch 零依赖。
 *
 * 包体闸锁死 sqlite-vec/jieba/undici（运行时依赖只有 schemastery），所以：
 * - HTTP 用全局 fetch（照 drsc/prime 客户端同一先例，fetchImpl 可注入测试）；
 * - 向量存 entry_vector BLOB（Float32Array 序列化，写入侧 L2 归一 ⇒ 查询侧点积即余弦）；
 * - 全表暴力扫只许走冷路径（面板搜索），注入热路径（recall.timeoutMs=800）绝不碰。
 *
 * G11 出站收口：本文件是 spirit 第一条**非 loopback** 出站的合法落点——
 * baseUrl 来自部署面配置（不进 volatile，面板改不了出站目标 = 不给 SSRF 开口子）。
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { SpiritConfig } from '../contract.js';
import type { MinimalLogger } from '../persona/store.js';

export const EMBED_BATCH_MAX = 32;
export const EMBED_TIMEOUT_MS = 10_000;
/** 单条输入粗筛上限（IPC/请求体护栏，照姊妹包 maxInputChars 的做法）。 */
export const EMBED_INPUT_MAX_CHARS = 5_000;

export interface EmbedRemoteDeps {
  cfg: () => SpiritConfig;
  logger: MinimalLogger;
  fetchImpl?: typeof fetch;
}

/** 文本 → 向量（已 L2 归一）。失败返回 null（调用方降级关键词路，不抛穿）。 */
export class RemoteEmbedding {
  private readonly fetchImpl: typeof fetch;
  /** 极简并发闸：同一时刻至多 1 个嵌入批在飞（冷路径不需要并发，要的是不叠峰）。 */
  private inFlight: Promise<number[][]> | null = null;

  constructor(private readonly deps: EmbedRemoteDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  get enabled(): boolean {
    const vector = this.deps.cfg().distill.vector;
    return vector.enabled && vector.baseUrl.trim() !== '' && vector.model.trim() !== '' && vector.apiKey.trim() !== '';
  }

  async embed(texts: readonly string[]): Promise<number[][] | null> {
    if (!this.enabled || texts.length === 0) return null;
    if (this.inFlight !== null) {
      // 串行闸：排队而不是并发（重嵌风暴比慢一点更糟）
      await this.inFlight.catch(() => undefined);
    }
    const run = this.embedSerial(texts.slice(0, EMBED_BATCH_MAX));
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async embedSerial(texts: readonly string[]): Promise<number[][]> {
    const vector = this.deps.cfg().distill.vector;
    const base = vector.baseUrl.trim().replace(/\/+$/u, '');
    const response = await this.fetchImpl(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${vector.apiKey.trim()}` },
      body: JSON.stringify({ model: vector.model.trim(), input: texts.map((t) => t.slice(0, EMBED_INPUT_MAX_CHARS)) }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`embeddings HTTP ${response.status}`);
    const body = (await response.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
    if (!Array.isArray(body.data)) throw new Error('embeddings 响应无 data 数组');
    const out: number[][] = texts.map(() => []);
    for (const item of body.data) {
      const index = typeof item.index === 'number' ? item.index : -1;
      if (index < 0 || index >= texts.length || !Array.isArray(item.embedding)) throw new Error('embeddings 响应形状不符');
      out[index] = normalize(item.embedding);
    }
    return out;
  }
}

/** L2 归一（点积即余弦）；零向量原样返回。 */
export function normalize(vec: readonly number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return [...vec];
  return vec.map((v) => v / norm);
}

/** BLOB ⇄ Float32Array（存储层的唯一编解码点）。 */
export function encodeVector(vec: readonly number[]): Uint8Array {
  const f32 = new Float32Array(vec);
  return new Uint8Array(f32.buffer);
}

export function decodeVector(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

/** 文本哈希（source_hash 对账：条目文本变了才重嵌，关闸期写入的条目重开必补）。 */
export function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 把一批 (entryId, text) 中缺向量/已过期的补嵌进库；返回补嵌条数。 */
export async function backfillVectors(deps: {
  db: () => DatabaseSync | null;
  embedder: RemoteEmbedding;
  logger: MinimalLogger;
}, entries: ReadonlyArray<{ id: string; text: string }>): Promise<number> {
  const db = deps.db();
  if (db === null || !deps.embedder.enabled) return 0;
  const stale: Array<{ id: string; text: string; hash: string }> = [];
  for (const entry of entries) {
    const hash = hashText(entry.text);
    try {
      const row = db.prepare(`SELECT source_hash FROM entry_vector WHERE entry_id = ?`).get(entry.id) as Record<string, SQLOutputValue> | undefined;
      if (typeof row?.['source_hash'] === 'string' && row['source_hash'] === hash) continue;
    } catch {
      return 0;
    }
    stale.push({ id: entry.id, text: entry.text, hash });
  }
  if (stale.length === 0) return 0;
  const vectors = await deps.embedder.embed(stale.map((s) => s.text)).catch((err: unknown) => {
    deps.logger.warn(`[spirit] 向量补嵌失败（降级关键词路）：${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  if (vectors === null || vectors.length !== stale.length) return 0;
  let n = 0;
  const now = Date.now();
  try {
    db.exec('BEGIN');
    try {
      for (let i = 0; i < stale.length; i += 1) {
        const item = stale[i];
        const vec = vectors[i];
        if (item === undefined || vec === undefined || vec.length === 0) continue;
        db.prepare(`INSERT OR REPLACE INTO entry_vector (entry_id, dim, source_hash, vec, updated_at) VALUES (?, ?, ?, ?, ?)`)
          .run(item.id, vec.length, item.hash, Buffer.from(encodeVector(vec).buffer), now);
        n += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    deps.logger.warn(`[spirit] 向量落库失败：${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  return n;
}

/** 余弦精排（归一后点积）：候选集 ≤200 的暴力扫，只许冷路径调用。 */
export function rankByCosine(query: readonly number[], candidates: ReadonlyArray<{ id: string; vec: Float32Array }>): Array<{ id: string; score: number }> {
  return candidates
    .map((c) => {
      let dot = 0;
      const len = Math.min(query.length, c.vec.length);
      for (let i = 0; i < len; i += 1) dot += (query[i] ?? 0) * (c.vec[i] ?? 0);
      return { id: c.id, score: dot };
    })
    .sort((a, b) => b.score - a.score);
}
