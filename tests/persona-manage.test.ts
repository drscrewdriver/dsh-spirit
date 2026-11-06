/**
 * 人设管理面门禁（store 历史读取 + 四个端点）。
 *
 * 守的是三条会真丢东西的行为：
 * 1. 预览**绝不写盘**（面板每次改字都会调它）；
 * 2. `expectedRevision` 不匹配必须拒写（静默覆盖别人改过的人设最难查）；
 * 3. 回退是追加新 revision，历史文件只增不改。
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SPIRIT_DEFAULTS, SPIRIT_RPC_PREFIX } from '../src/contract.js';
import { PersonaStore, PERSONA_FILE, PERSONA_HISTORY_FILE, PERSONA_MARKDOWN_FILE } from '../src/persona/store.js';
import { parsePersonaMarkdown } from '../src/persona/markdown.js';
import { handleEndpoint, type RpcDeps } from '../src/rpc.js';

const logger = { info: () => {}, warn: () => {} };

let dir = '';

function makeDeps(personas: PersonaStore): RpcDeps {
  return {
    spirit: {},
    stats: { latest: () => null, snapshot: () => null, agentOfSession: () => undefined },
    store: null,
    modes: { isOff: () => false, isBypass: () => false },
    personas,
    dataDir: dir,
    cfg: () => SPIRIT_DEFAULTS,
    drscVerdict: () => 'skipped' as const,
    logger,
  } as unknown as RpcDeps;
}

function call(deps: RpcDeps, op: string, payload: Record<string, unknown> = {}): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
  return handleEndpoint(`${SPIRIT_RPC_PREFIX}${op}`, payload, deps) as Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-persona-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PersonaStore.history / findRevision', () => {
  it('没有历史文件时退空列表（不是故障）', () => {
    const store = new PersonaStore({ dataDir: dir, logger });
    expect(store.history(10)).toEqual([]);
    expect(store.findRevision(1)).toBeUndefined();
  });

  it('save 三次后历史倒序可读，且能按 revision 找回', () => {
    const store = new PersonaStore({ dataDir: dir, logger });
    for (const name of ['A', 'B', 'C']) {
      const saved = store.save({ ...store.current(), name });
      expect(saved.ok).toBe(true);
    }
    const history = store.history(10);
    // 三条：初次的内置默认卡（rev1）与 A(rev2)——save 先把“当时生效的那张”追加进历史
    expect(history.map((card) => card.name)).toEqual(['B', 'A', '未命名角色']);
    expect(history[0]!.revision).toBeGreaterThan(history[1]!.revision);
    expect(store.findRevision(1)?.name).toBe('未命名角色');
    expect(store.current().name).toBe('C');
  });

  it('坏行跳过（半行 JSON 不能让整本历史读不出来）', () => {
    writeFileSync(join(dir, PERSONA_HISTORY_FILE), '{"name":"broken"\n{"id":"d","revision":7,"name":"好卡","voice":"plain","salience":{},"focus":[]}\n', 'utf8');
    const store = new PersonaStore({ dataDir: dir, logger });
    const history = store.history(10);
    expect(history).toHaveLength(1);
    expect(history[0]!.name).toBe('好卡');
  });
});

describe('persona-preview / set / history / restore 端点', () => {
  it('preview 不写盘，且给出的就是将要注入的原文', async () => {
    const personas = new PersonaStore({ dataDir: dir, logger });
    personas.save({ ...personas.current(), name: '初版' });
    const before = statSync(join(dir, PERSONA_FILE)).mtimeMs;
    const result = await call(makeDeps(personas), 'persona-preview', { patch: { name: '预览版' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.value as { projectedText: string; bytes: number; overBudget: boolean };
    expect(view.projectedText).toContain('预览版');
    expect(view.bytes).toBe(Buffer.byteLength(view.projectedText, 'utf8'));
    expect(statSync(join(dir, PERSONA_FILE)).mtimeMs).toBe(before);
    expect(personas.current().name).toBe('初版');
  });

  it('expectedRevision 不匹配时拒写且文件不动', async () => {
    const personas = new PersonaStore({ dataDir: dir, logger });
    const deps = makeDeps(personas);
    const rejected = await call(deps, 'persona-set', { expectedRevision: 99, patch: { name: '不该写进去' } });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error?.code).toBe('conflict');
    expect(personas.current().name).not.toBe('不该写进去');
  });

  it('set 成功后 revision +1、旧版进历史', async () => {
    const personas = new PersonaStore({ dataDir: dir, logger });
    const deps = makeDeps(personas);
    const current = personas.current();
    const saved = await call(deps, 'persona-set', { expectedRevision: current.revision, patch: { name: '改名' } });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const view = saved.value as { revision: number; name: string; projectedText: string };
    expect(view.revision).toBe(current.revision + 1);
    expect(view.name).toBe('改名');
    expect(view.projectedText).toContain('改名');
    const hist = await call(deps, 'persona-history', {});
    expect(hist.ok).toBe(true);
    if (!hist.ok) return;
    const page = hist.value as { current: number; items: Array<{ revision: number; name: string }> };
    expect(page.current).toBe(current.revision + 1);
    expect(page.items[0]?.name).toBe(current.name);
  });

  it('restore 以新 revision 落库，历史只增不改', async () => {
    const personas = new PersonaStore({ dataDir: dir, logger });
    const deps = makeDeps(personas);
    personas.save({ ...personas.current(), name: '第一版' });
    personas.save({ ...personas.current(), name: '第二版' });
    const historyBefore = readFileSync(join(dir, PERSONA_HISTORY_FILE), 'utf8');
    // rev1 = 内置默认卡，rev2 = 第一版（每次 save 先把当时生效的卡追加进历史）
    const restored = await call(deps, 'persona-restore', { revision: 2 });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const view = restored.value as { revision: number; name: string };
    expect(view.name).toBe('第一版');
    expect(view.revision).toBeGreaterThan(3);
    const historyAfter = readFileSync(join(dir, PERSONA_HISTORY_FILE), 'utf8');
    expect(historyAfter.startsWith(historyBefore)).toBe(true);
  });

  it('restore 不存在的 revision 报 not-found，不写盘', async () => {
    const personas = new PersonaStore({ dataDir: dir, logger });
    // 先落一次盘：persona.json 不存在时 readFileSync 会直接抛，测不到“未写盘”这条
    personas.save({ ...personas.current(), name: '基线' });
    const before = readFileSync(join(dir, PERSONA_FILE), 'utf8');
    const result = await call(makeDeps(personas), 'persona-restore', { revision: 4242 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not-found');
    expect(readFileSync(join(dir, PERSONA_FILE), 'utf8')).toBe(before);
  });

  it('patch 里的 id / revision 被忽略（写面不接受外部推进 revision）', async () => {
    const personas = new PersonaStore({ dataDir: dir, logger });
    const deps = makeDeps(personas);
    const current = personas.current();
    const saved = await call(deps, 'persona-set', {
      expectedRevision: current.revision,
      patch: { name: '白名单', id: 'evil', revision: 9_999 },
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const view = saved.value as { id: string; revision: number };
    expect(view.id).toBe(current.id);
    expect(view.revision).toBe(current.revision + 1);
  });
});

describe('persona-export-md / persona-import-md', () => {
  it('export 返回可读文本（含当前名字）且 parse 得回来', async () => {
    const personas = new PersonaStore({ dataDir: dir, logger });
    personas.save({ ...personas.current(), name: '备份导出鱼' });
    const result = await call(makeDeps(personas), 'persona-export-md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { text: string; revision: number };
    expect(value.revision).toBe(personas.current().revision);
    expect(value.text).toContain('备份导出鱼');
    const parsed = parsePersonaMarkdown(value.text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.persona.name).toBe('备份导出鱼');
  });

  it('import 好文本 ⇒ 新 revision 生效、旧版进历史、persona.md 重生成', async () => {
    const personas = new PersonaStore({ dataDir: dir, logger });
    const before = personas.current().revision;
    const exported = await call(makeDeps(personas), 'persona-export-md');
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const text = (exported.value as { text: string }).text.replace('## 名字\n未命名角色', '## 名字\n恢复回来的鱼');
    const imported = await call(makeDeps(personas), 'persona-import-md', { text });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect((imported.value as { revision: number }).revision).toBe(before + 1);
    expect(personas.current().name).toBe('恢复回来的鱼');
    // 历史只增：旧版（未命名角色）可找回
    expect(personas.findRevision(before)?.name).toBe('未命名角色');
    // md 备份与当前卡同步重生
    expect(readFileSync(join(dir, PERSONA_MARKDOWN_FILE), 'utf8')).toContain('恢复回来的鱼');
  });

  it('import 坏文本 ⇒ bad-request 且**未写盘**（半恢复比不恢复危险）', async () => {
    const personas = new PersonaStore({ dataDir: dir, logger });
    personas.save({ ...personas.current(), name: '基线' });
    const before = readFileSync(join(dir, PERSONA_FILE), 'utf8');
    const empty = await call(makeDeps(personas), 'persona-import-md', { text: '' });
    expect(empty.ok).toBe(false);
    expect(empty.error?.code).toBe('bad-request');
    const garbage = await call(makeDeps(personas), 'persona-import-md', { text: '# 随便写的\n不是备份' });
    expect(garbage.ok).toBe(false);
    expect(garbage.error?.code).toBe('bad-request');
    expect(readFileSync(join(dir, PERSONA_FILE), 'utf8')).toBe(before);
  });
});
