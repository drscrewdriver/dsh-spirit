/**
 * 回响面**纯函数**（v0.8.11）：记录行文字 / 语气行 / 真源定位 / 编号短显。
 *
 * 编号口径（与 host 侧 identity.ts 同义，客户端只做展示，不发号）：
 * - `echo-<uuid>` = 记录的号（progress/done 卡片本身）；列表显示 UUID 前 12 位，全号进 tooltip；
 * - `recall-<uuid>` = 回响事件的号（一轮注入一个）。
 */
import type { SpiritEchoRecordRow, SpiritEchoTone } from '../../../src/contract.js';

/** 翻阅页的子视图（与 sea-records 的 view/ontoTab 同口径）。 */
export type EchoRefTarget =
  | { view: 'entries' }
  | { view: 'onto'; ontoTab: 'tasks' | 'entities' | 'feedback' | 'memory' };

/** 展示短号：`echo-` + UUID 去连字符后前 12 位（与 host 侧 shortEchoId 同口径）。 */
export function shortEcho(echoId: string): string {
  const body = echoId.startsWith('echo-') ? echoId.slice('echo-'.length) : echoId;
  return `echo-${body.replaceAll('-', '').slice(0, 12)}`;
}

/** recall 展示短号（同口径）。 */
export function shortRecall(recallId: string): string {
  const body = recallId.startsWith('recall-') ? recallId.slice('recall-'.length) : recallId;
  return `recall-${body.replaceAll('-', '').slice(0, 12)}`;
}

/** 记录行的行文字：标题（无标题退 memId）；`×N` 只在多次被想起时出现。 */
export function echoRefLabel(row: Pick<SpiritEchoRecordRow, 'title' | 'memId' | 'times'>): string {
  const title = row.title.trim() !== '' ? row.title.trim() : row.memId;
  return row.times > 1 ? `${title} \u00d7${row.times}` : title;
}

/** 语气栏文本行：状态/开场各一行（缺者不出现，顺序固定）。 */
export function echoToneLines(tone: SpiritEchoTone, prefix: { state: string; opening: string }): string[] {
  const lines: string[] = [];
  if (tone.state !== undefined && tone.state !== '') lines.push(`${prefix.state}${tone.state}`);
  if (tone.opening !== undefined && tone.opening !== '') lines.push(`${prefix.opening}${tone.opening}`);
  return lines;
}

/**
 * 点行去哪儿（真源定位）：
 * - task/delivery → 本体·任务线；experience → 条目流；memory/goal → 本体·记着；未知 → 条目流。
 */
export function echoRefTarget(kind: string): EchoRefTarget {
  if (kind === 'task' || kind === 'delivery') return { view: 'onto', ontoTab: 'tasks' };
  if (kind === 'entity') return { view: 'onto', ontoTab: 'entities' };
  if (kind === 'experience') return { view: 'entries' };
  if (kind === 'memory' || kind === 'goal') return { view: 'onto', ontoTab: 'memory' };
  return { view: 'entries' };
}
