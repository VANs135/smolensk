import { chartsTables, rulesConstants } from '@/data'
import type { HexRef, Side } from '@/data'

import { HEX_DIRECTIONS, neighbor } from '../hex-geometry'
import { findTable, lookupCell, matchRowIndex, resolveNumericColumnIndex } from '../tables/lookup'
import type { GamePhase } from '../state-types'
import { roundHalfUp } from './combat'
import type { CombatLine } from './terrain'

/**
 * 轰炸结算（B15，OCS 10.0 章）
 *
 * 通用流程（10.0）：「将轰炸值加总 → 确定轰炸表应使用的**初始纵列** → 按该列消耗补给（**仅火炮**）→
 * 按轰炸表说明做**列横移** → 掷两枚骰子结算结果」。★ 顺序不可颠倒，且**列横移可叠加、可越界**。
 * 至少需要 1 点轰炸值才可使用轰炸表（在计算横移**之前**判定）。
 *
 * ## 条文索引（中文规则书 10.0，横移数值照录中文辅助卡第 4 页轰炸表附注）
 *   - 10.0a 轰炸表：对敌方**战斗单位**；目的是把它们 DG。**由目标玩家**选择可能提供横移的地形，
 *          并选择堆叠中**哪些单位承受军力损失**。
 *          密度：「只计算战斗单位，不计算运输点数、SP 等」；「单独一个师（即使是多单位编队）
 *          在计算单位密度的横移时永远不会算作超过 **3RE**；少于 3RE 时用实际数量」
 *   - 10.0b 正确的观察员＝与目标格**相邻**、且**未装载于登陆艇**的任何友方**战斗单位**；
 *          无正确观察员 ⇒ 攻击**左移 3 列**；**低空扫射**（无论用哪张表）都需要正确观察员；
 *          无观察员**不影响**对设施轰炸表（除低空扫射的限制外）；**战略轰炸机**轰炸时该惩罚**永久生效**
 *   - 10.0c 对设施轰炸表：须**预先指定**具体目标（空军基地 / 港口 / 作为空军任务的运输破坏）；
 *          **不被修正、无地形横移、不需要观察员**；掷**一个骰子**定结果
 *   - 10.0d 混合目标格：攻击方须宣布**一个整体目标**，轰炸值只能用于该目标
 *   - 10.0e 限制：A) 每格每阶段只允许被轰炸**一次**（例外：反舰船轰炸与低空扫射；已宣布但被防空/
 *          拦截完全摧毁或返航的任务也算）；B) 一个单位每阶段只能轰炸一次，不能拆分轰炸值，
 *          也不能低于印刷轰炸值轰炸；C) 只有空军/海军能在**移动阶段**轰炸；D) 只有火炮能在
 *          **战斗阶段**轰炸；E) 三类都能在**反应阶段与进击阶段**轰炸；F) 一次轰炸只能用**同一类型**单位
 *   - 10.1a 火炮射程以**格**为单位，**不受天气与地形影响**
 *   - 10.1b 火炮轰炸消耗战斗补给，用量取**初始列（计算任何横移之前）**；付不出则**不能执行**
 *          （无惩罚：所有单位取消，且**不视为已轰炸过**）；A) 多单位齐射时补给须来自**同一指挥部**，
 *          不用指挥部则来自**同一补给站**；B) 断补火炮仍用**完整轰炸值**；C) 轰炸**永不能用部队储备**
 *   - 10.2a 空军轰炸在轰炸环节结算，结算后须返基地并**立即非激活**（14.1c）；轰炸前受拦截（14.5）与防空（14.4）
 *   - 10.2b **短程效果**：执行轰炸的**所有**飞机都在其基地 **10 格及以内** ⇒ 常规轰炸表**右移 1 列**；
 *          **例外：战略轰炸机永远不享受**
 *   - 10.2c 空军轰炸**无补给消耗**
 *   - 18.3b 舰船对地轰炸的效果减损（**本作无海军**，见专规 1.1c；本模块只保留 `[1/2]` 的
 *          「舰船射击 ⇒ 视为 DG」这一条，减损表本身不实现）
 *
 * ## 与既有模块的分工
 *   - 表格与通用原语：engine/tables（`barrage` / `barrage-vs-facility`）；
 *   - 地形类别由 `terrain.combatLineOf` 给出（**不在此另立映射**）；
 *   - 观察员是否「相邻」用 `hex-geometry` 的唯一几何实现。
 */

/* ── 常量（源自 rules-constants.json） ── */
export const BARRAGE_MAX_AIRCRAFT_PER_MISSION = rulesConstants.barrage.maxAircraftPerMission
export const BARRAGE_MIN_VALUE = rulesConstants.barrage.minBarrageValue
export const BARRAGE_NO_SPOTTER_SHIFT_LEFT = rulesConstants.barrage.noSpotterShiftLeft
export const BARRAGE_SHORT_RANGE_HEXES = rulesConstants.barrage.shortRangeHexes
export const BARRAGE_DENSITY_CAP_RE = rulesConstants.barrage.densityCapRe
export const BARRAGE_DENSITY_SHIFTS = rulesConstants.barrage.densityShifts

