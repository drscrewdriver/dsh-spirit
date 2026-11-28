/**
 * v0.13.7 放出闸四臂：on / off / bypass / subagent。
 *
 * 这四条是**同一根因**的四个面：v0.13.6 实测 103 个 off 会话里 97 个仍带完整人格块，
 * 17 个子代理会话 17 个都带——因为人格区只读 `live.personaEnabled`，不看会话档位。
 * 所以每个臂都必须断言 `text() === ''`（空串 = 物理离场，宿主不会拼进系统提示）。
 */

import { describe, expect, it } from 'vitest';

import { registerPersonaSection, type PersonaSectionDeps } from '../src/hooks/persona-section.js';
import { PersonaStore } from '../src/persona/store.js';
import { effectiveCfg, readLiveRef } from '../src/config.js';
import { SPIRIT_DEFAULTS, type SpiritConfig } from '../src/contract.js';
import type { HostCapabilities } from '../src/capability.js';

const logger = { info: (): void => undefined, warn: (): void => undefined };

/** 装一个只声明 section 的假 agent，返回宿主真叫到时拿到的文本。 */
function textThroughHook(options: {
  agent?: Record<string, unknown>;
  modes?: PersonaSectionDeps['modes'];
  isSubagent?: PersonaSectionDeps['isSubagent'];
}): string {
  const handlers: Record<string, (payload: unknown) => undefined> = {};
  const ctx = {
    on: (name: string, handler: (payload: unknown) => undefined) => {
      handlers[name] = handler;
    },
    effect: () => undefined,
  } as unknown as Parameters<typeof registerPersonaSection>[0];
  let captured: (() => string) | undefined;
  const deps: PersonaSectionDeps = {
    personas: new PersonaStore({ dataDir: '', logger }),
    eff: () => effectiveCfg({ ...SPIRIT_DEFAULTS } as SpiritConfig, readLiveRef({ get: () => ({ ...SPIRIT_DEFAULTS.live }) })),
    caps: { systemPromptSection: true } as HostCapabilities,
    logger,
  };
  if (options.modes !== undefined) deps.modes = options.modes;
  if (options.isSubagent !== undefined) deps.isSubagent = options.isSubagent;
  registerPersonaSection(ctx, deps);
  handlers['agent/created']?.({
    agent: {
      ...(options.agent ?? {}),
      ctx: {
        systemPrompt: {
          section: (def: { text: () => string }) => {
            captured = def.text;
            return () => undefined;
          },
        },
      },
    },
  });
  return captured?.() ?? '';
}

/** 只对某个 sessionId 报 true 的假档位表（其余跟随全局=不关）。 */
function modesFor(offIds: string[], bypassIds: string[] = []): PersonaSectionDeps['modes'] {
  return {
    isOff: (sessionId: string) => offIds.includes(sessionId),
    isBypass: (sessionId: string) => !offIds.includes(sessionId) && bypassIds.includes(sessionId),
  };
}

describe('人格区放出闸（v0.13.7 四臂）', () => {
  it('臂 1 / on：无人关闸 ⇒ 人格块照常在场（门没把正常路径误杀）', () => {
    const text = textThroughHook({ agent: { session: { id: 's-on' } }, modes: modesFor([]), isSubagent: () => false });
    expect(text).toContain('[角色]');
    expect(text).toContain('[语气]');
  });

  it('臂 2 / off：会话 off ⇒ text() === \'\'（物理离场）', () => {
    expect(textThroughHook({ agent: { session: { id: 's-off' } }, modes: modesFor(['s-off']), isSubagent: () => false })).toBe('');
  });

  it('臂 3 / bypass：会话旁路 ⇒ text() === \'\'（留数据、断出口）', () => {
    expect(textThroughHook({ agent: { session: { id: 's-bypass' } }, modes: modesFor([], ['s-bypass']), isSubagent: () => false })).toBe('');
  });

  it('臂 4 / subagent：子代理 ⇒ text() === \'\'（人格不传染）', () => {
    expect(textThroughHook({ agent: { session: { id: 's-sub' }, origin: 'subagent' }, modes: modesFor([]), isSubagent: (agent) => (agent as { origin?: string }).origin === 'subagent' })).toBe('');
  });

  it('子代理会话的 off 档沿 ownerSessionIdOfAgent 上溯到父会话生效', () => {
    const child = { session: { id: 's-child', header: { parentSession: 's-parent' } } };
    // 只关父会话：子会话自己无条目，也必须离场
    expect(textThroughHook({ agent: child, modes: modesFor(['s-parent']), isSubagent: () => false })).toBe('');
    // 反向对照：只关子会话 id ⇒ 上溯到父后父未关 ⇒ 照常在场（证明上溯用的是父 id，不是自身 id）
    expect(textThroughHook({ agent: child, modes: modesFor(['s-child']), isSubagent: () => false })).toContain('[角色]');
  });

  it('关闸后恢复（off→on）人格块立即回来，且不靠缓存旧文本', () => {
    const handlers: Record<string, (payload: unknown) => undefined> = {};
    const ctx = {
      on: (name: string, handler: (payload: unknown) => undefined) => {
        handlers[name] = handler;
      },
      effect: () => undefined,
    } as unknown as Parameters<typeof registerPersonaSection>[0];
    let captured: (() => string) | undefined;
    let off = true;
    registerPersonaSection(ctx, {
      personas: new PersonaStore({ dataDir: '', logger }),
      eff: () => effectiveCfg({ ...SPIRIT_DEFAULTS } as SpiritConfig, readLiveRef({ get: () => ({ ...SPIRIT_DEFAULTS.live }) })),
      caps: { systemPromptSection: true } as HostCapabilities,
      logger,
      modes: { isOff: () => off, isBypass: () => false },
      isSubagent: () => false,
    });
    handlers['agent/created']?.({
      agent: {
        session: { id: 's-live' },
        ctx: {
          systemPrompt: {
            section: (def: { text: () => string }) => {
              captured = def.text;
              return () => undefined;
            },
          },
        },
      },
    });
    expect(captured?.() ?? '').toBe('');
    off = false;
    expect(captured?.() ?? '').toContain('[角色]');
  });

  it('省略 modes/isSubagent ⇒ 门集退化但不抛（老宿主与测试代理形态）', () => {
    expect(textThroughHook({ agent: { session: { id: 's-legacy' } } })).toContain('[角色]');
  });
});
