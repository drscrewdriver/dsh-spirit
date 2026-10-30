/**
 * 注入帧文本工具。
 *
 * `escapeFrame` 不是排版洁癖：宿主用 `<system-reminder>` 框住注入内容，若体验行里
 * 混进了闭合串（来自被引用的会话原文、文件正文、网页文本），那条串会**提前关框**，
 * 框外的部分就被模型当成正文指令读。姊妹包同款做法是转义成 `<\/system-reminder>`。
 */

/** 按 UTF-8 计字节（预算口径与宿主侧 token 估算无关，只保证"进卡的字节数"可控）。 */
export function byteLen(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 把帧内出现的闭合串转义，使注入文本不可能自行关闭 `<system-reminder>` 框。 */
export function escapeFrame(text: string): string {
  return text.replaceAll('</system-reminder>', '<\\/system-reminder>');
}

/** 按码点累加到字节上限（码点迭代天然不劈代理对）。 */
function cutToBytes(text: string, maxBytes: number): string {
  let out = '';
  let used = 0;
  for (const ch of text) {
    const cost = byteLen(ch);
    if (used + cost > maxBytes) break;
    out += ch;
    used += cost;
  }
  return out;
}

/**
 * 按**整行边界**截断到字节预算；首行就装不下时退化为按码点截断。
 *
 * 为什么优先整行：半句体验（"你第三次打断时，我把"）比丢掉整条更伤语义，
 * 而且半句会让下一次同态比较出现难以解释的字节差。
 */
export function truncateToLine(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text === '') return '';
  if (byteLen(text) <= maxBytes) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = byteLen(line) + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxBytes) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length > 0) return kept.join('\n');
  return cutToBytes(lines[0] ?? '', maxBytes);
}