/** 额外列横移（10.0a 表下；正 = 右移、负 = 左移） */
export const BARRAGE_COLUMN_SHIFTS = rulesConstants.barrage.columnShifts

/** `[1/2]` 视同 DG 的环形工事等级下限（10.0a） */
export const BARRAGE_BRACKET_HEDGEHOG_MIN_LEVEL = rulesConstants.barrage.bracketHedgehogMinLevel

/** `1/2` 掷取整骰时损 1 步的最低骰值（10.0a：4-6 损 1 步并 DG） */
export const BARRAGE_HALF_RESULT_STEP_LOSS_MIN_DIE = rulesConstants.barrage.halfResultStepLossMinDie

/* ── 类型 ── */

/** 轰炸单位类别（10.0e-F：一次轰炸只能用同一类型） */
export type BarrageKind = 'artillery' | 'air' | 'ship'

/** 轰炸的「整体目标」（10.0d：混合目标格须宣布其一） */
export type BarrageTargetKind = 'combatUnits' | 'airBase' | 'port' | 'trainbusting'

export interface ResolveBarrageInput {
  /** 2d6 原始骰值 */
  die: number
  /** 轰炸值（合计数） */
  valueRange: number
  /** 目标格内**战斗单位**的 RE 合计（10.0a：只算战斗单位；未填则不移） */
  enemyREInHex?: number
  /** 是否有**正确的观察员**（无则左移 3 列，10.0b） */
  hasSpotter?: boolean
  /** 任务中最远飞机的距基地格数（10.2b：**所有**飞机 ≤10 格才右移 1 列） */
  rangeFromBase?: number
  /** 目标格环形工事等级（任意等级 ⇒ 左移 1 列，10.0a） */
  hedgehogLevel?: number
  /** 目标玩家为本次轰炸选择的地形所属战斗线（10.0a：地形横移由**目标玩家**选） */
  terrainLine?: CombatLine
  /** 目标格中是否有单位为**战略模式**（有 ⇒ 右移 3 列，10.0a） */
  stratModeInHex?: boolean
  /** 轰炸方类别（10.2b 的短程效果仅空军享有；战略轰炸机见 `strategicBomber`） */
  kind?: BarrageKind
  /** 是否为战略轰炸机（10.0b/10.2b：无观察员惩罚永久生效、且不享受短程效果） */
  strategicBomber?: boolean
}

/** 列横移明细（10.0a） */
export interface BarrageShiftBreakdown {
  /** 密度横移（10.0a 密度表） */
  density: number
  /** 环形工事横移（任意等级左移） */
  hedgehog: number
  /** 地形横移（目标玩家所选地形的战斗线） */
  terrain: number
  /** 观察员横移（无正确观察员左移 3；战略轰炸机永久生效） */
  spotter: number
  /** 战略模式横移（格内有战略模式单位则右移 3） */
  stratMode: number
  /** 短程横移（全部飞机 ≤10 格且非战略轰炸机） */
  shortRange: number
  /** 合计（正 = 右移） */
  total: number
  /** 逐条说明（供界面与日志） */
  detail: string[]
}

export interface BarrageResult {
  /** 结果代码（表内格值，如 `-` / `DG` / `1 (5)` / `2 * (4)`） */
  code: string
  /** 本次任务 T 成本（★ 取**初始列**（横移前），10.1b） */
  costT: number
  /** 横移前的初始列位 */
  initialColumn: number
  /** 定位到的列位索引（横移后） */
  finalColumn: number
  /** 列横移明细 */
  shifts: BarrageShiftBreakdown
  die: number
}

/* ── 10.0a 密度（只算战斗单位；单师/编队计入密度时上限 3 RE） ── */

/**
 * 密度统计口径（10.0a）
 *
 * 「单位密度只计算**战斗单位**，不计算运输点数、SP 等」；
 * 「单独**一个师**（即使是**多单位编队**）在计算单位密度的横移时，永远不会算作超过 3RE；
 *   如果少于 3RE，则使用实际数量即可」——故按「师/编队」分组，每组 RE 合计**封顶**
 * `BARRAGE_DENSITY_CAP_RE`（3 RE）后再相加；没有编队标识的单位各自视为一组（同样封顶）。
 *
 * @param units 目标格内的单位（须标出是否战斗单位、RE 与所属编队 id）
 */
export function densityReOf(
  units: readonly { isCombat: boolean; re: number; formationId?: string }[],
): number {
  const groups = new Map<string, number>()
  let index = 0
  for (const unit of units) {
    if (!unit.isCombat) continue
    const key = unit.formationId ?? `#lone-${index++}`
    groups.set(key, (groups.get(key) ?? 0) + unit.re)
  }
  let total = 0
  for (const re of groups.values()) total += Math.min(re, BARRAGE_DENSITY_CAP_RE)
  return total
}

