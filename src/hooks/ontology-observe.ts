/**
 * 本体层反馈捕获的接线面（Phase B / TB.2）：`session/event` 旁路 → 命中意图 → 锚定 → 落 evaluation。
 *
 * 与事务轨同为旁路（不挂 pre-step 串行链），但**这条不跑 LLM**：反馈是 matchIntent 确定性命中 +
 * 锚定也是本地匹配，落库是一次廉价 INSERT——所以它可以在事件路径上同步做（照 ledger 结算先例）。
 *
 * 三条纪律：
 * 1. **关时零副作用**：`ontology.enabled=false` ⇒ 直接 return，一条 evaluation 都不落（countEvaluations 恒 0）。
 * 2. **防回声**：自家注入卡以 user/message 形态可见，必须过 `isOwnCardText` + source.kind==='user' 双重判，
 *    否则角色自己的"事务："段会被当成主人评价（跨轮自喂的闭环）。
 * 3. **user_line 脱敏+钳短**：入库的用户原句先 dropIfSecret（含密则不存原句，只存档位与锚），再按顶截断；
 *    原文绝不整段落库。
 */

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent';

import type { SpiritConfig } from '../contract.js';
import type { OntologyStore } from '../store/ontology.js';
import type { TxnStore } from '../store/transaction.js';
import type { OntologyWatcher } from '../ontology/watcher.js';
import type { OntologyExtractor } from '../ontology/extractor.js';
import { anchorFeedback } from '../ontology/anchor.js';
import { dropIfSecret } from '../ontology/scrub.js';
import { matchIntent } from '../words.js';
import { isOwnCardText } from '../slot/render.js';
import { sessionIdOfSession } from '../util/host-shape.js';
import { TRUST_USER_EXPLICIT } from '../types.js';

/** user_line 入库顶（码点截，劈代理对会写出无法编码的半个字符）。 */
const USER_LINE_MAX_CHARS = 160;

export interface OntologyObserveDeps {
  store: OntologyStore;
  txnStore: TxnStore;
  watcher: OntologyWatcher;
  extractor: OntologyExtractor;
  cfg: () => SpiritConfig;
  logger: { warn(message: string): void };
  /** 空 workspaceId 修复链（cwd→同会话反查→全局桶）；省略 ⇒ 原样传（老装配兼容）。 */
  resolveWorkspace?: (sessionId: string, candidate: string) => string;
  now?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** 只取第一段 text 块（与事务 watcher 同法）；原文不外泄，仅用于本地 matchIntent/锚定。 */
function firstText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    const record = asRecord(block);
    if (record['type'] === 'text' && typeof record['text'] === 'string') return record['text'];
  }
  return '';
}

function workspaceOf(data: Record<string, unknown>): string {
  const value = data['workspace_id'];
  return typeof value === 'string' ? value : '';
}

export function registerOntologyObserve(ctx: Context, deps: OntologyObserveDeps): void {
  const now = deps.now ?? Date.now;

  ctx.on('session/event', (session, event) => {
    try {
      if (!deps.cfg().ontology.enabled) return; // 关时：一条都不落（零落库的半边靠这条）
      const raw = event as { type?: unknown; data?: unknown } | null | undefined;
      const type = typeof raw?.type === 'string' ? raw.type : '';
      if (type === '') return;
      const sessionId = sessionIdOfSession(session);
      if (sessionId === '') return;

      const data = asRecord(raw?.data);
      // 头部没带工作区时不能直接传空串（写侧闸会整批拒）：走修复链修到对应范围或全局桶
      const workspaceId = deps.resolveWorkspace === undefined
        ? workspaceOf(data)
        : deps.resolveWorkspace(sessionId, workspaceOf(data));

      // 本体采集旁路：所有事件喂 watcher，turn/end 取信号入队（异步批，不 await）。
      deps.watcher.observe(sessionId, workspaceId, { type, data: raw?.data }, now());
      if (type === 'turn/end' && deps.watcher.hasActivity(sessionId)) {
        const signals = deps.watcher.takeSignals(sessionId, now());
        if (signals !== null) {
          const got = deps.extractor.enqueue(signals);
          if (!got.accepted && got.reason !== 'queue-full') deps.logger.warn(`[spirit] 本体抽取本轮未受理（${got.reason}）`);
        }
      }

      if (type !== 'user/message') return;
      const source = asRecord(data['source']);
      if (source['kind'] !== 'user') return; // 别的插件注入行不算用户发言
      const text = firstText(data['content']);
      if (text === '' || isOwnCardText(text)) return; // 防回声：自家卡不是评价

      const hit = matchIntent(text);
      if (hit === null) return;

      const tsMs = now();
      const anchor = anchorFeedback(deps.txnStore, {
        kind: hit.kind,
        sessionId,
        workspaceId,
        tsMs,
        userText: text,
      });
      // user_line：脱敏后钳短；含密则不存原句（只存档位与锚，宁缺毋造）。
      const safe = dropIfSecret(Array.from(text).slice(0, USER_LINE_MAX_CHARS).join(''));
      const result = deps.store.insertEvaluation({
        id: `eval-${sessionId}-${tsMs}`,
        deliveryId: anchor.deliveryId,
        kind: hit.kind,
        anchorMode: anchor.anchorMode,
        anchorConfidence: anchor.anchorConfidence,
        userLine: safe,
        sourceTrust: TRUST_USER_EXPLICIT,
        sessionId,
        workspaceId,
        tsMs,
      });
      if (!result.ok) deps.logger.warn(`[spirit] 评价未落库（${result.reason}）`);
    } catch (err) {
      deps.logger.warn(`[spirit] 反馈捕获异常（忽略本轮）：${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
