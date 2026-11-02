/**
 * 条件化 bias（刀4）：强负体验给同类动作短期抑制——**只经卡文本通道**。
 *
 * 边界自证（为什么这不是"改变 agent 行为的钩子"）：
 * - 不触碰 decision、不注册 restrict/guard/waterfall、不改系统提示控制面；
 * - 输出只有档位词（与 grid.tendency 同族的查表短语），无任何数值对外——
 *   伪精确双闸（无 toFixed、卡无浮点）对它同样生效；
 * - 存储是「可重算派生缓存」（action_bias 表，turn/end 冷路径写），不是经历真源；
 *   删光可以从 experience 重建。pre-step 只做 O(1) 查表，禁扫表（每轮现算
 *   等价 LIKE 全扫，是对"对话延迟永远比少一条回忆贵"的直接违背）。
 *
 * 语义：上次那手没成 ⇒ 这次对同名动作先犹豫一下。这是体验的下游形态（经典条件化），
 * 不是事实召回——它不复述条目内容，只改"我现在怎么说"。
 */

/** band 取值域（与 ExperienceEntry.reaction 的负向档对齐；0/undefined = 无条件化）。 */
export const BIAS_HESITANT = 1 as const;
export const BIAS_GUARDED = 2 as const;

/** 查表面：band → 行为倾向短语（第一人称、可执行、无时间数——不伪造"三天前"）。 */
const BIAS_TENDENCY: Readonly<Record<number, string>> = {
  [BIAS_HESITANT]: '那手我再遇上的话，先确认一步再走',
  [BIAS_GUARDED]: '那手我上次栽过，这次先绕开它试别的',
};

/** 读侧依赖：由 index 注入（store 查表实现），测试直接传闭包。 */
export type BiasReader = (actionKey: string) => number | undefined;

/**
 * 选最强的条件化档：读表失败/缺席 ⇒ undefined（不编造"有教训"）。
 *
 * @param cfg 生效配置（`bias.enabled` 关时恒 undefined——与 fadeEnabled 同一灰度闸链）
 * @param fallbackBands 乘子通道已收好的 trigger→band 集：动作键不在候选池（如纯工具步）时
 *        退而用它——两通道同源同表，不新增输入
 */
export function readBias(
  cfg: { bias: { enabled: boolean } },
  reader: BiasReader | undefined,
  actionKeys: Iterable<string>,
  fallbackBands?: ReadonlyMap<string, number>,
): number | undefined {
  if (!cfg.bias.enabled || reader === undefined) return undefined;
  let top: number | undefined;
  for (const key of actionKeys) {
    if (key === '') continue;
    const band = reader(key);
    if (typeof band !== 'number' || !Number.isFinite(band) || band <= 0) continue;
    if (top === undefined || band > top) top = band;
  }
  if (top !== undefined) return top;
  if (fallbackBands !== undefined) {
    for (const band of fallbackBands.values()) {
      if (typeof band === 'number' && band > 0 && (top === undefined || band > top)) top = band;
    }
  }
  return top;
}

/** band → 倾向短语；未命中表/关闭 ⇒ undefined（卡照旧用网格自带倾向）。 */
export function biasTendency(band: number | undefined): string | undefined {
  if (band === undefined) return undefined;
  return BIAS_TENDENCY[band];
}
