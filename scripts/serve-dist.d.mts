/**
 * serve-dist.mjs 的 TypeScript 声明（仅供类型检查与测试引用；模块本体为纯 JS）
 *
 * 与 scripts/sync-*.d.mts 同口径：只声明对外可见的常量、纯函数与主流程入口。
 */
import type { Server } from 'node:http'

/** 默认服务根目录 */
export const DEFAULT_ROOT: string
/** 默认绑定地址（回环） */
export const DEFAULT_HOST: string
/** 默认端口（避开 Vite 的 5173） */
export const DEFAULT_PORT: number
/** 端口被占用时的自增重试次数 */
export const DEFAULT_PORT_TRIES: number
/** 扩展名 → MIME 类型映射（只读） */
export const MIME_TYPES: Readonly<Record<string, string>>
/** 未知扩展名的回退 MIME */
export const FALLBACK_MIME: string
/** 入口文件名 */
export const INDEX_FILE: string
/** 哈希产物目录前缀 */
export const HASHED_ASSET_PREFIX: string
/** 哈希产物缓存策略 */
export const IMMUTABLE_CACHE_CONTROL: string
/** 非哈希资源缓存策略 */
export const REVALIDATE_CACHE_CONTROL: string
/** 命令行帮助文本 */
export const HELP_TEXT: string

/** safeResolve 失败原因 */
export type ResolveFailureReason = 'invalid' | 'nul' | 'traversal'

/** safeResolve 结果 */
export type ResolveResult =
  { ok: true; filePath: string } | { ok: false; reason: ResolveFailureReason }

/** 命令行参数解析结果 */
export interface ServeOptions {
  root: string
  host: string
  port: number
  open: boolean
  portTries: number
  help: boolean
}

export function contentTypeFor(filePath: string): string
export function hasFileExtension(urlPath: string): boolean
export function cacheControlFor(urlPath: string): string
export function safeResolve(rootDir: string, urlPath: string): ResolveResult
export function etagFor(stat: { size: number; mtimeMs: number }): string
export function isNotModified(
  headers: Record<string, string | string[] | undefined>,
  etag: string,
): boolean
export function parseArgs(argv: readonly string[]): ServeOptions
export function renderBanner(info: { root: string; host: string; port: number }): string

export function createStaticServer(options: { rootDir: string; quiet?: boolean }): Server
export function listenWithFallback(
  server: Server,
  options: { host: string; port: number; tries?: number },
): Promise<number>
export function openBrowser(url: string, options?: { quiet?: boolean }): boolean
export function assertRootReady(rootDir: string): string
export function main(argv?: readonly string[]): Promise<Server>
