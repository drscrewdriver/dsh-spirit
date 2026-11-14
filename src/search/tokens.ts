/**
 * 分词与查询构造（FTS 读写两侧共用的唯一入口）。
 *
 * 词元 = jieba 词级切词 ∪ 拉丁词/数字串 ∪ CJK 二元组，按首次出现顺序去重：
 * - **词元**给 BM25 提供高精度整词命中（"负载均衡"作为词，idf 远高于碎片二元组）——
 *   这正是"车不会撞进车站"的来源：库里存的是 `车站` 这个词元，查 `车` 时不命中它；
 * - **二元组**保住子词召回底线（查"负载"仍能命中只切出"负载均衡"的行），也是 jieba
 *   缺席时唯一的索引内容；
 * - **去重**防 2 字词与其自身二元组重复计数（TF 被同一次出现双计）。
 *
 * 索引侧与查询侧必须走同一函数——这是格式级契约，不是可自由重设计的实现细节。
 */
import { jiebaCut } from './tokenizer.js';

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const WORD_RE = /[a-zA-Z0-9][a-zA-Z0-9_-]{1,}/g;
/** token 里至少要有一个字母 / 数字 / CJK 字（滤掉 jieba 切出的纯标点）。 */
const TOKEN_KEEP_RE = /[a-z0-9\u3400-\u9fff\uf900-\ufaff]/;

/**
 * 单条文本的 token 上限：一条经历正文最长也就几百字，正常远低于此；
 * 设上限只为防"有人把整篇日志当一条记忆写进来"把索引撑爆。
 */
export const MAX_TOKENS = 512;

/** 高频虚词：进 MATCH 只添噪声（查询侧过滤，索引侧不过滤）。 */
const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那',
  '吗', '吧', '呢', '啊', '呀', '哦', '嗯', '把', '被', '给',
]);

/** CJK 连续段的二元组（孤立单字保留为单字 token）。 */
function cjkBigrams(text: string): string[] {
  const tokens: string[] = [];
  const cjk = text.replace(/[^\u3400-\u9fff\uf900-\ufaff]/g, ' ');
  for (let i = 0; i < cjk.length; i += 1) {
    const ch = cjk[i] as string;
    if (!CJK_RE.test(ch)) continue;
    const next = cjk[i + 1];
    tokens.push(next !== undefined && CJK_RE.test(next) ? ch + next : ch);
  }
  return tokens;
}

/** FTS / BM25 共用分词入口（输入内部统一小写）。 */
export function tokenize(text: string): string[] {
  const lower = String(text ?? '').toLowerCase();
  if (lower.trim() === '') return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  const push = (token: string): void => {
    if (tokens.length >= MAX_TOKENS) return;
    if (token === '' || seen.has(token)) return;
    if (!TOKEN_KEEP_RE.test(token)) return;
    if (token.length < 2 && !(token.length === 1 && CJK_RE.test(token))) return;
    seen.add(token);
    tokens.push(token);
  };
  const words = jiebaCut(lower);
  if (words !== undefined) for (const word of words) push(word.trim());
  for (const match of lower.matchAll(WORD_RE)) push(match[0]);
  for (const bigram of cjkBigrams(lower)) push(bigram);
  return tokens;
}

/**
 * 写入侧：多字段拼一段再切词（正文 + gist + cues 之类一起进同一文档）。
 * 字段间用换行分隔，避免跨字段拼出假二元组。
 */
export function indexText(...parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => String(part ?? '').trim())
    .filter((part) => part !== '')
    .join('\n');
}

/** 写入侧：token 空格连接，交给 FTS5 unicode61 建索引。 */
export function tokenizeForIndex(text: string): string {
  return tokenize(text).join(' ');
}

/**
 * 查询侧：构造 FTS5 MATCH 表达式（token 引号化后 OR 连接）。
 *
 * 为什么 OR 而不是 AND：中文短句里往往只有一两个词是关键，AND 会把"顺便问一句"
 * 整句拖成零命中；命中多个 token 的文档由 BM25 自然排前。
 *
 * @returns 无可用 token（空串 / 全是虚词）⇒ null，调用方跳过检索
 */
export function buildMatchQuery(raw: string): string | null {
  const tokens = tokenize(raw).filter((token) => !STOP_WORDS.has(token));
  if (tokens.length === 0) {
    // 全被虚词吃掉（如"你 在 吗"）：退回不过滤虚词的 token，宁可宽一点也不给零结果
    const raw2 = tokenize(raw);
    if (raw2.length === 0) return null;
    return raw2.map((token) => `"${token.replaceAll('"', '')}"`).join(' OR ');
  }
  return tokens.map((token) => `"${token.replaceAll('"', '')}"`).join(' OR ');
}