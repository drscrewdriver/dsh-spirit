/**
 * 本体层的**入库前置脱敏**（Phase A / TA.3）：读正文进语义层/回填前的第一道闸。
 *
 * 为什么"命中即整段丢弃"而不是"截断/替换"：
 * - 截断可能劈在密钥中间，反而把半截 secret 落进库；
 * - 替换（打码）会把外部内容改写成"看起来像记忆的东西"，污染语义且难追责；
 * - 本体记忆宁缺毋造——一段里疑似含密钥/PII，就整段不产记录，比"存了个打了码的版本"诚实。
 *
 * 这是纵深防御的一层，不替代 `hitsInjection`（那是防指令注入）与 `isSemanticAllowed`（形状闸）：
 * 三者叠加——本层只管"别把机密写进长期记忆并回流上下文"。
 *
 * ⚠️ 假阳取严不取松：11 位手机号 / 18 位身份证这类纯数字模式可能误伤普通数字串，
 * 但"漏放一个真 secret 进库"的代价远大于"多丢一段本可记的内容"。回填历史会话时尤其要保守。
 */

/** 已知机密/PII 形态（大小写口径按各模式；命中任一即判该段含密）。 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/u, // OpenAI/Anthropic 风格 API key
  /\bAKIA[0-9A-Z]{16}\b/u, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}\b/u, // Google API key
  /\bghp_[A-Za-z0-9]{20,}\b/u, // GitHub token
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*\b/iu, // HTTP Bearer
  /-----BEGIN (?:[A-Z ]*)?PRIVATE KEY-----/u, // PEM 私钥头
  /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth)\b\s*[:=]\s*[^\s,;'"`]{6,}/iu, // key=value 形式的机密
  /:\/\/[^/\s:@]+:[^/\s@]+@/u, // URL 内嵌 user:pass
  /\b\d{17}[\dXx]\b/u, // 中国大陆身份证（18 位）
  /\b1[3-9]\d{9}\b/u, // 中国大陆手机号（11 位）
];

/** 是否含疑似机密/PII。命中即调用方应整段丢弃（不入库、不产 card_line/evaluation/delivery）。 */
export function containsSecret(text: string): boolean {
  if (text === '') return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 语义层的"放行否则丢"闸：含密返回 null（丢整段），否则返回原文。
 * 采集/回填侧统一走这个，保证"丢弃"是一个显式动作而非隐式截断。
 */
export function dropIfSecret(text: string): string | null {
  return containsSecret(text) ? null : text;
}
