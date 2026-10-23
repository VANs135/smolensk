import { chartsCrt } from '@/data'

import { lookupCell, matchRowIndex, TableLookupError } from './lookup'

/**
 * CRT 取表（OCS 9.9）
 *
 * 掷骰：2d6 + 攻方行动值 - 守方行动值 - 守方工事等级（调用方算好最终掷骰值后传入）。
 * 列位：先按地形类取 odds 列位表（Extr Close/Very Close/Close/Open），
 *       再按 odds 标签定位 13 列之一；odds 越界时夹取到最近边界列。
 * 返回：原始结果代码（如 "Ao1 e4 DL1o2"），组间以空格分隔，解析交给战斗结算（B12）。
 */

/** CRT 四类地形列位（决定 odds 列标签） */
export type CrtTerrain = 'Extr Close' | 'Very Close' | 'Close' | 'Open'

export const CRT_TERRAIN_TYPES: readonly CrtTerrain[] = [
  'Extr Close',
  'Very Close',
  'Close',
  'Open',
]

/** 取表所需的 CRT 最小结构（兼容冻结数据） */
export interface CrtLike {
  diceRows: readonly string[]
  terrainColumns: Readonly<Record<string, readonly string[]>>
  matrix: readonly (readonly string[])[]
}

/** 取表结果：代码 + 行列定位（供界面展示依据） */
export interface CrtLookupResult {
  /** 原始结果代码（如 "Ao1 e4 DL1o2"） */
  code: string
  rowIndex: number
  columnIndex: number
  /** 所在列的 odds 标签（如 "3:1"） */
  columnLabel: string
  /** 掷骰行标注（如 "8"） */
  rowLabel: string
}

/** 解析 odds 标签为数值（'4:1' → 4；'1:2' → 0.5）；非法返回 null */
function parseOdds(label: string): number | null {
  const match = label.match(/^(\d+):(\d+)$/)
  if (!match) return null
  const numerator = Number(match[1])
  const denominator = Number(match[2])
  if (denominator === 0) return null
  return numerator / denominator
}

/** odds 越界时夹取到最近的列位（用于超大/超小攻防比） */
function clampOddsIndex(columnLabels: readonly string[], odds: string): number {
  const target = parseOdds(odds)
  if (target === null) {
    throw new TableLookupError(
      'crt',
      `列位中无「${odds}」且无法解析为攻防比值（${columnLabels.join(' | ')}）`,
    )
  }

  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  columnLabels.forEach((label, index) => {
    const value = parseOdds(label)
    if (value === null) return
    const distance = Math.abs(value - target)
    // 目标超出最小/最大列时，对应边界列的距离最小，自然落位
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  })
  return bestIndex
}

/** CRT 取表：给最终掷骰值与 odds，返回结果代码与定位 */
export function crtLookup(
  roll: number,
  terrain: CrtTerrain,
  odds: string,
  source: CrtLike = chartsCrt.crt,
): CrtLookupResult {
  const columnLabels = source.terrainColumns[terrain]
  if (!columnLabels) {
    throw new TableLookupError(
      'crt',
      `无效地形类「${terrain}」（${Object.keys(source.terrainColumns).join(' | ')}）`,
    )
  }

  let columnIndex = columnLabels.indexOf(odds)
  if (columnIndex === -1) {
    columnIndex = clampOddsIndex(columnLabels, odds)
  }

  const rowIndex = matchRowIndex(source.diceRows, roll, 'crt')
  const code = lookupCell(source.matrix, rowIndex, columnIndex, 'crt')

  return {
    code,
    rowIndex,
    columnIndex,
    columnLabel: columnLabels[columnIndex] ?? odds,
    rowLabel: source.diceRows[rowIndex] ?? String(roll),
  }
}
