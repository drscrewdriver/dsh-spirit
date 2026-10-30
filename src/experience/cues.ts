/**
 * 检索线索（cues）提取：只从**结构化事实**里取确定性 token。
 *
 * 为什么需要它：条目正文是查表产出的体验句，词面窄，用户说"那个投递脚本"时匹配不上。
 * cues 补的是"这件事客观上牵涉到什么"——工具名、文件 basename、命令名，
 * 这些是宿主事件里现成的结构字段，不需要读任何自由文本。
 *
 * 三条边界：
 * 1. **默认不抽用户原文**（`capture.userSnippet` 关着时，一个用户词都不进 cues）——
 *    用户说过什么会连同隐私与注入面一起进库，代价大于收益；要历史原文请走 DRSC。
 * 2. 只留 **basename**，不留目录：路径本身会泄露工作区结构。
 * 3. 数量与长度都有顶：cues 表会随条目线性膨胀，无顶就是无界增长。
 */

import type { ExperienceFact } from '../types.js';

export const CUE_LIMITS = { maxPerEntry: 8, maxLen: 40 } as const;

/** 归一化：小写、裁长、去空。空串直接丢。 */
function normalize(token: string): string {
  const clean = token.trim().toLowerCase();
  if (clean === '') return '';
  return clean.length > CUE_LIMITS.maxLen ? clean.slice(0, CUE_LIMITS.maxLen) : clean;
}

/** 文件路径 → basename（不含目录、不含扩展名也可匹配，这里保留扩展名以提高区分度）。 */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1] ?? '';
}

/**
 * 从事实里取 cues。
 *
 * @param fact 结构化事实（唯一的原料来源）
 * @param userSnippet 可选的用户原文片段；**只有显式开启采集时才由调用方传入**，
 *                    本函数不判断开关（判断在采集侧，避免这里出现第二份配置口径）
 */
export function extractCues(fact: ExperienceFact, userSnippet?: string): string[] {
  const tokens: string[] = [];
  if (fact.tool) tokens.push(fact.tool);
  for (const pathBase of fact.pathBases ?? []) tokens.push(baseName(pathBase));
  // 用户原文只截前若干个 token，绝不整段进库
  if (userSnippet !== undefined && userSnippet !== '') {
    for (const word of userSnippet.split(/\s+/u).slice(0, 4)) tokens.push(word);
  }
  const cleaned = tokens.map(normalize).filter((token) => token !== '');
  return [...new Set(cleaned)].slice(0, CUE_LIMITS.maxPerEntry);
}

/** 分词分隔符集（character class 内 `[` 不需转义；`\]` 才需要——多转一道就是 no-useless-escape）。 */
const SPLIT_CHARS = /[\s,，。、；;:：()[\]{}<>/\\'"`]+/u;

/** 查询串 → 检索 token（与 cues 同一归一口径；口径不一致就等于查不到自己写进去的东西）。 */
export function queryTokens(query: string, limit = 8): string[] {
  const parts = query
    .split(SPLIT_CHARS)
    .map(normalize)
    .filter((token) => token !== '' && token.length >= 2);
  return [...new Set(parts)].slice(0, limit);
}
