/**
 * 蒸馏 LLM 通道（v0.3.5 长觉阶梯）：宿主 llm 服务的窄封装 + fail-closed 路由。
 *
 * 两条命门（都是姊妹包用事故换来的纪律，直接继承）：
 * 1. **绝不隐式改选模型**。distill.provider/model 显式配了就用；留空 ⇒ 取宿主默认模型
 *    （agentDefaultModel 服务，宽容读）；两者都拿不到 ⇒ `NoDistillRouteError` 拒蒸。
 *    配错悄悄退到"随便一个模型"是账单事故 + 隐私事故 + 可解释性事故，三重不可接受（G13 实闸）。
 * 2. **配置类错误不进退避**：NoDistillRouteError 是"没接线"，不是"模型慢"——
 *    对它退避重试等于把配置问题伪装成网络问题（调用方按 reason 分类，本文件不掺策略）。
 *
 * 流消费形状照 prime llm.ts 实战版：文本以 block-end 为准、text-delta 仅兜底，
 * finish=error/aborted 抛错，空输出抛错（流正常结束但一个字没吐是最难排查的失败）。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import type { MinimalLogger } from '../persona/store.js';

/** 配置类失败：路由解析不出可用模型（与瞬态故障分开分类，供退避策略豁免）。 */
export class NoDistillRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoDistillRouteError';
  }
}

export interface DistillRoute {
  provider: string;
  model: string;
}

/** 宿主 llm 服务的面（只声明本通道真正用到的部分，不绑全类型）。 */
export interface LlmRuntimeLike {
  stream(params: {
    provider: string;
    model: string;
    system: string;
    messages: readonly unknown[];
    temperature?: number;
    maxTokens?: number;
    reasoningEffort?: string;
    signal?: AbortSignal;
  }): AsyncIterable<Record<string, unknown>>;
}

export interface LlmChannelDeps {
  llm: () => LlmRuntimeLike | undefined;
  /** 宿主默认模型（agentDefaultModel 服务的宽容读结果；拿不到给 undefined，不许抛）。 */
  defaultModel: () => DistillRoute | undefined;
  logger: MinimalLogger;
}

export interface DistillCallOptions {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface DistillCallResult {
  text: string;
  route: DistillRoute;
  outputTokens: number;
}

/**
 * 路由解析（fail-closed）：显式配置 > 宿主默认 > 无路可走抛 NoDistillRouteError。
 * 半配（只有 provider 没有 model）按"配错"处理同样拒——隐式补一半也是改选。
 */
export function resolveDistillRoute(cfg: { provider: string; model: string }, deps: LlmChannelDeps): DistillRoute {
  const provider = cfg.provider.trim();
  const model = cfg.model.trim();
  if (provider !== '' && model !== '') return { provider, model };
  if (provider !== '' || model !== '') {
    throw new NoDistillRouteError('distill.provider 与 distill.model 必须成对配置（半配按配错拒绝，不隐式补另一半）');
  }
  const hostDefault = deps.defaultModel();
  if (hostDefault === undefined || hostDefault.provider === '' || hostDefault.model === '') {
    throw new NoDistillRouteError('未配置 distill 模型且宿主默认模型不可解析：请显式配置或保持长觉关闭（不隐式改选）');
  }
  return hostDefault;
}

/** 一次蒸馏调用的通道（可注入测试假实现：同签名即可）。 */
export interface LlmChannel {
  complete(opts: DistillCallOptions & { route: DistillRoute; reasoningEffort?: string }): Promise<DistillCallResult>;
}

export function createLlmChannel(deps: LlmChannelDeps): LlmChannel {
  return {
    async complete(opts) {
      const llm = deps.llm();
      if (llm === undefined || typeof llm.stream !== 'function') {
        // 服务缺席走同一错误类：长觉整段休眠的语义（supported:false）由调用方按此分类
        throw new NoDistillRouteError('宿主 llm 服务不可用');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      const outerSignal = opts.signal;
      const onOuterAbort = () => controller.abort();
      if (outerSignal !== undefined) {
        if (outerSignal.aborted) controller.abort();
        else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
      }
      let blockText = '';
      let deltaText = '';
      let outputTokens = 0;
      let finishKind = '';
      try {
        const stream = llm.stream({
          provider: opts.route.provider,
          model: opts.route.model,
          system: opts.system,
          messages: [createUserMessage({ content: [{ type: 'text', text: opts.user }], source: { kind: 'user' } })],
          temperature: 0.2,
          maxTokens: opts.maxTokens,
          ...(opts.reasoningEffort !== undefined && opts.reasoningEffort !== '' ? { reasoningEffort: opts.reasoningEffort } : {}),
          signal: controller.signal,
        });
        for await (const chunk of stream) {
          const type = chunk['type'];
          if (type === 'text-delta') deltaText += String(chunk['text'] ?? '');
          else if (type === 'block-end') {
            const block = chunk['block'] as { type?: unknown; text?: unknown } | undefined;
            if (block?.type === 'text') blockText += String(block.text ?? '');
          } else if (type === 'usage') {
            const usage = chunk['usage'] as { outputTokens?: unknown } | undefined;
            if (typeof usage?.outputTokens === 'number') outputTokens = usage.outputTokens;
          } else if (type === 'finish') {
            const reason = chunk['reason'] as { kind?: unknown; failure?: { message?: unknown } } | undefined;
            finishKind = String(reason?.kind ?? '');
            if (finishKind === 'error' || finishKind === 'aborted') {
              throw new Error(`llm ${finishKind}: ${String(reason?.failure?.message ?? 'unknown failure')}`);
            }
          }
        }
      } finally {
        clearTimeout(timer);
        if (outerSignal !== undefined) outerSignal.removeEventListener('abort', onOuterAbort);
      }
      const text = (blockText !== '' ? blockText : deltaText).trim();
      if (text === '') {
        deps.logger.warn(`[spirit] 蒸馏空输出（finish=${finishKind || '无 finish 块'}，tokens=${outputTokens}）`);
        throw new Error('llm 空输出（流正常结束但一个字没吐）');
      }
      return { text, route: opts.route, outputTokens };
    },
  };
}
