import { chartsCrt, rulesConstants } from '@/data'

import { crtLookup } from '../tables/crt'
import { combatLineOf, type CombatLine } from './terrain'

/**
 * 战斗与特殊战斗（OCS 8.0 / 9.0）——CRT 列位、结果解析与查表
 *
 * 数值与符号定义全部取自数据层：
 *   - 矩阵与列位：charts-crt.json（chartsCrt.crt，195 格，逐格核对）
 *   - 地形 → 战斗线列位：TEC 的 combatLine 列（复用 terrain.ts 的 combatLineOf，不另立映射）
 *   - 常量（突袭 MP / 环形工事奇袭 DRM / 撤退 DG 阈值 / 基地夺取）：rules-constants.json
 */

/* ── 常量（保持既有 API） ── */
export const OVERRUN_MP_COST = rulesConstants.combat.overrunMpCost
export const HEDGEHOG_SURPRISE_DRM = rulesConstants.combat.hedgehogSurpriseDrm
export const RETREAT_DG_MIN_HEXES = rulesConstants.combat.retreatDgMinHexes
export const AIR_BASE_CAPTURE_NO_LOSS_MIN_DICE = rulesConstants.combat.airBaseCaptureNoLossMinDice

/** CRT 列位（TEC 战斗线，与 charts-crt.json 的 terrainColumns 键一一对应） */
export type CrtTerrainLine = CombatLine

/** 地形名 → CRT 列位；格边地形（原文 ot）返回 null，调用方须回查格内主地形 */
export function crtTerrainLine(terrain: string): CrtTerrainLine | null {
  return combatLineOf(terrain)
}

/* ── CRT 结果记号解析（9.9） ── */

/**
 * 结果记号表（charts-crt.json resultCodes）：
 *   A 攻击方 / D 防守方 / L# 损失 # 军力 / o# 选项（撤退或损失 1 军力）
 *   DG 防守方混乱 / e# 行动值 ≥ # 的攻方获进击标记
 *
 * 实际取值共 12 种（如 `AL1o1 Do1`、`Ao1 e4 DL1o2`、`Ae2 DL2o3DG`）：
 * 同一格的攻方段与守方段以空格分隔，守方段以 `D` 起首。
 */
export interface AttackerResult {
  /** 损失军力数（L#） */
  losses: number
  /** 是否有选项（o#） */
  hasOption: boolean
  /**
   * 选项点数（9.10a：`o2` 提供 **2 点**选择，可拆成「1 点损失 + 1 格撤退」）
   *
   * ★ 只记 `hasOption` 会丢掉 `o1`/`o2`/`o3` 的区别 —— 那正是选项分配的全部自由度所在。
   */
  optionPoints: number
  /** 进击标记门槛（e#：行动值 ≥ # 的攻方获进击标记）；无则 undefined */
  exploitationAR?: number
}

export interface DefenderResult {
  /** 损失军力数（L#） */
  losses: number
  /** 是否有选项（o#） */
  hasOption: boolean
  /** 选项点数（9.10a；见 `AttackerResult.optionPoints`） */
  optionPoints: number
  /** 是否混乱（DG） */
  disorganized: boolean
}

export interface CombatResult {
  attacker: AttackerResult
  defender: DefenderResult
  /** 原始 CRT 格值（供日志/UI） */
  raw: string
  /** 实际用于查表的修正骰（2d6 + 攻方 AR − 守方 AR − 守方工事等级） */
  modifiedDice: number
  /** 查表所用列位 */
  terrainLine: CrtTerrainLine
  /** 查表所用军力比（攻:守），已按 9.7 + 4.2 取整（零战斗值见 9.14a） */
  ratio: string
}

/** 解析攻方段（A 起首，可能含独立 e# 记号） */
function parseAttackerSection(text: string): AttackerResult {
  const losses = Number(text.match(/L(\d+)/)?.[1] ?? 0)
  const optionPoints = Number(text.match(/o(\d+)/)?.[1] ?? 0)
  const eMatch = text.match(/e(\d+)/)
  return {
    losses,
    hasOption: optionPoints > 0,
    optionPoints,
    ...(eMatch ? { exploitationAR: Number(eMatch[1]) } : {}),
  }
}

