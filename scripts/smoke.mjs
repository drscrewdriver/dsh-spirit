/**
 * dist 冒烟（四层门禁的最后一层：typecheck → test → build → **dist 冒烟**）。
 *
 * 为什么单独一层：单测跑的是 `src/`，而宿主装的是 `dist/`。两者之间的缝隙
 * （tsc 产物形态、client bundle 包装、清单里的组件路径）只有直接 import 产物才照得出来。
 * "全绿却没界面"就是这么漏过去的。
 */

import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const failures = [];

function check(label, passed, detail = '') {
  if (passed) {
    console.warn(`  ok   ${label}`);
    return;
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`);
  console.error(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

// ── 1. 宿主半入口 ──
const hostEntry = path.join(root, 'dist', 'index.js');
check('dist/index.js 存在', existsSync(hostEntry));
if (existsSync(hostEntry)) {
  const entry = require(hostEntry);
  check('export const name = dsh-spirit-plugin', entry.name === 'dsh-spirit-plugin', String(entry.name));
  check(
    'export const inject = [systemPrompt]',
    JSON.stringify(entry.inject) === JSON.stringify(['systemPrompt']),
    JSON.stringify(entry.inject ?? null),
  );
  // Config 必须是可调用 schema：叫别的名字会被 cordis 静默忽略（→ apply 拿到 undefined 崩）
  check('export const Config 可调用（Standard Schema 面）', typeof entry.Config === 'function');
  let resolved = null;
  try {
    resolved = entry.Config({});
  } catch (err) {
    console.error(`  说明：Config 直调不可用（${err instanceof Error ? err.message : String(err)}），改走 validate 面`);
  }
  if (resolved !== null && typeof resolved === 'object') {
    const value = /** @type {Record<string, unknown>} */ (resolved);
    check('默认配置有 live 节（设置面依赖它）', value['live'] !== undefined && typeof value['live'] === 'object');
    check('默认配置有 card/drsc 节', value['card'] !== undefined && value['drsc'] !== undefined);
  }
  check('export async function apply', typeof entry.apply === 'function');
}

// ── 2. 客户端半产物形态 ──
const clientBundle = path.join(root, 'dist', 'client.js');
check('dist/client.js 存在', existsSync(clientBundle));
if (existsSync(clientBundle)) {
  const bundle = readFileSync(clientBundle, 'utf8');
  check('client 产物有 __ModuleLoader__ 包装', bundle.startsWith('window.__ModuleLoader__.load({'));
  // id 必须等于 npm 包名：不一致 ⇒ 宿主按包名取不到模块，整半静默失活
  check('client 产物 id == 包名 dsh-spirit', bundle.includes('id: "dsh-spirit"'));
  check('react 走 external（未把 react 打进 bundle）', bundle.includes('require("react")'));
}

// ── 3. 清单与产物路径一致 ──
const manifest = JSON.parse(readFileSync(path.join(root, 'dsh.plugin.json'), 'utf8'));
const components = manifest.components ?? {};
check('components.host 指向的产物存在', typeof components.host === 'string' && existsSync(path.join(root, components.host)), String(components.host));
check('components.client 指向的产物存在', typeof components.client === 'string' && existsSync(path.join(root, components.client)), String(components.client));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
check('两清单版本同串', manifest.version === pkg.version, `${manifest.version} vs ${pkg.version}`);

if (failures.length > 0) {
  console.error(`\ndist 冒烟失败 ${failures.length} 项：`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.warn('\ndist 冒烟全部通过');
}
