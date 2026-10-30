/**
 * 人格卡的持久化：`persona.json` + `persona-history.jsonl`。
 *
 * **旧版永不静默覆盖**：每次写入前把当前生效的那张卡追加进历史文件。这样
 * "人设改坏了"有一条明确的后退回填路径，而不是靠用户回忆原文重写。
 * revision 单调递增，作为稳定区文本的缓存键（revision 未变 ⇒ 不重算，node 0 不动）。
 *
 * 读侧宽容、写侧严格：读坏了退默认人格（插件不能因为一个 json 坏掉就起不来），
 * 写入形状不合法直接拒（不把脏值留在库里）。
 */

import { join } from 'node:path';

import { SPIRIT_PERSONA_FILE_VERSION } from '../contract.js';
import type { PersonaCard } from '../types.js';
import { readJsonTolerant, withFileLock, writeEnvelopedJson, appendLine } from '../store/json-file.js';
import { DEFAULT_PERSONA, validatePersona, sanitizePersona } from './types.js';

export interface MinimalLogger {
  info(message: string): void;
  warn(message: string): void;
}

export const PERSONA_FILE = 'persona.json';
export const PERSONA_HISTORY_FILE = 'persona-history.jsonl';

export class PersonaStore {
  private cached?: PersonaCard;

  constructor(private readonly deps: { dataDir: string; logger: MinimalLogger }) {}

  private get filePath(): string {
    return join(this.deps.dataDir, PERSONA_FILE);
  }

  private get historyPath(): string {
    return join(this.deps.dataDir, PERSONA_HISTORY_FILE);
  }

  /** 当前生效卡（带缓存）；文件缺失或损坏 ⇒ 内置默认，并把降级说出来。 */
  current(): PersonaCard {
    if (this.cached !== undefined) return this.cached;
    const result = readJsonTolerant<PersonaCard>(this.filePath, SPIRIT_PERSONA_FILE_VERSION);
    if (!result.ok) {
      if (result.reason !== 'missing') {
        this.deps.logger.warn(`[spirit] persona.json 不可用（${result.reason}），本次退回内置默认人格`);
      }
      this.cached = { ...DEFAULT_PERSONA };
      return this.cached;
    }
    const { persona, fellBack } = sanitizePersona(result.value);
    if (fellBack) this.deps.logger.warn('[spirit] persona.json 形状不符，已退回默认人格（请检查字段名）');
    this.cached = persona;
    return persona;
  }

  /**
   * 写入新卡。
   *
   * @param raw 待写形状（未校验；调用方可能是 RPC/文件/测试）
   * @returns 拒绝时给出原因，**不抛**——人设写坏了不该让会话中断
   */
  save(raw: unknown): { ok: true; persona: PersonaCard } | { ok: false; reason: string } {
    const checked = validatePersona(raw);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const previous = this.current();
    const next: PersonaCard = {
      ...checked.persona,
      // revision 只由本层推进：调用方给的值一律取 max(prev+1, 给定值)，防止外部回退它
      revision: Math.max(previous.revision + 1, checked.persona.revision),
    };
    const done = withFileLock(this.deps.dataDir, 'persona', () => {
      // 旧版先进历史，再覆盖当前：顺序反了就没有回退点
      appendLine(this.historyPath, JSON.stringify(previous));
      writeEnvelopedJson(this.filePath, SPIRIT_PERSONA_FILE_VERSION, next);
      this.cached = next;
      return next;
    });
    if (done === undefined) return { ok: false, reason: '人格文件被占用，本次未写入（可稍后重试）' };
    this.deps.logger.info(`[spirit] 人格已更新至 revision ${done.revision}，旧版已留档`);
    return { ok: true, persona: done };
  }

  /** 丢弃缓存（文件被外部编辑后强制重读）。 */
  invalidate(): void {
    this.cached = undefined;
  }
}
