/**
 * 会话级开关：`off`（完全不参与）与 `bypass`（旁路：照常记录与派生，只是不注入）。
 *
 * 两者正交，别混为一谈：
 * - `off` 是**关功能**——不注入也不记录（由调用方在采集入口判）；
 * - `bypass` 是**留数据、断出口**——这才是效果归因要的对照组：同样的条目库、同样的档位，
 *   唯一差别是卡不进上下文。没有它，"入戏感是不是这套机制带来的"根本无法回答。
 *
 * 持久化按 sessionId，重启/恢复会话不丢；写盘走文件锁 + 原子替换。
 */

import { join } from 'node:path';

import { SPIRIT_MODES_FILE_VERSION } from '../contract.js';
import { readJsonTolerant, withFileLock, writeEnvelopedJson } from './json-file.js';

export const MODES_FILE = 'session-modes.json';

export interface SessionModeEntry {
  /** 完全不参与（不注入也不记录）。缺省即跟随全局。 */
  off?: boolean;
  /** 旁路：记录与派生照常，不注入。 */
  bypass?: boolean;
}

type ModesMap = Record<string, SessionModeEntry>;

export class SessionModeStore {
  private modes: ModesMap = {};
  private loaded = false;

  constructor(private readonly deps: { dataDir: string; logger: { warn(message: string): void } }) {}

  /** 载入（损坏/缺失 ⇒ 空表，不抛；只载一次）。 */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const result = readJsonTolerant<ModesMap>(join(this.deps.dataDir, MODES_FILE), SPIRIT_MODES_FILE_VERSION);
    if (!result.ok) {
      if (result.reason !== 'missing') this.deps.logger.warn(`[spirit] session-modes 不可用（${result.reason}），本次按全部跟随全局处理`);
      return;
    }
    const raw = result.value;
    if (typeof raw !== 'object' || raw === null) return;
    const next: ModesMap = {};
    for (const [sessionId, entry] of Object.entries(raw)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const item = entry as SessionModeEntry;
      const clean: SessionModeEntry = {};
      if (item.off === true) clean.off = true;
      if (item.bypass === true) clean.bypass = true;
      // 两个标记都没有 ⇒ 不写入表（跟随全局即"无条目"，留着空对象会让文件只增不减）
      if (clean.off === true || clean.bypass === true) next[sessionId] = clean;
    }
    this.modes = next;
  }

  get(sessionId: string): SessionModeEntry {
    this.load();
    return this.modes[sessionId] ?? {};
  }

  isOff(sessionId: string): boolean {
    return this.get(sessionId).off === true;
  }

  /** 旁路只对**注入**生效；采集与派生不看这个标记。 */
  isBypass(sessionId: string): boolean {
    const entry = this.get(sessionId);
    return entry.off !== true && entry.bypass === true;
  }

  /**
   * 设置会话覆盖。两个标记全清 ⇒ 删掉条目（回到"跟随全局"），并广播落盘。
   *
   * @returns 是否已落盘（false = 文件被占用或不可写；内存态已生效，下次写盘会带上）
   */
  set(sessionId: string, patch: SessionModeEntry): boolean {
    this.load();
    const next: SessionModeEntry = {};
    if (patch.off === true) next.off = true;
    if (patch.bypass === true && next.off !== true) next.bypass = true;
    if (next.off === undefined && next.bypass === undefined) delete this.modes[sessionId];
    else this.modes[sessionId] = next;
    return this.persist();
  }

  /** 写盘（持锁 + 原子替换）。失败只 warn 并返回 false，绝不抛穿会话。 */
  persist(): boolean {
    const written = withFileLock(this.deps.dataDir, 'session-modes', () => {
      writeEnvelopedJson(join(this.deps.dataDir, MODES_FILE), SPIRIT_MODES_FILE_VERSION, this.modes);
      return true;
    });
    if (written !== true) this.deps.logger.warn('[spirit] session-modes 落盘失败，本次只保留内存态（重启后会话档位回到跟随全局）');
    return written === true;
  }

  /** 条目数（面板与清理用）。 */
  size(): number {
    this.load();
    return Object.keys(this.modes).length;
  }

  /** 丢弃内存态（测试与外部编辑文件后用）。 */
  invalidate(): void {
    this.loaded = false;
    this.modes = {};
  }
}
