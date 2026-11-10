/**
 * 「做梦」tab（v0.3.3）：让鱼睡一觉——确定性本地整理 + 一份梦境报告。
 *
 * 一次 POST 直接回报告（同步冷路径，秒级），**不引入 prime 的进度轮询/取消/背压**：
 * spirit 的整理全是本地计算，没有分钟级的模型步骤要等。
 * 去重窗在服务端（60s）：连点与定时器收敛成一次真睡，面板把"刚刚睡过"说出口。
 */
import { createElement, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import type { SpiritDreamReport, SpiritDistillRouteView, SpiritSleepReport, SpiritSleepStatus, SpiritBackfillStatus } from '../../../src/contract.js';
import { copyOf, type CopyKey } from '../copy.js';
import type { RpcFn } from '../rpc.js';

const BLOCK_STYLE: CSSProperties = { padding: '12px 16px', maxWidth: 680, display: 'grid', gap: 10, colorScheme: 'dark' };
const TITLE_STYLE: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600, color: '#9fc1ff' };
const MUTED_STYLE: CSSProperties = { fontSize: 12, color: '#6d7891' };
const BUTTON_STYLE: CSSProperties = { background: 'rgba(120,160,255,.1)', color: '#b8c9ee', border: '1px solid rgba(120,160,255,.22)', borderRadius: 8, padding: '6px 14px', fontSize: 13, cursor: 'pointer' };
const CARD_STYLE: CSSProperties = { padding: '10px 12px', borderRadius: 8, border: '1px solid rgba(120,160,255,.16)', fontSize: 12, display: 'grid', gap: 4 };

