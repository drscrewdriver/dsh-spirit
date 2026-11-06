/**
 * Vitest 配置：纯 node 环境，只测纯函数与模块级逻辑（不拉宿主）。
 * client 的 JSX 组件**渲染**不在本 suite（另由 typecheck 管）；但入口的**座位判定**是
 * 纯逻辑且属静默失败面，必须能测——于是把依赖链上唯一缺的 react 运行时指到桩。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // 正则精确匹配：字符串 alias 是前缀匹配，会把 react/jsx-runtime 一起带进桩里
      { find: /^react$/u, replacement: path.join(root, 'tests/stubs/react-stub.ts') },
      { find: /^react\/jsx-runtime$/u, replacement: path.join(root, 'tests/stubs/react-stub.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
