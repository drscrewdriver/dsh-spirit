/**
 * 兼容闸门预检（计划 task_7.6）：逐条目标宿主线核对**两份**声明能否被满足。
 *
 * 为什么这条必须存在、且两件事都要查：
 * 1. 本地宿主树（0.2.0-rc.2）实测兼容裁决读的是 `peerDependencies`，README 明写
 *    "不是 `engines.dsh`"；旧认知"闸门只读 engines.dsh"在新线才成立。
 *    **只写一处 = 在某条线上静默装不上或被拒载**，所以 peers 与 engines.dsh 都要过。
 * 2. 版本串是人手维护的，漏一条或多一条不会有任何地方报错——只有这条脚本会。
 *
 * 声明策略（宽 range 也要有界）：允许 `>=0.2.0-rc.1 <0.3.0` 这类紧凑区间省掉逐线枚举，
 * 但 range 必须整体落在 0.2.x——不得把未实测的 0.1.x/0.3.0+ 一并承诺出去，也不得漏掉
 * 0.2.0 起点。越界的"看着覆盖全部"宽 range 仍判红（比窄而真更坏这条没变）。
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import * as semver from 'semver';

/** 目标宿主线：与 engines.dsh 同源，改动需两边一起改（本脚本正是用来抓这件事的）。 */
export const TARGET_HOSTS = [
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.1-rc.1',
  '0.2.1-rc.2',
  '0.2.1-rc.3',
  '0.2.1-rc.4',
  '0.2.1-rc.5',
];

/** 只允许承诺 0.2.x：range 必须含 0.2.0 起点、且不得命中下列界外探针（未实测线）。 */
const IN_SCOPE_PROBE = '0.2.0';
const OUT_OF_SCOPE_PROBES = ['0.1.9', '0.3.0', '0.4.0'];

/** range 是否整体落在 0.2.x 内（含预发布语义，与宿主裁决口径一致）。 */
function rangeStaysIn02x(range) {
  if (!semver.validRange(range)) return false;
  const opts = { includePrerelease: true };
  if (!semver.satisfies(IN_SCOPE_PROBE, range, opts)) return false;
  return OUT_OF_SCOPE_PROBES.every((probe) => !semver.satisfies(probe, range, opts));
}

export function readManifests(cwd = process.cwd()) {
  const pkg = JSON.parse(readFileSync(new URL('package.json', `file://${cwd}/`), 'utf8'));
  const manifest = JSON.parse(readFileSync(new URL('dsh.plugin.json', `file://${cwd}/`), 'utf8'));
  return { pkg, manifest };
}

/**
 * @returns 每条问题一句人话；空数组 = 全绿。
 */
export function checkCompat(pkg, manifest, hosts = TARGET_HOSTS) {
  const problems = [];
  const enginesDsh = pkg?.engines?.dsh;
  const manifestEnginesDsh = manifest?.engines?.dsh;
  const peers = pkg?.peerDependencies ?? {};
  const optionalFlags = pkg?.peerDependenciesMeta ?? {};

  if (typeof enginesDsh !== 'string' || enginesDsh.trim() === '') problems.push('package.json engines.dsh 缺失或为空');
  if (manifestEnginesDsh !== enginesDsh) problems.push('engines.dsh 两文件不同串（部署面按逐字串裁决）');
  if (pkg?.version !== manifest?.version) problems.push(`版本不同串：package.json ${pkg?.version} vs dsh.plugin.json ${manifest?.version}`);

  // 界约束取代旧的逐段前缀检查：允许 `>=0.2.0-rc.1 <0.3.0` 这类宽 range，只要整体不溢出 0.2.x。
  if (!rangeStaysIn02x(String(enginesDsh ?? ''))) {
    problems.push(`engines.dsh 越界：range 必须整体落在 0.2.x（含 ${IN_SCOPE_PROBE}、不得命中 ${OUT_OF_SCOPE_PROBES.join('/')}）：${enginesDsh}`);
  }
  for (const [name, range] of Object.entries(peers)) {
    if (name.startsWith('@deepseek-ai/dsh') && !rangeStaysIn02x(String(range))) {
      problems.push(`peer ${name} 的 range 越界（必须整体落在 0.2.x 内）：${range}`);
    }
  }

  for (const host of hosts) {
    let satisfied;
    try {
      satisfied = semver.satisfies(host, String(enginesDsh ?? ''), { includePrerelease: true });
    } catch (err) {
      problems.push(`engines.dsh 不是合法 range（${err instanceof Error ? err.message : String(err)}）`);
      break;
    }
    if (!satisfied) problems.push(`engines.dsh 不覆盖目标线 ${host}`);

    // 本包声明的每个 dsh peer 也必须能被该线满足（裁决读的是 peers，不是 engines）
    for (const [name, range] of Object.entries(peers)) {
      if (name.startsWith('@deepseek-ai/dsh') && !semver.satisfies(host, String(range), { includePrerelease: true })) {
        problems.push(`peer ${name}@${range} 在 ${host} 上不满足`);
      }
      if (optionalFlags[name]?.optional !== true) {
        problems.push(`peer ${name} 必须在 peerDependenciesMeta 标 optional（未标的 peer 会让装配失败变成硬失败）`);
      }
    }
  }

  const node = pkg?.engines?.node;
  if (node !== '>=22.16.0') problems.push(`engines.node 应为 >=22.16.0（node:sqlite 内置的门槛），当前 ${node}`);
  return problems;
}

// 被当脚本直接跑时才自检（被测试 import 时不得改 process.exitCode）
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const { pkg, manifest } = readManifests();
  const problems = checkCompat(pkg, manifest);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`compat: ${problem}`);
    process.exitCode = 1;
  } else {
    console.warn(`compat: 全绿（${TARGET_HOSTS.length} 条宿主线 × engines.dsh + peers 双查）`);
  }
}
