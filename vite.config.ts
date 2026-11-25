/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'

/**
 * Vite 构建配置
 *
 * - 多环境：按 mode 读取 .env.development / .env.production / .env.local，VITE_ 前缀变量注入客户端
 * - 别名 @ -> src：全部源码经唯一别名引用，路径不因层级漂移
 * - Vitest 与 Vite 共享配置；无 DOM 的纯函数用例用 node 环境
 */
export default defineConfig(({ mode }) => {
  // 仅取 VITE_ 前缀，供构建期使用（客户端变量由 import.meta.env 直接读取）
  loadEnv(mode, process.cwd(), 'VITE_')

  /*
   * ⑧ 日志导出要标明构建来源：构建期抓一次 git 短提交号；
   * 无 git / 非仓库环境退回 'unknown'（不让构建失败）。
   */
  const appCommit = (() => {
    try {
      return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    } catch {
      return 'unknown'
    }
  })()

  return {
    plugins: [vue()],

    define: {
      __APP_COMMIT__: JSON.stringify(appCommit),
    },

    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },

    server: {
      // 热坐本机对局，绑定回环地址，不放行局域网访问
      host: '127.0.0.1',
      port: 5173,
      open: false,
      strictPort: true,
    },

    build: {
      outDir: 'dist',
      target: 'es2022',
      assetsInlineLimit: 4096,
      sourcemap: false,
    },

    // Vitest 配置：与构建共享 alias；默认跑 tests/**/*.test.ts
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'node',
      globals: false,
      restoreMocks: true,
      /*
       * 并行度：CI 固定 4，本地交给 Vitest（本机 20 线程）。
       * 原因：拉满并行时偶发单例 5s 超时（本机两次红在两个不同的 seed-search 用例，
       * 单文件复跑均通过）；4 worker 跑 643 文件 / 6408 例全绿。
       * 要在本地复现 CI 的并行度：VITEST_MAX_WORKERS=4 npm run check
       */
      maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 0) || (process.env.CI ? 4 : undefined),
    },
  }
})
