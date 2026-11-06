/**
 * 「做梦」tab（v0.3.3）：让鱼睡一觉——确定性本地整理 + 一份梦境报告。
 *
 * 一次 POST 直接回报告（同步冷路径，秒级），**不引入 prime 的进度轮询/取消/背压**：
 * spirit 的整理全是本地计算，没有分钟级的模型步骤要等。
 * 去重窗在服务端（60s）：连点与定时器收敛成一次真睡，面板把"刚刚睡过"说出口。
 */
import { createElement, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import type { SpiritDreamReport, SpiritSleepReport, SpiritSleepStatus } from '../../../src/contract.js';
import { copyOf, type CopyKey } from '../copy.js';
import type { RpcFn } from '../rpc.js';

const BLOCK_STYLE: CSSProperties = { padding: '12px 16px', maxWidth: 680, display: 'grid', gap: 10 };
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

export function SeaDream(props: SeaDreamProps) {
  const { rpc } = props;
  const copy = copyOf(typeof document === 'undefined' ? undefined : document.documentElement.lang);
  const [report, setReport] = useState<SpiritDreamReport | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 长觉（v0.3.5）：异步受理 + 进度轮询（phase 定频：干活 4s、空闲 30s）
  const [sleep, setSleep] = useState<SpiritSleepStatus | null>(null);
  const [sleepReport, setSleepReport] = useState<SpiritSleepReport | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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

  useEffect(() => {
    mountedRef.current = true;
    void loadReport();
    void pollSleep();
    return () => {
      mountedRef.current = false;
      if (pollRef.current !== undefined) clearTimeout(pollRef.current);
    };
  }, [loadReport, pollSleep]);

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
          setNote(reason === 'unsupported' ? copy['sleep.unsupported'] : reason === 'disabled' ? copy['sleep.disabledByDeploy'] : reason === 'dedup-window' ? copy['dream.dedup'] : copy['sleep.phaseFailed']);
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
  );
}
