/**
 * pack-release.mjs 的 TypeScript 声明（仅供类型检查与测试引用；模块本体为纯 JS）
 */

/** 默认构建产物目录 */
export const DEFAULT_DIST_DIR: string
/** 默认发布包目录 */
export const DEFAULT_RELEASE_DIR: string
/** 发布包内服务器副本文件名 */
export const SERVER_FILE_NAME: string
/** 发布包内双击启动文件名 */
export const LAUNCHER_FILE_NAME: string
/** 构建产物必须存在的顶层条目 */
export const REQUIRED_ENTRIES: readonly string[]
/** 命令行帮助文本 */
export const HELP_TEXT: string

/** 装配参数 */
export interface ReleasePlan {
  distDir: string
  releaseDir: string
  serverSource: string
  serverFile: string
  launcherFile: string
  port: number
}

/** 装配结果 */
export interface ReleaseResult {
  releaseDir: string
  launcherFile: string
  serverFile: string
  files: number
  bytes: number
  port: number
}

/** pack-release 命令行参数 */
export interface PackOptions {
  distDir: string
  releaseDir: string
  port: number
  help: boolean
}

export function renderLauncherBat(options?: { port?: number; serverFile?: string }): string
export function listFiles(rootDir: string): string[]
export function copyTree(srcDir: string, destDir: string): number
export function assertDistReady(distDir: string): string
export function resolveReleasePlan(options: {
  distDir?: string
  releaseDir?: string
  serverSource: string
  port?: number
}): ReleasePlan
export function formatBytes(bytes: number): string
export function directorySize(dir: string): number
export function assembleRelease(options?: {
  distDir?: string
  releaseDir?: string
  port?: number
  serverSource?: string
  clean?: boolean
}): ReleaseResult
export function parseArgs(argv: readonly string[]): PackOptions
export function main(argv?: readonly string[]): ReleaseResult | null
