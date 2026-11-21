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
      /*
       * 安卓壳：`android/` 由 `cap add android` 生成，里面既有 Gradle 模板、
       * 也有 `cap sync` 每次覆盖的 `assets/public`（dist 的副本）。
       * 对它跑 lint/format 只会得到一堆"别人的代码不合规范"。
       */
      'android/**',
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
      // 模板里用到的组件必须真的被 import/注册：漏 import 时 Vue 只在**运行时**打
      // `Failed to resolve component` 警告并渲染成空标签（实测 AirPanel 的 SessionStep、
      // OpsFlowPanel 的 OpsLossPicker、ReinforcementPanel 的 CounterPicker 都漏了），
      // 静态关把这类"看不见的空白"拦在门禁里。
      'vue/no-undef-components': 'error',
      'vue/component-name-in-template-casing': [
        'error',
        'PascalCase',
        { registeredComponentsOnly: true },
      ],
    },
  },

  {
    /*
     * 其它 stores 的层间约束：**类型导入放行**（如 ui.ts 只 `import type { ViewName }`），
     * 值导入一律禁止 —— 用 allowTypeImports 避免误伤既有类型依赖。
     * 注意：本块必须排在下面的"切片"块之前，否则会覆盖切片的 ./workbench 禁令。
     */
    files: ['src/stores/**/*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@/components', message: 'stores 不得 import 组件层', allowTypeImports: true },
            { name: '@/views', message: 'stores 不得 import 视图层', allowTypeImports: true },
          ],
          patterns: [
            {
              group: ['@/components/**'],
              message: 'stores 不得 import 组件层',
              allowTypeImports: true,
            },
            { group: ['@/views/**'], message: 'stores 不得 import 视图层', allowTypeImports: true },
          ],
        },
      ],
    },
  },

  {
    /*
     * 解构的机器闸（docs/specs/2026-11-20-workbench解构/ §8）：
     *   ① max-lines —— 起手按现值卡住、只降不升；每落地一批就把数字下调到实测值；
     *   ② 切片不得从 facade 取值或取类型（类型一律走 ./workbench-model）。
     * 下列阈值均为 2026-11-21 实测值 + 5 行余量，只许改小。
     */
    files: ['src/stores/workbench-*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'max-lines': ['error', { max: 2005, skipBlankLines: false, skipComments: false }],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: './workbench',
              message: '切片不得从 facade 取值（类型请走 ./workbench-model）',
            },
            { name: '@/components', message: 'stores 不得 import 组件层' },
            { name: '@/views', message: 'stores 不得 import 视图层' },
          ],
          patterns: [
            { group: ['@/components/**'], message: 'stores 不得 import 组件层' },
            { group: ['@/views/**'], message: 'stores 不得 import 视图层' },
          ],
        },
      ],
    },
  },

  {
    // 空军切片拆分前的临时豁免：B2-4 拆成 air / air-mission / air-state 后删掉本块
    files: ['src/stores/workbench-air.ts'],
    rules: { 'max-lines': ['error', { max: 3384, skipBlankLines: false, skipComments: false }] },
  },

  {
    // model 拆分前的临时卡口（目标：类型 ≤1,000 + 纯函数 ≤800）
    files: ['src/stores/workbench-model.ts'],
    rules: { 'max-lines': ['error', { max: 4213, skipBlankLines: false, skipComments: false }] },
  },

  {
    // facade：每搬完一批必须把 27542 下调到实测值（只降不升）
    files: ['src/stores/workbench.ts'],
    rules: { 'max-lines': ['error', { max: 27277, skipBlankLines: false, skipComments: false }] },
  },

  {
    // engine 只依赖纯逻辑：不许碰框架、store 与渲染层
    files: ['src/engine/**/*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'max-lines': ['error', { max: 2320, skipBlankLines: false, skipComments: false }],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['vue', 'pinia', '@/stores', '@/stores/**', '@/render', '@/render/**'],
              message: 'engine 不得依赖框架、store 与渲染层',
            },
          ],
        },
      ],
    },
  },

  {
    // 组件行预算（ReinforcementPanel 为既成事实的临时豁免，拆完删）
    files: ['src/components/**/*.vue', 'src/views/**/*.vue'],
    rules: { 'max-lines': ['error', { max: 1605, skipBlankLines: false, skipComments: false }] },
  },

  {
    files: ['src/components/reinforcement/ReinforcementPanel.vue'],
    rules: { 'max-lines': ['error', { max: 1761, skipBlankLines: false, skipComments: false }] },
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
