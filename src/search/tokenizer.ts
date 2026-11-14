/**
 * 分词器装配：jieba 词级分词（`@node-rs/jieba`，可选原生依赖）优先，
 * 加载失败（平台无预编译二进制 / 用户没装可选包）**永久回退 CJK 二元组**。
 *
 * 为什么可选而不是硬依赖：本包的包体闸与「零新依赖」纪律（同 `entry_vector` 锁死
 * sqlite-vec 的先例）——分词是**增强**不是运行前提；缺了它检索退化成二元组，功能不消失。
 *
 * 三条纪律：
 * 1. **惰性单例**：首次调用即定死本进程的模式，运行中不漂移——FTS 写入侧与查询侧共用
 *    同一实例，索引 token 与查询 token 天然对齐；
 * 2. **永不抛出**：装配失败只降级（与 `openSpiritDb` 的降级哲学一致）；
 * 3. **版本戳**：`jieba-v1` / `bigram-v1` 是 FTS 重建的触发键（见 `search/fts.ts`）。
 *    戳必须如实反映"构建当前索引的分词器"——换了分词器却不换戳，索引与查询就会错位。
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export type TokenizerMode = 'jieba' | 'bigram';

interface JiebaLike {
  cut(sentence: string, hmm?: boolean): string[];
}

let mode: TokenizerMode | undefined;
let cutFn: ((text: string) => string[]) | undefined;

/** 惰性初始化（永不抛出）。词典约 5MB，首次加载 ~100ms。 */
function ensure(): TokenizerMode {
  if (mode !== undefined) return mode;
  try {
    const mod = nodeRequire('@node-rs/jieba') as { Jieba: { withDict(dict: Uint8Array): JiebaLike } };
    const dictMod = nodeRequire('@node-rs/jieba/dict') as { dict: Uint8Array };
    const jieba = mod.Jieba.withDict(dictMod.dict);
    cutFn = (text: string) => jieba.cut(text, true);
    mode = 'jieba';
  } catch {
    cutFn = undefined;
    mode = 'bigram';
  }
  return mode;
}

/** 当前模式（启动横幅 / 面板诊断用）。 */
export function tokenizerMode(): TokenizerMode {
  return ensure();
}

/** 分词器版本戳：FTS 重建的唯一触发键。 */
export function tokenizerStamp(): string {
  return ensure() === 'jieba' ? 'jieba-v1' : 'bigram-v1';
}

/** 人话描述（日志用）。 */
export function describeTokenizer(): string {
  return ensure() === 'jieba'
    ? 'jieba 词级分词（@node-rs/jieba）+ CJK 二元组并集'
    : 'jieba 不可用，回退 CJK 二元组分词（子词召回降级，功能不受影响）';
}

/** jieba 切词；回退模式下返回 undefined，调用方走二元组路径。 */
export function jiebaCut(text: string): string[] | undefined {
  return ensure() === 'jieba' ? cutFn?.(text) : undefined;
}

/**
 * 测试注入：给一个假切词器（`undefined` = 恢复真实装配）。
 *
 * 为什么需要：仓库里不一定装了可选原生依赖，而"词元 ∪ 二元组"的并集语义必须可测——
 * 否则 CI 永远只测到回退路径。
 */
export function __setCutForTest(fn?: (text: string) => string[]): void {
  if (fn === undefined) {
    mode = undefined;
    cutFn = undefined;
    return;
  }
  mode = 'jieba';
  cutFn = fn;
}