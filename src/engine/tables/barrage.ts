import { chartsTables } from '@/data'
import { barrageCostT, roundBarrageValue } from '@/engine/rules/barrage'

import { findTable, lookupCell, matchRowIndex, resolveNumericColumnIndex } from './lookup'
import type { TableLike } from './lookup'

/**
 * 轰炸表取表（OCS 10.0a / 10.0c）
 *
 * - 常规轰炸（10.0a）：掷 2d6，列位为炮击总轰炸值（1 or less … 117+），
 *   每次轰炸掷一次骰；结果代码 - / DG / [1/2] / 1/2 / 1 / 2 / 3。
 * - 对设施轰炸（10.0c）：掷 1 骰，列位为轰炸值（1 or less … 81+）；
 *   结果含 *（运输破坏成功）与 (#)（对基地内飞机掷骰的门槛）。
 * 列位落在值段之间时夹取到最近边界列。
 *
 * ★ 口径唯一（M2⑥ + M6⑤）：
 *   - **T 成本**只在 `rules/barrage.ts#barrageCostT` 一处实现（那里先按 4.2 取整再定列），本模块只转发；
 *   - **列位**也必须先过 4.2 的 `roundBarrageValue`：常规轰炸的取表此前**不取整**，
 *     于是 `1.5 / 2.5 / 4.5 …` 这类半数值会落到与产品路径（`rules/barrage.ts#resolveBarrage`，
 *     那里明确取整）**不同的列**——正是 M2⑥ 修掉的「测试测这份、产品用另一份」那一类。
 *     （对设施轰炸那一张表产品侧本身不取整，故此处与之保持一致。）
 */

export { barrageCostT }

/** 取表结果 */
export interface BarrageLookupResult {
  /** 结果代码：'-' | 'DG' | '[1/2]' | '1/2' | '1' | '2' | '3' */
  code: string
  rowIndex: number
  columnIndex: number
  columnLabel: string
}

function lookupByValue(table: TableLike, roll: number, barrageValue: number): BarrageLookupResult {
  const columnIndex = resolveNumericColumnIndex(table.columns, barrageValue, table.id)
  const rowIndex = matchRowIndex(table.rows, roll, table.id)
  const code = lookupCell(table.grid, rowIndex, columnIndex, table.id)
  return {
    code,
    rowIndex,
    columnIndex,
    columnLabel: table.columns?.[columnIndex] ?? String(barrageValue),
  }
}

/**
 * 常规轰炸（10.0a）：掷 2d6 与炮击总轰炸值
 *
 * ★ 4.2：纵列按**合并后取整**的轰炸值确定（与 `resolveBarrage` 同口径）。
 */
export function barrageLookup(roll: number, barrageValue: number): BarrageLookupResult {
  return lookupByValue(
    findTable(chartsTables.tables, 'barrage'),
    roll,
    roundBarrageValue(barrageValue),
  )
}

/** 对设施轰炸（10.0c）：掷 1 骰与轰炸值（该表产品侧不取整，故此处同样原样取值） */
export function barrageVsFacilityLookup(die: number, barrageValue: number): BarrageLookupResult {
  return lookupByValue(findTable(chartsTables.tables, 'barrage-vs-facility'), die, barrageValue)
}