/** densityShifts 单档：maxRe = 该档 RE 上界（null 表示无上限） */
interface DensityStep {
  maxRe: number | null
  shift: number
}

/**
 * 密度列移（10.0a 密度表）
 *
 * 表：1 RE 及以下**左移 1 列**；大于 1 且 ≤3 RE 不移；>3≤4 右移 1；>4≤5 右移 2；>5≤6 右移 3；>6 右移 4。
 * 未提供 RE（`undefined`）时视为无法判定，返回 0。
 */
export function computeDensityShift(enemyRE: number | undefined): number {
  if (enemyRE === undefined) return 0
  const steps = BARRAGE_DENSITY_SHIFTS as readonly DensityStep[]
  for (const step of steps) {
    if (step.maxRe === null || enemyRE <= step.maxRe) return step.shift
  }
  return 0
}

/* ── 10.0a / 10.0b / 10.2b 列横移汇总 ── */

/**
 * 全部列横移（可叠加，10.0a）
 *
 * 逐条来源见文件头条文索引；「每条最多结算一次」。
 */
export function barrageColumnShifts(input: {
  enemyREInHex?: number
  hedgehogLevel?: number
  terrainLine?: CombatLine
  hasSpotter?: boolean
  stratModeInHex?: boolean
  /** 任务中最远飞机距基地格数（10.2b） */
  rangeFromBase?: number
  kind?: BarrageKind
  strategicBomber?: boolean
}): BarrageShiftBreakdown {
  const detail: string[] = []

  const density = computeDensityShift(input.enemyREInHex)
  if (density !== 0) detail.push(`密度 ${input.enemyREInHex} RE ⇒ ${shiftText(density)}`)

  const hedgehog = (input.hedgehogLevel ?? 0) > 0 ? BARRAGE_COLUMN_SHIFTS.hedgehogAnyLevel : 0
  if (hedgehog !== 0)
    detail.push(
      `目标格存在 ${input.hedgehogLevel} 级环形工事 ⇒ ${shiftText(hedgehog)}（任意等级同值）`,
    )

  const terrain =
    input.terrainLine === undefined
      ? 0
      : (BARRAGE_COLUMN_SHIFTS.terrainByCombatLine[input.terrainLine] ?? 0)
  if (terrain !== 0)
    detail.push(`目标玩家选择的地形（${input.terrainLine}）⇒ ${shiftText(terrain)}`)

  // 10.0b：无正确观察员左移 3；★ 战略轰炸机轰炸时该惩罚**永久生效**
  const spotter =
    input.strategicBomber === true || input.hasSpotter === false
      ? -BARRAGE_NO_SPOTTER_SHIFT_LEFT
      : 0
  if (input.strategicBomber === true)
    detail.push(`战略轰炸机：无观察员惩罚永久生效 ⇒ ${shiftText(spotter)}`)
  else if (input.hasSpotter === false)
    detail.push(`缺少与目标相邻的正确观察员 ⇒ ${shiftText(spotter)}`)

  const stratMode = input.stratModeInHex === true ? BARRAGE_COLUMN_SHIFTS.stratModeInHex : 0
  if (stratMode !== 0) detail.push(`目标格内有单位为战略模式 ⇒ ${shiftText(stratMode)}（10.0a）`)

  // 10.2b：所有飞机都在基地 10 格及以内才 +1，且战略轰炸机永远不享受
  const shortRange =
    input.kind === 'air' &&
    input.strategicBomber !== true &&
    input.rangeFromBase !== undefined &&
    input.rangeFromBase <= BARRAGE_SHORT_RANGE_HEXES
      ? BARRAGE_COLUMN_SHIFTS.allAircraftInShortRange
      : 0
  if (shortRange !== 0)
    detail.push(
      `全部飞机在基地 ${BARRAGE_SHORT_RANGE_HEXES} 格内 ⇒ ${shiftText(shortRange)}（10.2b）`,
    )

  const total = density + hedgehog + terrain + spotter + stratMode + shortRange
  return { density, hedgehog, terrain, spotter, stratMode, shortRange, total, detail }
}

function shiftText(shift: number): string {
  return shift > 0 ? `右移 ${shift} 列` : `左移 ${Math.abs(shift)} 列`
}

/* ── 10.0b 正确的观察员 ── */

/**
 * 10.0b：是否为「正确的观察员」
 *
 * 「与目标格**相邻**的，且**未装载于登陆艇**的任何**友方战斗单位**」。
 * 本作无登陆艇（专规 1.1c 无海运），故 `loadedOnLandingCraft` 恒为 false，保留入参以对齐原文。
 */
export function isCorrectSpotter(input: {
  side: Side
  /** 观察员所在格 */
  hex: HexRef
  targetHex: HexRef
  isCombat: boolean
  /** **轰炸方**阵营（观察员须为其战斗单位——「友方」是相对轰炸方而言） */
  friendlySide: Side
  loadedOnLandingCraft?: boolean
}): boolean {
  if (input.side !== input.friendlySide) return false
  if (!input.isCombat) return false
  if (input.loadedOnLandingCraft === true) return false
  return HEX_DIRECTIONS.some((direction) =>
    sameHex(neighbor(input.hex, direction), input.targetHex),
  )
}

