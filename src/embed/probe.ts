/**
 * 向量能力仲裁（v0.3.5）：borrowed | self-remote | off 三态 + TTL 缓存。
 *
 * 用户裁决「prime 在跑就借用，否则自启」的**事实修正版**（调研实锤，见 findings Agent A）：
 * prime 没有「送文本→回向量」的服务端点（8 个 embedding-* 全是管理面），本地嵌入是私有子进程——
 * 所以「借用」的真实语义是：**借档位**（baseURL/模型/维度对齐，两套向量同空间才兼容），
 * 调用权与 apiKey 必须 spirit 自持。prime 缺席或档位拿不到 ⇒ 用 spirit 自己的配置（self-remote）。
 *
 * 缺席判定照 owner 同步的三态探测先例（probe + TTL 缓存 + 失败不误报）；
 * 维度锁：首建时把 dims 写进 meta，之后与探测档位不一致 ⇒ 显式报错不静默重建
 * （drop+全量重嵌是昂贵链路，必须由用户显式发起）。
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { SpiritConfig } from '../contract.js';
import type { MinimalLogger } from '../persona/store.js';
import type { PrimeClient } from '../prime/client.js';

export type EmbedStatus = 'borrowed' | 'self-remote' | 'off';

export const EMBED_PROBE_TTL_MS = 300_000;
export const EMBED_DIMS_KEY = 'embed.dimensions';

export interface EmbedResolution {
  status: EmbedStatus;
  /** 生效档位（borrowed=prime 档位，self-remote=自家配置；off 时空）。 */
  baseUrl: string;
  model: string;
  dimensions: number;
  /** 档位来源说明（面板如实标「参数来源=prime」，避免用户以为向量化由 prime 代跑）。 */
  note: string;
}

export interface EmbedProbeDeps {
  /** prime 客户端；undefined = prime 缺席（直接走 self-remote 判定）。 */
  prime: PrimeClient | undefined;
  cfg: () => SpiritConfig;
  db: () => DatabaseSync | null;
  logger: MinimalLogger;
}

export class EmbedArbitrator {
  private cached: { at: number; value: EmbedResolution } | null = null;
  private lastError = '';

  constructor(private readonly deps: EmbedProbeDeps) {}

  /** 维度冲突标记：一旦置位，probe 持续返回它直到用户处置（不静默 drop 重建）。 */
  private dimsConflict: EmbedResolution | null = null;

  async probe(force = false): Promise<EmbedResolution> {
    const now = Date.now();
    if (!force && this.cached !== null && now - this.cached.at < EMBED_PROBE_TTL_MS) return this.cached.value;
    if (this.dimsConflict !== null) return this.dimsConflict;
    const vector = this.deps.cfg().distill.vector;
    if (!vector.enabled) {
      const off: EmbedResolution = { status: 'off', baseUrl: '', model: '', dimensions: 0, note: '向量能力未启用（关键词路照常工作）' };
      this.cached = { at: now, value: off };
      return off;
    }
    // ① 借档位：prime 在跑且开了远程嵌入 ⇒ 对齐它的 baseURL/模型/维度
    if (this.deps.prime !== undefined) {
      try {
        const state = await this.deps.prime.embeddingState();
        if (state.source === 'remote' && state.remote !== null && state.remote.baseUrl !== '' && state.remote.model !== '') {
          const borrowed: EmbedResolution = {
            status: 'borrowed',
            baseUrl: vector.baseUrl.trim() === '' ? state.remote.baseUrl : vector.baseUrl.trim(),
            model: vector.model.trim() === '' ? state.remote.model : vector.model.trim(),
            dimensions: vector.dimensions > 0 ? vector.dimensions : state.remote.dimensions,
            note: '参数来源=prime-memory 档位（向量化仍由 spirit 自跑，key 自持）',
          };
          return this.lockDims(borrowed, now);
        }
      } catch (err) {
        // 探测失败不误报缺失也不炸：落到自启判定（照 probe 三态先例的宽容口径）
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    // ② 自启：spirit 自己的三件套配置齐了才算可用
    if (vector.baseUrl.trim() !== '' && vector.model.trim() !== '' && vector.apiKey.trim() !== '') {
      const self: EmbedResolution = {
        status: 'self-remote',
        baseUrl: vector.baseUrl.trim(),
        model: vector.model.trim(),
        dimensions: vector.dimensions,
        note: this.lastError === '' ? '参数来源=自家配置' : 'prime 档位不可得，已用自家配置',
      };
      return this.lockDims(self, now);
    }
    const off: EmbedResolution = { status: 'off', baseUrl: '', model: '', dimensions: 0, note: '档位不可得（prime 无远程嵌入且自家配置不齐），走关键词路' };
    this.cached = { at: now, value: off };
    return off;
  }

  /** 维度锁：首建记 meta，之后不一致 ⇒ 显式冲突态（调用方报错给用户，不自动重嵌）。 */
  private lockDims(value: EmbedResolution, now: number): EmbedResolution {
    const db = this.deps.db();
    if (db !== null && value.dimensions > 0) {
      try {
        const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(EMBED_DIMS_KEY) as Record<string, SQLOutputValue> | undefined;
        if (typeof row?.['value'] === 'string' && row['value'] !== '') {
          const locked = Number(row['value']);
          if (Number.isFinite(locked) && locked !== value.dimensions) {
            this.dimsConflict = {
              ...value,
              note: `维度冲突：库里向量是 ${locked} 维，当前档位是 ${value.dimensions} 维——请显式清空向量表后重嵌（不静默 drop）`,
            };
            return this.dimsConflict;
          }
        } else {
          db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(EMBED_DIMS_KEY, String(value.dimensions));
        }
      } catch {
        /* meta 读写失败不连坐档位判定 */
      }
    }
    this.cached = { at: now, value };
    return value;
  }

  /** 用户显式处置维度冲突后复位（重嵌完成/清表后调用）。 */
  resetDimsConflict(): void {
    this.dimsConflict = null;
    this.cached = null;
  }
}
