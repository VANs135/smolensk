import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * ESLint 扁平配置（门禁第一关）
 *
 * 规则基线：
 * - TS 与 Vue 取推荐集；js 只留错误推荐
 * - 禁用 any（开发规范）；类型导入走 type-only（配 verbatimModuleSyntax）
 * - 末尾合并 Prettier 关闭冲突规则，格式化交给 Prettier 单独把关
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'public/**',
      'coverage/**',
      // 人工备份逐字节原样保存（含事故现场快照），不参与任何格式化/静态检查
      // ——与 `.prettierignore` 同一口径。
      'backup/**',
    ],
  },

  {
    files: ['**/*.{ts,mts,cts,vue}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      ...pluginVue.configs['flat/recommended'],
      eslintConfigPrettier,
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      'no-explicit-any': 'off', // 由下方 TS 规则接管（typescript-eslint 关闭了 js 同名规则）
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      // 掷骰必须可重放：随机一律走 engine/rng.ts（CODE_SPEC §3.3）
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: '禁用 Math.random：随机一律走 engine/rng.ts（CODE_SPEC §3.3）',
        },
      ],
      'vue/multi-word-component-names': ['error', { ignores: ['App'] }],
      'vue/component-name-in-template-casing': [
        'error',
        'PascalCase',
        { registeredComponentsOnly: true },
      ],
    },
  },

  {
    // 构建期 Node 脚本与 ESLint 自身
    //
    // 此前 `scripts/*.mjs` **不在任何规则集内**（实测 `eslint --print-config scripts/sync-units.mjs`
    // 的 rules 与 globals 键数均为 0），于是 CODE_SPEC §3.3「禁用 Math.random」、no-unused-vars
    // 等全部对 14 个脚本无效——而 `npm run lint` 却是绿灯，属假绿。
    files: ['**/*.mjs', '**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // 与 TS 块同口径：随机一律走 engine/rng.ts
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: '禁用 Math.random：随机一律走 engine/rng.ts（CODE_SPEC §3.3）',
        },
      ],
    },
  },

  {
    // Node 侧 TS 配置：vite.config
    files: ['vite.config.ts', 'vitest.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },

  {
    // 测试代码放宽严格性：允许未使用参数等以便断言
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
)