/* ── 10.1a 火炮射程 ── */

/**
 * 10.1a：火炮轰炸的射程判定
 *
 * 「火炮轰炸的射程以**格**为单位计算。射程**不受天气和地形影响**」——
 * 故只比格距，不看天气/地形（射程为 3 的火炮可打 1～3 格上的目标）。
 */
export function canBarrageAtRange(input: { rangeHexes: number; distanceHexes: number }): boolean {
  return input.distanceHexes >= 1 && input.distanceHexes <= input.rangeHexes
}

/* ── 10.1b 火炮补给 ── */

/** 初始列（横移前）的 T 成本（10.1b：用量取初始列，不取横移后的列） */
export function barrageCostT(valueRange: number): number {
  const table = findTable(chartsTables.tables, 'barrage')
  const columns = table.columns ?? []
  // 4.2：纵列按**取整后**的轰炸值确定，故成本也跟着取整值走
  const columnIndex = resolveNumericColumnIndex(columns, roundBarrageValue(valueRange), 'barrage')
  return table.cost?.[columnIndex] ?? 0
}

/** 轰炸表元信息（10.0 通用流程的「加总轰炸值 → 确定纵列 → 按该列付补给」三步） */
export interface BarrageTableMeta {
  /** 10.0a / 10.0c：本次整体目标所对应的表 */
  tableId: 'barrage' | 'barrage-vs-facility'
  /** 初始列位（按轰炸值确定；★ 横移之前） */
  initialColumn: number
  /** 初始列上的 T 成本（10.1b：取初始列，不取横移后的列） */
  costT: number
  /** 初始列的列标签（如 `8-11`，供界面显示） */
  columnLabel: string
  /** 表列数（列横移可越界，夹取用） */
  columnCount: number
}

/**
 * 轰炸表元信息（10.0d：整体目标决定用哪张表）
 *
 * 一个函数覆盖两张表，避免「取初始列 / 取成本」的口径在两处漂移。
 */
export function barrageTableMeta(input: {
  target: BarrageTargetKind
  valueRange: number
}): BarrageTableMeta {
  const tableId = input.target === 'combatUnits' ? 'barrage' : 'barrage-vs-facility'
  const table = findTable(chartsTables.tables, tableId)
  const columns = table.columns ?? []
  const initialColumn = resolveNumericColumnIndex(
    columns,
    roundBarrageValue(input.valueRange),
    tableId,
  )
  return {
    tableId,
    initialColumn,
    costT: table.cost?.[initialColumn] ?? 0,
    columnLabel: columns[initialColumn] ?? '',
    columnCount: columns.length,
  }
}

/**
 * 10.1b：能否支付这次火炮轰炸的补给
 *
 * 「消耗量会在对应轰炸表的顶部给出；请使用轰炸的**初始列**（计算任何横移之前）上的消耗量。
 *   如果无法满足轰炸所需的 SP 消耗，则**不能执行此次轰炸**。（这没有惩罚——所有单位取消轰炸，
 *   也**不视为已轰炸过**。）」A) 多单位齐射须来自**同一指挥部**，不用指挥部则来自**同一补给站**；
 *   C) 轰炸**永远不能使用部队储备**。
 */
export function canPayBarrageCost(input: {
  requiredT: number
  /** 可动用的 T（**只能来自 SP**：同一 HQ 或同一 dump，不含部队储备） */
  availableT: number
  /** 参炸单位数（>1 时才受 10.1b-A 的「同一来源」约束） */
  unitCount?: number
  /** 是否来自同一指挥部（10.1b-A）；false 时须来自同一补给站 */
  fromSameHq?: boolean
  /** 是否来自同一补给站（10.1b-A 的后半句） */
  fromSameDump?: boolean
  /** 是否动用了部队储备（10.1b-C：明令禁止） */
  usedInternalStocks?: boolean
}): { ok: true; rule: string } | { ok: false; rule: string; reason: string } {
  if (input.usedInternalStocks === true)
    return { ok: false, rule: '10.1b-C', reason: 'internalStocksForbidden' }
  if (input.availableT < input.requiredT)
    return { ok: false, rule: '10.1b', reason: 'cannotAfford' }
  // 10.1b-A：多单位齐射时补给须来自同一指挥部；不用指挥部则须来自同一补给站（单单位无此约束）
  if ((input.unitCount ?? 1) > 1 && input.fromSameHq !== true && input.fromSameDump !== true)
    return { ok: false, rule: '10.1b-A', reason: 'mixedSupplySources' }
  return { ok: true, rule: '10.1b' }
}

/* ── 4.2 轰炸值取整（唯一口径） ── */