/** 解析守方段（D 起首；`Do#` 仅表示选项，不表示损失） */
function parseDefenderSection(text: string): DefenderResult {
  const optionPoints = Number(text.match(/o(\d+)/)?.[1] ?? 0)
  return {
    losses: Number(text.match(/L(\d+)/)?.[1] ?? 0),
    hasOption: optionPoints > 0,
    optionPoints,
    disorganized: /DG/.test(text),
  }
}

/**
 * 解析单个 CRT 格值
 *
 * 记号按空格切分后归类：`A…` 归攻方段、`D…` 归守方段、独立的 `e#` 归攻方段。
 */
export function parseCrtResultCell(cell: string): CombatResult {
  const tokens = cell.split(/\s+/).filter(Boolean)
  let attackerText = ''
  let defenderText = ''
  for (const token of tokens) {
    if (token.startsWith('D')) defenderText += token
    else if (token.startsWith('A')) attackerText += token
    else if (/^e\d+$/.test(token)) attackerText += token
  }
  return {
    attacker: parseAttackerSection(attackerText),
    defender: parseDefenderSection(defenderText),
    raw: cell,
    modifiedDice: 0,
    terrainLine: 'Open',
    ratio: '',
  }
}

/* ── 军力比与列位（9.7 / 9.7a / 9.14a / 4.2） ── */

/**
 * 4.2 小数取整：小数部分 **< .5 向下、≥ .5 向上**
 *
 * 规则原文（4.2）：「当数字的小数部分小于 0.5 时，向下取整。当小数部分大于等于 0.5 时，向上取整。」
 * 并附「15:6 的攻防比取整为 3:1」「9.75 : 2 = 4.875 → 5:1」两例。
 * ★ 这是**四舍五入**而不是向下取整——攻防比与列位必须按此口径，否则会系统性偏向守方。
 */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5)
}

/** 已按 4.2 取整的攻防比 */
export interface BattleOdds {
  /** 取整后的攻方值（=1 或 N） */
  attacker: number
  /** 取整后的守方值（=1 或 N） */
  defender: number
  /** 形如 `3:1` / `1:2`（与 CRT 列标签同格式） */
  label: string
  /** 取整后的数值比 attacker/defender（供 9.7a 取列） */
  ratio: number
}

/**
 * 9.7 攻防比
 *
 * 「将这两个数值分别除以二者中较小的数值，并对每个结果应用取整规则（见 4.2）。
 *   将两个结果，按攻击者:防御者的格式组合，形成攻防比。」
 * 除以较小者后其中一个商恒为 1，故结果必为 `N:1` 或 `1:N`。
 * 零战斗值不在本函数处理（9.14a 直接指定左右端列，见 `battleColumnIndex`）。
 */
export function battleOdds(attackerA: number, defenderA: number): BattleOdds {
  const smaller = Math.min(attackerA, defenderA)
  if (!(smaller > 0)) {
    // 退化输入（含 0）；9.14a 的零战斗值由 battleColumnIndex 直接指定端列
    const attacker = attackerA > 0 ? 1 : 0
    const defender = defenderA > 0 ? 1 : 0
    return {
      attacker,
      defender,
      label: `${attacker}:${defender}`,
      ratio: attacker / (defender || 1),
    }
  }
  const attacker = roundHalfUp(attackerA / smaller)
  const defender = roundHalfUp(defenderA / smaller)
  return { attacker, defender, label: `${attacker}:${defender}`, ratio: attacker / defender }
}

/** 该比值标签的数值（`3:1` → 3；`1:2` → 0.5） */
function ratioValue(label: string): number {
  const [a, b] = label.split(':').map(Number)
  if (!a || !b) throw new Error(`CRT 列位不是合法比值：${label}`)
  return a / b
}

/**
 * 取军力比所在列位（9.7a）
 *
 * 「玩家需要根据防御方的地形类别找到正确的横行……根据上面计算且**取整过**的攻防比，
 *   找到**小于或等于**它的最大的一列。」→ 故先把 9.7/4.2 取整后的比值算出来，再取列。
 * 实际比值低于最小列时归入最小列（9.7b 的越界判据另见 `battleColumnIndex`）。
 */
