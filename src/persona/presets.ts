/**
 * 人格预设库（v0.7 对表 dsh-soul 的人格配置编译器）。
 *
 * 分工（三条不变式，和 PersonaStore 的纪律对齐）：
 * 1. **激活 = 把预设卡写进正式人设**：走 PersonaStore.save()（revision 推进 / 历史留档 / md 重生），
 *    本库只记 activeId。绝不另起一套"当前卡"——两套真源必然分叉。
 * 2. **作用域覆盖是只读投影**：工作区/会话绑定到某预设时，读取侧取该预设卡（不改 persona.json），
 *    优先级 session > workspace > active（全局）。写面永远只有 persona-set 一条路。
 * 3. **内置预设不可删**：builtin 是出厂语言，用户改自建即可；删除=从库里摘掉（不影响已激活卡）。
 *
 * 存储：persona-presets.json（enveloped，原子写 + 文件锁）；审计 append 到 persona-audit.jsonl。
 * 会话绑定 30 天回收（照 dsh-soul 的 sidecar 纪律），工作区绑定长期有效。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PersonaCard } from '../types.js';
import { DEFAULT_PERSONA, sanitizePersona } from './types.js';
import { appendLine, readJsonTolerant, withFileLock, writeEnvelopedJson } from '../store/json-file.js';

export const PERSONA_PRESETS_FILE = 'persona-presets.json';
export const PERSONA_AUDIT_FILE = 'persona-audit.jsonl';
export const PRESET_FILE_VERSION = 1;
/** 会话绑定的回收期（与 dsh-soul 的 30 天宽限同口径）。 */
export const SESSION_BINDING_GC_MS = 30 * 24 * 60 * 60 * 1_000;
/** 面板回显的审计条数上限。 */
const AUDIT_MAX = 20;

export interface PersonaPreset {
  id: string;
  name: string;
  builtin: boolean;
  card: PersonaCard;
  savedAt: number;
}

export interface PersonaPresetFile {
  activeId: string;
  presets: PersonaPreset[];
  /** workspaceId → presetId（长期）。 */
  workspaces: Record<string, string>;
  /** sessionId → 临时覆盖（30 天回收）。 */
  sessions: Record<string, { presetId: string; at: number }>;
}

export interface PersonaAuditRow {
  at: number;
  action: 'activate' | 'preset-save' | 'preset-delete' | 'bind' | 'unbind';
  detail: string;
}

export interface PersonaPresetRow {
  id: string;
  name: string;
  builtin: boolean;
  revision: number;
}

export interface PersonaResolved {
  card: PersonaCard;
  source: 'session' | 'workspace' | 'active' | 'current';
  presetId?: string;
  presetName?: string;
}

export interface PersonaPresetsView {
  activeId: string;
  activeName: string;
  presets: PersonaPresetRow[];
  workspaces: Record<string, string>;
  sessions: Array<{ sessionId: string; presetId: string; at: number }>;
  audit: PersonaAuditRow[];
}

/** 内置预设的卡片构造：默认卡 + 逐项覆盖（内置即"出厂语气/关注面"，不是空卡；卡本体的 name 必须跟预设同名）。 */
function builtin(id: string, name: string, patch: Partial<PersonaCard>): PersonaPreset {
  return {
    id,
    name,
    builtin: true,
    savedAt: 0,
    card: { ...structuredClone(DEFAULT_PERSONA), id: `preset-${id}`, name, ...patch },
  };
}

const BUILTINS: PersonaPreset[] = [
  builtin('quiet', '安静记录者', {
    voice: 'hush',
    values: ['安静做事', '少说空话', '把事情记清楚'],
    boundaries: ['不替主人拿主意', '不编造没做的事'],
  }),
  builtin('plain', '如实记事', {
    voice: 'plain',
    values: ['如实记录', '有摩擦才开口'],
    boundaries: ['不夸大', '不隐瞒失误'],
  }),
  builtin('blunt', '直白工程师', {
    voice: 'blunt',
    values: ['先验证再说', '结论向前'],
    boundaries: ['不绕过验证', '不将就'],
  }),
  builtin('lively', '俏皮同伴', {
    voice: 'lively',
    values: ['轻松不失分寸', '记得住小事'],
    boundaries: ['不在正事上开玩笑'],
  }),
  builtin('poetic', '诗意守夜人', {
    voice: 'poetic',
    values: ['慢一点', '把细节看仔细'],
    boundaries: ['不空谈感受'],
  }),
];

