/**
 * 兼容闸门预检（计划 task_7.6）：逐条目标宿主线核对**两份**声明能否被满足。
 *
 * 为什么这条必须存在、且两件事都要查：
 * 1. 本地宿主树（0.2.0-rc.2）实测兼容裁决读的是 `peerDependencies`，README 明写
 *    "不是 `engines.dsh`"；旧认知"闸门只读 engines.dsh"在新线才成立。
 *    **只写一处 = 在某条线上静默装不上或被拒载**，所以 peers 与 engines.dsh 都要过。
 * 2. 版本串是人手维护的，漏一条或多一条不会有任何地方报错——只有这条脚本会。
 *
 * 故意写得严格：`<0.2.0-0` 这类"看起来覆盖全部"的宽 range 会被判红，
 * 因为它会连带把未实测的老线承诺出去（比窄而真更坏）。
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import * as semver from 'semver';

/** 目标宿主线：与 engines.dsh 同源，改动需两边一起改（本脚本正是用来抓这件事的）。 */
export const TARGET_HOSTS = [
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.1-rc.1',
  '0.2.1-rc.2',
  '0.2.1-rc.3',
  '0.2.1-rc.4',
];

/** 只有已实测的 0.2.x 线可以承诺；老线缺 producer-owned kind 与 systemPrompt.section。 */
const ALLOWED_PREFIX = '0.2.';

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

  for (const line of String(enginesDsh ?? '').split('||').map((s) => s.trim()).filter(Boolean)) {
    if (!line.startsWith(ALLOWED_PREFIX)) problems.push(`engines.dsh 含未实测的宽声明：${line}（只允许承诺 ${ALLOWED_PREFIX}x 已验证线）`);
  }

  for (const host of hosts) {
    let satisfied = false;
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

const isCli = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '');
if (isCli) {
  const { pkg, manifest } = readManifests();
  const problems = checkCompat(pkg, manifest);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`compat: ${problem}`);
    process.exitCode = 1;
  } else {
    console.warn(`compat: 全绿（${TARGET_HOSTS.length} 条宿主线 × engines.dsh + peers 双查）`);
  }
}
