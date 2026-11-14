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
import { defineTool } from '@deepseek-ai/dsh-tools';

import { SPIRIT_TOOL_PREFIX } from '../contract.js';
import type { DistillDigestRow, SpiritEntityDigestResult } from '../contract.js';
import type { ModelMemoryStore, GoalStore, GoalStatus } from '../memory/store.js';
import type { MinimalLogger } from '../persona/store.js';
import { recentLines } from '../prime/recent.js';

interface ToolsServiceFace {
  register(tool: unknown): (() => void) | Promise<() => void>;
}

// 工具定义走宿主 `defineTool`（v0.8.23 修复）：它会把 parameters 规范化为 JSON Schema；
// 之前这里用的是本地 identity 函数，裸字段表被当 schema 发给上游 ⇒ 400 invalid schema。

function textLine(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }];
}

export function registerMemoryTools(ctx: Context, deps: {
  memory: ModelMemoryStore;
  goals: GoalStore;
  logger: MinimalLogger;
  /** 生涯流程档读取器（v0.8.18）：三档（week/month/milestone）；未生成 ⇒ 空。知识性归上游，不在本档。 */
  digests?: () => DistillDigestRow[];
  /** 按实体查三档（v0.8.18）：实体对齐后可返回该实体的流程行 + 知识引用计数。 */
  entityDigest?: (entity: string, limit?: number) => SpiritEntityDigestResult;
}): void {
  ctx.inject(['tools'], (scope) => {
    const tools = (scope.get('tools') ?? undefined) as ToolsServiceFace | undefined;
    if (tools === undefined || typeof tools.register !== 'function') return;

    /**
     * 时间性问题入口（v0.8.22）：`spirit_history` 与 `action=recent` 共用。
     * 读三档流程档（按 days 选 week/month + 里程碑） + 窗口内的自写记忆；不占 memory_search 配额。
     */
    const runRecent = (args: Record<string, unknown>): { ok: boolean; notice: string; items: Array<Record<string, unknown>> } => {
      const daysRaw = Number(args['days']);
      const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(365, Math.floor(daysRaw))) : 7;
      const q = String(args['q'] ?? '').trim();
      const limitRaw = Number(args['limit']);
      const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
      const lines = recentLines(deps.digests?.() ?? [], { days, ...(q === '' ? {} : { q }), ...(limit === undefined ? {} : { limit }) });
      const since = Date.now() - days * 86_400_000;
      const selfItems = deps.memory
        .recent({ scope: 'life', ...(limit === undefined ? {} : { limit }) })
        .filter((row) => row.updatedAt >= since)
        .map((row) => ({ ...toItem(row), source: 'self' }));
      const items = [
        ...selfItems,
        ...lines.map((entry, index) => ({ id: `recent-${entry.tier}-${index}`, scope: 'distill', kind: entry.tier, text: entry.line, pinned: false, source: 'digest' })),
      ];
      const notice = items.length === 0
        ? `近 ${days} 天没有流程档/自写记录；事实/方法论请用 memory_search`
        : `近 ${days} 天：流程档 ${lines.length} 行 + 自写 ${selfItems.length} 条（里程碑只增不改）`;
      return { ok: true, notice, items };
    };

    const registered = tools.register(defineTool({
      name: `${SPIRIT_TOOL_PREFIX}memory`,
      description:
        // 首句就是边界声明：与上游 memory_add 语义重叠时，模型先看到"归谁"再看到"怎么用"
        '**只写生涯账/工作账/日记/对话细节**；事实、方法论、踩坑、项目规则、偏好一律用上游 `memory_search`/`memory_add`（知识性归它，本工具不存知识副本，避免双真源）。' +
        '先想清归属再写：' +
        'scope=life 记生涯面的心里话/与主人的约定（全局、跟人格走；pin 后会以「心里记着」进系统提示）；' +
        'scope=work 记长期工作的事实/决定/偏好/约定（按工作区隔离；pin 后只在对应工作区的事务卡「记着」段出现）；' +
        'scope=diary 记日记（**不自动注入**，之后要用靠 recall 按词取）；' +
        'scope=episode 记对话细节（主人原话/承诺/关键上下文，一句话≤200 字；**不自动注入**，靠 recall 取）；' +
        '一句话记一件事，不抄长段原文；含密钥/隐私的内容会被拒绝。' +
        '查「这周/最近做了什么」用 **spirit_history**（时间性问题，不占 memory_search 配额）；' +
        '查事实/方法论/踩坑/项目规则用上游 **memory_search**（知识性归它）；本工具的 recall 适合按关键词找自写记忆 + 流程档。',
      parameters: {
        action: { type: 'string', required: true, description: 'write | pin | unpin | forget | recall | list | recent' },
        scope: { type: 'string', description: 'life | work | diary | episode（write/recall/list 用；省略默认 life）' },
        kind: { type: 'string', description: 'life: bond/promise；work: fact/decision/preference/promise；diary: note；episode: detail' },
        text: { type: 'string', description: 'write 的正文（≤200 字，一句话一件事）' },
        workspaceId: { type: 'string', description: 'work 记忆归属的工作区（cwd）；省略=跨工作区' },
        id: { type: 'string', description: 'pin/unpin/forget 用的记忆 id' },
        q: { type: 'string', description: 'recall 的关键词（文本包含匹配）' },
        limit: { type: 'number', description: 'recall/list 的条数上限（有顶）' },
        source: { type: 'string', description: 'recall/list 的范围：self（自写两本账+日记）| procedural（生涯流程档/预总结）| all（默认）；knowledge 会提示改用 memory_search' },
        days: { type: 'number', description: '流程档回看天数说明（档本身按 7/30 天窗口 + 里程碑预总结）' },
        entity: { type: 'string', description: '按实体（名/别名）查该实体的生涯流程档；知识性只回计数，正文用 memory_search' },
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
                  source: { type: 'string', description: 'self | digest' },
                  tsMs: { type: 'number' },
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
        const sourceRaw = String(args['source'] ?? '').trim().toLowerCase();
        const wantsKnowledge = sourceRaw === 'knowledge' || sourceRaw === 'fact' || sourceRaw === 'knowledge_base';
        const source: 'self' | 'procedural' | 'all' =
          sourceRaw === 'self' ? 'self'
            : sourceRaw === 'procedural' || sourceRaw === 'l1' ? 'procedural'
              : 'all';
        const entity = String(args['entity'] ?? '').trim();
        /** 生涯流程档（预总结，三档）→ 条目；entity 给定时按该实体过滤。 */
        const digestItems = (): Array<{ id: string; scope: string; kind: string; text: string; pinned: boolean; source: string }> => {
          if (source === 'self') return [];
          const out: Array<{ id: string; scope: string; kind: string; text: string; pinned: boolean; source: string }> = [];
          if (entity !== '') {
            const scoped = deps.entityDigest?.(entity, 3);
            if (scoped === undefined) return out;
            for (const digest of scoped.digests) {
              for (const line of digest.lines) {
                if (q !== '' && !line.includes(q)) continue;
                out.push({ id: `digest-${digest.tier}-${digest.periodKey}`, scope: 'distill', kind: digest.tier, text: line, pinned: false, source: 'digest' });
              }
            }
            return out;
          }
          for (const digest of deps.digests?.() ?? []) {
            for (const line of digest.summary.split('\n')) {
              if (line.trim() === '') continue;
              if (q !== '' && !line.includes(q)) continue;
              out.push({ id: `digest-${digest.tier}-${digest.periodKey}`, scope: 'distill', kind: digest.tier, text: line, pinned: false, source: 'digest' });
            }
          }
          return out;
        };

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
          if (wantsKnowledge) {
            return { ok: true, notice: '知识性记忆归上游记忆插件（用 memory_search 查）；spirit 只存生涯流程档', items: [] };
          }
          if (q === '') return { ok: false, notice: 'recall 需要 q' };
          // 自写层 + 生涯流程档（预总结，source=digest）：两层各带 source，不混账
          const selfItems = source === 'procedural'
            ? []
            : deps.memory.search(q, { scope, ...(workspaceId === '' ? {} : { workspaceId }), ...(limit === undefined ? {} : { limit }) }).map((row) => ({ ...toItem(row), source: 'self' }));
          const digestRows = digestItems();
          const items = [...selfItems, ...digestRows];
          const notice = items.length === 0
            ? `没有匹配（自写 ${selfItems.length} · 流程档 ${digestRows.length}）；知识性记忆请用 memory_search`
            : `找到 ${items.length} 条（自写 ${selfItems.length} · 流程档 ${digestRows.length}）${entity === '' ? '' : ` · 实体 ${entity} 上游相关知识 ${deps.entityDigest?.(entity, 3)?.knowledgeRefs ?? 0} 条（memory_search）`}`;
          return { ok: true, notice, items };
        }
        if (action === 'list') {
          if (wantsKnowledge) {
            return { ok: true, notice: '知识性记忆归上游记忆插件（用 memory_search 查）；spirit 只存生涯流程档', items: [] };
          }
          const selfItems = source === 'procedural'
            ? []
            : deps.memory.recent({ scope, ...(workspaceId === '' ? {} : { workspaceId }), ...(limit === undefined ? {} : { limit }) }).map((row) => ({ ...toItem(row), source: 'self' }));
          const digestRows = digestItems();
          const items = [...selfItems, ...digestRows];
          return { ok: true, notice: `${items.length} 条（自写 ${selfItems.length} · 流程档 ${digestRows.length}）`, items };
        }
        if (action === 'recent') {
          return runRecent(args);
        }
        return { ok: false, notice: 'action 必须是 write/pin/unpin/forget/recall/list/recent' };
      },
    }));

    // 生涯回顾（v0.8.22）：时间性问题的专职入口——“这周做了什么”不该先走关键词 recall。
    const historyRegistered = tools.register(defineTool({
      name: `${SPIRIT_TOOL_PREFIX}history`,
      description:
        '生涯回顾（时间性问题专用）：问「这周/最近/这段时间做了什么、进展到哪、有哪些里程碑」时**先用我**。' +
        '读预总结的生涯流程档（近 7 天 / 近 30 天 / 里程碑，只增不改），**不占 memory_search 的每轮调用配额**。' +
        '与 memory_search 的分工：事实、方法论、踩坑、项目规则、用户偏好 → 上游 memory_search（知识性）；' +
        '写记忆 → spirit_memory write；按关键词找自写记忆 → spirit_memory recall。',
      parameters: {
        days: { type: 'number', description: '回看天数（默认 7；≤7 给近 7 天档，≤30 加近 30 天档，始终带里程碑）' },
        q: { type: 'string', description: '可选关键词（某个任务/项目名）；时间性问题可省略' },
        limit: { type: 'number', description: '返回行数上限（默认 12，封顶 30）' },
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
                  kind: { type: 'string', description: 'week | month | milestone' },
                  text: { type: 'string' },
                  pinned: { type: 'boolean' },
                  source: { type: 'string', description: 'self | digest' },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        render: (_args: unknown, value: { notice?: string }) => textLine(value.notice ?? '(no notice)'),
      },
      execute: async (args: Record<string, unknown>) => runRecent(args),
    }));

    const goalRegistered = tools.register(defineTool({
      name: `${SPIRIT_TOOL_NAME_GOAL}`,
      description:
        '目的层：记录「惦记的事」（长期目标，不是当前 todo）。add=立一个目标（同标的重开会复用）；' +
        'done/drop=结掉或放下；list=看看还惦记着什么。open 状态的目标会以「惦记」段进事务卡（最多 3 条）。',
      parameters: {
        action: { type: 'string', required: true, description: 'add | done | drop | list' },
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

    for (const [label, handle] of [['记忆', registered], ['生涯回顾', historyRegistered], ['目的', goalRegistered]] as const) {
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


