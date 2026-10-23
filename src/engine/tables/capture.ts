import { chartsTables } from '@/data'

import { findTable, lookupCell, matchRowIndex, resolveLabelColumnIndex } from './lookup'

/**
 * 夺取表（OCS 9.14b / 9.14c）
 *
 * 对补给站 / 卡车与装载 SP / 马车与装载 SP 的夺取：掷 1 骰，
 * 对每类在场地中分别查表，结果为被夺取的百分比（余下按类别注释处置）。
 */

/** 夺取类别 → 列位标签（权威列名） */
export const CAPTURE_COLUMNS = {
  dump: 'Dump (on ground)',
  trucks: 'Trucks (and loaded SPs)',
  wagons: 'Wagons (and loaded SPs)',
} as const

export type CaptureCategory = keyof typeof CAPTURE_COLUMNS

/** 夺取百分比（0–100）；num 为骰面（1–6） */
export function captureLookup(die: number, category: CaptureCategory): number {
  const table = findTable(chartsTables.tables, 'capture')
  const rowIndex = matchRowIndex(table.rows, die, table.id)
  const columnIndex = resolveLabelColumnIndex(table.columns, CAPTURE_COLUMNS[category], table.id)
  const cell = lookupCell(table.grid, rowIndex, columnIndex, table.id)
  return Number(cell)
}
