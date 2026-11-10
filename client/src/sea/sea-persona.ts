/**
 * 人设管理面（编辑 + 注入预览 + 历史回退）。
 *
 * 三条边界：
 * 1. **写面复用宿主半的 `PersonaStore.save()`**：旧卡先追加进 `persona-history.jsonl`
 *    再覆盖，本组件不实现任何"改历史"的路径；
 * 2. **回退也是追加**：点「回到这一版」写的是**新 revision**，历史一行都不动；
 * 3. **保存前必须看得见投射结果**：`persona-preview` 给的就是将要注入系统提示的原文，
 *    超预算时禁用保存（而不是让用户猜"为什么人格区少了几行"）。
 */
import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import type { SpiritPersonaHistoryPage, SpiritPersonaPatch, SpiritPersonaPreview, SpiritPersonaView, SpiritOwnerProfile, SpiritPersonaPresetsView, SpiritPersonaEffectiveResult } from '../../../src/contract.js';
import { NOTICE_KINDS, VOICE_TIERS } from '../../../src/types.js';
import type { NoticeKind, VoiceTier } from '../../../src/types.js';
import { VOICE_WORDS } from '../../../src/words.js';
import { copyOf } from '../copy.js';
import type { RpcFn } from '../rpc.js';
import { NOTICE_LABEL, TRIGGER_LABEL, TRIGGER_ORDER } from './sea-labels.js';

