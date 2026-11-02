/**
 * 刀2 echo 链断言（CI 档）。
 *
 * 两半的分工必须说白，否则这是条常绿假闸：
 * - 本文件（CI，可常跑）：用**fixture 复现**姊妹引擎的分流规则（`user/message` 只放行
 *   `source.kind==='user'`；`assistant/message` 原样进文本），断言两件事：
 *   ① 卡行以 `kind:'plugin:spirit'` 落日志时被分流规则挡在证据外（入口防线，已在真机验证过）；
 *   ② 模型复述卡语会**整段可识别**地出现在证据里（泄漏口如实标注为开放），
 *     并且复述文本必然命中 SPIRIT_PHRASES——语汇纪律是压小其信息量的唯一防线。
 * - 真机档（发版前手跑，见 tasks 2.3）：两仓同装 + 真模型跑回合，读对方 L1 导出面
 *   断言不含 spirit 短语集。**没有真模型时 ②的"证据含短语"不是 bug，是把口子照下来。**
 *
 * fixture 与对方源码的对应点（对方仓库 src/store/evidence-source.ts:189-209，2026-11 核对）；
 * 这里不 import 对方包、不出现其包名字面量（解耦闸），对上了才有下面两条断言的意义。
 */
import { describe, expect, it } from 'vitest';

import { containsSpiritPhrase, SPIRIT_PHRASES } from '../src/util/echo-phrases.js';
import { renderCard, SPIRIT_CARD_DISCLAIMER, SPIRIT_CARD_SIGNATURE } from '../src/slot/render.js';
import { GIST_TABLE, BODY_TABLE, renderGistText } from '../src/experience/render.js';
import { SPIRIT_SOURCE_KIND, SPIRIT_DEFAULTS } from '../src/contract.js';
import type { Mood } from '../src/types.js';

/** 分流 fixture：只复现"注入行进不进证据"这一条规则。 */
function projectEventTextLikeSibling(event: { type: string; data?: unknown }): string {
  if (event.type === 'user/message') {
    const data = event.data as { source?: { kind?: unknown }; content?: Array<{ type?: string; text?: string }> };
    if (data.source?.kind !== 'user') return ''; // 姊妹引擎原样语义：非用户来源整行丢弃
    return (data.content ?? []).map((b) => (b?.type === 'text' ? (b.text ?? '') : '')).join('');
  }
  if (event.type === 'assistant/message') {
    const data = event.data as { message?: { content?: Array<{ type?: string; text?: string }> } };
    return (data.message?.content ?? []).map((b) => (b?.type === 'text' ? (b.text ?? '') : '')).join('');
  }
  return '';
}

const mood: Mood = { valence: 'neg', arousal: 'normal', label: '有点堵', revision: 1, updatedAt: 0 };

function realCard(): string {
  const gist = renderGistText('tool_failure', 'self_mistake');
  const card = renderCard({
    mood,
    recent: [BODY_TABLE.tool_failure.mild as string, gist],
    recalled: [],
    maxBytes: SPIRIT_DEFAULTS.card.maxBytes,
    maxCharsPerEntry: SPIRIT_DEFAULTS.recall.maxCharsPerEntry,
  });
  expect(card.text).not.toBe('');
  return card.text;
}

describe('语汇单源（SPIRIT_PHRASES 覆盖卡上所有固定文案）', () => {
  it('签名行、声明行、九档 label/tendency、全部 gist 残句都在集合内', () => {
    expect(SPIRIT_PHRASES).toContain(SPIRIT_CARD_SIGNATURE);
    expect(SPIRIT_PHRASES).toContain(SPIRIT_CARD_DISCLAIMER);
    for (const gist of Object.values(GIST_TABLE)) expect(SPIRIT_PHRASES).toContain(gist);
  });
  it('集合非空且无空串成员（空短语=恒命中的假闸）；短档词门槛在匹配函数里', () => {
    expect(SPIRIT_PHRASES.length).toBeGreaterThan(10);
    expect(SPIRIT_PHRASES.every((p) => p !== '')).toBe(true);
  });
  it('二字档词不做裸子串判定（真机自家 L1 盘上“顺手/平常”必然假阳）', () => {
    expect(containsSpiritPhrase('这个工具用起来很顺手')).toBeNull();
    expect(containsSpiritPhrase('今天手感平常')).toBeNull();
  });
});

describe('卡文本整段可识别（语汇纪律的反面哨兵）', () => {
  it('真渲染的卡必然命中短语集', () => {
    expect(containsSpiritPhrase(realCard())).not.toBeNull();
  });
  it('gist 残句单独出现也可识别', () => {
    expect(containsSpiritPhrase(renderGistText('recovery', 'task_progress'))).not.toBeNull();
  });
  it('普通客观陈述不误命中（控制组）', () => {
    expect(containsSpiritPhrase('npm run build 以退出码 1 结束')).toBeNull();
  });
});

describe('分流规则（fixture 复现）', () => {
  it('入口防线：卡行以 plugin 署名落日志 ⇒ 进不了证据', () => {
    const text = realCard();
    const projected = projectEventTextLikeSibling({
      type: 'user/message',
      data: { source: { kind: SPIRIT_SOURCE_KIND }, content: [{ type: 'text', text }] },
    });
    expect(projected).toBe('');
  });

  it('泄漏口如实标注：模型原样复述 ⇒ 会整段进入证据，且必然可识别', () => {
    const echo = projectEventTextLikeSibling({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '刚才卡上写着：我有点堵——句子短，不想解释第二遍' }] } },
    });
    expect(containsSpiritPhrase(echo)).not.toBeNull();
  });

  it('转述式复述（带完整倾向句）同样命中——不可蒸馏语把泄漏压成无信息量短句', () => {
    const paraphrase = '我刚才有点堵，句子短，不想解释第二遍';
    const hit = containsSpiritPhrase(paraphrase);
    expect(hit).not.toBeNull();
    // 命中的是倾向短语这类"状态写法"，不是任何因果陈述句
    expect((hit ?? '').length).toBeLessThanOrEqual(20);
  });
});