export function resolveRatioColumnIndex(
  columns: readonly string[],
  attackerA: number,
  defenderA: number,
): number {
  const actual = battleOdds(attackerA, defenderA).ratio
  let best = 0
  for (let i = 0; i < columns.length; i++) {
    if (ratioValue(columns[i]!) <= actual) best = i
    else break
  }
  return best
}

/**
 * 9.7：攻防比标签（显示用；与 `battleColumnIndex` 同口径，不会出现「标签与列位不一致」）
 */
export function battleRatioLabel(attackerA: number, defenderA: number): string {
  return battleOdds(attackerA, defenderA).label
}

/**
 * 9.7a / 9.7b / 9.14a：攻防比列位
 *
 * 「找到**小于或等于**它的最大的一列」；攻防比不在表上时使用最后一个可用纵列（9.7b/9.1g）。
 * 9.14a 的零战斗值特例：**被攻击方战斗值为 0** 时直接从**最右列**开始（横移亦从最右列起算）；
 * **攻击方战斗值为 0** 时从**最左列**开始（且仍须照常支付战斗补给）；**双方都为 0** 时用 **1:1** 列。
 */
export function battleColumnIndex(
  columns: readonly string[],
  attackerA: number,
  defenderA: number,
): { index: number; rule: string } {
  if (attackerA <= 0 && defenderA <= 0) {
    const even = columns.indexOf('1:1')
    return { index: even === -1 ? 0 : even, rule: '9.14a' }
  }
  if (defenderA <= 0) return { index: Math.max(0, columns.length - 1), rule: '9.14a' }
  if (attackerA <= 0) return { index: 0, rule: '9.14a' }
  return { index: resolveRatioColumnIndex(columns, attackerA, defenderA), rule: '9.7a' }
}

/* ── 查表主函数 ── */

export interface ResolveCombatInput {
  /** 2d6 原始骰值（2–12） */
  die: number
  /** 攻方行动值 */
  attackerAR: number
  /** 守方行动值 */
  defenderAR: number
  /** 守方环形工事等级（0 = 无） */
  hedgehogLevel?: number
  /** TEC 战斗线列位（由 crtTerrainLine(terrain) 取得） */
  terrainLine: CrtTerrainLine
  /** 攻方总军力（A 值求和） */
  attackerA: number
  /** 守方总军力（A 值求和） */
  defenderA: number
}

/**
 * 战斗结算（9.9 查表）
 *
 * 修正骰 = 2d6 + 攻方行动值 − 守方行动值 − 守方环形工事等级（9.9 重要提示）。
 * 列位走 `battleColumnIndex`（9.7a 取「≤ 取整后比值」的最大列；9.14a 的零战斗值取端列），
 * 取表走 `tables/crt#crtLookup` —— 与 `battle.ts` 的 `resolveBattleDice` 是**同一条取表路径**，
 * 避免两处口径漂移。
 *
 * 注意本函数**不含**奇袭横移：横移由 9.8 在取列之后、掷骰之前完成（见 `battle.resolveBattleSurprise`），
 * 故调用方若已有横移后的列标签，应改用 `battle.resolveBattleDice`。
 */
export function resolveCombat(input: ResolveCombatInput): CombatResult {
  const {
    die,
    attackerAR,
    defenderAR,
    hedgehogLevel = 0,
    terrainLine,
    attackerA,
    defenderA,
  } = input

  if (!Number.isInteger(die) || die < 2 || die > 12) {
    throw new RangeError(`CRT 骰值应为 2–12 的两个骰之和，收到 ${die}`)
  }

  const modified = die + attackerAR - defenderAR - hedgehogLevel

  const columns = chartsCrt.crt.terrainColumns[terrainLine]
  if (columns === undefined) throw new Error(`CRT 无此地形列组：${terrainLine}`)
  // 9.14a：零战斗值时 `battleColumnIndex` 直接给出端列；否则按 9.7a 取列
  const colIndex = battleColumnIndex(columns, attackerA, defenderA).index
  const columnLabel = columns[colIndex]!

  const lookup = crtLookup(modified, terrainLine, columnLabel)

  const parsed = parseCrtResultCell(lookup.code)
  parsed.modifiedDice = modified
  parsed.terrainLine = terrainLine
  parsed.ratio = lookup.columnLabel
  return parsed
}
