/**
 * sync-counters.mjs 的 TypeScript 声明（仅供类型检查与测试引用；模块本体为纯 JS）
 */

export const ASSET_ROOT: string
export const DB_DIR: string
export const TEXTURE_DIR_NAME: string

/** 阵营 → public 子目录（中立算子 `both` 归入 markers） */
export function countersDirOfSide(side: string): 'axis' | 'soviet' | 'markers'

/** 要拷贝的一张图 */
export interface CounterAsset {
  file: string
  dir: 'axis' | 'soviet' | 'markers'
  kind: 'ground' | 'air'
}

/** 仅 selectCounterAssets 需要的字段（其余字段忽略） */
export interface CounterSourceItem {
  fill_stage?: string
  side?: string
  images?: {
    front?: string | null
    back?: string | null
    front_paths?: readonly string[]
    back_paths?: readonly string[]
  } | null
}

export function selectCounterAssets(
  groundItems: readonly CounterSourceItem[],
  aircraftItems: readonly CounterSourceItem[],
): CounterAsset[]

export function indexPngByName(root: string): Map<string, string>
