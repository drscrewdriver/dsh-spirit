/**
 * 刀3 未竟账 + 刀4 条件化：结构计数、取代收敛、过期、双闸与"只经文本通道"的自证。
 */
import { describe, expect, it } from 'vitest';

import { LedgerStore, ledgerLineText, type LedgerRow } from '../src/store/ledger.js';
import { BiasStore } from '../src/store/bias.js';
import { TurnWatcher } from '../src/experience/watcher.js';
import { biasTendency, readBias } from '../src/slot/bias.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };

function row(over: Partial<LedgerRow> & { id: string }): LedgerRow {
  return { sessionId: 's1', workspaceId: 'w1', tsMs: 1_000, turnSeq: 3, open: 1, inProgress: 0, ...over };
}

describe('watcher.openLoops：只吃 todo 快照的结构计数', () => {
  it('从未见过快照 ⇒ undefined（不拿"没看见"当"有未竟"也不当"都完了"）', () => {
    const w = new TurnWatcher({ gapThresholdMs: 180_000 });
    expect(w.openLoops('s1')).toBeUndefined();
  });

  it('计数真值：pending/in_progress 都算开着，in_progress 单列', () => {
    const w = new TurnWatcher({ gapThresholdMs: 180_000 });
    w.observe('s1', { type: 'todo/write', data: { todos: [
      { status: 'pending' }, { status: 'in_progress' }, { status: 'completed' },
    ] } }, 100);
    expect(w.openLoops('s1')).toEqual({ open: 2, inProgress: 1 });
    // 后到快照覆盖先到（只留最后一次）
    w.observe('s1', { type: 'todo/write', data: { todos: [{ status: 'completed' }] } }, 200);
    expect(w.openLoops('s1')).toEqual({ open: 0, inProgress: 0 });
  });

  it('未知状态不算完成也不计入开着（不猜形状）', () => {
    const w = new TurnWatcher({ gapThresholdMs: 180_000 });
    w.observe('s1', { type: 'todo/write', data: { todos: [{ status: 'weird' }] } }, 100);
    expect(w.openLoops('s1')).toEqual({ open: 0, inProgress: 0 });
  });
});

describe('LedgerStore（内存镜像臂）：取代收敛与过期', () => {
  it('同会话后写取代先写；读只给最新未取代的一条', () => {
    const led = new LedgerStore({ db: null, logger });
    led.append(row({ id: 'l-s1-1', turnSeq: 1, open: 2 }));
    led.append(row({ id: 'l-s1-2', turnSeq: 2, open: 1 }));
    const got = led.latestFor('w1', 's2', 1_500, 0);
    expect(got?.id).toBe('l-s1-2');
  });

  it('排除本会话；maxAge 过期不带出（陈旧账不当今天的心情）', () => {
    const led = new LedgerStore({ db: null, logger });
    led.append(row({ id: 'l1', tsMs: 1_000 }));
    expect(led.latestFor('w1', 's1', 2_000, 0)).toBeUndefined();
    expect(led.latestFor('w1', 's2', 1_500, 100)).toBeUndefined();
    expect(led.latestFor('w1', 's2', 1_500, 10_000)?.id).toBe('l1');
  });

  it('镜像有顶（无界增长是红线）', () => {
    const led = new LedgerStore({ db: null, logger });
    for (let i = 0; i < 260; i += 1) led.append(row({ id: `l-${i}`, sessionId: `s-${i}`, tsMs: i }));
    expect(led.latestFor('w1', 'other', 1_000_000, 0)?.sessionId).toBe('s-259');
  });
});

describe('ledgerLineText：措辞档位化，不伪造具体性', () => {
  it('undefined/零未竟 ⇒ 整行不给', () => {
    expect(ledgerLineText(undefined)).toBeUndefined();
    expect(ledgerLineText(row({ id: 'x', open: 0 }))).toBeUndefined();
  });
  it('单条给措辞；多条才给数（计数真是 3 才说 3）', () => {
    expect(ledgerLineText(row({ id: 'x', open: 1, inProgress: 1 }))).toContain('一步');
    expect(ledgerLineText(row({ id: 'x', open: 3 }))).toContain('3 处');
  });
});

describe('BiasStore（内存镜像臂）：取严、过期、撤销', () => {
  it('upsert 取严不取松；撤销（<=0）允许覆盖', () => {
    const bias = new BiasStore({ db: null, logger });
    bias.upsert('w1', 'bash', 2, 1_000);
    bias.upsert('w1', 'bash', 1, 1_500);
    expect(bias.read('w1', 'bash', 1_500, 0)).toBe(2);
    bias.upsert('w1', 'bash', 0, 2_000);
    expect(bias.read('w1', 'bash', 2_000, 0)).toBeUndefined();
  });

  it('半衰期量化过期：跨一档降一级、跨两档失效（档内读数不随 now 漂移）', () => {
    const bias = new BiasStore({ db: null, logger });
    bias.upsert('w1', 'bash', 2, 0);
    expect(bias.read('w1', 'bash', 900, 1_000)).toBe(2);
    expect(bias.read('w1', 'bash', 1_500, 1_000)).toBe(1);
    expect(bias.read('w1', 'bash', 2_500, 1_000)).toBeUndefined();
  });
});

describe('readBias/biasTendency：只经卡文本通道的自证面', () => {
  const cfgOn = { bias: { enabled: true } };
  const cfgOff = { bias: { enabled: false } };

  it('闸关 ⇒ 恒 undefined（与 fadeEnabled 同一灰度链，双闸缺一不出短语）', () => {
    expect(readBias(cfgOff, () => 2, ['bash'])).toBeUndefined();
    expect(readBias(cfgOn, undefined, ['bash'])).toBeUndefined();
    expect(biasTendency(readBias(cfgOn, () => 9, ['bash']))).toBeUndefined(); // 表外档位不编短语
  });

  it('多动作键取最强档；空键/非数忽略', () => {
    const bands: Record<string, number> = { a: 1, b: 2 };
    expect(readBias(cfgOn, (k) => bands[k], ['a', 'b', '', 'zz'])).toBe(2);
  });

  it('短语只有档位词，无任何数值（伪精确防线的正面）', () => {
    const hesitant = biasTendency(1);
    const guarded = biasTendency(2);
    expect(hesitant).toBeDefined();
    expect(guarded).toBeDefined();
    for (const text of [hesitant, guarded]) {
      expect(text).not.toMatch(/\d/u);
      expect(text).not.toContain('.');
    }
  });
});
