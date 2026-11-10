/**
 * 模型可写记忆工具（v0.8）：两本账 + 日记 + 目的。
 *
 * 形状照自称工具（tools 服务缺席 ⇒ 不注册；execute 不抛，失败给 reason）。
 * 两条边界写在工具描述里让模型自己守：
 * - **生涯账（life）**：心里话、与主人的约定——全局，跟人格连续性走，pinned 会进人格区。
 * - **工作账（work）**：长期工作的事实/决定/偏好/约定——按工作区隔离（省略 workspaceId = 跨区），
 *   pinned 只进对应工作区的事务卡「记着」段。
 * - **日记（diary）**：按条追加、**不自动注入**，需要时用 recall 按关键词取（或面板看）。
 * 宁少勿滥：一句话记一件事，不抄原文长段。
 */
import type { Context } from '@deepseek-ai/cordis';

import { SPIRIT_TOOL_PREFIX } from '../contract.js';
import type { ModelMemoryStore, GoalStore, GoalStatus } from '../memory/store.js';
import type { MinimalLogger } from '../persona/store.js';

interface ToolsServiceFace {
  register(tool: unknown): (() => void) | Promise<() => void>;
}

// ── 工具定义最小面（与 selfname 同形） ──
function defineTool(face: unknown): unknown {
  return face;
}

function textLine(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }];
}