const H_STYLE: CSSProperties = { margin: '0 0 6px', fontSize: 13, color: '#9fc1ff' };
const BTN_STYLE: CSSProperties = { padding: '3px 10px', borderRadius: 6, border: '1px solid rgba(120,160,255,.28)', background: 'rgba(20,28,48,.7)', color: '#cfe0ff', fontSize: 12, cursor: 'pointer' };
const ROW_STYLE: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' };
const LABEL_STYLE: CSSProperties = { fontSize: 12, color: '#8e9ab5', minWidth: 96 };
const INPUT_STYLE: CSSProperties = { flex: '1 1 180px', padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(120,160,255,.22)', background: 'rgba(8,11,20,.6)', color: '#e8eeff', fontSize: 12 };
const AREA_STYLE: CSSProperties = { ...INPUT_STYLE, flex: '1 1 100%', minHeight: 56, resize: 'vertical', fontFamily: 'inherit' };
/** 长文本框自动长高（用户点名：主人档案同步段钉死三行读不了）：随内容撑开，封顶 480px 后内滚。 */
const AREA_MAX_H = 480;

function AutoArea(props: { value: string; readOnly?: boolean; mono?: boolean; placeholder?: string; onChange?: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, AREA_MAX_H)}px`;
  }, [props.value]);
  return createElement('textarea', {
    ref,
    readOnly: props.readOnly === true,
    placeholder: props.placeholder,
    style: { ...AREA_STYLE, ...(props.mono === true ? { fontFamily: 'ui-monospace, Consolas, monospace' } : {}) },
    value: props.value,
    onChange: (event: { target: { value: string } }) => props.onChange?.(event.target.value),
  });
}
const MUTED_STYLE: CSSProperties = { fontSize: 12, color: '#6d7891' };
const BUTTON_STYLE: CSSProperties = { background: 'rgba(120,160,255,.1)', color: '#b8c9ee', border: '1px solid rgba(120,160,255,.22)', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer' };

function linesToText(lines: readonly string[]): string {
  return lines.join('\n');
}

function textToLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function SeaPersona(props: { rpc?: RpcFn; sessionId?: string }) {
  const { rpc, sessionId } = props;
  const copy = copyOf(typeof document === 'undefined' ? undefined : document.documentElement.lang);
  const [card, setCard] = useState<SpiritPersonaView | null>(null);
  const [draft, setDraft] = useState<SpiritPersonaPatch>({});
  const [preview, setPreview] = useState<SpiritPersonaPreview | null>(null);
  const [history, setHistory] = useState<SpiritPersonaHistoryPage | null>(null);
  // v0.7 人格预设库：库视图 + 生效解析（来源徽标） + 选择态
  const [presets, setPresets] = useState<SpiritPersonaPresetsView | null>(null);
  const [effective, setEffective] = useState<SpiritPersonaEffectiveResult | null>(null);
  const [presetPick, setPresetPick] = useState('');
  const [presetName, setPresetName] = useState('');
  const [presetBusy, setPresetBusy] = useState(false);
  /** 主人档案（v0.3.2）：`owner` 是服务端实态，`ownerSelf` 是自述段的编辑草稿。 */
  const [owner, setOwner] = useState<SpiritOwnerProfile | null>(null);
  const [ownerSelf, setOwnerSelf] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** markdown 备份：`mdText` 是「查看备份」拉到的当前备份，`mdDraft` 是待恢复的粘贴文本。 */
  const [mdText, setMdText] = useState<string | null>(null);
  const [mdDraft, setMdDraft] = useState('');
  const mountedRef = useRef(true);

  const fillFrom = useCallback((view: SpiritPersonaView): void => {
    setCard(view);
    setDraft({
      name: view.name,
      aliases: [...view.aliases],
      selfNames: [...view.selfNames],
      voice: view.voice,
      salience: { ...view.salience },
      focus: [...view.focus],
      values: [...view.values],
      boundaries: [...view.boundaries],
    });
  }, []);

  const load = useCallback(async () => {
    if (rpc === undefined) return;
    setError(null);
    try {
      const [got, hist, own, pres, eff] = await Promise.all([
        rpc('persona-get', {}),
        rpc('persona-history', { limit: 20 }),
        // 档案拉失败（老宿主报 unavailable）不拖挂人设主面：单独退 null，面板如实标
        rpc('owner-get', {}).catch(() => ({ ok: false }) as { ok: false; value?: SpiritOwnerProfile; error?: { code: string; message: string } }),
        // 预设库拉失败（老装配）不拖挂主面：退 null
        rpc('persona-presets', {}).catch(() => ({ ok: false }) as { ok: false; value?: SpiritPersonaPresetsView; error?: { code: string; message: string } }),
        rpc('persona-effective', sessionId === undefined || sessionId === '' ? {} : { sessionId }).catch(() => ({ ok: false }) as { ok: false; value?: SpiritPersonaEffectiveResult; error?: { code: string; message: string } }),
      ]);
      if (!mountedRef.current) return;
      if (!got.ok) {
        setError(got.error.message);
        return;
      }
      fillFrom(got.value);
      if (hist.ok) setHistory(hist.value);
      if (own.ok) {
        setOwner(own.value ?? null);
        setOwnerSelf(own.value?.selfText ?? '');
      } else {
        setOwner(null);
      }
      if (pres.ok) {
        setPresets(pres.value ?? null);
        setPresetPick((prev) => (prev !== '' ? prev : (pres.value?.presets[0]?.id ?? '')));
      } else {
        setPresets(null);
      }
      setEffective(eff.ok ? (eff.value ?? null) : null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rpc, fillFrom, sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const doExportMd = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return;
    setError(null);
    try {
      const result = await rpc('persona-export-md', {});
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setMdText(result.value.text);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rpc]);

  /** 复制失败（非安全上下文/无剪贴板 API）退化为提示手抄，不静默吞。 */
  const doCopyMd = (): void => {
    if (mdText === null) return;
    try {
      void navigator.clipboard
        ?.writeText(mdText)
        .then(() => setNote(copy['sea.personaMdCopied']))
        .catch(() => setNote(copy['sea.personaMdRestoreHint']));
    } catch {
      setNote(copy['sea.personaMdRestoreHint']);
    }
  };

  /**
   * 从粘贴文本恢复：二次确认 → `persona-import-md`（宿主侧走 save()，追加新 revision）。
   * 失败时 reason 直接进 error 行——解析拒绝信息里点名了非法词，那就是主人要改的东西。
   */
  const doImportMd = useCallback(async (): Promise<void> => {
    if (rpc === undefined || mdDraft.trim() === '') return;
    if (!window.confirm(copy['sea.personaMdRestoreHint'])) return;
    setError(null);
    try {
      const result = await rpc('persona-import-md', { text: mdDraft });
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      fillFrom(result.value);
      setNote(copy['sea.personaMdRestored']);
      setMdDraft('');
      void load();
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rpc, mdDraft, copy, fillFrom, load]);

  const patch = (next: Partial<SpiritPersonaPatch>): void => {
    setDraft((current) => ({ ...current, ...next }));
    setPreview(null);
  };

  /** 手动同步：三个结果都要说出口（更新/去重/跳过）——"按了没反应"是最坏的面板行为。 */
  const doOwnerSync = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return;
    setError(null);
    try {
      const result = await rpc('owner-sync-now', {});
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setNote(result.value.updated
        ? copy['sea.ownerSyncUpdated']
        : result.value.reason === 'dedup-window' ? copy['sea.ownerDedup'] : copy['sea.ownerSyncSkipped']);
      void load();
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rpc, copy, load]);

  /** 保存自述段：expectedRevision 乐观并发；冲突报错不静默覆盖（同 persona-set 口径）。 */
  const doOwnerSaveSelf = useCallback(async (): Promise<void> => {
    if (rpc === undefined || owner === null) return;
    setError(null);
    try {
      const result = await rpc('owner-set-self', { text: ownerSelf, expectedRevision: owner.revision });
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setOwner(result.value);
      setNote(copy['sea.ownerSelfSaved']);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rpc, owner, ownerSelf, copy]);

  /** 在意面多选：空集不合法（宿主侧 focusOf 会退默认关注面），所以允许取消到空但不鼓励。 */
  const toggleFocus = (kind: NoticeKind): void => {
    const current = [...(draft.focus ?? card?.focus ?? [])];
    const next = current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind];
    patch({ focus: next });
  };

  const doPreview = useCallback(async (): Promise<SpiritPersonaPreview | null> => {
    if (rpc === undefined) return null;
    const result = await rpc('persona-preview', { patch: draft });
    if (!result.ok) {
      setError(result.error.message);
      return null;
    }
    setPreview(result.value);
    return result.value;
  }, [rpc, draft]);

  const save = async (): Promise<void> => {
    if (rpc === undefined || card === null) return;
    setNote(null);
    // 保存前先拿一次预览：超预算就不写（写了也是被宿主截断的半段人格）
    const next = await doPreview();
    if (next !== null && next.overBudget) {
      setError(copy['sea.personaOverBudget']);
      return;
    }
    const result = await rpc('persona-set', { expectedRevision: card.revision, patch: draft });
    if (!result.ok) {
      setError(result.error.code === 'conflict' ? copy['sea.personaConflict'] : `${copy['sea.personaSaveFailed']}: ${result.error.message}`);
      return;
    }
    fillFrom(result.value);
    setNote(copy['sea.personaSaved']);
    const hist = await rpc('persona-history', { limit: 20 });
    if (hist.ok) setHistory(hist.value);
  };

  const restore = async (revision: number): Promise<void> => {
    if (rpc === undefined) return;
    setNote(null);
    const result = await rpc('persona-restore', { revision });
    if (!result.ok) {
      setError(`${copy['sea.personaSaveFailed']}: ${result.error.message}`);
      return;
    }
    fillFrom(result.value);
    setNote(copy['sea.personaSaved']);
    const hist = await rpc('persona-history', { limit: 20 });
    if (hist.ok) setHistory(hist.value);
  };

  const salience = (typeof draft.salience === 'object' && draft.salience !== null ? draft.salience : {}) as Record<string, number>;

  // 改字后自动重算预览（防抖 400ms）：超预算要能在点保存之前就看到，
  // 而不是保存完才发现“人格区被截了两行”
  useEffect(() => {
    if (rpc === undefined || card === null) return;
    const timer = setTimeout(() => {
      void doPreview();
    }, 400);
    return () => clearTimeout(timer);
  }, [rpc, card, doPreview]);

  const reloadPresets = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return;
    const [pres, eff] = await Promise.all([
      rpc('persona-presets', {}).catch(() => ({ ok: false }) as const),
      rpc('persona-effective', sessionId === undefined || sessionId === '' ? {} : { sessionId }).catch(() => ({ ok: false }) as const),
    ]);
    if (!mountedRef.current) return;
    if (pres.ok) setPresets(pres.value);
    if (eff.ok) setEffective(eff.value);
  }, [rpc, sessionId]);

  /** 预设动作统一流程：禁双击 → 落错到 error → 成功 note + 重拉库/生效视图。 */
  const runPresetAction = useCallback((label: string, action: () => Promise<{ ok: boolean; error?: { message: string } }>): void => {
    if (rpc === undefined || presetBusy) return;
    setPresetBusy(true);
    setNote(null);
    setError(null);
    void action()
      .then(async (result) => {
        if (!mountedRef.current) return;
        if (!result.ok) {
          setError(result.error?.message ?? '操作失败');
          return;
        }
        setNote(label);
        await reloadPresets();
      })
      .catch((err) => {
        if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (mountedRef.current) setPresetBusy(false);
      });
  }, [rpc, presetBusy, reloadPresets]);

  const doActivate = (): void => {
    if (rpc === undefined || presetPick === '') return;
    runPresetAction(copy['sea.presetActivated'], async () => {
      const result = await rpc('persona-activate', { presetId: presetPick });
      if (result.ok && result.value.ok && result.value.persona !== undefined) fillFrom(result.value.persona);
      return result.ok ? { ok: result.value.ok, ...(result.value.reason === undefined ? {} : { error: { message: result.value.reason } }) } : result;
    });
  };

  const doSavePreset = (): void => {
    if (rpc === undefined || presetName.trim() === '') return;
    const name = presetName.trim();
    runPresetAction(copy['sea.presetSaved'], async () => {
      const result = await rpc('persona-preset-save', { name });
      if (result.ok && result.value.ok) setPresetName('');
      return result.ok ? { ok: result.value.ok, ...(result.value.reason === undefined ? {} : { error: { message: result.value.reason } }) } : result;
    });
  };

  const doDeletePreset = (): void => {
    if (rpc === undefined || presetPick === '') return;
    runPresetAction(copy['sea.presetDeleted'], async () => {
      const result = await rpc('persona-preset-delete', { presetId: presetPick });
      return result.ok ? { ok: result.value.ok, ...(result.value.reason === undefined ? {} : { error: { message: result.value.reason } }) } : result;
    });
  };

  const doBindSession = (presetId: string | null): void => {
    if (rpc === undefined || sessionId === undefined || sessionId === '') return;
    runPresetAction(presetId === null ? copy['sea.presetUnbound'] : copy['sea.presetBound'], async () => {
      const result = await rpc('persona-bind', { scope: 'session', sessionId, presetId });
      return result.ok ? { ok: result.value.ok, ...(result.value.reason === undefined ? {} : { error: { message: result.value.reason } }) } : result;
    });
  };

  return createElement(
    'div',
    { style: { padding: '12px 16px', overflowY: 'auto' } },
    card === null
      ? createElement('p', { style: MUTED_STYLE }, copy['panel.noData'])
      : createElement(
        'div',
        null,
        createElement('h4', { style: H_STYLE }, `${copy['sea.personaName']} · revision ${card.revision}`),
        // v0.7 预设库：选 → 激活（写正式人设）；另存为预设；当前会话可临时绑定
        presets === null ? null : createElement(
          'div',
          { style: ROW_STYLE },
          createElement('span', { style: LABEL_STYLE }, copy['sea.presets']),
          createElement(
            'select',
            { style: { ...INPUT_STYLE, flex: '0 0 auto', minWidth: 120 }, value: presetPick, onChange: (event: { target: { value: string } }) => setPresetPick(event.target.value) },
            ...presets.presets.map((preset) => createElement('option', { key: preset.id, value: preset.id }, `${preset.name}${preset.builtin ? ` · ${copy['sea.presetBuiltin']}` : ''}`)),
          ),
          createElement('button', { type: 'button', style: BTN_STYLE, disabled: presetBusy || presetPick === '', onClick: () => doActivate() }, copy['sea.presetActivate']),
          createElement('button', { type: 'button', style: BTN_STYLE, disabled: presetBusy || presetPick === '', onClick: () => doDeletePreset() }, copy['sea.presetDelete']),
          createElement('input', { style: { ...INPUT_STYLE, flex: '0 0 120px' }, placeholder: copy['sea.presetSaveName'], value: presetName, onChange: (event: { target: { value: string } }) => setPresetName(event.target.value) }),
          createElement('button', { type: 'button', style: BTN_STYLE, disabled: presetBusy || presetName.trim() === '', onClick: () => doSavePreset() }, copy['sea.presetSave']),
        ),
        sessionId === undefined || sessionId === '' || presets === null ? null : createElement(
          'div',
          { style: ROW_STYLE },
          createElement('span', { style: LABEL_STYLE }, copy['sea.presetScope']),
          createElement('button', { type: 'button', style: BTN_STYLE, disabled: presetBusy || presetPick === '', onClick: () => doBindSession(presetPick) }, copy['sea.presetBindSession']),
          createElement('button', { type: 'button', style: BTN_STYLE, disabled: presetBusy, onClick: () => doBindSession(null) }, copy['sea.presetUnbindSession']),
        ),
        effective === null ? null : createElement(
          'div',
          { style: { ...MUTED_STYLE, marginTop: 6 } },
          `${copy['sea.presetEffective']}：${effective.source === 'session' ? copy['sea.presetSourceSession'] : effective.source === 'workspace' ? copy['sea.presetSourceWorkspace'] : effective.source === 'active' ? copy['sea.presetSourceActive'] : copy['sea.presetSourceCurrent']}${effective.presetName !== undefined ? `（${effective.presetName}）` : ''}`,
        ),
        createElement(
          'div',
          { style: ROW_STYLE },
          createElement('span', { style: LABEL_STYLE }, copy['sea.personaName']),
          createElement('input', { style: INPUT_STYLE, value: draft.name ?? '', onChange: (event: { target: { value: string } }) => patch({ name: event.target.value }) }),
        ),
        // 昵称序列（v0.3.4）：大名之外主人怎么喊都算；分隔宽进（顿号/逗号/分号/空白），上限 8 个
        createElement(
          'div',
          { style: ROW_STYLE },
          createElement('span', { style: LABEL_STYLE }, copy['sea.personaAliases']),
          createElement('input', {
            style: INPUT_STYLE,
            placeholder: copy['sea.personaAliasesHint'],
            value: (draft.aliases ?? []).join('、'),
            onChange: (event: { target: { value: string } }) => patch({ aliases: event.target.value.split(/[、,，;；\s]+/u).map((item) => item.trim()).filter((item) => item !== '').slice(0, 8) }),
          }),
        ),
        // 自称序列（v0.3.4）：模型也能经 spirit_selfname 工具自己增删——主人在这里看到的是当前全量
        createElement(
          'div',
          { style: ROW_STYLE },
          createElement('span', { style: LABEL_STYLE }, copy['sea.personaSelfNames']),
          createElement('input', {
            style: INPUT_STYLE,
            placeholder: copy['sea.personaSelfNamesHint'],
            value: (draft.selfNames ?? []).join('、'),
            onChange: (event: { target: { value: string } }) => patch({ selfNames: event.target.value.split(/[、,，;；\s]+/u).map((item) => item.trim()).filter((item) => item !== '').slice(0, 8) }),
          }),
        ),
        createElement(
          'div',
          { style: ROW_STYLE },
          createElement('span', { style: LABEL_STYLE }, copy['sea.personaVoice']),
          createElement(
            'select',
            { style: INPUT_STYLE, value: draft.voice ?? card.voice, onChange: (event: { target: { value: string } }) => patch({ voice: event.target.value }) },
            VOICE_TIERS.map((tier) => createElement('option', { key: tier, value: tier }, VOICE_WORDS[tier])),
          ),
        ),
        createElement('h4', { style: { ...H_STYLE, marginTop: 16 } }, copy['sea.personaSalience']),
        ...TRIGGER_ORDER.map((trigger) =>
          createElement(
            'div',
            { key: trigger, style: ROW_STYLE },
            createElement('span', { style: LABEL_STYLE }, TRIGGER_LABEL[trigger] !== undefined ? copy[TRIGGER_LABEL[trigger]] : trigger),
            createElement(
              'select',
              {
                style: INPUT_STYLE,
                value: String(salience[trigger] ?? card.salience[trigger] ?? 0),
                onChange: (event: { target: { value: string } }) => patch({ salience: { ...salience, [trigger]: Number(event.target.value) } }),
              },
              [0, 1, 2].map((weight) => createElement('option', { key: weight, value: String(weight) }, String(weight))),
            ),
          ),
        ),
        createElement('h4', { style: { ...H_STYLE, marginTop: 16 } }, copy['sea.personaFocus']),
        createElement(
          'div',
          { style: ROW_STYLE },
          NOTICE_KINDS.map((kind) =>
            createElement(
              'label',
              { key: kind, style: { display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12, marginRight: 8 } },
              createElement('input', {
                type: 'checkbox',
                checked: (draft.focus ?? card.focus).includes(kind),
                onChange: () => toggleFocus(kind),
              }),
              NOTICE_LABEL[kind] !== undefined ? copy[NOTICE_LABEL[kind]] : kind,
            ),
          ),
        ),
        createElement('h4', { style: { ...H_STYLE, marginTop: 16 } }, copy['sea.personaValues']),
        createElement(AutoArea, { value: linesToText(draft.values ?? []), onChange: (v: string) => patch({ values: textToLines(v) }) }),
        createElement('h4', { style: { ...H_STYLE, marginTop: 16 } }, copy['sea.personaBoundaries']),
        createElement(AutoArea, { value: linesToText(draft.boundaries ?? []), onChange: (v: string) => patch({ boundaries: textToLines(v) }) }),
        createElement(
          'div',
          { style: ROW_STYLE },
          createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => void doPreview() }, copy['sea.personaPreview']),
          createElement(
            'button',
            {
              // 超预算直接禁用：让“保存了也会被截断”这个状态在按钮上就能看见，不靠人读提示
              type: 'button',
              style: preview?.overBudget === true ? { ...BUTTON_STYLE, opacity: 0.45, cursor: 'not-allowed' } : BUTTON_STYLE,
              disabled: preview?.overBudget === true,
              onClick: () => void save(),
            },
            copy['sea.personaSave'],
          ),
          createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => void load() }, copy['sea.retry']),
        ),
        preview === null
          ? null
          : createElement(
            'div',
            { style: { marginTop: 10 } },
            createElement(
              'div',
              { style: MUTED_STYLE },
              `${copy['sea.personaBudget']}: ${preview.bytes} / ${preview.budgetBytes}`,
            ),
            preview.overBudget ? createElement('div', { style: { color: '#ff9a9a', fontSize: 12 } }, copy['sea.personaOverBudget']) : null,
            createElement(
              'pre',
              { style: { marginTop: 6, padding: 8, borderRadius: 8, background: 'rgba(8,11,20,.7)', fontSize: 12, whiteSpace: 'pre-wrap', color: '#dbe6ff' } },
              preview.projectedText,
            ),
          ),
        error !== null ? createElement('p', { style: { color: '#ff9a9a', fontSize: 12 } }, error) : null,
        note !== null ? createElement('p', { style: MUTED_STYLE }, note) : null,
        createElement('h4', { style: { ...H_STYLE, marginTop: 16 } }, copy['sea.personaHistory']),
        history === null || history.items.length === 0
          ? createElement('p', { style: MUTED_STYLE }, copy['sea.personaNoHistory'])
          : createElement(
            'ul',
            { style: { listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 6 } },
            history.items.map((item) =>
              createElement(
                'li',
                { key: item.revision, style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 } },
                createElement('span', { style: MUTED_STYLE }, `r${item.revision} · ${item.name} · ${VOICE_WORDS[item.voice as VoiceTier] ?? item.voice}`),
                createElement(
                  'button',
                  {
                    type: 'button',
                    style: BUTTON_STYLE,
                    onClick: () => {
                      if (window.confirm(`${copy['sea.personaRestore']} r${item.revision}?`)) void restore(item.revision);
                    },
                  },
                  copy['sea.personaRestore'],
                ),
              ),
            ),
          ),
        // ── markdown 备份：导出可读可改，粘贴回来即恢复（追加新 revision） ──
        createElement('h4', { style: { ...H_STYLE, marginTop: 16 } }, copy['sea.personaMd']),
        createElement(
          'div',
          { style: ROW_STYLE },
          createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => void doExportMd() }, copy['sea.personaMdView']),
          mdText !== null
            ? createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: doCopyMd }, copy['sea.personaMdCopy'])
            : null,
        ),
        mdText !== null
          ? createElement(AutoArea, { readOnly: true, mono: true, value: mdText })
          : null,
        createElement('div', { style: { ...MUTED_STYLE, marginTop: 8 } }, copy['sea.personaMdRestoreHint']),
        createElement(AutoArea, { value: mdDraft, onChange: (v: string) => setMdDraft(v) }),
        createElement(
          'button',
          {
            type: 'button',
            style: mdDraft.trim() === '' ? { ...BUTTON_STYLE, opacity: 0.45, cursor: 'not-allowed' } : BUTTON_STYLE,
            disabled: mdDraft.trim() === '',
            onClick: () => void doImportMd(),
          },
          copy['sea.personaMdRestore'],
        ),
        // ── 主人档案（v0.3.2）：同步段只读整段覆盖，自述段手改同步不碰 ──
        createElement('h4', { style: { ...H_STYLE, marginTop: 16 } }, copy['sea.ownerTitle']),
        owner === null
          ? createElement('p', { style: MUTED_STYLE }, copy['panel.noData'])
          : createElement(
            'div',
            null,
            createElement(
              'div',
              { style: MUTED_STYLE },
              `${owner.primeStatus === 'available' ? copy['sea.ownerPrimeAvailable'] : owner.primeStatus === 'graph-off' ? copy['sea.ownerPrimeGraphOff'] : copy['sea.ownerPrimeAbsent']}${owner.syncMeta.syncedAt === null ? '' : ` · ${copy['sea.ownerSyncedAt']} ${new Date(owner.syncMeta.syncedAt).toLocaleString()}`}`,
            ),
            createElement('div', { style: LABEL_STYLE }, copy['sea.ownerSync']),
            createElement(AutoArea, { readOnly: true, mono: true, value: owner.syncText }),
            createElement(
              'button',
              { type: 'button', style: BUTTON_STYLE, onClick: () => void doOwnerSync() },
              copy['sea.ownerSyncNow'],
            ),
            createElement('div', { style: { ...LABEL_STYLE, marginTop: 8 } }, copy['sea.ownerSelf']),
            createElement(AutoArea, { value: ownerSelf, onChange: (v: string) => setOwnerSelf(v) }),
            createElement(
              'button',
              { type: 'button', style: BUTTON_STYLE, onClick: () => void doOwnerSaveSelf() },
              copy['sea.ownerSaveSelf'],
            ),
          ),
      ),
  );
}
