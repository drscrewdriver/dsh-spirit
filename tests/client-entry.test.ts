/**
 * client 入口座位门禁（v0.3 顶部「记忆星海」入口）。
 *
 * 为什么值得单独一份：座位注册是**静默失败面**——挂多了会在设置里出现三份同一面板
 * （姊妹包实测回归过），挂少了整个入口看不见且没有任何报错。这两种都过不了
 * "看 Console 一眼"以外的检查，所以在这里把 ledger 钉死：
 *
 * - 两席位齐 → 面板行 + 主栏页各一枚，且 id/key 同串；
 * - 只声明其一 → **一枚都不注册**（半席位比没席位更糟：点了没反应）；
 * - 老宿主 → 只有既有的分节与 pill，不新增任何座位；
 * - `settings.section` 永远只有一枚。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAIN_SEAT, PILL_SEAT, SEA_PANEL_ID, SETTINGS_SEAT, TOP_TOOL_SEAT, apply } from '../client/src/entry.js';
import type { SpiritClientCtx } from '../client/src/env.js';

interface Registration {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  label?: unknown;
}

function fakeCtx(declared: readonly string[]) {
  const ledger: Registration[] = [];
  const closed: Array<string | null> = [];
  const ctx = {
    slots: {
      inject(slot: string, factory: () => unknown): unknown {
        // 宿主未声明的座位不触发 factory —— 这正是"缺座即不挂"的机制
        if (!declared.includes(slot)) return () => {};
        const off = factory();
        return typeof off === 'function' ? off : () => {};
      },
      register(options: Record<string, unknown>): unknown {
        ledger.push(options as unknown as Registration);
        return () => {};
      },
    },
    get: () => undefined,
    layout: {
      selectPanel: (key: string | null): void => {
        closed.push(key);
      },
    },
  } as unknown as SpiritClientCtx;
  return { ctx, ledger, closed };
}

const ALL_SEATS = [SETTINGS_SEAT, PILL_SEAT, TOP_TOOL_SEAT, MAIN_SEAT];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('顶部星海入口', () => {
  it('两席位齐备：面板行 + 主栏页各一枚，id 与 key 同串', () => {
    const { ctx, ledger } = fakeCtx(ALL_SEATS);
    apply(ctx);
    vi.runAllTimers();

    const rows = ledger.filter((item) => item.name === TOP_TOOL_SEAT);
    const pages = ledger.filter((item) => item.name === MAIN_SEAT);
    expect(rows).toHaveLength(1);
    expect(pages).toHaveLength(1);
    expect(rows[0]!.id).toBe(SEA_PANEL_ID);
    expect(pages[0]!.key).toBe(SEA_PANEL_ID);
    expect(rows[0]!.order).toBe(6);
    // 顶栏与设置分节不能同时成为两个入口：星海只挂顶部这一处
    expect(ledger.filter((item) => item.name === 'sidebar.footer.action')).toHaveLength(0);
  });

  it('只声明其一：一枚都不注册（半席位比没席位更糟）', () => {
    const { ctx, ledger } = fakeCtx([SETTINGS_SEAT, PILL_SEAT, TOP_TOOL_SEAT]);
    apply(ctx);
    vi.runAllTimers();
    expect(ledger.filter((item) => item.name === TOP_TOOL_SEAT)).toHaveLength(0);
    expect(ledger.filter((item) => item.name === MAIN_SEAT)).toHaveLength(0);
    // 既有两个座位不受影响
    expect(ledger.filter((item) => item.name === SETTINGS_SEAT)).toHaveLength(1);
    expect(ledger.filter((item) => item.name === PILL_SEAT)).toHaveLength(1);
  });

  it('老宿主（无顶部席位）：只保留分节与 pill，且说出诊断', () => {
    const { ctx, ledger } = fakeCtx([SETTINGS_SEAT, PILL_SEAT]);
    apply(ctx);
    vi.runAllTimers();
    expect(ledger.map((item) => item.name).sort()).toEqual([PILL_SEAT, SETTINGS_SEAT].sort());
    const warnings = vi.mocked(console.warn).mock.calls.flat().filter((line): line is string => typeof line === 'string');
    expect(warnings.some((line) => line.includes('sidebar.panellist'))).toBe(true);
  });

  it('同一座位绝不重复注册（历史上出现过三份同一面板）', () => {
    const { ctx, ledger } = fakeCtx(ALL_SEATS);
    apply(ctx);
    vi.runAllTimers();
    // 每个座位恰好一枚：顶部两席位算一个入口，也不该把同一面板挂两处
    expect(ledger.filter((item) => item.name === SETTINGS_SEAT)).toHaveLength(1);
    expect(ledger.filter((item) => item.name === PILL_SEAT)).toHaveLength(1);
    expect(ledger.filter((item) => item.name === TOP_TOOL_SEAT)).toHaveLength(1);
    expect(ledger.filter((item) => item.name === MAIN_SEAT)).toHaveLength(1);
  });

  it('行标题传 thunk：语言在渲染期取，不在 apply 期冻结', () => {
    const { ctx, ledger } = fakeCtx(ALL_SEATS);
    apply(ctx);
    vi.runAllTimers();
    const row = ledger.find((item) => item.name === TOP_TOOL_SEAT);
    expect(typeof row?.label).toBe('function');
    const label = (row!.label as () => string)();
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });
});