export function registerMemoryTools(ctx: Context, deps: {
  memory: ModelMemoryStore;
  goals: GoalStore;
  logger: MinimalLogger;
}): void {
  ctx.inject(['tools'], (scope) => {
    const tools = (scope.get('tools') ?? undefined) as ToolsServiceFace | undefined;
    if (tools === undefined || typeof tools.register !== 'function') return;

    const registered = tools.register(defineTool({
      name: `${SPIRIT_TOOL_PREFIX}memory`,
      description:
        '主动记东西到长期记忆（**先想清归属再写**）：' +
        'scope=life 记生涯面的心里话/与主人的约定（全局、跟人格走；pin 后会以「心里记着」进系统提示）；' +
        'scope=work 记长期工作的事实/决定/偏好/约定（按工作区隔离；pin 后只在对应工作区的事务卡「记着」段出现）；' +
        'scope=diary 记日记（**不自动注入**，之后要用靠 recall 按词取）。' +
        '一句话记一件事，不抄长段原文；含密钥/隐私的内容会被拒绝。',
      parameters: {
        action: { type: 'string', description: 'write | pin | unpin | forget | recall | list' },
        scope: { type: 'string', description: 'life | work | diary（write/recall/list 用；省略默认 life）' },
        kind: { type: 'string', description: 'life: bond/promise；work: fact/decision/preference/promise；diary: note' },
        text: { type: 'string', description: 'write 的正文（≤200 字，一句话一件事）' },
        workspaceId: { type: 'string', description: 'work 记忆归属的工作区（cwd）；省略=跨工作区' },
        id: { type: 'string', description: 'pin/unpin/forget 用的记忆 id' },
        q: { type: 'string', description: 'recall 的关键词（文本包含匹配）' },
        limit: { type: 'number', description: 'recall/list 的条数上限（有顶）' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', description: '是否成功' },
            notice: { type: 'string', description: '一句话回执' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  scope: { type: 'string' },
                  kind: { type: 'string' },
                  text: { type: 'string' },
                  pinned: { type: 'boolean' },
                },
                additionalProperties: false,
              },
              description: 'recall/list 的结果',
            },
          },
          additionalProperties: false,
        },
        render: (_args: unknown, value: { notice?: string }) => textLine(value.notice ?? '(no notice)'),
      },
      execute: async (args: Record<string, unknown>) => {
        const action = String(args['action'] ?? '').trim();
        const scopeRaw = String(args['scope'] ?? '').trim();
        const scope = (scopeRaw === '' ? 'life' : scopeRaw) as 'life' | 'work' | 'diary';
        const text = String(args['text'] ?? '');
        const id = String(args['id'] ?? '').trim();
        const q = String(args['q'] ?? '').trim();
        const limitRaw = Number(args['limit']);
        const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
        const workspaceId = typeof args['workspaceId'] === 'string' ? args['workspaceId'] : '';

        if (action === 'write') {
          const wrote = deps.memory.write({ scope, kind: String(args['kind'] ?? ''), text, ...(workspaceId === '' ? {} : { workspaceId }) });
          if (!wrote.ok) return { ok: false, notice: `没记住：${wrote.reason}` };
          deps.logger.info(`[spirit] 模型写入记忆 ${wrote.row.scope}/${wrote.row.kind}：${wrote.row.id}`);
          const where = wrote.row.scope === 'life' ? '生涯账' : wrote.row.scope === 'work' ? '工作账' : '日记';
          return { ok: true, notice: `已记进${where}（${wrote.row.id}）${wrote.row.scope === 'diary' ? '；日记不会自动注入，要用时 recall' : ''}` };
        }
        if (action === 'pin' || action === 'unpin') {
          if (id === '') return { ok: false, notice: 'pin/unpin 需要 id' };
          const okPin = deps.memory.pin(id, action === 'pin');
          return okPin ? { ok: true, notice: action === 'pin' ? '已置顶到注入面' : '已取消置顶' } : { ok: false, notice: '没找到这条记忆（或已遗忘）' };
        }
        if (action === 'forget') {
          if (id === '') return { ok: false, notice: 'forget 需要 id' };
          return deps.memory.forget(id) ? { ok: true, notice: '已遗忘（置标记，不物理删）' } : { ok: false, notice: '没找到这条记忆' };
        }
        if (action === 'recall') {
          if (q === '') return { ok: false, notice: 'recall 需要 q' };
          const items = deps.memory.search(q, { scope, ...(workspaceId === '' ? {} : { workspaceId }), ...(limit === undefined ? {} : { limit }) });
          return { ok: true, notice: items.length === 0 ? '没有匹配的记忆' : `找到 ${items.length} 条`, items: items.map(toItem) };
        }
        if (action === 'list') {
          const items = deps.memory.recent({ scope, ...(workspaceId === '' ? {} : { workspaceId }), ...(limit === undefined ? {} : { limit }) });
          return { ok: true, notice: `${items.length} 条`, items: items.map(toItem) };
        }
        return { ok: false, notice: 'action 必须是 write/pin/unpin/forget/recall/list' };
      },
    }));

    const goalRegistered = tools.register(defineTool({
      name: `${SPIRIT_TOOL_NAME_GOAL}`,
      description:
        '目的层：记录「惦记的事」（长期目标，不是当前 todo）。add=立一个目标（同标的重开会复用）；' +
        'done/drop=结掉或放下；list=看看还惦记着什么。open 状态的目标会以「惦记」段进事务卡（最多 3 条）。',
      parameters: {
        action: { type: 'string', description: 'add | done | drop | list' },
        title: { type: 'string', description: 'add 的目标标题（≤80 字，一句话）' },
        why: { type: 'string', description: 'add 的可选动机（≤200 字）' },
        id: { type: 'string', description: 'done/drop 用的目标 id' },
        workspaceId: { type: 'string', description: '归属工作区（cwd）；省略=跨工作区' },
        limit: { type: 'number', description: 'list 的条数上限' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', description: '是否成功' },
            notice: { type: 'string', description: '一句话回执' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' } },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        render: (_args: unknown, value: { notice?: string }) => textLine(value.notice ?? '(no notice)'),
      },
      execute: async (args: Record<string, unknown>) => {
        const action = String(args['action'] ?? '').trim();
        const workspaceId = typeof args['workspaceId'] === 'string' ? args['workspaceId'] : '';
        const id = String(args['id'] ?? '').trim();
        if (action === 'add') {
          const added = deps.goals.add({ title: String(args['title'] ?? ''), why: String(args['why'] ?? ''), ...(workspaceId === '' ? {} : { workspaceId }) });
          if (!added.ok) return { ok: false, notice: `没立成：${added.reason}` };
          return { ok: true, notice: `惦记上了：${added.row.title}（${added.row.id}）` };
        }
        if (action === 'done' || action === 'drop') {
          if (id === '') return { ok: false, notice: `${action} 需要 id` };
          const okSet = deps.goals.setStatus(id, (action === 'done' ? 'done' : 'dropped') as GoalStatus);
          return okSet ? { ok: true, notice: action === 'done' ? '已结掉' : '已放下' } : { ok: false, notice: '没找到这个目标' };
        }
        if (action === 'list') {
          const items = deps.goals.list({ ...(workspaceId === '' ? {} : { workspaceId }), ...(Number.isFinite(Number(args['limit'])) ? { limit: Number(args['limit']) } : {}) });
          return { ok: true, notice: `${items.length} 个目标`, items: items.map((g) => ({ id: g.id, title: g.title, status: g.status })) };
        }
        return { ok: false, notice: 'action 必须是 add/done/drop/list' };
      },
    }));

    for (const [label, handle] of [['记忆', registered], ['目的', goalRegistered]] as const) {
      void Promise.resolve(handle).catch((err: unknown) => {
        deps.logger.warn(`[spirit] ${label}工具注册失败：${err instanceof Error ? err.message : String(err)}`);
      });
    }
  });
}

const SPIRIT_TOOL_NAME_GOAL = `${SPIRIT_TOOL_PREFIX}goal`;

function toItem(row: { id: string; scope: string; kind: string; text: string; pinned: boolean }): { id: string; scope: string; kind: string; text: string; pinned: boolean } {
  return { id: row.id, scope: row.scope, kind: row.kind, text: row.text, pinned: row.pinned };
}
