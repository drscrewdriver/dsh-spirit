/**
 * 人格预设库（v0.7 / 对表 dsh-soul 的人格配置编译器）。
 * 正反成对：激活走 save() 写正式人设、内置不可删、作用域优先级、会话绑定回收。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { SPIRIT_DEFAULTS, SPIRIT_RPC_PREFIX } from '../src/contract.js';
import { PersonaStore } from '../src/persona/store.js';
import { PersonaPresetStore, PERSONA_PRESETS_FILE, SESSION_BINDING_GC_MS, PRESET_FILE_VERSION } from '../src/persona/presets.js';
import { handleEndpoint, type RpcDeps } from '../src/rpc.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-presets-'));
  dirs.push(dir);
  return dir;
}

function stores(): { dir: string; presets: PersonaPresetStore; personas: PersonaStore } {
  const dir = freshDir();
  // 文件路径模式（db 省缺）：与 PersonaStore 的降级路径同一条纪律
  const personas = new PersonaStore({ dataDir: dir, logger });
  const presets = new PersonaPresetStore({ dataDir: dir, logger });
  return { dir, presets, personas };
}

describe('PersonaPresetStore', () => {
  it('首次读种下 5 张内置预设；全是 builtin', () => {
    const { presets } = stores();
    const view = presets.view();
    expect(view.presets.length).toBe(5);
    expect(view.presets.every((p) => p.builtin)).toBe(true);
    expect(view.activeId).toBe('');
  });

  it('激活：markActive 记录 activeId（卡写入由调用方 personas.save 完成）', () => {
    const { presets } = stores();
    const got = presets.markActive('quiet');
    expect(got.ok).toBe(true);
    expect(presets.view().activeId).toBe('quiet');
    expect(presets.view().activeName).toBe('安静记录者');
    // 审计落了一行
    expect(presets.view().audit.some((a) => a.action === 'activate' && a.detail.includes('quiet'))).toBe(true);
  });

  it('自建预设：存 → 删；内置删不动（正反）', () => {
    const { presets, personas } = stores();
    const saved = presets.savePreset('我的卡', personas.current());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const id = saved.preset.id;
    expect(id).toMatch(/^user-\d+$/);
    expect(presets.deletePreset('quiet').ok, '内置保护').toBe(false);
    expect(presets.deletePreset(id).ok).toBe(true);
    expect(presets.view().presets.some((p) => p.id === id)).toBe(false);
  });

  it('作用域解析：session > workspace > active > current', () => {
    const { presets, personas } = stores();
    const current = personas.current();
    expect(presets.resolve({ workspaceId: 'ws1', sessionId: 's1', current }).source).toBe('current');
    presets.markActive('plain');
    expect(presets.resolve({ workspaceId: 'ws1', current }).source).toBe('active');
    expect(presets.bind({ scope: 'workspace', workspaceId: 'ws1', presetId: 'blunt' }).ok).toBe(true);
    const byWs = presets.resolve({ workspaceId: 'ws1', current });
    expect(byWs.source).toBe('workspace');
    expect(byWs.presetName).toBe('直白工程师');
    expect(presets.bind({ scope: 'session', sessionId: 's1', presetId: 'lively' }).ok).toBe(true);
    const bySession = presets.resolve({ workspaceId: 'ws1', sessionId: 's1', current });
    expect(bySession.source).toBe('session');
    expect(bySession.presetName).toBe('俏皮同伴');
  });

  it('会话绑定 30 天回收（view 顺手清理）；解绑回上一级', () => {
    const { dir, presets, personas } = stores();
    presets.bind({ scope: 'session', sessionId: 's-old', presetId: 'quiet' });
    // 手改文件把 at 拨老，模拟过期现场（envelope = {version, data}）
    const filePath = join(dir, PERSONA_PRESETS_FILE);
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { version: number; data: { sessions: Record<string, { presetId: string; at: number }> } };
    raw.data.sessions['s-old']!.at = Date.now() - SESSION_BINDING_GC_MS - 1000;
    writeFileSync(filePath, JSON.stringify({ version: PRESET_FILE_VERSION, data: raw.data }), 'utf8');
    expect(presets.view().sessions.some((s) => s.sessionId === 's-old'), '过期绑定已被回收').toBe(false);

    presets.bind({ scope: 'session', sessionId: 's1', presetId: 'quiet' });
    presets.bind({ scope: 'session', sessionId: 's1', presetId: null });
    expect(presets.resolve({ sessionId: 's1', current: personas.current() }).source).toBe('current');
  });
});

describe('预设 RPC 面', () => {
  function depsFor(): { deps: RpcDeps; presets: PersonaPresetStore; personas: PersonaStore } {
    const { presets, personas } = stores();
    const deps = {
      personas,
      presets,
      logger,
      dataDir: freshDir(),
      cfg: () => SPIRIT_DEFAULTS,
      eff: () => SPIRIT_DEFAULTS,
    } as unknown as RpcDeps;
    return { deps, presets, personas };
  }

  it('未装配预设库 ⇒ unavailable', async () => {
    const bare = { logger } as unknown as RpcDeps;
    const result = await handleEndpoint(`${SPIRIT_RPC_PREFIX}persona-presets`, {}, bare);
    expect(result.ok).toBe(false);
  });

  it('presets / activate / save / bind / effective 一路走通', async () => {
    const { deps, personas } = depsFor();
    const list = await handleEndpoint(`${SPIRIT_RPC_PREFIX}persona-presets`, {}, deps);
    expect(list.ok).toBe(true);

    const act = await handleEndpoint(`${SPIRIT_RPC_PREFIX}persona-activate`, { presetId: 'blunt' }, deps);
    expect(act.ok).toBe(true);
    if (act.ok) {
      const view = act.value as { ok: boolean; persona?: { name: string } };
      expect(view.ok).toBe(true);
      expect(view.persona?.name).toBe('直白工程师');
    }
    // 激活真的写进了正式人设（save 唯一写路径）：revision 推进 + 名字变了
    expect(personas.current().name).toBe('直白工程师');
    expect(personas.current().revision).toBeGreaterThan(1);

    const saved = await handleEndpoint(`${SPIRIT_RPC_PREFIX}persona-preset-save`, { name: '自建一' }, deps);
    expect(saved.ok).toBe(true);

    const bound = await handleEndpoint(`${SPIRIT_RPC_PREFIX}persona-bind`, { scope: 'session', sessionId: 's9', presetId: 'quiet' }, deps);
    expect(bound.ok).toBe(true);

    const eff = await handleEndpoint(`${SPIRIT_RPC_PREFIX}persona-effective`, { sessionId: 's9' }, deps);
    expect(eff.ok).toBe(true);
    if (eff.ok) {
      const v = eff.value as { source: string; presetName?: string; projectedText: string };
      expect(v.source).toBe('session');
      expect(v.presetName).toBe('安静记录者');
      expect(v.projectedText.length).toBeGreaterThan(0);
    }
  });

  it('删内置预设 ⇒ bad-request', async () => {
    const { deps } = depsFor();
    const result = await handleEndpoint(`${SPIRIT_RPC_PREFIX}persona-preset-delete`, { presetId: 'quiet' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('bad-request');
  });
});