/**
 * 4.2：小数轰炸值**先合并、再取整**
 *
 * 「Fractional barrage factors are **combined and then rounded** to determine the barrage column.」
 * ⇒ 取整作用在**加总之后**的值上，不能先逐个取整再相加；口径与 9.7 攻防比一致（四舍五入，
 * 见 `combat.roundHalfUp`）。
 *
 * 本作印值均为整数，出现小数只有一个来源：**DG 单位的轰炸值减半**（5.10b-A）。
 * 故 `barrageTableMeta` / `barrageCostT` / `resolveBarrage` 三个入口都必须先过这里，
 * 否则 2.5 这类值既不落在 `2` 段也不落在 `3-4` 段，会直接抛 TableLookupError。
 */
export function roundBarrageValue(value: number): number {
  return roundHalfUp(value)
}

/* ── 10.0 主结算 ── */

/** 列位夹取到表有效范围（横移可越界，10.0） */
function clampColumn(index: number, columns: readonly string[]): number {
  return Math.max(0, Math.min(columns.length - 1, index))
}

/**
 * 轰炸结算（10.0a）
 *
 * 列位 = **初始列**（按轰炸值）+ 全部列横移（密度/工事/地形/观察员/战略模式/短程），再按 2d6 取行。
 * ★ `costT` 取**初始列**的补给用量（10.1b），与横移无关。
 */
export function resolveBarrage(input: ResolveBarrageInput): BarrageResult {
  const { die, valueRange } = input
  if (!Number.isInteger(die) || die < 2 || die > 12)
    throw new RangeError(`[barrage] 轰炸骰应为 2–12 的两个骰之和，收到 ${die}`)
  if (valueRange < BARRAGE_MIN_VALUE)
    throw new RangeError(
      `[barrage] 至少需要 ${BARRAGE_MIN_VALUE} 点轰炸值才可使用轰炸表，收到 ${valueRange}`,
    )

  const table = findTable(chartsTables.tables, 'barrage')
  const columns = table.columns ?? []

  // 4.2：纵列按**合并后取整**的轰炸值确定（本函数也可能被直接以小数调用）
  const roundedValue = roundBarrageValue(valueRange)
  if (roundedValue < BARRAGE_MIN_VALUE)
    throw new RangeError(
      `[barrage] 至少需要 ${BARRAGE_MIN_VALUE} 点轰炸值才可使用轰炸表，收到 ${valueRange}`,
    )

  const initialColumn = resolveNumericColumnIndex(columns, roundedValue, 'barrage')
  const shifts = barrageColumnShifts(input)
  const finalColumn = clampColumn(initialColumn + shifts.total, columns)

  const rowIndex = matchRowIndex(table.rows, die, 'barrage')
  const code = lookupCell(table.grid, rowIndex, finalColumn, 'barrage')

  return {
    code,
    // 10.1b：补给用量取**初始列**（横移之前）
    costT: table.cost?.[initialColumn] ?? 0,
    initialColumn,
    finalColumn,
    shifts,
    die,
  }
}

/* ── 10.0a 结果结算（DG / 减损 / [1/2]） ── */

/** 战斗单位被轰炸后的结果 */
export interface BarrageOutcome {
  rule: string
  /** 目标格内**所有**战斗单位是否进入 DG（`-` 以外的一切结果都会 DG） */
  dg: boolean
  /** 需损失的军力点数合计（由拥有者选择哪些单位承受；10.0a） */
  stepLosses: number
  /** `1/2` 是否还需掷取整骰（调用方掷后重入 `halfDie`） */
  needsHalfDie: boolean
  detail: string
}

/**
 * 10.0a 结果解释（中文辅助卡第 4 页逐条）
 *
 *   - `-` 无效果；
 *   - `DG` 该格所有战斗单位进入 DG；
 *   - `#` 损失 # 点军力**并** DG；
 *   - `[1/2]` **若**目标在**等级 3 或 4 的环形工事**内、**或是飞机/舰船轰炸**、**或缺少观察员**，
 *     则直接**视为 DG**（不掷骰）；**其他情况视为普通的 `1/2`**；
 *   - `1/2` 掷 1 骰：**4-6** 损失 1 点军力并 DG，**其他结果只 DG**。
 *
 * @param halfDie `1/2` 的取整骰（1–6）；未给出且确实需要时返回 `needsHalfDie: true`
 */
