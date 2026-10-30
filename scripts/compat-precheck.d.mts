/** 兼容预检的声明面（脚本本体是 .mjs，测试与 CLI 共用）。 */

export declare const TARGET_HOSTS: readonly string[];

export declare function readManifests(cwd?: string): {
  pkg: Record<string, unknown>;
  manifest: Record<string, unknown>;
};

export declare function checkCompat(
  pkg: {
    engines?: { dsh?: string; node?: string };
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  },
  manifest: { engines?: { dsh?: string }; version?: string },
  hosts?: readonly string[],
): string[];
