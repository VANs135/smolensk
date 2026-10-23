import { chartsSupplyRepl } from '@/data'
import type { DeepReadonly, RebuildEntry, Side, SpecialReplKind } from '@/data'

import { matchRowIndex, TableLookupError } from './lookup'

/**
 * 补给、补员与重建取数 API（A7.3）
 *
 * 数据源 charts-supply-repl.json（经管线冻结）：
 * - supplyTableRoll：1.6b 补给表，掷 2d6 → SP（19 Aug 起取 late 档）；
 * - replTableRoll：1.6b 补员表，掷 2d6 → Ftr/Tac/Pax/Eq（调用方按日期应用 -1 DRM）；
 * - specialReplRoll：1.6c 特殊补员表，掷 1 骰 → 事件；
 * - rebuildLookup / isFreeSpecialReplEligible：13.5c 重建费用与 1.6c 免费资格。
 */

/** 补员表 19 Aug 起掷骰修正（1.6b；轴/苏一致） */
export const REPL_ROLL_DRM_FROM_19_AUG = chartsSupplyRepl.repl.axis.drmFrom19Aug

/** 补给表：掷 2d6 → SP；from19Aug 决定取早/晚档（1.6b） */
export function supplyTableRoll(side: Side, from19Aug: boolean, roll: number): number {
  const sideData = chartsSupplyRepl.supply[side]
  const rowIndex = matchRowIndex(sideData.rows, roll, 'supply')
  const values = from19Aug ? sideData.spFrom19Aug : sideData.spBefore19Aug
  const sp = values[rowIndex]
  if (sp === undefined) throw new TableLookupError('supply', `行越界（rowIndex ${rowIndex}）`)
  return sp
}

/** 补员表结果 */
export interface ReplRollResult {
  ftr: number
  tac: number
  pax: number
  eq: number
  rowLabel: string
}

/** 补员表：掷 2d6（已含 19 Aug 起 -1 修正）→ 各资源点数（1.6b） */
export function replTableRoll(side: Side, roll: number): ReplRollResult {
  const sideData = chartsSupplyRepl.repl[side]
  const rowIndex = matchRowIndex(sideData.rows, roll, 'repl')
  const row = sideData.grid[rowIndex]
  if (!row || row.length < 4) throw new TableLookupError('repl', `行越界（rowIndex ${rowIndex}）`)
  return {
    ftr: row[0] ?? 0,
    tac: row[1] ?? 0,
    pax: row[2] ?? 0,
    eq: row[3] ?? 0,
    rowLabel: sideData.rows[rowIndex] ?? String(roll),
  }
}

/** 特殊补员事件 */
export interface SpecialReplResult {
  kind: SpecialReplKind
  /** 卡面原文（如 "Division & Supply Cache"） */
  label: string
}

/** 特殊补员表：掷 1 骰 → 事件（1.6c；19 Aug 起停止，由调用方判断） */
export function specialReplRoll(side: Side, die: number): SpecialReplResult {
  const rows = chartsSupplyRepl.specialRepl[side]
  const row = rows.find((entry) => die >= entry.dieFrom && die <= entry.dieTo)
  if (!row) throw new TableLookupError('special-repl', `骰面 ${die} 无对应行`)
  return { kind: row.resultKind, label: row.label }
}

/**
 * 重建费用查询（13.5c 重建费用表）。
 * 未登记类型返回 null（不在表内，应视为不可经常规途径重建）。
 * 返回冻结数据的只读视图，调用方不可改写。
 */
export function rebuildLookup(side: Side, unitType: string): DeepReadonly<RebuildEntry> | null {
  const entry = chartsSupplyRepl.rebuild[side].find((row) => row.unitType === unitType)
  return entry ? entry.rebuild : null
}

/**
 * 1.6c 免费特殊补员资格判定：仅 12-2-2 / 11-1-1 / 10-0-1 型步兵/民兵师
 * 可从死亡堆免费重建（以 -1 军力返回）；13-3-3 等其余型 "never rebuilt this way"
 * （规则原文），只能按 13.5c 正常费用重建。
 */
export function isFreeSpecialReplEligible(attack: number, ar: number, ma: number): boolean {
  return chartsSupplyRepl.freeSpecialReplFactors.some(
    (factor) => factor.attack === attack && factor.ar === ar && factor.ma === ma,
  )
}