export interface SeaDreamProps {
  rpc?: RpcFn;
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const PHASE_KEYS: Record<SpiritSleepStatus['phase'], CopyKey> = {
  idle: 'sleep.never',
  collecting: 'sleep.phaseCollecting',
  distilling: 'sleep.phaseDistilling',
  deduping: 'sleep.phaseDeduping',
  persisting: 'sleep.phasePersisting',
  done: 'sleep.phaseDone',
  failed: 'sleep.phaseFailed',
  cancelled: 'sleep.phaseCancelled',
};

/** 生效路由的来源档位 → 文案键（键名只出在这张映射里，client-copy 闸判据宽窄兼容此形）。 */
const SOURCE_KEYS: Record<NonNullable<SpiritDistillRouteView['effective']>['source'], CopyKey> = {
  deployPinned: 'sleep.srcPinned',
  runtimeOverride: 'sleep.srcOverride',
  hostDefault: 'sleep.srcHostDefault',
};

/** 拒写原因 → 文案键。 */
const SET_FAIL_KEYS: Record<'pinned' | 'half-config' | 'degraded', CopyKey> = {
  pinned: 'sleep.setPinned',
  'half-config': 'sleep.setHalf',
  degraded: 'sleep.setDegraded',
};

export function SeaDream(props: SeaDreamProps) {
  const { rpc } = props;
  const copy = copyOf(typeof document === 'undefined' ? undefined : document.documentElement.lang);
  const [report, setReport] = useState<SpiritDreamReport | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 长觉（v0.3.5）：异步受理 + 进度轮询（phase 定频：干活 4s、空闲 30s）
  const [sleep, setSleep] = useState<SpiritSleepStatus | null>(null);
  const [sleepReport, setSleepReport] = useState<SpiritSleepReport | null>(null);
  // 蒸馏模型选择（面板切路由）：生效视图 + provider/model 下拉 + 当前 provider 的模型清单
  const [route, setRoute] = useState<SpiritDistillRouteView | null>(null);
  const [modelOpts, setModelOpts] = useState<Array<{ id: string; name: string }>>([]);
  const [provSel, setProvSel] = useState('');
  const [modSel, setModSel] = useState('');
  const [applying, setApplying] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildNote, setRebuildNote] = useState<string | null>(null);
  const [rebuildStatus, setRebuildStatus] = useState<SpiritBackfillStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rebuildPollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);

  const loadReport = useCallback(async () => {
    if (rpc === undefined) return;
    try {
      const result = await rpc('dream-report', {});
      if (!mountedRef.current) return;
      if (result.ok) setReport(result.value.report);
    } catch {
      // 报告读不到不弹错：面板退「还没做过梦」是合法状态，传输失败由睡一觉动作自己说话
    }
  }, [rpc]);

  /** 长觉状态轮询：干活阶段 4s、空闲 30s（照 prime 面板的分级定频，但 spirit 只两级）。 */
  const pollSleep = useCallback(async () => {
    if (rpc === undefined) return;
    try {
      const result = await rpc('sleep-status', {});
      if (!mountedRef.current) return;
      if (result.ok) {
        setSleep(result.value);
        if (result.value.lastReport !== null) setSleepReport(result.value.lastReport);
        const interval = result.value.running ? 4_000 : 30_000;
        pollRef.current = setTimeout(() => void pollSleep(), interval);
      }
    } catch {
      if (!mountedRef.current) return;
      pollRef.current = setTimeout(() => void pollSleep(), 30_000);
    }
  }, [rpc]);

  /** 蒸馏路由视图（一次读，面板据此显示与重绘）。 */
  const loadRoute = useCallback(async () => {
    if (rpc === undefined) return;
    try {
      const result = await rpc('distill-models', {});
      if (!mountedRef.current || !result.ok) return;
      setRoute(result.value);
      const eff = result.value.effective;
      if (eff !== null) {
        setProvSel(eff.provider);
        setModSel(eff.model);
      }
    } catch {
      /* 读不到不弹错：面板退“未取到路由”，不阻断做梦主链 */
    }
  }, [rpc]);

  /** 拉某 provider 的模型清单（选 provider 时拉一次，不轮询）。 */
  const loadModels = useCallback(async (provider: string) => {
    if (rpc === undefined || provider === '') {
      setModelOpts([]);
      return;
    }
    try {
      const result = await rpc('distill-model-list', { provider });
      if (!mountedRef.current) return;
      setModelOpts(result.ok ? result.value.models : []);
    } catch {
      if (mountedRef.current) setModelOpts([]);
    }
  }, [rpc]);

  // 选 provider 变 → 拉该供应商模型（pin 时不拉，选择器已禁用）
  useEffect(() => {
    if (route !== null && !route.pinned && provSel !== '') void loadModels(provSel);
  }, [route, provSel, loadModels]);

  /** 写运行时覆盖（应用/清除）：无论成败拿回 route 一次重绘。req 为 {provider,model} 或 {clear:true}。 */
  const setRouteOverride = (req: { provider?: string; model?: string; clear?: boolean }): void => {
    if (rpc === undefined) return;
    setApplying(true);
    setNote(null);
    void rpc('distill-model-set', req)
      .then((result) => {
        if (!mountedRef.current) return;
        if (result.ok) {
          setRoute(result.value.route);
          if (!result.value.ok && result.value.reason !== undefined) setNote(copy[SET_FAIL_KEYS[result.value.reason]]);
        } else {
          setNote(`${copy['sleep.phaseFailed']}: ${result.error.message}`);
        }
      })
      .catch((err: unknown) => setNote(`${copy['sleep.phaseFailed']}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        if (mountedRef.current) setApplying(false);
      });
  };

  /** 全记忆重建进度轮询（照长觉 sleep-status）：跑着 1.5s 一轮，停了收尾。 */
  const pollRebuild = useCallback(async () => {
    if (rpc === undefined) return;
    try {
      const result = await rpc('ontology-backfill-status', {});
      if (!mountedRef.current) return;
      if (!result.ok) return;
      setRebuildStatus(result.value);
      if (result.value.running) rebuildPollRef.current = setTimeout(() => void pollRebuild(), 1_500);
      else setRebuilding(false);
    } catch {
      if (mountedRef.current) rebuildPollRef.current = setTimeout(() => void pollRebuild(), 3_000);
    }
  }, [rpc]);

  /** 全记忆重建（回填历史）：异步受理 + 轮询进度——与长觉同范式（不再一个哑的「正在重建…」）。 */
  const doRebuild = (): void => {
    if (rpc === undefined || rebuilding) return;
    setRebuilding(true);
    setRebuildNote(null);
    void rpc('ontology-backfill-run', { dryRun: false })
      .then((result) => {
        if (!mountedRef.current) return;
        if (!result.ok) { setRebuildNote(`${copy['sleep.phaseFailed']}: ${result.error.message}`); setRebuilding(false); return; }
        if (!result.value.accepted) {
          setRebuildNote(`${copy['sleep.phaseFailed']}: ${result.value.reason ?? ''}`);
          setRebuilding(false);
          return;
        }
        rebuildPollRef.current = setTimeout(() => void pollRebuild(), 500);
      })
      .catch((err: unknown) => { setRebuildNote(`${copy['sleep.phaseFailed']}: ${err instanceof Error ? err.message : String(err)}`); setRebuilding(false); });
  };

  useEffect(() => {
    mountedRef.current = true;
    void loadReport();
    void pollSleep();
    void loadRoute();
    void pollRebuild();
    return () => {
      mountedRef.current = false;
      if (pollRef.current !== undefined) clearTimeout(pollRef.current);
      if (rebuildPollRef.current !== undefined) clearTimeout(rebuildPollRef.current);
    };
  }, [loadReport, pollSleep, loadRoute, pollRebuild]);

  const startSleep = (): void => {
    if (rpc === undefined) return;
    setNote(null);
    void rpc('sleep-run', {})
      .then((result) => {
        if (!mountedRef.current) return;
        if (!result.ok) {
          setNote(`${copy['sleep.phaseFailed']}: ${result.error.message}`);
          return;
        }
        if (!result.value.accepted) {
          const reason = result.value.reason ?? '';
          setNote(reason === 'unsupported' ? copy['sleep.unsupported'] : reason === 'disabled' ? copy['sleep.disabledByDeploy'] : reason === 'toggle-off' ? copy['sleep.toggleOff'] : reason === 'dedup-window' ? copy['dream.dedup'] : copy['sleep.phaseFailed']);
        } else if (pollRef.current !== undefined) {
          // 受理成功：不等 30s 慢轮——800ms 后立刻补一次快轮（进度由轮询自己说话，这里不弹假确认）
          clearTimeout(pollRef.current);
          pollRef.current = setTimeout(() => void pollSleep(), 800);
        }
      })
      .catch((err: unknown) => setNote(`${copy['sleep.phaseFailed']}: ${err instanceof Error ? err.message : String(err)}`));
  };

  const cancelSleep = (): void => {
    if (rpc === undefined) return;
    void rpc('sleep-cancel', {}).catch(() => undefined);
  };

  const sleepPhaseText = sleep === null ? '' : copy[PHASE_KEYS[sleep.phase]];

  /** 进度条（doneSessions/totalSessions）：scan 完才知道总量，extracting 阶段按会话累加。 */
  const renderRebuildProgress = (st: SpiritBackfillStatus): ReturnType<typeof createElement> => {
    const total = st.totalSessions;
    const pct = total > 0 ? Math.min(100, Math.round((st.doneSessions / total) * 100)) : st.phase === 'done' ? 100 : 0;
    return createElement(
      'div',
      { style: { display: 'grid', gap: 4, maxWidth: 520 } },
      createElement('div', { style: MUTED_STYLE },
        `${copy['panel.rebuildScan']} ${st.doneSessions}/${total} · ${copy['panel.rebuildQueued']} ${st.doneTurns}/${st.totalTurns}${st.phase === 'scanning' ? ` · ${copy['panel.rebuildScanning']}` : ''}`),
      createElement('div', { style: { height: 8, borderRadius: 4, background: 'rgba(120,160,255,.16)', overflow: 'hidden' } },
        createElement('div', { style: { height: '100%', width: `${pct}%`, background: st.phase === 'failed' ? '#ff9a9a' : '#7fa8ff' } })),
      st.phase === 'failed' && st.lastError !== ''
        ? createElement('div', { style: { fontSize: 12, color: '#ff9a9a' } }, `${copy['sleep.phaseFailed']}: ${st.lastError}`)
        : null,
      // done 但有会话失败（超时/单轮坏）：不当整次失败，也不当作全好——黄字说清数量和续跑方式
      st.phase === 'done' && st.failedSessions > 0
        ? createElement('div', { style: { fontSize: 12, color: '#e8c07f' } },
          `${copy['panel.rebuildPartial']} ${st.failedSessions} · ${copy['panel.rebuildRetry']}${st.lastError !== '' ? `（${st.lastError}）` : ''}`)
        : null,
      st.phase === 'done' && st.failedSessions === 0
        ? createElement('div', { style: { fontSize: 12, color: '#8fb0e8' } }, copy['panel.rebuildDone'])
        : null,
    );
  };

  /** 小盹（v0.3.3）：同步秒回，一次 POST 直接拿报告。 */
  const nap = (): void => {
    if (rpc === undefined || busy) return;
    setBusy(true);
    setNote(null);
    void rpc('dream-run', {})
      .then((result) => {
        if (!mountedRef.current) return;
        if (!result.ok) {
          setNote(`${copy['dream.failed']}: ${result.error.message}`);
          return;
        }
        const outcome = result.value;
        if (outcome.updated && outcome.report !== undefined && outcome.report !== null) {
          setReport(outcome.report);
          setNote(copy['dream.done']);
        } else if (outcome.reason === 'dedup-window') {
          setNote(copy['dream.dedup']);
        } else if (outcome.reason === 'degraded') {
          setNote(copy['dream.degraded']);
        } else if (outcome.reason === 'disabled') {
          setNote(copy['dream.off']);
        } else {
          setNote(copy['dream.failed']);
        }
      })
      .catch((err: unknown) => setNote(`${copy['dream.failed']}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  };

  return createElement(
    'div',
    { style: BLOCK_STYLE },
    createElement('h4', { style: TITLE_STYLE }, copy['dream.title']),
    createElement('p', { style: MUTED_STYLE }, copy['dream.desc']),
    createElement('p', { style: MUTED_STYLE }, copy['dream.auto']),
    createElement('button', { type: 'button', style: BUTTON_STYLE, disabled: busy, onClick: nap }, copy['dream.run']),
    note !== null ? createElement('p', { style: { fontSize: 12, color: '#ffca7a' } }, note) : null,
    report === null
      ? createElement('p', { style: MUTED_STYLE }, copy['dream.never'])
      : createElement(
        'div',
        { style: CARD_STYLE },
        createElement('div', { style: { color: '#9fc1ff' } }, `${copy['dream.last']} · ${copy['dream.at']} ${formatTime(report.dreamedAt)}`),
        createElement('div', null, `${copy['dream.merged']} ${report.mergedPairs} · ${copy['dream.archived']} ${report.archivedSessions}${report.archiveDryRun ? copy['dream.dryRun'] : ''} · ${copy['dream.entries']} ${report.archivedEntries}`),
        createElement('div', null, `${copy['dream.active']} ${report.active} · ${copy['dream.ghosts']} ${report.ghosts} · ${copy['dream.marked']} ${report.marked}`),
        createElement('div', { style: MUTED_STYLE }, `${copy['dream.tiers']} ${report.tierFull}/${report.tierGist}/${report.tierHeld}`),
      ),
    // 长觉块（v0.3.5）：异步深整理——开关在设置卡睡眠块（live.distillEnabled），这里只管跑与看
    createElement('h4', { style: { ...TITLE_STYLE, marginTop: 18 } }, copy['sleep.title']),
    createElement('p', { style: MUTED_STYLE }, copy['sleep.desc']),
    sleep !== undefined && sleep !== null && !sleep.supported
      ? createElement('p', { style: { fontSize: 12, color: '#ffca7a' } }, copy['sleep.unsupported'])
      : null,
    createElement(
      'div',
      { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      createElement('button', { type: 'button', style: BUTTON_STYLE, disabled: sleep?.running === true || sleep === null, onClick: startSleep }, copy['sleep.run']),
      sleep?.running === true
        ? createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: cancelSleep }, copy['sleep.cancelSleep'])
        : null,
      sleep?.running === true ? createElement('span', { style: MUTED_STYLE }, `${copy['sleep.running']} · ${sleepPhaseText}`) : null,
    ),
    // 蒸馏模型选择（面板切路由，热生效：优先级 部署pin>运行时覆盖>宿主默认）
    createElement(
      'div',
      { style: { ...CARD_STYLE, marginTop: 10 } },
      createElement('div', { style: { color: '#9fc1ff', fontWeight: 600 } }, copy['sleep.modelTitle']),
      route === null
        ? createElement('div', { style: MUTED_STYLE }, copy['sleep.modelLoading'])
        : createElement(
          'div',
          { style: { display: 'grid', gap: 6 } },
          createElement(
            'div',
            { style: MUTED_STYLE },
            `${copy['sleep.modelCurrent']}: ${route.effective === null ? copy['sleep.modelNone'] : `${route.effective.provider}/${route.effective.model}${route.effective === null ? '' : ` · ${copy['sleep.modelSrc']} ${copy[SOURCE_KEYS[route.effective.source]]}`}`}`,
          ),
          route.enumerationSupported === false
            ? createElement('div', { style: { fontSize: 12, color: '#ffca7a' } }, copy['sleep.enumUnsupported'])
            : route.pinned
              ? createElement('div', { style: MUTED_STYLE }, copy['sleep.pinnedNote'])
              : createElement(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                createElement(
                  'select',
                  {
                    style: BUTTON_STYLE,
                    value: provSel,
                    onChange: (event: { target: { value: string } }) => {
                      setProvSel(event.target.value);
                      setModSel('');
                    },
                  },
                  createElement('option', { value: '' }, copy['sleep.pickProvider']),
                  route.providers.map((pv) => createElement('option', { key: pv.id, value: pv.id }, pv.name !== pv.id ? `${pv.name}（${pv.id}）` : pv.id)),
                ),
                createElement(
                  'select',
                  { style: BUTTON_STYLE, value: modSel, onChange: (event: { target: { value: string } }) => setModSel(event.target.value) },
                  createElement('option', { value: '' }, copy['sleep.pickModel']),
                  modelOpts.map((mo) => createElement('option', { key: mo.id, value: mo.id }, mo.name !== mo.id ? `${mo.name}（${mo.id}）` : mo.id)),
                  route.effective !== null && !modelOpts.some((mo) => mo.id === route.effective?.model)
                    ? createElement('option', { value: route.effective.model }, `${route.effective.model}（已不在列表）`)
                    : null,
                ),
                createElement('button', { type: 'button', style: BUTTON_STYLE, disabled: applying || provSel === '' || modSel === '', onClick: () => setRouteOverride({ provider: provSel, model: modSel }) }, copy['sleep.apply']),
                route.runtimeOverride !== null
                  ? createElement('button', { type: 'button', style: BUTTON_STYLE, disabled: applying, onClick: () => setRouteOverride({ clear: true }) }, copy['sleep.clearOverride'])
                  : null,
              ),
        ),
    ),
    sleepReport === null
      ? createElement('p', { style: MUTED_STYLE }, copy['sleep.never'])
      : createElement(
        'div',
        { style: CARD_STYLE },
        createElement('div', { style: { color: '#9fc1ff' } }, `${copy['sleep.last']} · ${formatTime(sleepReport.finishedAt)} · ${copy['sleep.model']} ${sleepReport.model}`),
        createElement('div', null, `${copy['sleep.scanned']} ${sleepReport.entriesScanned} · ${copy['sleep.topics']} ${sleepReport.topicsTouched} · ${copy['sleep.insights']} ${sleepReport.insightsCreated} · ${copy['sleep.edges']} ${sleepReport.edgesCreated}`),
        sleepReport.conflictsMarked > 0
          ? createElement('div', { style: { color: '#ffca7a' } }, `${copy['sleep.conflicts']} ${sleepReport.conflictsMarked}——${copy['topic.conflictHint']}`)
          : null,
        sleepReport.duplicatesDropped > 0 ? createElement('div', { style: MUTED_STYLE }, `${copy['sleep.dups']} ${sleepReport.duplicatesDropped}`) : null,
      ),
    // 全记忆重建（回填历史）：异步任务 + 进度条（照长觉轮询）；记忆蒸馏，与长觉同居
    createElement('h4', { style: { ...TITLE_STYLE, marginTop: 18 } }, copy['panel.rebuildTitle']),
    createElement('p', { style: MUTED_STYLE }, copy['panel.rebuildDesc']),
    createElement(
      'div',
      { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      createElement('button', { type: 'button', style: BUTTON_STYLE, disabled: rebuilding, onClick: doRebuild }, rebuilding ? copy['panel.rebuildBusy'] : copy['panel.rebuildRun']),
      rebuildNote !== null ? createElement('span', { style: MUTED_STYLE }, rebuildNote) : null,
    ),
    rebuildStatus !== null ? renderRebuildProgress(rebuildStatus) : null,
  );
}
