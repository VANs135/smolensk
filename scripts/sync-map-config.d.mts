/**
 * sync-map-config.mjs 的 TypeScript 声明（仅供类型检查与测试引用；模块本体为纯 JS）
 */

export const MAP_CONFIG_VERSION: string

export const CALIBRATION: {
  hexWidthPx: number
  hexHeightPx: number
  originX: number
  originY: number
  evenColumnOffsetPx: number
}

/** 按标定公式重算格心像素 [x, y]（flat-top、偶数列下移半格） */
export function centerByCalibration(col: number, row: number): [number, number]

export interface CalibrationItem {
  hex_id: string
  col: number
  row: number
  center_px?: readonly number[]
  on_map?: boolean
  state?: string
}

/** 全量校核：返回超差样本（空数组 = 全部一致） */
export function verifyCalibration(
  items: readonly CalibrationItem[],
  eps?: number,
): ReadonlyArray<{ hex: string; actual: unknown; expected: [number, number] }>

/** '36.13' → { col, row }（本作无字母前缀） */
export function parseHexRef(hexId: string): { col: number; row: number }

export function computeBounds(items: readonly CalibrationItem[]): {
  colStart: number
  colEnd: number
  rowStart: number
  rowEnd: number
}

export function buildEntryHexes(
  items: readonly { letter?: string; col: number; row: number }[],
): Record<string, ReadonlyArray<{ col: number; row: number }>>

export function parseVictoryLocations(
  listed: readonly string[],
): ReadonlyArray<{ col: number; row: number }>

export function parseBoundary(
  description: string,
): [{ col: number; row: number }, { col: number; row: number }]

export function buildMapConfig(arg: {
  mapHexes: readonly CalibrationItem[]
  entryItems: readonly { letter?: string; col: number; row: number }[]
  listedHexes: readonly string[]
  boundary: string
  orientation?: string
  offset?: string
}): Record<string, unknown>