function freshFile(): PersonaPresetFile {
  return { activeId: '', presets: BUILTINS.map((p) => structuredClone(p)), workspaces: {}, sessions: {} };
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 宽容读取：坏字段逐项退回内置，不整库作废（读侧宽容、写侧严格同 PersonaStore）。 */
function sanitizeFile(raw: unknown): PersonaPresetFile {
  const base = freshFile();
  if (typeof raw !== 'object' || raw === null) return base;
  const value = raw as Record<string, unknown>;
  const presets: PersonaPreset[] = [];
  const seen = new Set<string>();
  const rawPresets = Array.isArray(value['presets']) ? (value['presets'] as unknown[]) : [];
  for (const item of rawPresets) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const id = asText(row['id']).trim();
    const name = asText(row['name']).trim();
    if (id === '' || name === '' || seen.has(id)) continue;
    seen.add(id);
    presets.push({
      id,
      name: name.slice(0, 40),
      builtin: row['builtin'] === true,
      card: sanitizePersona(row['card']).persona,
      savedAt: Number.isFinite(Number(row['savedAt'])) ? Number(row['savedAt']) : 0,
    });
  }
  // 内置缺了就补回来（被手改删掉时出厂语言仍在）
  for (const b of BUILTINS) if (!seen.has(b.id)) presets.push(structuredClone(b));
  const workspaces: Record<string, string> = {};
  const rawWs = typeof value['workspaces'] === 'object' && value['workspaces'] !== null ? (value['workspaces'] as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(rawWs)) {
    const name = asText(k).trim();
    const presetId = asText(v).trim();
    if (name !== '' && presetId !== '') workspaces[name] = presetId;
  }
  const sessions: PersonaPresetFile['sessions'] = {};
  const rawSs = typeof value['sessions'] === 'object' && value['sessions'] !== null ? (value['sessions'] as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(rawSs)) {
    if (typeof v !== 'object' || v === null) continue;
    const row = v as Record<string, unknown>;
    const presetId = asText(row['presetId']).trim();
    const at = Number(row['at']);
    if (asText(k).trim() !== '' && presetId !== '' && Number.isFinite(at)) sessions[asText(k).trim()] = { presetId, at };
  }
  return { activeId: asText(value['activeId']).trim(), presets, workspaces, sessions };
}

export class PersonaPresetStore {
  constructor(private readonly deps: { dataDir: string; logger: { warn(message: string): void } }) {}

  private get filePath(): string {
    return join(this.deps.dataDir, PERSONA_PRESETS_FILE);
  }

  private readFile(): PersonaPresetFile {
    const result = readJsonTolerant<unknown>(this.filePath, PRESET_FILE_VERSION);
    if (!result.ok) {
      if (result.reason !== 'missing') this.deps.logger.warn(`[spirit] persona-presets.json 不可用（${result.reason}），本次退回内置预设`);
      return freshFile();
    }
    return sanitizeFile(result.value);
  }

  private writeFile(file: PersonaPresetFile): boolean {
    const done = withFileLock(this.deps.dataDir, 'persona-presets', () => {
      writeEnvelopedJson(this.filePath, PRESET_FILE_VERSION, file);
      return true;
    });
    return done === true;
  }

  private audit(action: PersonaAuditRow['action'], detail: string): void {
    try {
      appendLine(join(this.deps.dataDir, PERSONA_AUDIT_FILE), JSON.stringify({ at: Date.now(), action, detail } satisfies PersonaAuditRow));
    } catch {
      // 审计写失败不阻断操作：它只是可回看的旁证
    }
  }

