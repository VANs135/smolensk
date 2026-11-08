import { defineStore } from 'pinia'

import pkg from '../../package.json'

/**
 * 应用元信息 store
 *
 * 环境变量只经本 store 投影一次，界面不再直接读 import.meta.env。
 * getters 命名遵循 is/has 开头（开发规范）。
 */
export const useAppStore = defineStore('app', () => {
  // ── 环境投影（来自 .env.*，类型见 src/env.d.ts） ──────
  const appEnv = import.meta.env.VITE_APP_ENV
  const appTitle = import.meta.env.VITE_APP_TITLE
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL
  const appVersion = pkg.version
  /**
   * 构建期注入的提交号（vite.config 的 `__APP_COMMIT__`；无 git 环境时退回 'unknown'）。
   * ⑧ 的日志导出用来标明「这份记录出自哪一版构建」。
   */
  const appCommit = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'unknown'

  /** 当前是否为生产环境 */
  const isProduction = appEnv === 'production'

  return { appEnv, appTitle, apiBaseUrl, appVersion, appCommit, isProduction }
})