export function resolveBarrageOutcome(input: {
  code: string
  hedgehogLevel?: number
  hasSpotter?: boolean
  kind?: BarrageKind
  strategicBomber?: boolean
  halfDie?: number
}): BarrageOutcome {
  const code = input.code.trim()
  if (code === '-')
    return { rule: '10.0a', dg: false, stepLosses: 0, needsHalfDie: false, detail: '无效果' }

  const isBracketed = code.startsWith('[')
  const numeric = Number(code.replace(/[[\]]/g, '').split('/')[0])

  if (code === 'DG')
    return { rule: '10.0a', dg: true, stepLosses: 0, needsHalfDie: false, detail: '目标 DG' }

  if (isBracketed || code === '1/2') {
    // `[1/2]` 的三个「直接判 DG」条件（10.0a；战略轰炸机按 10.0b 视为无观察员）
    const noSpotter = input.hasSpotter === false || input.strategicBomber === true
    const inHighHedgehog = (input.hedgehogLevel ?? 0) >= BARRAGE_BRACKET_HEDGEHOG_MIN_LEVEL
    const airOrShip = input.kind === 'air' || input.kind === 'ship'
    if (isBracketed && (inHighHedgehog || airOrShip || noSpotter))
      return {
        rule: '10.0a',
        dg: true,
        stepLosses: 0,
        needsHalfDie: false,
        detail: `[1/2] 条件成立（${[
          inHighHedgehog ? `等级 ≥${BARRAGE_BRACKET_HEDGEHOG_MIN_LEVEL} 环形工事` : null,
          airOrShip ? '飞机/舰船轰炸' : null,
          noSpotter ? '缺少观察员' : null,
        ]
          .filter((item): item is string => item !== null)
          .join('、')}）⇒ 视为 DG`,
      }
    if (input.halfDie === undefined)
      return {
        rule: '10.0a',
        dg: true,
        stepLosses: 0,
        needsHalfDie: true,
        detail: '1/2：需掷 1 枚取整骰（4-6 损 1 军力并 DG，其他只 DG）',
      }
    if (!Number.isInteger(input.halfDie) || input.halfDie < 1 || input.halfDie > 6)
      throw new RangeError(`[barrage] 取整骰应为 1–6 的单骰，收到 ${input.halfDie}`)
    const stepLoss = input.halfDie >= BARRAGE_HALF_RESULT_STEP_LOSS_MIN_DIE ? 1 : 0
    return {
      rule: '10.0a',
      dg: true,
      stepLosses: stepLoss,
      needsHalfDie: false,
      detail:
        stepLoss === 1
          ? `1/2 取整骰 ${input.halfDie} ≥ ${BARRAGE_HALF_RESULT_STEP_LOSS_MIN_DIE}：损失 1 点军力并 DG`
          : `1/2 取整骰 ${input.halfDie}：不损军力，只 DG`,
    }
  }

  if (!Number.isFinite(numeric) || numeric <= 0)
    throw new Error(`[barrage] 无法解析轰炸结果代码：${code}`)
  return {
    rule: '10.0a',
    dg: true,
    stepLosses: numeric,
    needsHalfDie: false,
    detail: `损失 ${numeric} 点军力并 DG（由拥有者选择承受单位）`,
  }
}

/* ── 10.0c 对设施轰炸 ── */

/**
 * 对设施轰炸结算（10.0c）
 *
 * 「玩家必须预先指定他的具体目标：空军基地或港口（或作为空军任务执行的运输破坏）。这些轰炸
 *   **不会被修正，也没有地形产生横移，也不需要观察员**。掷**一个骰子**决定结果。」
 */
export function resolveBarrageVsFacility(die: number, valueRange: number): BarrageResult {
  if (!Number.isInteger(die) || die < 1 || die > 6)
    throw new RangeError(`[barrage] 对设施轰炸掷 1 枚骰子（1–6），收到 ${die}`)
  const table = findTable(chartsTables.tables, 'barrage-vs-facility')
  const columns = table.columns ?? []

  const columnIndex = resolveNumericColumnIndex(columns, valueRange, 'barrage-vs-facility')
  const rowIndex = matchRowIndex(table.rows, die, 'barrage-vs-facility')
  const code = lookupCell(table.grid, rowIndex, columnIndex, 'barrage-vs-facility')

  const noShift: BarrageShiftBreakdown = {
    density: 0,
    hedgehog: 0,
    terrain: 0,
    spotter: 0,
    stratMode: 0,
    shortRange: 0,
    total: 0,
    detail: ['10.0c：对设施轰炸不受修正、无地形横移、不需观察员'],
  }
  return {
    code,
    costT: table.cost?.[columnIndex] ?? 0,
    initialColumn: columnIndex,
    finalColumn: columnIndex,
    shifts: noShift,
    die,
  }
}

/** 对设施轰炸的格值解析（如 `1 * (5)` / `2 * (4)` / `(6)` / `-`） */
export interface FacilityCodeParts {
  /** 不带括号的数字结果：对基地＝降低等级；对港口＝伤害（10.0c-A/B） */
  levelOrDamage: number
  /** 是否含 `*`（运输破坏成功） */
  trainbusting: boolean
  /** 括号内数字（空军基地目标：每架飞机掷骰，≥该值则损 1 军力）；无则 null */
  aircraftThreshold: number | null
}

/** 解析对设施轰炸格值 */
export function parseFacilityCode(code: string): FacilityCodeParts {
  const text = code.trim()
  if (text === '-') return { levelOrDamage: 0, trainbusting: false, aircraftThreshold: null }
  const levelOrDamage = Number(text.match(/^(\d+)/)?.[1] ?? 0)
  const aircraftThreshold = text.match(/\((\d+)\)/)
  return {
    levelOrDamage,
    trainbusting: text.includes('*'),
    aircraftThreshold: aircraftThreshold === null ? null : Number(aircraftThreshold[1]),
  }
}

