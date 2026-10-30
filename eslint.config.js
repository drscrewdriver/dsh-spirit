import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'lib/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'client/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // 占位参数用 `_` 开头是约定（测试里造长度确定的数组时几乎必然要用到）
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // TS 下交给编译器管名字解析；开着 no-undef 会把 Response/fetch/Buffer 报成未定义
      'no-undef': 'off',
    },
  },
  {
    // 构建脚本跑在 Node，需要真 globals（它不在 TS 里，no-undef 不能关）
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
);
