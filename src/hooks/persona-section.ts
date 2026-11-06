/**
 * 人格区注册：`systemPrompt.section`（**不是 `context()`**）。
 *
 * 这条纠偏是实测得来的、也是本插件最容易写错的一处：`systemPrompt.context()` 的文本
 * **不进系统提示**，它进 runtime-context 的尾部快照消息（宿主会把多个 provider 合成一条）。
 * 把人格写在 `context()` 里，会得到"人格每轮跟着变、还连带重发别人的 sandbox/approval 文本"，
 * 而看起来两者都"生效了"。
 *
 * 另外两条：
 * - **disposer 必须挂插件 fiber**：`agent.ctx` 比插件实例活得久，不主动清理会在热重载后
 *   撞名（`already registered`），实测是姊妹包的事故位。
 * - **以 revision 为缓存键**：文本没变就别让宿主重算系统提示——node 0 一变整个请求前缀全 miss。
 *   `section` 不可用时停用本层并说出来，**不退到 `context()`**：那是换了个语义凑数。
 */

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent'; // agent/created 事件名声明

import { SPIRIT_SECTION_NAME, SPIRIT_SECTION_ORDER, type SpiritConfig } from '../contract.js';
import type { PersonaStore } from '../persona/store.js';
import { composeOwnerText, composePersonaText } from '../persona/render.js';
import type { OwnerProfileStore } from '../store/owner.js';
import { getService, type HostCapabilities } from '../capability.js';

export interface PersonaSectionDeps {
  personas: PersonaStore;
  /**
   * 主人背景档案（v0.3.2）：同一稳定区内拼 persona 文本 + 主人段（各用各预算键）。
   * 省略 ⇒ 只拼人格区（老宿主/测试代理的形态）。
   */
  owner?: OwnerProfileStore;
  /**
   * ⚠️ 必须是**已合并 live 兜底的生效配置**（`effectiveCfg(config, readLiveRef(config.live))`），
   * 不是原始 `config`。
   *
   * 真宿主 0.2.0-rc.2 实测：原始 `config.live` 是个 VolatileRef，`config.live.personaEnabled`
   * 永远 `undefined` ⇒ 人格区被判空。而它外在表现就是“那个开关没开”，一点不像 bug：
   * 系统提示里没我们的人格区、卡却照常注入（卡走的是 `eff()` 解析后的视图）。
   * 所以这里宁可不把 `cfg` 递进来，只递已解析的 `eff`。
   */
  eff: () => SpiritConfig;
  caps: HostCapabilities;
  logger: { warn(message: string): void; info(message: string): void };
}

export function registerPersonaSection(ctx: Context, deps: PersonaSectionDeps): void {
  if (!deps.caps.systemPromptSection) {
    deps.logger.warn('[spirit] 宿主无 systemPrompt.section，人格区停用（回忆卡不受影响）');
    return;
  }
  const registered = new WeakSet<object>();
  const disposers: Array<() => void> = [];

  const registerForAgent = (agent: unknown): void => {
    if (typeof agent !== 'object' || agent === null || registered.has(agent)) return;
    registered.add(agent);
    const agentCtx = (agent as { ctx?: { systemPrompt?: { section?: unknown } } }).ctx;
    if (typeof agentCtx?.systemPrompt?.section !== 'function') return;
    // 缓存键 = 人格 revision + 档案 revision + 同步时刻：三者都没动字节才准复用——
    // 只看 persona.revision 会把"后台同步更新了主人段"当成没变化，新段永远进不了提示。
    let cacheKey = '';
    let cacheText = '';
    const text = (): string => {
      const cfg = deps.eff();
      if (!cfg.enabled || !cfg.persona.enabled || !cfg.live.personaEnabled) return '';
      const persona = deps.personas.current();
      const ownerRow = deps.owner?.get();
      const key = `${persona.revision}:${ownerRow?.revision ?? 0}:${ownerRow?.syncMeta.syncedAt ?? 0}`;
      if (cacheKey === key && cacheText !== '') return cacheText;
      const personaText = composePersonaText(persona, cfg.persona.budgetBytes);
      const ownerText = ownerRow === undefined ? '' : composeOwnerText(ownerRow, cfg.owner.budgetBytes);
      cacheText = [personaText, ownerText].filter((part) => part !== '').join('\n');
      cacheKey = key;
      return cacheText;
    };
    try {
      const dispose = (agentCtx.systemPrompt as { section: (arg: unknown) => unknown }).section({
        name: SPIRIT_SECTION_NAME,
        order: SPIRIT_SECTION_ORDER,
        text,
      });
      if (typeof dispose === 'function') disposers.push(dispose as () => void);
    } catch (err) {
      deps.logger.warn(`[spirit] 人格区注册失败（回忆卡不受影响）：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const agents = getService(ctx, 'agents') as { list?: () => readonly unknown[] } | undefined;
  if (typeof agents?.list === 'function') {
    for (const agent of agents.list()) registerForAgent(agent);
  }
  ctx.on('agent/created', (payload) => {
    registerForAgent(payload.agent);
    // 宿主签名要求 handler 返回 Promise<undefined> | undefined：直接吐 undefined，
    // 写成"无返回值的箭头块"会在类型层报 void 不可赋值（看着不相关，实际是这个形状）。
    return undefined;
  });

  // disposer 挂插件 fiber：热重载后不留旧注册
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* 宿主已销毁 */
      }
    }
  });
}
