/**
 * `spirit_selfname` 工具（v0.3.4）：这条鱼的**自称列表允许模型自己增删**。
 *
 * 为什么开这条腿：自称是说话时养出来的习惯——主人教一次不够，模型在对话里
 * 用顺了一个新自称（"本鱼觉得…"），应当能当场把它记下来，而不是等人设页手动同步。
 * 这是人设面**唯一**对模型开放的写字段：名字/语气/在意度/价值/边界都不开
 * （那些是身份与选择器，被对话语境改写是漂移之源；自称恰恰相反，它本来就该随使用沉淀）。
 *
 * 护栏四条：
 * 1. 走 `PersonaStore.save()` 唯一写路径 ⇒ revision 推进、历史追加、md 备份重生，全套纪律免费；
 * 2. 列表有顶（≤8 个、单条 ≤24 字、去重保序，sanitize 同形状）——模型递什么进来都收窄得动；
 * 3. 累积式：add/remove 都精确匹配，没有"整表覆盖"参数（模型不能一把清空身份面）；
 * 4. 总闸 `config.enabled=false` ⇒ 根本不注册（零副作用纪律，关闸时模型看不见这个工具）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';

import { SPIRIT_TOOL_PREFIX } from '../contract.js';
import type { MinimalLogger } from '../persona/store.js';
import { PERSONA_LIMITS } from '../persona/types.js';
import type { PersonaStore } from '../persona/store.js';

interface ToolsServiceFace {
  register(tool: unknown): (() => void) | Promise<() => void>;
}

/** 纯合并逻辑（单测直调，不依赖 ctx/宿主）：remove 精确删、add 追加，去重保序、有顶。 */
export function mergeSelfNames(current: readonly string[], add: readonly string[], remove: readonly string[]): string[] {
  const removed = new Set(remove.map((item) => item.trim()).filter((item) => item !== ''));
  const kept = current.filter((item) => !removed.has(item));
  const next = [...kept, ...add.map((item) => item.trim()).filter((item) => item !== '')];
  return [...new Set(next)]
    .map((item) => item.slice(0, PERSONA_LIMITS.aliasChars))
    .slice(0, PERSONA_LIMITS.selfNames);
}

/** 逗号/顿号/分号/空白宽进（与 client 昵称输入同一条分隔纪律）。 */
function splitWords(value: unknown): string[] {
  return typeof value === 'string' ? value.split(/[、,，;；\s]+/u).map((item) => item.trim()).filter((item) => item !== '') : [];
}

/** 注册工具；返回 disposer。tools 服务缺席（老宿主线）⇒ 调用方不会走到这里。 */
export function registerSelfNameTool(ctx: Context, deps: { personas: PersonaStore; logger: MinimalLogger }): void {
  ctx.inject(['tools'], (scope) => {
    const tools = (scope.get('tools') ?? undefined) as ToolsServiceFace | undefined;
    if (tools === undefined || typeof tools.register !== 'function') return;
    const registered = tools.register(defineTool({
      name: `${SPIRIT_TOOL_PREFIX}selfname`,
      description:
        '增删这条鱼的自称列表（它说话时用来指代自己的词，如「我」「本鱼」「鱼鱼」）。' +
        '列表会以 [自称] 行注入系统提示；主人能在人设页看到并修改，历史版本会留档。' +
        '当你用顺了一个新自称，或主人纠正了自称（“以后别说本鱼了”），就用这个工具把它记下来。',
      parameters: {
        add: { type: 'string', description: '要新增的自称，用、或逗号分隔（单条 ≤24 字，列表上限 8 个）' },
        remove: { type: 'string', description: '要移除的自称（精确匹配），用、或逗号分隔；省略则只增不删' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', description: '是否写入成功' },
            selfNames: { type: 'array', items: { type: 'string' }, description: '更新后的自称全量列表' },
            revision: { type: 'number', description: '人设新版本号' },
            notice: { type: 'string', description: '给人看的一句话回执' },
          },
          additionalProperties: false,
        },
        render: (_args: { add?: string; remove?: string }, value: { notice?: string }) => [{ type: 'text', text: value.notice ?? '(no notice)' }],
      },
      execute: async (args: { add?: string; remove?: string }) => {
        const add = splitWords(args['add']);
        const remove = splitWords(args['remove']);
        const current = deps.personas.current();
        if (add.length === 0 && remove.length === 0) {
          return { ok: false, selfNames: current.selfNames, revision: current.revision, notice: 'add 与 remove 都是空的，什么都没做' };
        }
        const next = mergeSelfNames(current.selfNames, add, remove);
        const saved = deps.personas.save({ ...current, selfNames: next });
        if (!saved.ok) {
          return { ok: false, selfNames: current.selfNames, revision: current.revision, notice: `自称保存失败：${saved.reason}` };
        }
        deps.logger.info(`[spirit] 模型更新自称列表（rev ${saved.persona.revision}）`);
        return {
          ok: true,
          selfNames: next,
          revision: saved.persona.revision,
          notice: `自称已记为：${next.join('、') === '' ? '（空，回到默认自称）' : next.join('、')}`,
        };
      },
    }));
    void Promise.resolve(registered).catch((err: unknown) => {
      deps.logger.warn(`[spirit] 自称工具注册失败（人设页仍可改自称）：${err instanceof Error ? err.message : String(err)}`);
    });
  });
}
