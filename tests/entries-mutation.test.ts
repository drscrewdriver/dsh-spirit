/**
 * G3：条目管理动作必须**可观测地推进注入输入**——注入指纹是内容寻址
 * （mood.revision | recentTexts.join('#') | formsDigest，spirit.ts L243-254），
 * 管理动作若没让这三元之一变化，就会被 `passthrough('unchanged')` 静默吞掉：
 * 用户藏了一条还在意的事，卡却"没变"，是最难归因的假生效。
 *
 * 这里断言的是**组成指纹的输入面**（store 投影），不重复 spirit 的编排测试：
 * recent() 的输出文本集变了 ⇒ 指纹必变 ⇒ 下一轮自然重发。无需手动失效动作。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openSpiritDb } from '../src/db/open.js';
import { ExperienceStore } from '../src/store/experience.js';
import { TRIGGER_TOOL_FAILURE } from '../src/types.js';

const logger = { warn: (_m: string) => undefined, info: (_m: string) => undefined };

function seed(): ExperienceStore {
  const store = new ExperienceStore({ db: null, logger });
  store.append(
    { id: 'e1', sessionId: 's1', workspaceId: 'w1', turnSeq: 1, tsMs: 1_000, personaRevision: 1 },
    { trigger: TRIGGER_TOOL_FAILURE, notice: 'environment', reaction: 'mild', text: '手边的动作没成，我记着这一下。', fact: {}, lane: 'live' },
  );
  store.append(
    { id: 'e2', sessionId: 's1', workspaceId: 'w1', turnSeq: 2, tsMs: 2_000, personaRevision: 1 },
    { trigger: TRIGGER_TOOL_FAILURE, notice: 'self_mistake', reaction: 'mild', text: '第二条也记着。', fact: {}, lane: 'live' },
  );
  return store;
}

const digest = (store: ExperienceStore): string => store.recent('s1', 5).map((entry) => entry.text).join('#');

describe('G3 管理动作 ⇒ 注入输入推进', () => {
  it('藏起来 ⇒ recent 文本集收缩（指纹三元之一必变，unchanged 吞不掉）', () => {
    const store = seed();
    const before = digest(store);
    store.setHidden(['e2'], true);
    expect(digest(store)).not.toBe(before);
    // 再想起 ⇒ 文本集又变回去——两次都是"变"，没有哪次是静默
    store.setHidden(['e2'], false);
    expect(digest(store)).toBe(before);
  });

  it('更正式编辑 ⇒ 新文本进 recent（旧文本退出可见表面）', () => {
    const store = seed();
    const before = digest(store);
    const revised = store.reviseEntry('e1', { text: '其实那一下我记岔了，重新记。' });
    expect(revised).not.toBeNull();
    const after = digest(store);
    expect(after).not.toBe(before);
    expect(after).toContain('其实那一下我记岔了');
    expect(after).not.toContain('手边的动作没成');
  });

  it('做梦合并重复 ⇒ 收缩同样可观测（保留者文本在场，重复者退出；真库，降级面不做梦）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spirit-g3-'));
    const opened = openSpiritDb(dir);
    if (!opened.ok) throw new Error('库应打开成功');
    try {
      const store = new ExperienceStore({ db: opened.db, logger });
      for (const id of ['d1', 'd2']) {
        store.append(
          { id, sessionId: 's1', workspaceId: 'w1', turnSeq: id === 'd2' ? 2 : 1, tsMs: id === 'd2' ? 2_000 : 1_000, personaRevision: 1 },
          { trigger: TRIGGER_TOOL_FAILURE, notice: 'environment', reaction: 'mild', text: '同一句记了两遍。', fact: {}, lane: 'live' },
        );
      }
      // 等值重复在 recent 里本来就同文本——合并的观测面是**条数**收缩（formsDigest 吃条数）
      const beforeCount = store.recent('s1', 5).length;
      const groups = store.dreamDuplicateGroups();
      expect(groups).toHaveLength(1);
      const keep = groups[0]?.[0];
      if (keep !== undefined) {
        for (const dup of groups[0]?.slice(1) ?? []) store.supersede(dup.id, keep.id);
      }
      expect(store.recent('s1', 5).length).toBe(beforeCount - 1);
    } finally {
      opened.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
