/**
 * 形状读取工具：从宿主对象上取字段，**取不到就退空值，绝不抛**。
 *
 * 单源在这里的理由：这些读取点散布在采集与对账上，任何一处直接 `as` 断言字段存在，
 * 都会在某个宿主版本上变成"整个 hook 抛穿"（pre-step 抛穿 = 这一轮对话失败）。
 */

/** 取 user/assistant 消息的纯文本正文（非文本块忽略——不看图片、不看工具结果内容）。 */
export function textOfMessage(raw: unknown): string {
  const record = raw as { content?: unknown } | null | undefined;
  const content = record?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    const item = block as { type?: unknown; text?: unknown };
    if (item?.type === 'text' && typeof item.text === 'string') out += item.text;
  }
  return out;
}

/** 取会话 id（宿主各线形状不一：`session.id` / 直接就是字符串）。 */
export function sessionIdOfSession(session: unknown): string {
  if (typeof session === 'string') return session;
  const id = (session as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' ? id : id === undefined ? '' : String(id);
}

/** 从 `agent.session.header` 取工作区标识；取不到退空串（键降级为只用 sessionId）。 */
export function workspaceIdOfAgent(agent: unknown): string {
  const header = (agent as { session?: { header?: Record<string, unknown> } } | null | undefined)?.session?.header;
  if (typeof header !== 'object' || header === null) return '';
  for (const key of ['cwd', 'workspaceId', 'workspace']) {
    const value = header[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/** 沿 parentSession 上溯档位所有者；无父链即自身。 */
export function ownerSessionIdOfAgent(agent: unknown): string {
  const session = (agent as { session?: { header?: { parentSession?: unknown }; id?: unknown } } | null | undefined)?.session;
  const parent = session?.header?.parentSession;
  if (typeof parent === 'string' && parent !== '') return parent;
  if (typeof parent === 'object' && parent !== null) {
    const parentId = (parent as { id?: unknown }).id;
    if (typeof parentId === 'string' && parentId !== '') return parentId;
  }
  const own = session?.id;
  return typeof own === 'string' ? own : '';
}

/** 是否子代理产生的 agent。 */
export function isSubagentAgent(agent: unknown): boolean {
  const record = agent as { origin?: unknown; meta?: { origin?: unknown; parentSession?: unknown } } | null | undefined;
  const origin = record?.origin ?? record?.meta?.origin;
  if (typeof origin === 'string' && origin === 'subagent') return true;
  const parent = record?.meta?.parentSession;
  return typeof parent === 'string' && parent !== '';
}

/**
 * 读会话的**当前模型可见表面**（`session.surface.nodes`）。
 *
 * 为什么不能只信事件：`compaction/end` 并不可靠（CCI 类 compat 摘要路径根本不发这个事件），
 * 漏一次就永久错且无法补算。事件只能当快路径，**表面才是事实**：它直接回答
 * “我那张卡还在不在上下文里”。
 *
 * 拿不到就返回 `undefined` —— **当未知处理**，绝不把"读不到"当"不在"（那会把一次
 * 形状不识别误判成"卡被推走了"，变成不该重发时反复重发）。
 */
export function readSurfaceNodes(session: unknown): ReadonlySet<unknown> | undefined {
  if (typeof session !== 'object' || session === null) return undefined;
  const surface = (session as { surface?: unknown }).surface;
  if (typeof surface !== 'object' || surface === null) return undefined;
  const nodes = (surface as { nodes?: unknown }).nodes;
  if (nodes instanceof Set) return nodes as ReadonlySet<unknown>;
  if (Array.isArray(nodes)) return new Set(nodes as readonly unknown[]);
  return undefined;
}
