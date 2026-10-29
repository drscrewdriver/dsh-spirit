/**
 * Vitest 配置：纯 node 环境，只测纯函数与模块级逻辑（不拉宿主）。
 * client 的 JSX 组件不在本 suite，另由 typecheck 管。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
