/**
 * 顶层「手记」分节（运行读数 + 会话开关 + 导出）。
 *
 * v0.3.3 瘦身：记录检视段（条目流+这条重要）已整体迁到星海面板的「翻阅」tab——
 * 设置面只留「运行状态读数 + volatile 开关 + 导出」，不再在宿主的设置里养第二个面板。
 *
 * 三条刻意的克制：
 * 1. **不重复生成设置表单**：0.1.7+ 宿主会按 Config 的 volatile 节自动出表单，
 *    本分节只做"看状态 / 会话开关 / 导出"，一个字段的编辑都不抢。
 * 2. **标题写明"非事实记录"**：手记是角色的体验，把它排版成事实清单，
 *    用户会拿它当审计记录看。
 * 3. **轮询只读轻量投影**：有活动 2s、静默 5s、卸载即停；检视段迁走后这里不再逐轮拉条目。
 */
import { createElement, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import type { SpiritDreamReport, SpiritSessionStats, SpiritSettingsView } from '../../src/contract.js';
import type { RpcFn } from './rpc.js';
import { copyOf } from './copy.js';
import { sessionIdOf, type SeatProps } from './env.js';

const mutedStyle: CSSProperties = { opacity: 0.65, fontSize: 12 };
const hStyle: CSSProperties = { margin: '0 0 4px', fontSize: 14, fontWeight: 600 };
const HINT_BOX_STYLE: CSSProperties = { margin: '6px 0', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(210,160,30,.45)', display: 'grid', gap: 6 };

const DRSC_VERDICT_KEYS = { ok: 'panel.drscOk', skipped: 'panel.drscSkipped', warn: 'panel.drscWarn', fail: 'panel.drscFail' } as const;

function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function SpiritPanel(props: { rpc?: RpcFn } & SeatProps) {
  const rpc = props.rpc;
  const copy = copyOf(typeof document === 'undefined' ? undefined : document.documentElement.lang);
  const [stats, setStats] = useState<SpiritSessionStats | null>(null);
  const [settings, setSettings] = useState<SpiritSettingsView | null>(null);
  // 上次梦境读数（v0.3.4 设置面可见性：睡眠块要说话，不只在做梦 tab 里）
  const [dreamReport, setDreamReport] = useState<SpiritDreamReport | null>(null);
  const [halfLifeDraft, setHalfLifeDraft] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [guideCopied, setGuideCopied] = useState(false);
  const guideRef = useRef<HTMLTextAreaElement | null>(null);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  // 会话由宿主给就用给的，否则服务端挑最近有活动的（不逼客户端先拉会话列表）
  const seatSessionId = sessionIdOf(props);

  const load = useCallback(async () => {
    if (rpc === undefined) return;
    const token = ++seqRef.current;
    setError(null);
    try {
      // 检视段迁走后这里只剩轻量读数：统计是内存注册表（重启后为空是常态），
      // 条目流归「翻阅」tab 按动作取（两边都不再轮询全库）。
      const sessionId = seatSessionId;
      const statsResult = sessionId === '' ? await rpc('session-stats', {}) : await rpc('session-stats', { sessionId });
      if (token !== seqRef.current || !mountedRef.current) return;
      setStats(statsResult.ok ? statsResult.value : null);
      // 面板可调腿：读当前生效值（不是静态缺省）；读失败不阻断主数据链
      const s = await rpc('settings-get', {});
      if (token !== seqRef.current || !mountedRef.current) return;
      if (s.ok) {
        setSettings(s.value);
        setHalfLifeDraft(String(Math.round(s.value.fadeHalfLifeMs / 60_000)));
      }
      // 上次梦境：读 meta 单键（本地冷路径，失败不阻断——面板退「还没做过梦」）
      const dr = await rpc('dream-report', {});
      if (token !== seqRef.current || !mountedRef.current) return;
      if (dr.ok) setDreamReport(dr.value.report);
    } catch (err) {
      if (token !== seqRef.current || !mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rpc, seatSessionId]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      // 有活动在 2s、静默 5s：轮询间隔本身就是"面板不该在后台干重活"的兜底
      const busy = (stats?.injectedTurns ?? 0) + (stats?.bypassedTurns ?? 0) > 0;
      timer = setTimeout(async () => {
        await load();
        tick();
      }, busy ? 2_000 : 5_000);
    };
    tick();
    return () => {
      mountedRef.current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [load, stats?.injectedTurns, stats?.bypassedTurns]);

  const [exportNote, setExportNote] = useState<string | null>(null);

  /**
   * 导出。**显式 dryRun:false** 才落盘：部署面 `journal.dryRun` 缺省为 true，
   * 不显式传就会永远只得到"干跑"，按钮看起来像坏了。
   * 会话省略 ⇒ 服务端三级兜底（注册表→库里最近），重启后导出不能先死。
   */
  const doExport = (format: 'md' | 'jsonl') => {
    if (rpc === undefined) return;
    setExportNote(null);
    void rpc('journal-export', { ...(stats?.sessionId === undefined ? {} : { sessionId: stats.sessionId }), format, dryRun: false })
      .then((result) => {
        if (!result.ok) {
          setExportNote(`${copy['panel.exportFailed']}: ${result.error.message}`);
          return;
        }
        setExportNote(
          result.value.dryRun
            ? copy['panel.exportDry']
            : `${copy['panel.exported']}: ${result.value.dirName}/${result.value.fileName} (${result.value.written})`,
        );
      })
      .catch(() => setExportNote(copy['panel.exportFailed']));
  };

  /**
   * DRSC 缺席指引：只展示、只给可复制文案，**绝不自动执行**（改 profile 属高危，
   * 桌面版还会被宿主拒绝——照 prime banner 的裁决）。clipboard 失败退回选中文本。
   */
  const copyGuide = () => {
    const text = copy['drscHint.guide'];
    const fallbackSelect = () => {
      const area = guideRef.current;
      if (area === null) return;
      area.focus();
      area.select();
      setGuideCopied(true);
      setTimeout(() => setGuideCopied(false), 4_000);
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      navigator.clipboard.writeText(text)
        .then(() => {
          setGuideCopied(true);
          setTimeout(() => setGuideCopied(false), 4_000);
        })
        .catch(fallbackSelect);
    } else {
      fallbackSelect();
    }
  };

  const fade = stats?.fade;
  /**
   * 写 volatile 面（六腿的写腿）：淡出两键 + 做梦开关；反馈闸不常改，只随 fadeEnabled 一起开关。
   * 保存后重拉一次 settings-get 回显真值（update 可能被宿主拒 → 面板不能自报已生效）。
   */
  const saveSettings = (patch: { fadeEnabled?: boolean; fadeHalfLifeMs?: number; dreamEnabled?: boolean; distillEnabled?: boolean; ontologyEnabled?: boolean }) => {
    if (rpc === undefined) return;
    setExportNote(null);
    void rpc('settings-set', patch)
      .then((result) => {
        if (!result.ok) {
          setExportNote(`${copy['panel.settingsFailed']}: ${result.error.message}`);
          return;
        }
        setSettings(result.value);
        setExportNote(result.value.hotUpdatable ? copy['panel.settingsSaved'] : copy['panel.settingsCold']);
      })
      .catch(() => setExportNote(copy['panel.settingsFailed']));
  };
  return createElement(
    'section',
    { style: { padding: '12px 16px' } },
    createElement('h3', { style: hStyle }, copy['panel.title']),
    createElement('p', { style: mutedStyle }, `${copy['panel.hint']} · ${copy['panel.notFact']}`),
    error !== null ? createElement('p', { style: { color: 'var(--dsw-danger-color, inherit)' } }, `${copy['panel.loadFailed']}: ${error}`) : null,
    stats === null
      ? createElement('p', { style: mutedStyle }, copy['panel.noData'])
      : createElement(
        'div',
        null,
        createElement(
          'p',
          null,
          `${copy['panel.mood']}：${stats.moodLabel || '—'}`,
          createElement('span', { style: mutedStyle }, ` · ${copy['panel.entries']} ${stats.entryCount} · ${copy['panel.injected']} ${stats.injectedTurns} · ${copy['panel.bypassed']} ${stats.bypassedTurns}`),
        ),
        stats.degraded ? createElement('p', { style: mutedStyle }, copy['panel.degraded']) : null,
        // 注入数与确认数分开显示：两者不相等就说明卡没真落进上下文，看着“生效”其实没生效
        createElement(
          'p',
          { style: mutedStyle },
          `${copy['panel.injected']} ${stats.injectedTurns} → ${stats.confirmedTurns} · ${stats.lastRecallHits} · ${copy['panel.confirmedHint']}`,
        ),
        // 段数专治「连上了但库里没内容」：只说"可用"会把静默为空读成功能正常
        createElement(
          'p',
          { style: mutedStyle },
          `${copy['panel.drsc']}：${copy[DRSC_VERDICT_KEYS[stats.drscVerdict]]}${stats.drscSegments === undefined ? '' : ` · ${copy['panel.drscSegments']} ${stats.drscSegments}`}`,
        ),
        // DRSC 缺席提示块（v0.3.3）：只有 warn 才出（skipped 中性无据不进故障提示，
        // 四值纪律见 src/drsc/probe.ts）；ok/fail 不渲染——fail 留给自家故障，不是依赖缺席。
        stats.drscVerdict === 'warn'
          ? createElement(
            'div',
            { style: HINT_BOX_STYLE },
            createElement('p', { style: { margin: 0, fontSize: 13, fontWeight: 600 } }, copy['drscHint.title']),
            createElement('p', { style: mutedStyle }, copy['drscHint.impact']),
            createElement('textarea', {
              ref: guideRef,
              readOnly: true,
              value: copy['drscHint.guide'],
              rows: 3,
              style: { width: '100%', boxSizing: 'border-box' as const, fontSize: 12 },
            }),
            createElement(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              createElement('button', { type: 'button', style: mutedStyle, onClick: copyGuide }, copy['drscHint.copy']),
              guideCopied ? createElement('span', { style: mutedStyle }, copy['drscHint.copied']) : null,
            ),
          )
          : null,
        // 淡出指标行（调参 SOP 的读数腿）：只在淡出真跑过时出现，关闸时不占行不编零
        fade !== undefined && fade.pool > 0
          ? createElement('p', { style: mutedStyle }, `${copy['panel.fade']}：${fade.full}/${fade.gist}/${fade.held}${fade.marked > 0 ? ` · ★${fade.marked}` : ''} · ${copy['panel.churn']} ${fade.churn}`)
          : null,
        // 面板可调腿（六腿的写腿）：仅当 volatile 通道可读时出现
        settings === null
          ? null
          : createElement(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 6 } },
            createElement('span', { style: mutedStyle }, copy['panel.fadeSettings']),
            createElement(
              'label',
              { style: { display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12 } },
              createElement('input', { type: 'checkbox', checked: settings.fadeEnabled, onChange: (e: { target: { checked: boolean } }) => saveSettings({ fadeEnabled: e.target.checked }) }),
              copy['panel.fadeOn'],
            ),
            createElement('span', { style: mutedStyle }, copy['panel.fadeHalfLife']),
            createElement('input', {
              type: 'number', min: 0, value: halfLifeDraft, style: { width: 72 },
              onChange: (e: { target: { value: string } }) => setHalfLifeDraft(e.target.value),
              onBlur: () => {
                const minutes = Number.parseFloat(halfLifeDraft);
                if (Number.isFinite(minutes) && Math.round(minutes * 60_000) !== settings.fadeHalfLifeMs) saveSettings({ fadeHalfLifeMs: Math.max(0, Math.round(minutes * 60_000)) });
              },
            }),
            settings.hotUpdatable
              ? null
              : createElement('span', { style: mutedStyle }, copy['panel.settingsCold']),
          ),
      ),
    // 检视段（条目流+这条重要）已迁星海「翻阅」tab：这里不再养第二份列表。
    // 睡眠块（v0.3.4 设置面可见性）：自动做梦开关（live 热更）+ 上次梦境读数 + 回响导航行。
    settings === null
      ? null
      : createElement(
        'div',
        { style: { display: 'grid', gap: 4, marginTop: 10 } },
        createElement('h4', { style: { ...hStyle, margin: 0 } }, copy['panel.dreamSettings']),
        createElement(
          'label',
          { style: { display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12 } },
          createElement('input', { type: 'checkbox', checked: settings.dreamEnabled, onChange: (e: { target: { checked: boolean } }) => saveSettings({ dreamEnabled: e.target.checked }) }),
          copy['panel.dreamOn'],
        ),
        // 长觉热更开关（v0.3.5）：面板一键开；部署面总闸关着时开了也不跑（双闸，面板说真话）
        createElement(
          'label',
          { style: { display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12 } },
          createElement('input', { type: 'checkbox', checked: settings.distillEnabled, onChange: (e: { target: { checked: boolean } }) => saveSettings({ distillEnabled: e.target.checked }) }),
          copy['sleep.on'],
        ),
        // 本体层热更开关（v0.5）：面板「本体」真实控制线；关 ⇒ 采集/抽取全停（零落库）
        createElement(
          'label',
          { style: { display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12 } },
          createElement('input', { type: 'checkbox', checked: settings.ontologyEnabled, onChange: (e: { target: { checked: boolean } }) => saveSettings({ ontologyEnabled: e.target.checked }) }),
          copy['panel.ontologyOn'],
        ),
        settings.hotUpdatable
          ? null
          : createElement('span', { style: mutedStyle }, copy['panel.settingsCold']),
        createElement(
          'p',
          { style: mutedStyle },
          dreamReport === null
            ? copy['panel.dreamNever']
            : `${copy['panel.dreamLast']}：${formatTime(dreamReport.dreamedAt)} · ${copy['dream.merged']} ${dreamReport.mergedPairs} · ${copy['dream.active']} ${dreamReport.active}`,
        ),
        createElement('p', { style: mutedStyle }, copy['panel.echoNav']),
      ),
    createElement(
      'div',
      { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
      createElement('button', { type: 'button', style: mutedStyle, onClick: () => void load() }, copy['panel.retry']),
      createElement('button', { type: 'button', style: mutedStyle, onClick: () => doExport('md') }, copy['panel.exportMd']),
      createElement('button', { type: 'button', style: mutedStyle, onClick: () => doExport('jsonl') }, copy['panel.exportJsonl']),
      exportNote !== null ? createElement('span', { style: mutedStyle }, exportNote) : null,
    ),
  );
}
