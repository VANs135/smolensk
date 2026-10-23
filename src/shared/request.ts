import type { ZodType } from 'zod'

/**
 * 网络与静态资源请求层
 *
 * 本期为本地热坐对局、无后端服务，本层现行职责：
 *   1. 加载本地 JSON 数据（数据管线校验：异步加载 + Zod 解析）；
 *   2. 加载 public/ 下静态资源（地图位图、算子图档、字体）的二进制读取。
 * 二期接入 FastAPI + WebSocket 时复用同一层：仅需配置 VITE_API_BASE_URL 并新增端点方法。
 *
 * 依赖方向：src/shared 不依赖 Vue / Pinia / 引擎。
 */

/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT = 10_000

/** 请求选项 */
export interface RequestOptions {
  /** 超时毫秒数，默认 10s */
  timeout?: number
  /** 附加请求头 */
  headers?: Record<string, string>
  /** 追加到 URL 的查询参数（null/undefined 自动跳过） */
  query?: Record<string, string | number | boolean | null | undefined>
  /** 覆盖默认基地址（默认取 VITE_API_BASE_URL） */
  baseURL?: string
}

/** 请求失败统一错误：携带 HTTP 状态码与响应体，便于界面定位 */
export class HttpError extends Error {
  readonly status: number
  readonly url: string
  readonly body: unknown

  constructor(status: number, url: string, body: unknown, message = `请求失败（HTTP ${status}）`) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.url = url
    this.body = body
  }
}

/** 拼接基地址、路径与查询参数；未配置 baseURL 时按相对路径处理 */
export function buildUrl(
  path: string,
  query?: RequestOptions['query'],
  baseURL: string = '',
): string {
  const base = (baseURL ?? '').replace(/\/+$/, '')
  const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url
}

/** 核心请求：超时中止 + 非 2xx 归一化为 HttpError，返回 Response */
export async function request(
  path: string,
  init: RequestInit = {},
  options: RequestOptions = {},
): Promise<Response> {
  const controller = new AbortController()
  // 允许调用方传入自己的 signal 时沿用（组合超时与外部取消）
  const externalSignal = init.signal
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // 基地址取调用方覆盖值，其次取环境配置（未配置则为空 → 相对路径）
  const baseURL = options.baseURL ?? (import.meta.env.VITE_API_BASE_URL || '')
  const url = buildUrl(path, options.query, baseURL)

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...options.headers, ...init.headers },
    })
    if (!response.ok) {
      let body: unknown = null
      try {
        body = await response.clone().json()
      } catch {
        body = await response.text()
      }
      throw new HttpError(response.status, url, body)
    }
    return response
  } finally {
    clearTimeout(timer)
  }
}

/** GET JSON：可选 Zod schema 在返回前完成校验；校验失败抛错并携带路径提示 */
export async function getJson<T>(
  path: string,
  schema?: ZodType<T>,
  options?: RequestOptions,
): Promise<T> {
  const response = await request(path, { method: 'GET' }, options)
  const data: unknown = await response.json()
  return schema ? schema.parse(data) : (data as T)
}

/** POST JSON：请求体序列化 + Zod 响应校验 */
export async function postJson<T = void>(
  path: string,
  body?: unknown,
  schema?: ZodType<T>,
  options?: RequestOptions,
): Promise<T> {
  const response = await request(
    path,
    {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    options,
  )
  const data: unknown = await response.json()
  return schema ? schema.parse(data) : (data as T)
}

/** 读静态资源为 Blob（地图位图、图档预加载等；图片直接 <img> 引用时走浏览器缓存，无需本函数） */
export async function loadBlob(path: string, options?: RequestOptions): Promise<Blob> {
  const response = await request(path, { method: 'GET' }, options)
  return response.blob()
}
