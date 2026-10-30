/**
 * `agent/pre-step` 适配器：把宿主 payload 翻成编排层的输入，再决定要不要追加回忆卡。
 *
 * 三条来自姊妹包实证的规矩：
 * 1. **先 `await next()` 再改写**：不劫持其它监听器的决定，也不丢它们的注入。
 * 2. **注册不加 `prepend`**：靠后注册，让别家先说话；本插件**永不返回 `reject`**
 *    （reject 会让整轮以 blocked 结束，那是"卡没发出去"的最坏实现方式）。
 * 3. **绝不返回空 `messages`**：`enter` + 空数组会让被 claim 的用户消息被丢弃且永不落库。
 *
 * 卡追加在 `decision.messages` **之后**（尾部，离生成点最近；宿主自己的动态快照也放这一侧）。
 */

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent'; // agent/pre-step 事件名声明
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { SPIRIT_SLOT_SECTION_NAME, SPIRIT_SOURCE_KIND } from '../contract.js';
import type { PreStepInput, PreStepOutcome, Spirit } from '../spirit.js';
import { readSurfaceNodes, textOfMessage } from '../util/host-shape.js';

export interface PreStepHookDeps {
  spirit: Spirit;
  logger: { warn(message: string): void };
  /** 档位所有者：子代理要沿 parentSession 上溯，否则父会话的 off 档在子代理里不生效。 */
  ownerOf(agent: unknown): string;
  isSubagent(agent: unknown): boolean;
  sessionIdOf(agent: unknown): string;
  workspaceIdOf(agent: unknown): string;
  /** 本轮是否有新注入（适配器不用管：由编排层按门 6 判）；此字段保留给未来真机诊断。 */
  isAborted?: (payload: unknown) => boolean;
  now?: () => number;
  /**
   * 每轮结果回调（统计面写这里）。
   *
   * 为什么不在 hook 里直接写 stats：这个 hook 要能在无 stats 的环境下单测；
   * 而且统计口径属于"怎么数"的业务判断，不该混进宿主适配器。
   */
  afterOutcome?(input: PreStepInput, outcome: PreStepOutcome): void;
}

/** 取用户来源消息的正文，当检索查询串（只取第一条，长度有顶）。 */
function queryFrom(messages: readonly unknown[]): string {
  for (const raw of messages) {
    const record = raw as { source?: { kind?: unknown } };
    if (record.source?.kind !== 'user') continue;
    const text = textOfMessage(raw);
    if (text !== '') return text.slice(0, 240);
  }
  return '';
}

export function registerCardPreStep(ctx: Context, deps: PreStepHookDeps): void {
  const now = deps.now ?? Date.now;
  ctx.on('agent/pre-step', async (payload, next) => {
    // 先 next()：不劫持其它监听器的决定，也不丢它们的注入
    const decision = await next();
    try {
      if (decision.kind !== 'enter') return decision;
      if (payload.signal?.aborted === true) return decision; // 门 7
      const agent = payload.agent;
      const agentId = String(agent.id ?? '');
      const messages = decision.messages ?? [];
      const preStepInput: PreStepInput = {
        agentId,
        sessionId: deps.sessionIdOf(agent),
        workspaceId: deps.workspaceIdOf(agent),
        ownerId: deps.ownerOf(agent),
        isSubagent: deps.isSubagent(agent),
        newUserText: queryFrom(messages),
        messageCount: messages.length,
        // 每轮对一次表面：压缩不发事件的宿主线确实存在，只靠事件会永久静默
        surfaceNodes: readSurfaceNodes((agent as { session?: unknown }).session),
        now: now(),
      };
      const outcome = await deps.spirit.onPreStep(preStepInput);
      deps.afterOutcome?.(preStepInput, outcome);
      if (outcome.kind !== 'injected' || outcome.text === '') return decision;

      const card = createUserMessage({
        content: [{ type: 'text', text: outcome.text }],
        // v4 producer-owned kind + 宿主原生 snapshot 形态（后续快照取代先前）。
        // ⚠️ 不用 `form: 'slot'`：那不是 ContextForm 的合法值。
        source: {
          kind: SPIRIT_SOURCE_KIND as 'plugin:spirit',
          form: 'snapshot',
          sections: [{ name: SPIRIT_SLOT_SECTION_NAME, text: outcome.text }],
        },
      });
      // 两段式：等 card-observe 在会话日志里看到这一行，指纹才算"已发"
      deps.spirit.noteInjected(agentId, String(card.id ?? ''), outcome.fingerprint);
      // 卡追加在尾部；**不设 startsRequestSeries**（它会强制系统提示重新准入并打断请求系列）
      return { kind: 'enter', messages: [...messages, card] };
    } catch (err) {
      deps.logger.warn(`[spirit] pre-step 适配器异常，本轮原样透传：${err instanceof Error ? err.message : String(err)}`);
      return decision;
    }
  });
}
