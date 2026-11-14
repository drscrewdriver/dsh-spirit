/**
 * 回响原文回填（v0.8.3）：v11 之前的行只有摘要，原文从 DRSC 会话日志按摘要/时间捞回来。
 *
 * 重点验四件事：摘要优先、时间兜底、已补的不覆盖、窗口外不碰。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { previewOfEcho } from '../src/echo-log.js';
import { backfillEchoText, cardsOf, ECHO_BACKFILL_DAYS, pickCard } from '../src/echo/text-backfill.js';
import { SPIRIT_CARD_SIGNATURE } from '../src/slot/render.js';
import { EchoRecallStore } from '../src/store/echo-recall.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

let dir = '';
let db: DatabaseSync | undefined;
let store: EchoRecallStore;

function cardText(lines: string[]): string {
  return `<system-reminder>\n${SPIRIT_CARD_SIGNATURE}\n${lines.join('\n')}\n</system-reminder>`;
}

function row(time: number, text: string): { seq: number; turn: number; step: number; kind: string; role: string; time: number; text: string } {
  return { seq: 0, turn: 0, step: 0, kind: 'user/message', role: 'user', time, text };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spirit-echo-backfill-'));
  const opened = openSpiritDb(dir);
  if (!opened.ok) throw new Error(`库应打开成功：${String(opened.err)}`);
  db = opened.db;
  store = new EchoRecallStore({ db: () => db });
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* 已关闭 */
  }
  db = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('cardsOf / pickCard', () => {
  it('只认签名行，按时间升序', () => {
    const cards = cardsOf([row(2000, cardText(['状态：平常'])), row(1000, '普通对话'), row(500, cardText(['状态：忙']))]);
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.at)).toEqual([500, 2000]);
  });

  it('摘要一致优先于时间更近的卡', () => {
    const cards = cardsOf([row(1000, cardText(['状态：平常', '线程：甲'])), row(1000, cardText(['状态：平常', '线程：乙']))]);
    const target = cards[1];
    if (target === undefined) throw new Error('应有第二张卡');
    const picked = pickCard({ at: 1000, preview: target.preview }, cards);
    expect(picked?.preview).toBe(target.preview);
  });

  it('DRSC 插空格的正文仍能按摘要匹配（忽略空白）', () => {
    const original = cardText(['状态：平常', '线程：plugin-9lang']);
    const spaced = original.replace('线程：', '线 程：').replace('不是客观', '不是 客观');
    const cards = cardsOf([row(5000, spaced), row(999_000, cardText(['状态：别的']))]);
    const picked = pickCard({ at: 1000, preview: previewOfEcho(original) }, cards);
    expect(picked?.at).toBe(5000);
  });

  it('摘要为空时按时间兜底，超容差不认', () => {
    const cards = cardsOf([row(1000, cardText(['状态：平常']))]);
    expect(pickCard({ at: 1500, preview: '' }, cards)?.at).toBe(1000);
    const fresh = cardsOf([row(1000, cardText(['状态：平常']))]);
    expect(pickCard({ at: 1000 + 10 * 60_000, preview: '' }, fresh)).toBeUndefined();
  });
});

describe('backfillEchoText', () => {
  it('按摘要补回原文，已有原文不动，窗口外不碰', async () => {
    const oldCard = cardText(['状态：平常', '线程：plugin-9lang-five-dim']);
    const freshCard = cardText(['状态：忙', '线程：别的']);
    store.record({ sessionId: 's1', agentId: 'a1', at: NOW - DAY, kind: 'injected', preview: previewOfEcho(oldCard) });
    store.record({ sessionId: 's1', agentId: 'a1', at: NOW - 2 * DAY, kind: 'injected', preview: previewOfEcho(freshCard), text: '已有的原文' });
    store.record({ sessionId: 's1', agentId: 'a1', at: NOW - (ECHO_BACKFILL_DAYS + 1) * DAY, kind: 'injected', preview: '窗口外' });

    const result = await backfillEchoText({
      store,
      scan: () => ({ sessionAll: async () => [row(NOW - DAY + 500, oldCard), row(NOW - 2 * DAY + 500, freshCard)] }),
      logger: { info: () => {}, warn: () => {} } as never,
      now: () => NOW,
    });

    expect(result).toMatchObject({ ran: true, pending: 1, filled: 1, sessions: 1 });
    const detail = store.detail('s1', `recall-${NOW - DAY}`);
    expect(detail?.text).toBe(oldCard);
    const untouched = store.detail('s1', `recall-${NOW - 2 * DAY}`);
    expect(untouched?.text).toBe('已有的原文');
    // 窗口外的条目虽然也缺原文，但没进本次待补集（窗口有顶），依旧空。
    expect(store.detail('s1', `recall-${NOW - (ECHO_BACKFILL_DAYS + 1) * DAY}`)?.text).toBe('');
  });

  it('只在缺摘要时只补 preview（v10 行才有）：原文不被覆盖', async () => {
    store.record({ sessionId: 's1', agentId: 'a1', at: NOW - DAY, kind: 'injected' });
    const legacy = store.detail('s1', `recall-${NOW - DAY}`);
    expect(legacy).toMatchObject({ preview: '', text: '' });
    // 模拟「已经补过原文、但摘要还空」的中间态。
    store.setText('s1', `recall-${NOW - DAY}`, '已有的整卡原文')
    const card = cardText(['状态：平常', '线程：plugin-9lang']);
    const result = await backfillEchoText({
      store,
      scan: () => ({ sessionAll: async () => [row(NOW - DAY + 200, card)] }),
      logger: { info: () => {}, warn: () => {} } as never,
      now: () => NOW,
    });
    expect(result).toMatchObject({ ran: true, filled: 1 });
    const after = store.detail('s1', `recall-${NOW - DAY}`);
    expect(after?.preview).toBe(previewOfEcho(card));
    expect(after?.text).toBe('已有的整卡原文');
  });

  it('会话读失败只跳过该会话，不抛', async () => {
    store.record({ sessionId: 's1', agentId: 'a1', at: NOW - DAY, kind: 'injected', preview: '摘要甲' });
    store.record({ sessionId: 's2', agentId: 'a1', at: NOW - DAY, kind: 'injected', preview: '摘要乙' });
    const card = cardText(['状态：平常']);
    const result = await backfillEchoText({
      store,
      scan: () => ({
        sessionAll: async (sessionId: string) => {
          if (sessionId === 's1') throw new Error('404');
          return [row(NOW - DAY, card)];
        },
      }),
      logger: { info: () => {}, warn: () => {} } as never,
      now: () => NOW,
    });
    expect(result).toMatchObject({ ran: true, pending: 2, filled: 1, sessions: 2 });
  });

  it('无扫描面或无待补条目时整段休眠', async () => {
    expect(await backfillEchoText({ store, scan: () => undefined, logger: { info: () => {}, warn: () => {} } as never, now: () => NOW })).toMatchObject({ ran: false, filled: 0 });
    store.record({ sessionId: 's1', agentId: 'a1', at: NOW - DAY, kind: 'injected', preview: '摘要', text: '原文' });
    expect(await backfillEchoText({ store, scan: () => ({ sessionAll: async () => [] }), logger: { info: () => {}, warn: () => {} } as never, now: () => NOW })).toMatchObject({ ran: false, pending: 0 });
  });
});

