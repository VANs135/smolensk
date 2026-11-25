/**
 * probe-ui.mjs 的 TypeScript 声明（仅为用例与类型检查引用；模块本体为纯 JS）
 *
 * 与 scripts/serve-dist.d.mts 同口径：只声明对外入口与纯函数。
 */
import type { Browser, Page } from 'playwright-core'

export const PROBE_DEFAULT_PORT: number
export const PROBE_DEFAULT_OUT: string
export const PROBE_DEFAULT_SCENARIO: string
export const HELP_TEXT: string

/** 命令行参数解析结果 */
export interface ProbeOptions {
  dist: string
  out: string
  scenario: string
  mode: number
  preset: boolean
  zoom: number
  focus: { x: number; y: number } | null
  steps: string | null
  port: number
  keepOpen: boolean
  help: boolean
}

export function parseArgs(argv: readonly string[]): ProbeOptions
export function assertDistReady(distDir: string): string
export function enterMatch(page: Page, options: ProbeOptions): Promise<void>
export function presetAndExpose(page: Page): Promise<void>
export interface ProbeResult {
  url: string
  out: string
  keepOpen: boolean
  browser: Browser
}
export function runProbe(options: ProbeOptions): Promise<ProbeResult>
export function main(argv?: readonly string[]): Promise<void>
