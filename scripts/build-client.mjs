/**
 * 客户端半构建：client/src(TS) → dist/client.js（单文件 CJS bundle + handoff 包装）。
 *
 * 产物必须符合宿主 handoff 协议（与官方 dsh-client-ui-* 的 lib/client.js 同形）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { …; return module.exports } })
 * —— `id` **必须等于 npm 包名**，不一致会让整半静默失活（宿主按包名取模块，取不到不报错）。
 *
 * react / react-jsx-runtime 必须 external：打进 bundle 会出现两份 react 实例，
 * hooks 立刻炸（Symbol 身份不等）。
 *
 * 末尾的自检不是装饰：这几条各自对应一种"构建成功、装上却没界面"的静默失败形状。
 */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ID = 'dsh-spirit';

const result = await build({
  entryPoints: [path.join(root, 'client/src/entry.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  charset: 'utf8',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
  // 不 minify：插件产物要能被用户打开读懂（"可读性优先"是这类包的既有纪律）
  minify: false,
  legalComments: 'none',
  sourcemap: false,
  write: false,
  logLevel: 'warning',
});

if (result.outputFiles.length === 0) throw new Error('build-client: esbuild 没产出任何文件');

let body = result.outputFiles[0].text;
// "use strict" 放进函数体无害，剥掉保持包装干净
body = body.replace(/^("|')use strict\1;\s*/, '');

const out =
  'window.__ModuleLoader__.load({\n' +
  `\tid: ${JSON.stringify(PLUGIN_ID)},\n` +
  '\tfactory: (require) => {\n' +
  '\t\tvar module = { exports: {} };\n' +
  '\t\tvar exports = module.exports;\n' +
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n' +
  body.replace(/\n/g, '\n\t\t') +
  '\n\t\t// esbuild 的具名导出会整体替换 module.exports（__toCommonJS getter + __esModule）；' +
  '\n\t\t// 摊平成官方 bundle 同款的普通数据属性对象，loader 只按属性读取。' +
  '\n\t\tvar __flat = {};' +
  '\n\t\tfor (var __k in module.exports) __flat[__k] = module.exports[__k];' +
  '\n\t\tObject.defineProperty(__flat, Symbol.toStringTag, { value: "Module" });' +
  '\n\t\treturn __flat;\n' +
  '\t}\n' +
  '});\n';

// ── 产物自检：包装形状、id 一致、纯 CJS、react 走 external ──
if (!out.startsWith('window.__ModuleLoader__.load({')) {
  throw new Error('build-client: 产物缺少协议包装头');
}
if (!out.includes(`id: ${JSON.stringify(PLUGIN_ID)}`)) {
  throw new Error('build-client: 产物 id 与包名不一致（loader 按包名取模块，不一致 = 整半静默失活）');
}
if (/^\s*import[\s{"' ]/m.test(out)) {
  throw new Error('build-client: 产物含裸 import 语句（bundle 必须是纯 CJS 体）');
}
if (!out.includes('require("react")')) {
  throw new Error('build-client: 产物缺少 react 的 require 调用（external 失效，react 被打进来了？）');
}
// 双保险：external 失守时 react 的实现代码会出现在包里
if (out.includes('useSyncExternalStore') && out.includes('__toCommonJS')) {
  const reactImpl = /function useSyncExternalStore\b/mu.test(out);
  if (reactImpl) throw new Error('build-client: 检出 react 实现代码被打进 bundle');
}

await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist/client.js'), out, 'utf8');
console.warn(`client bundle built → dist/client.js (${out.length} bytes)`);