/** 对设施轰炸的结果 */
export interface FacilityOutcome {
  rule: string
  /** 空军基地等级变化后的值（最低 1 级；简易机场永不降低） */
  baseLevelAfter?: number
  /** 每架飞机的掷骰结果（≥ 阈值则损失 1 军力） */
  aircraftLosses?: { id: string; roll: number; stepLoss: boolean }[]
  /** 港口累计伤害（上限 4 点，19.0b；本作无港口，仅按原文返回累计值） */
  portDamage?: number
  /** 是否放置运输破坏标记（14.8c：下一敌方清理阶段移除） */
  trainbustingPlaced?: boolean
  detail: string
}

/**
 * 10.0c：对设施轰炸的结果结算
 *
 *   A) 空军基地：括号结果 `(#)` ⇒ 对该格内**所有敌方飞机**逐一掷骰，掷骰 ≥# 者损失 1 军力；
 *      不带括号的数字（1/2）⇒ 把基地**降低相应等级、最低降至 1 级**；**简易机场永不降低等级**；
 *   B) 港口：只有 1/2 造成伤害，港口累积**最多 4 点**伤害（19.0b）——本作无港口，按原文返回累计值；
 *   C) 运输破坏：需要 `*` 结果才在该格放置运输破坏标记（14.8c）。
 */
export function resolveFacilityOutcome(input: {
  code: string
  target: Exclude<BarrageTargetKind, 'combatUnits'>
  /** 空军基地当前等级与是否简易机场 */
  baseLevel?: number
  isAirstrip?: boolean
  /** 港口的既有累计伤害（0–4） */
  portDamageBefore?: number
  /** 该格内的飞机与其掷骰（1d6；调用方掷） */
  aircraft?: readonly { id: string; roll: number }[]
}): FacilityOutcome {
  const parts = parseFacilityCode(input.code)
  if (input.code.trim() === '-') {
    const empty: Partial<FacilityOutcome> =
      input.target === 'airBase'
        ? { baseLevelAfter: input.baseLevel ?? 1 }
        : input.target === 'port'
          ? { portDamage: input.portDamageBefore ?? 0 }
          : { trainbustingPlaced: false }
    return { rule: '10.0c', ...empty, detail: '无效果' }
  }

  if (input.target === 'airBase') {
    const level = input.baseLevel ?? 1
    // 简易机场永不降低等级（10.0c-A）
    const baseLevelAfter =
      input.isAirstrip === true ? level : Math.max(1, level - parts.levelOrDamage)
    const aircraftLosses =
      parts.aircraftThreshold === null
        ? undefined
        : (input.aircraft ?? []).map((plane) => ({
            id: plane.id,
            roll: plane.roll,
            stepLoss: plane.roll >= (parts.aircraftThreshold ?? 0),
          }))
    return {
      rule: '10.0c-A',
      baseLevelAfter,
      ...(aircraftLosses === undefined ? {} : { aircraftLosses }),
      detail:
        `${input.code}：` +
        (parts.levelOrDamage > 0
          ? `基地等级 ${level} → ${baseLevelAfter}${input.isAirstrip === true ? '（简易机场永不降低）' : ''}；`
          : '') +
        (parts.aircraftThreshold === null
          ? ''
          : `每架飞机掷骰，≥${parts.aircraftThreshold} 者损失 1 军力（共 ${aircraftLosses?.length ?? 0} 架）`),
    }
  }

  if (input.target === 'port') {
    // 只有 1/2 造成伤害；累计上限 4 点（19.0b）
    const damage = Math.min(4, (input.portDamageBefore ?? 0) + parts.levelOrDamage)
    return {
      rule: '10.0c-B',
      portDamage: damage,
      detail: `${input.code}：港口累计伤害 ${input.portDamageBefore ?? 0} → ${damage}（上限 4）`,
    }
  }

  // 运输破坏：需要 `*` 结果
  return {
    rule: '10.0c-C',
    trainbustingPlaced: parts.trainbusting,
    detail: parts.trainbusting
      ? `${input.code}：放置运输破坏标记（14.8c）`
      : `${input.code}：无运输破坏效果`,
  }
}

/* ── 10.0d / 10.0e 资格与阶段 ── */

/** 轰炸资格判定 */
export type BarrageEligibility =
  { ok: true; rule: string } | { ok: false; rule: string; reason: string }

/**
 * 10.0d / 10.0e（＋10.1a / 10.2a / 10.2b / 13.4a）：能否发起这次轰炸
 *
 * 逐条：目标须预先宣布（10.0d）；每格每阶段只炸一次（10.0e-A，低空扫射/反舰除外）；
 * 每单位每阶段只炸一次且不得拆分/低于印刷值（10.0e-B）；阶段门槛（10.0e-C/D/E）；
 * 同类型限制（10.0e-F）；火炮在预备/战略模式不能轰炸（13.4a）；
 * 火炮射程按格且不受天气地形影响（10.1a）；空军任务机数与短程判定（10.0 / 10.2b）；
 * 至少 1 点轰炸值（10.0）。
 */