  private readAudit(): PersonaAuditRow[] {
    try {
      const text = readFileSync(join(this.deps.dataDir, PERSONA_AUDIT_FILE), 'utf8');
      const lines = text.trimEnd().split('\n').reverse();
      const out: PersonaAuditRow[] = [];
      for (const line of lines) {
        if (out.length >= AUDIT_MAX) break;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          const action = asText(row['action']);
          if (action === '') continue;
          out.push({ at: Number(row['at']) || 0, action: action as PersonaAuditRow['action'], detail: asText(row['detail']) });
        } catch {
          /* 坏行跳过 */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** 预设库视图（面板用）。会顺手做会话绑定回收。 */
  view(now = Date.now()): PersonaPresetsView {
    const file = this.readFile();
    let dirty = false;
    for (const [sessionId, bind] of Object.entries(file.sessions)) {
      if (now - bind.at > SESSION_BINDING_GC_MS) {
        delete file.sessions[sessionId];
        dirty = true;
      }
    }
    if (dirty) this.writeFile(file);
    const active = file.presets.find((p) => p.id === file.activeId);
    return {
      activeId: file.activeId,
      activeName: active?.name ?? '',
      presets: file.presets.map((p) => ({ id: p.id, name: p.name, builtin: p.builtin, revision: p.card.revision })),
      workspaces: { ...file.workspaces },
      sessions: Object.entries(file.sessions).map(([sessionId, b]) => ({ sessionId, presetId: b.presetId, at: b.at })),
      audit: this.readAudit(),
    };
  }

  /** 取预设卡（激活/解析用）；不存在 ⇒ undefined。 */
  preset(id: string): PersonaPreset | undefined {
    return this.readFile().presets.find((p) => p.id === id);
  }

  /**
   * 激活：返回预设卡，**由调用方**走 PersonaStore.save() 写入（本层不动正式人设）。
   * @returns 失败原因（不存在/写库失败由调用方报）
   */
  markActive(id: string): { ok: true; preset: PersonaPreset } | { ok: false; reason: string } {
    const file = this.readFile();
    const preset = file.presets.find((p) => p.id === id);
    if (preset === undefined) return { ok: false, reason: `预设不存在：${id}` };
    file.activeId = id;
    if (!this.writeFile(file)) return { ok: false, reason: 'preset 文件被占用，本次未写入' };
    this.audit('activate', `${id}（${preset.name}）`);
    return { ok: true, preset };
  }

  /** 把一张卡存成预设（自建）。同名复用 id 不可行 ⇒ 用递增序号保唯一。 */
  savePreset(name: string, card: PersonaCard, now = Date.now()): { ok: true; preset: PersonaPreset } | { ok: false; reason: string } {
    const clean = name.trim().slice(0, 40);
    if (clean === '') return { ok: false, reason: '预设名不能为空' };
    const file = this.readFile();
    const taken = new Set(file.presets.map((p) => p.id));
    let n = 1;
    while (taken.has(`user-${n}`)) n += 1;
    const preset: PersonaPreset = { id: `user-${n}`, name: clean, builtin: false, card: { ...card }, savedAt: now };
    file.presets.push(preset);
    if (!this.writeFile(file)) return { ok: false, reason: 'preset 文件被占用，本次未写入' };
    this.audit('preset-save', `${preset.id}（${clean}）rev${card.revision}`);
    return { ok: true, preset };
  }

  /** 删除自建预设；内置保护。绑定了它的作用域一并摘掉（不留悬空指针）。 */
  deletePreset(id: string): { ok: true } | { ok: false; reason: string } {
    const file = this.readFile();
    const preset = file.presets.find((p) => p.id === id);
    if (preset === undefined) return { ok: false, reason: `预设不存在：${id}` };
    if (preset.builtin) return { ok: false, reason: '内置预设不可删除' };
    file.presets = file.presets.filter((p) => p.id !== id);
    if (file.activeId === id) file.activeId = '';
    for (const [ws, pid] of Object.entries(file.workspaces)) if (pid === id) delete file.workspaces[ws];
    for (const [s, b] of Object.entries(file.sessions)) if (b.presetId === id) delete file.sessions[s];
    if (!this.writeFile(file)) return { ok: false, reason: 'preset 文件被占用，本次未写入' };
    this.audit('preset-delete', id);
    return { ok: true };
  }

  /**
   * 绑定/解绑作用域。
   * `scope='workspace'` 时需要 workspaceId；`scope='session'` 时需要 sessionId。
   * presetId=null ⇒ 解绑（回到上一级）。
   */
  bind(input: { scope: 'workspace' | 'session'; workspaceId?: string; sessionId?: string; presetId: string | null }, now = Date.now()): { ok: true } | { ok: false; reason: string } {
    const file = this.readFile();
    const presetId = input.presetId;
    if (presetId !== null && !file.presets.some((p) => p.id === presetId)) return { ok: false, reason: `预设不存在：${presetId}` };
    if (input.scope === 'workspace') {
      const ws = (input.workspaceId ?? '').trim();
      if (ws === '') return { ok: false, reason: 'workspace 绑定缺 workspaceId' };
      if (presetId === null) delete file.workspaces[ws];
      else file.workspaces[ws] = presetId;
    } else {
      const sid = (input.sessionId ?? '').trim();
      if (sid === '') return { ok: false, reason: 'session 绑定缺 sessionId' };
      if (presetId === null) delete file.sessions[sid];
      else file.sessions[sid] = { presetId, at: now };
    }
    if (!this.writeFile(file)) return { ok: false, reason: 'preset 文件被占用，本次未写入' };
    this.audit(presetId === null ? 'unbind' : 'bind', `${input.scope}:${(input.scope === 'workspace' ? input.workspaceId : input.sessionId) ?? ''} → ${presetId ?? '（解绑）'}`);
    return { ok: true };
  }

  /**
   * 解析某作用域的生效卡：session 覆盖 > workspace 绑定 > 激活预设 > 传入的当前卡。
   * 覆盖层只读（不改正式人设）；活跃路径每次读文件（面板动作级频率，非热路）。
   */
  resolve(input: { workspaceId?: string; sessionId?: string; current: PersonaCard }): PersonaResolved {
    const file = this.readFile();
    const find = (id: string): PersonaPreset | undefined => file.presets.find((p) => p.id === id);
    const sid = (input.sessionId ?? '').trim();
    if (sid !== '') {
      const bound = file.sessions[sid];
      const preset = bound === undefined ? undefined : find(bound.presetId);
      if (preset !== undefined) return { card: preset.card, source: 'session', presetId: preset.id, presetName: preset.name };
    }
    const ws = (input.workspaceId ?? '').trim();
    if (ws !== '') {
      const preset = find(file.workspaces[ws] ?? '');
      if (preset !== undefined) return { card: preset.card, source: 'workspace', presetId: preset.id, presetName: preset.name };
    }
    const active = find(file.activeId);
    if (active !== undefined) {
      // 激活卡就是正式人设（激活时已 save 写入）；卡本体仍用 current，避免"预设文件被手改"时与 DB 权威分叉。
      return { card: input.current, source: 'active', presetId: active.id, presetName: active.name };
    }
    return { card: input.current, source: 'current' };
  }
}
