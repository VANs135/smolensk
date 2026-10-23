import { chartsTables, rulesConstants } from '@/data'

import { findTable, lookupCell, matchRowIndex, resolveLabelColumnIndex } from './lookup'

/**
 * 损耗表取表（OCS 12.8b，掷 2 骰）
 *
 * 规则口径（中文规则书 12.8b / 12.8c）：
 *   - 「掷两枚骰子，使用标为断补的单位中**行动值最高**单位的行动值，找到对应的一列，
 *     并计算格中的断补单位的**军力数量**」→ 行＝2d6 + 修正，列＝最高 AR，格值＝该堆叠必须损失的军力点数；
 *   - 掷骰修正：**格中断补军力 ≥ 5 时 +3**（英文原版表下注，见 `ocs-rules-v43` ch17 表 17-13）；
 *   - 12.8c：「不要因单位处于 DG 模式而修正单位的 AR，但要按战略模式进行修正」；
 *   - 结果由堆叠拥有者决定哪些断补单位承受，**没有**「最高 AR 单位必须承受」的要求。
 *
 * 数据源：charts-tables.json 的 `attrition`（列位 5/4/3/2/1/0，行标 2…12 与 `13+`），
 * 逐格按英文原版 OCS_Chartsv4.3.pdf 录入（AR 列不足处为 `–`，即该 AR 下无「无损失」档）。
 */

/** AR 列顺序（照表头：Action Rating 5 4 3 2 1 0） */
export const ATTRITION_AR_COLUMNS = ['5', '4', '3', '2', '1', '0'] as const

/** 损耗表掷骰修正（12.8b：格中断补军力 ≥ minSteps 时 +modifier） */
export const ATTRITION_DRM = rulesConstants.supply.attritionDrm

/** 损耗结果（12.8b） */
export type AttritionResult =
  /** 损失指定军力点数（0 = 无损失） */
  | { kind: 'steps'; steps: number }
  /** 全部军力（原文 `All`；该堆叠的断补单位全部消灭） */
  | { kind: 'allSteps' }

/** 取表结果 */
export interface AttritionLookup {
  /** 修正后的掷骰值（2d6 + 12.8b 的 +3） */
  modifiedDice: number
  /** 掷骰修正量（0 或 +3） */
  drm: number
  rowIndex: number
  columnIndex: number
  /** 原始格值（如 `-2 Steps`） */
  raw: string
  result: AttritionResult
  rule: '12.8b'
}

/** 解析格值：`No Loss` / `-1 Step` / `-2 Steps` / `-4 Steps` / `-All Steps` */
export function parseAttritionCell(cell: string): AttritionResult {
  const text = cell.trim()
  if (/^no\s*loss$/i.test(text)) return { kind: 'steps', steps: 0 }
  if (/all/i.test(text)) return { kind: 'allSteps' }
  const steps = text.match(/-?\s*(\d+)/)
  if (steps === null)
    throw new Error(`[attrition] 无法解析损耗格值：${cell}（应为 No Loss / -N Steps / -All Steps）`)
  return { kind: 'steps', steps: Number(steps[1]) }
}

/**
 * 取列：断补堆叠中最高行动值（12.8b）
 *
 * 表头只到 AR 5，故高于 5 时夹取到 5 列（表注为「Action Rating 5」即最高档）；
 * 低于 0 时夹取到 0 列。非整数 AR 视为数据异常并报错（AR 是印值，必为整数）。
 */
export function attritionColumnIndex(bestAr: number): number {
  if (!Number.isFinite(bestAr))
    throw new RangeError(`[attrition] 行动值必须为有限数，收到 ${bestAr}`)
  const clamped = Math.max(0, Math.min(Number(ATTRITION_AR_COLUMNS[0]), Math.trunc(bestAr)))
  const table = findTable(chartsTables.tables, 'attrition')
  return resolveLabelColumnIndex(table.columns, String(clamped), table.id)
}

/**
 * 损耗判定（12.8b）：2 骰 + 修正 → 查表
 *
 * @param die      两枚骰之和（2–12）
 * @param bestAr   格中断补单位中最高的行动值（12.8c：DG 不修正；战略模式按 0，由调用方先算好）
 * @param oosSteps 格中断补单位的军力点数合计（≥5 时 +3）
 */
export function attritionLookup(die: number, bestAr: number, oosSteps: number): AttritionLookup {
  if (!Number.isInteger(die) || die < 2 || die > 12)
    throw new RangeError(`[attrition] 骰值应为 2–12 的两个骰之和，收到 ${die}`)

  const drm = oosSteps >= ATTRITION_DRM.minSteps ? ATTRITION_DRM.modifier : 0
  const modifiedDice = die + drm
  const table = findTable(chartsTables.tables, 'attrition')
  const rowIndex = matchRowIndex(table.rows, modifiedDice, table.id)
  const columnIndex = attritionColumnIndex(bestAr)
  const raw = lookupCell(table.grid, rowIndex, columnIndex, table.id)
  return {
    modifiedDice,
    drm,
    rowIndex,
    columnIndex,
    raw,
    result: parseAttritionCell(raw),
    rule: '12.8b',
  }
}

/** 12.8b：该格是否触发 +3 掷骰修正 */
export function attritionDrmFor(oosSteps: number): number {
  return oosSteps >= ATTRITION_DRM.minSteps ? ATTRITION_DRM.modifier : 0
}