export function barrageEligibility(input: {
  kind: BarrageKind
  /** 当前 SOP 段（2.2） */
  phase: GamePhase
  /** 本次宣布的整体目标（10.0d） */
  declaredTarget: BarrageTargetKind
  /** 参炸单位数（10.0：空军单任务 ≤4 机） */
  unitCount: number
  /** 合计轰炸值（10.0：至少 1 点才可用表） */
  totalValue: number
  /** 该格本阶段是否已被轰炸过（10.0e-A；低空扫射/反舰为例外，由调用方传 false 放行） */
  hexAlreadyBarragedThisPhase?: boolean
  /** 是否已有单位本阶段轰炸过（10.0e-B） */
  unitAlreadyBarragedThisPhase?: boolean
  /** 是否把轰炸值拆分到多次轰炸（10.0e-B 禁止） */
  splitValue?: boolean
  /** 是否有单位以低于其印刷轰炸值的数值参炸（10.0e-B 禁止） */
  belowPrintedValue?: boolean
  /** 参炸单位是否含不同类型（10.0e-F） */
  mixedKinds?: boolean
  /** 火炮单位是否处于预备或战略模式（13.4a 禁止） */
  artilleryInReserveOrStrat?: boolean
  /** 是否为低空扫射（10.0e-A/C 的例外；10.0b 需正确观察员） */
  hipShoot?: boolean
  /** 是否有正确的观察员（低空扫射必需，10.0b） */
  hasSpotter?: boolean
}): BarrageEligibility {
  if (input.totalValue < BARRAGE_MIN_VALUE)
    return { ok: false, rule: '10.0', reason: 'belowMinBarrageValue' }
  if (input.mixedKinds === true) return { ok: false, rule: '10.0e-F', reason: 'mixedBarrageKinds' }
  if (input.unitAlreadyBarragedThisPhase === true)
    return { ok: false, rule: '10.0e-B', reason: 'unitAlreadyBarraged' }
  if (input.splitValue === true)
    return { ok: false, rule: '10.0e-B', reason: 'cannotSplitBarrageValue' }
  if (input.belowPrintedValue === true)
    return { ok: false, rule: '10.0e-B', reason: 'belowPrintedBarrageValue' }
  if (input.hexAlreadyBarragedThisPhase === true && input.hipShoot !== true)
    return { ok: false, rule: '10.0e-A', reason: 'hexAlreadyBarraged' }

  // 阶段门槛（10.0e-C/D/E）：火炮＝战斗/反应/进击；空军与海军＝移动/反应/进击
  // （低空扫射发生在**移动环节**，已包含在空军/海军的许可段内，故无需额外放宽）
  const allowed =
    input.kind === 'artillery'
      ? (['combat', 'reaction', 'exploitation'] as GamePhase[])
      : (['movement', 'reaction', 'exploitation'] as GamePhase[])
  if (!allowed.includes(input.phase))
    return {
      ok: false,
      rule: input.kind === 'artillery' ? '10.0e-D' : '10.0e-C',
      reason: `wrongPhaseFor${input.kind}:${input.phase}`,
    }

  if (input.kind === 'artillery') {
    if (input.artilleryInReserveOrStrat === true)
      return { ok: false, rule: '13.4a', reason: 'artilleryInReserveOrStratCannotBarrage' }
  }
  if (input.kind === 'air' && input.unitCount > BARRAGE_MAX_AIRCRAFT_PER_MISSION)
    return { ok: false, rule: '10.0', reason: 'tooManyAircraft' }
  if (input.hipShoot === true && input.hasSpotter !== true)
    return { ok: false, rule: '10.0b', reason: 'hipShootNeedsCorrectSpotter' }
  /*
   * 14.7d-B：「A Hip Shoot must be made by a **single aircraft**。」⇒ 须**单机**。
   * 14.7d-D：「Exception: **Trainbusting cannot be performed as a Hip Shoot**.」⇒ 禁止运输破坏。
   *
   * ★ 这两条此前**缺失**（实测：3 架被接受、运输破坏被接受）。判据放在此处，空军交互的
   *   `hip_shoot` 分支也走同一个 `barrageEligibility`，故不必两处各写一遍。
   */
  if (input.hipShoot === true && input.unitCount !== 1)
    return { ok: false, rule: '14.7d-B', reason: `hipShootNeedsSingleAircraft:${input.unitCount}` }
  if (input.hipShoot === true && input.declaredTarget === 'trainbusting')
    return { ok: false, rule: '14.7d-D', reason: 'hipShootCannotTrainbusting' }
  if (input.declaredTarget === 'combatUnits' && input.kind === 'artillery' && input.unitCount === 0)
    return { ok: false, rule: '10.1', reason: 'noArtilleryUnit' }
  return { ok: true, rule: '10.0e' }
}

/* ── 工具 ── */

function sameHex(a: HexRef, b: HexRef): boolean {
  return a.col === b.col && a.row === b.row
}
