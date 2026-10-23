/// <reference types="vite/client" />

/**
 * 多环境变量类型声明
 *
 * 与 .env.development / .env.production / .env.example 保持同步；
 * 新增 VITE_ 前缀变量时，必须同时补在此处，否则 import.meta.env 无法获得类型。
 */
interface ImportMetaEnv {
  /** 运行环境标识：开发 / 生产 / 测试 */
  readonly VITE_APP_ENV: 'development' | 'production' | 'test'
  /** 应用标题（index.html <title> 与顶栏共用） */
  readonly VITE_APP_TITLE: string
  /** API 基地址；本期无后端留空，二期 FastAPI 部署时填写 */
  readonly VITE_API_BASE_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
