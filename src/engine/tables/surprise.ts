import { chartsTables, rulesConstants } from '@/data'

import { findTable, lookupCell } from './lookup'

/**
 * 奇袭表取表（OCS 9.8）
 *
 * 规则口径（中文规则书 9.8）：
 *   - 「掷两枚骰子，并加上 9.6 中判定的 DRM（＝攻方 AR − 守方 AR）。如果防御方有**任意等级**的环形工事，
 *      则从掷骰结果中**减 1**」→ 查奇袭表确定谁获奇袭；
 *   - 「注意攻击类型（突袭或常规攻击）决定了双方所需的奇袭掷骰（**表格不同**）」；
 *   - 发生奇袭时「掷一枚骰子，并将战斗表上的最终攻防比纵列进行若干列的横移。
 *      **向右横移表示攻击方奇袭，向左横移表示防御方奇袭**；如果没有发生奇袭，则不做横移」。
 *
 * 数据源：charts-tables.json 的 `surprise`（行＝regular / overrun，列＝守方奇袭 / 无 / 攻方奇袭，
 * 格值为该列的掷骰区间），按英文原版 OCS_Chartsv4.3.pdf（经 `ocs-rules-v43` ch17 表 17-8 转录）录入：
 *   - 常规战斗：≥10 攻方奇袭；≤5 守方奇袭（6–9 无）
 *   - 突袭    ：≥9 攻方奇袭；≤6 守方奇袭（7–8 无）
 */

/** 攻击类型（决定查表用哪一行） */
export type SurpriseAttackType = 'regular' | 'overrun'

/** 获奇袭方；`null` = 未发生奇袭（不横移） */
export type SurpriseSide = 'attacker' | 'defender' | null

/** 环形工事对奇袭掷骰的修正（9.8：任意等级都是 −1，与 9.9 的完整等级无关） */
export const HEDGEHOG_SURPRISE_DRM = rulesConstants.combat.hedgehogSurpriseDrm

/** 取表结果 */
export interface SurpriseLookup {
  /** 获奇袭的一方；null＝未发生奇袭 */
  side: SurpriseSide
  /** 修正后的奇袭掷骰（2d6 + AR 差 − 环形工事修正） */
  modifiedDice: number
  /** 实际施加的修正量（AR 差 + 环形工事修正） */
  drm: number
  rowIndex: number
  columnIndex: number
  /** 原始格值（如 `>=10`） */
  raw: string
  rule: '9.8'
}

/** 判定掷骰值是否落在区间标签内（支持 `<=N` / `>=N` / `N` / `A-B`） */
function inRange(label: string, value: number): boolean {
  const text = label.trim()
  const atMost = text.match(/^<=\s*(\d+)$/)
  if (atMost !== null) return value <= Number(atMost[1])
  const atLeast = text.match(/^>=\s*(\d+)$/)
  if (atLeast !== null) return value >= Number(atLeast[1])
  const span = text.match(/^(\d+)\s*-\s*(\d+)$/)
  if (span !== null) return value >= Number(span[1]) && value <= Number(span[2])
  const exact = text.match(/^(\d+)$/)
  if (exact !== null) return value === Number(exact[1])
  throw new Error(`[surprise] 无法解析奇袭表区间：${label}`)
}

/**
 * 奇袭判定（9.8）
 *
 * @param die              2 骰之和（2–12）
 * @param arDifferential   攻方 AR − 守方 AR（9.6 的 DRM；可为负）
 * @param attackType       `regular` 常规战斗 / `overrun` 突袭（两者用不同的行）
 * @param defenderInHedgehog 守方是否在任意等级的环形工事内（是则 −1）
 */
export function resolveSurprise(input: {
  die: number
  arDifferential: number
  attackType: SurpriseAttackType
  defenderInHedgehog?: boolean
}): SurpriseLookup {
  if (!Number.isInteger(input.die) || input.die < 2 || input.die > 12)
    throw new RangeError(`[surprise] 骰值应为 2–12 的两个骰之和，收到 ${input.die}`)

  const hedgehog = input.defenderInHedgehog === true ? HEDGEHOG_SURPRISE_DRM : 0
  const drm = input.arDifferential + hedgehog
  const modifiedDice = input.die + drm

  const table = findTable(chartsTables.tables, 'surprise')
  // 行＝攻击类型（regular / overrun 是**标签行**，故按标签定位）
  const rowIndex = table.rows.indexOf(input.attackType)
  if (rowIndex === -1)
    throw new Error(
      `[surprise] 表中无攻击类型行「${input.attackType}」（${table.rows.join(' | ')}）`,
    )

  const columns = table.columns ?? []
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
    const raw = lookupCell(table.grid, rowIndex, columnIndex, table.id)
    if (!inRange(raw, modifiedDice)) continue
    const label = columns[columnIndex]
    const side: SurpriseSide =
      label === 'attackerSurprise' ? 'attacker' : label === 'defenderSurprise' ? 'defender' : null
    return { side, modifiedDice, drm, rowIndex, columnIndex, raw, rule: '9.8' }
  }
  // 区间应完整覆盖骰值域，走到这里说明数据有洞
  throw new Error(
    `[surprise] 修正后掷骰 ${modifiedDice} 未落在任何区间（${table.rows[rowIndex] ?? ''}）：${table.grid[rowIndex]?.join(' | ')}`,
  )
}

/**
 * 9.8 横移列数
 *
 * 「如果发生奇袭，则掷一枚骰子，并将战斗表上的最终攻防比纵列进行若干列的横移」——
 * 横移骰由玩家掷出后传入；返回**带符号**的列位移：攻方奇袭为正（向右），守方奇袭为负（向左），
 * 未发生奇袭为 0。
 */
export function surpriseColumnShift(input: {
  side: SurpriseSide
  /** 横移骰（1–6，仅发生奇袭时掷） */
  shiftDie?: number
}): { shift: number; rule: '9.8'; detail: string } {
  if (input.side === null) return { shift: 0, rule: '9.8', detail: '未发生奇袭，不横移' }
  const die = input.shiftDie
  if (die === undefined || !Number.isInteger(die) || die < 1 || die > 6)
    throw new RangeError(`[surprise] 横移骰应为 1–6 的单骰，收到 ${String(die)}`)
  return {
    shift: input.side === 'attacker' ? die : -die,
    rule: '9.8',
    detail: `${input.side === 'attacker' ? '攻方' : '守方'}奇袭：向${input.side === 'attacker' ? '右' : '左'}横移 ${die} 列`,
  }
}

/**
 * 9.1g / 9.7b：把横移后的列位夹取回表内
 *
 * 「当初始攻防比超出了战斗表范围，或者因横移导致攻防比超出范围，则使用**最后一列可用的纵列**结算攻击。」
 */
export function clampColumnIndex(
  columnIndex: number,
  columnCount: number,
): { index: number; clamped: boolean; rule: '9.1g' } {
  if (columnCount <= 0) throw new RangeError('[surprise] 战斗表没有可用纵列')
  const index = Math.max(0, Math.min(columnCount - 1, columnIndex))
  return { index, clamped: index !== columnIndex, rule: '9.1g' }
}

/** 供外部复用的区间判定（测试与界面提示用） */
export const surpriseRangeMatches = inRange
