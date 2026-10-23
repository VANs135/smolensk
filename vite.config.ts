/// <reference types="vitest/config" />
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

  return {
    plugins: [vue()],

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
    },
  }
})
