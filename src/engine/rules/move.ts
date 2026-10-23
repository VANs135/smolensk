import { rulesConstants } from '@/data'
import type { Side } from '@/data'

import { HEX_DIRECTIONS, areAdjacent, hexDistance, neighbor, sameHex } from '../hex-geometry'
import { OVERRUN_MP_COST } from './combat'
import { bridgedCrossing } from './construction'
import type {
  MoveContext,
  MoveRejectReason,
  MoveUnitView,
  ReachableHex,
  ReachabilityResult,
  StepFailure,
  StepOutcome,
} from './move-types'
import {
  canMoveInPhase,
  canonicalMode,
  exertsZoc,
  hasMarker,
  maMultiplier,
  mustEndMoveInSupply,
  type ModeState,
  type MovementSegmentPhase,
} from './modes'
import { STACKING_LIMIT_RE } from './movement'
import { selectMovementTerrain } from './terrain'
import { isInEnemyZoc, zocEntryEffect, type ZocSource } from './zoc'

/**
 * 地面移动的执行与可达性（OCS 6.0 / 6.1 / 6.2 + 4.5a-A + 4.5b + 8.1）
 *
 * 本模块只做**移动**：取费、逐步合法性、可达格集合、突袭资格（突袭的战斗结算属 8.0/9.x）。
 * 一律纯函数；地图事实由 MapFacts 注入（默认实现 map-facts.ts）；数值全部来自 rules-constants.json。
 *
 * ## 条文索引（中文规则书）
 *   - 6.0    移动阶段/反应阶段/进击阶段各有移动环节；满足 MA、模式、燃料、地形才可移动
 *   - 6.1a   MP：每进入一格、每穿越一格边都要消耗 MP
 *   - 6.1b   MA：一个阶段可消耗的 MP 总量；SP/港口/空军基地/环形工事无 MA，不可移动或撤退
 *   - 6.1c   最小移动：允许移动且 MA>0 时，MP 不足也总能走一格；不能用于突袭、不能违反模式限制、不能进/穿禁入地形
 *   - 6.1d   互逆性：能从 A 进 B ⇔ 能从 B 进 A
 *   - 6.1h   减少后的 MA 永不取整
 *   - 6.2a   沿连续道路移动 → 付道路费率并忽略格/格边其他地形（同格内所有道路铁路视为相连）
 *   - 6.2b   格边地形消耗与进入格消耗相加；沿路时忽略格边地形
 *   - 6.2c   不能进入或穿越禁入的格与格边（除非桥梁或道路）；被迫者摧毁
 *   - 6.2d   格内多地形取最贵；符号有无即算
 *   - 4.5a-A 轮式 MP 单位进入未抵消敌方 ZOC 必须停止或突袭
 *   - 4.5b   抵消：格内有友方战斗单位（该单位本阶段起不得再消耗 MP）
 *   - 8.1/8.1a/8.1b/8.1c  突袭资格：阶段开始时同格堆叠的可攻击单位、战斗/移动/进击模式、
 *                          3 MP/次、进入格 MP ≤ 3、不得借道路桥梁降费或否定禁入地形
 *   - 12.5a  使用轮式/履带 MP 的战斗单位要消耗 MP 必须先付燃料
 *   - 5.8b   战略模式单位必须在当前拥有追溯补给的格内结束移动
 */

/* ────────────────────────────── 常量 ────────────────────────────── */

/** 突袭允许的「进入格」MP 上限（8.1b；突袭每次 3 MP 的费用见 combat.ts 的 OVERRUN_MP_COST） */
export const OVERRUN_MAX_ENTRY_MP = rulesConstants.combat.overrunMaxEntryMp

/* ────────────────────────────── 基础视图工具 ────────────────────────────── */

/** 单位 → 模式状态（与 state-types 字段一一对应） */
function modeStateOf(unit: MoveUnitView): ModeState {
  return {
    mode: unit.mode,
    orientation: unit.orientation,
    dg: unit.dg,
    exploit: unit.exploit,
    releasedFromReserve: unit.releasedFromReserve,
  }
}

/** 本阶段该单位的可用 MA（模式修正；6.1h 永不取整） */
export function availableMa(unit: MoveUnitView, phase: MovementSegmentPhase): number {
  return unit.ma * maMultiplier(modeStateOf(unit), phase)
}

/**
 * 12.5a：是否需要燃料才能消耗 MP
 *
 * 「使用轮式 MP 或履带 MP 的**战斗单位**要消耗 MP 的话，玩家必须消耗燃料补给，否则不能消耗任何 MP」；
 * 「其他类型的单位或功能（如步行单位、卡车、舰船、飞机、补给拖取、补给投递）永远不需要消耗燃料补给」。
 * 故判据 = 战斗单位 ∧ 机动类型为 truck/track。
 */
export function requiresFuel(unit: MoveUnitView): boolean {
  return unit.isCombat && (unit.mobility === 'truck' || unit.mobility === 'track')
}

/**
 * 由单位视图汇总 ZOC 来源（4.5：战斗模式 + 可攻击 + 非断补）
 *
 * ★ 「是否处于战斗模式」一律交给 modes.exertsZoc 裁定（基础模式 + 层叠标记 → ZOC 规则），
 *   本处不自行从 `unit.mode` 推导：那样会漏掉 **进击保留基础模式**（5.9c），
 *   也会把**已释放的预备**误判成仍在预备模式（5.7b 释放即回战斗/移动模式）。
 */
export function zocSourcesOf(units: readonly MoveUnitView[]): ZocSource[] {
  const sources: ZocSource[] = []
  for (const unit of units) {
    if (unit.hex === null) continue
    sources.push({
      hex: unit.hex,
      side: unit.side,
      attackCapable: unit.attackCapable,
      inCombatMode: exertsZoc(modeStateOf(unit)),
      hasTraceSupply: unit.hasTraceSupply,
    })
  }
  return sources
}

/**
 * 4.5b：该格的敌方 ZOC 是否被己方「垫人」抵消
 *
 * 「如果某一格内包含友方战斗单位，则该格内的敌方 ZOC 会被抵消。但是用于抵消 ZOC 的单位
 *   在之后时间里不能消耗 MP 直到当前阶段结束。」→ 判据 = 格内有己方**战斗单位**且其
 * `mpLockedThisPhase` 为真（该承诺由命令层在玩家点选垫人单位时写入）。
 */
export function zocNegatedAt(
  context: MoveContext,
  hex: { col: number; row: number },
  movingSide: Side,
): boolean {
  return context.units.some(
    (unit) =>
      unit.side === movingSide &&
      unit.isCombat &&
      unit.mpLockedThisPhase &&
      unit.hex !== null &&
      sameHex(unit.hex, hex),
  )
}

/**
 * 该格是否处于敌方 ZOC（4.5），已计入 4.5b 抵消
 *
 * 注意 4.5a-A 的另一半：「在某个阶段开始时就在敌方 ZOC 内的单位，可以使用轮式 MP 离开该格」
 * —— 那只影响「进入」判定，不影响本函数对格的描述。
 */
export function inEnemyZocAt(
  context: MoveContext,
  hex: { col: number; row: number },
  movingSide: Side,
): boolean {
  const enemySide: Side = movingSide === 'axis' ? 'soviet' : 'axis'
  return isInEnemyZoc(hex, enemySide, zocSourcesOf(context.units), {
    friendlyCombatUnitInHex: zocNegatedAt(context, hex, movingSide),
  })
}

/**
 * 专规 1.1b：该格是否为「**敌方**安全边缘格」（对 `movingSide` 而言不可进入）
 *
 * 数据来自剧本给出的补给源清单（专规 2.1/3.1），由调用方按归属分成两组放进 `MoveContext`；
 * 未提供即不施加该检查（宁可少判，也不臆造一张边缘格表）。
 */
export function isEnemySafeEdgeHex(
  context: MoveContext,
  hex: { col: number; row: number },
  movingSide: Side,
): boolean {
  const lists = context.safeEdgeHexesBySide
  if (lists === undefined) return false
  const enemySide: Side = movingSide === 'axis' ? 'soviet' : 'axis'
  const list = enemySide === 'axis' ? lists.axis : lists.soviet
  return list.some((item) => sameHex(item, hex))
}

/**
 * 该格是否处于敌方 ZOC（4.5）**且不计 4.5b 抵消**（9.12e 专用）
 *
 * 9.12e：「当一个战斗单位撤退进入一个敌方 ZOC 时，会立即切换为 DG 模式……此 ZOC 效果
 *   **无法被友方战斗单位『抵消』**，也不受地形影响。」
 *
 * ⇒ 撤退判定必须绕开 4.5b 的抵消（撤退是无计划移动，友军「保护」并不能避免混乱），
 *   故本函数与 `inEnemyZocAt` 的唯一差别就是**不接受** `friendlyCombatUnitInHex` 抵消。
 */
export function inEnemyZocForRetreat(
  context: MoveContext,
  hex: { col: number; row: number },
  movingSide: Side,
): boolean {
  const enemySide: Side = movingSide === 'axis' ? 'soviet' : 'axis'
  return isInEnemyZoc(hex, enemySide, zocSourcesOf(context.units))
}

/**
 * 格内**同方战斗单位**的 RE 合计（4.8 / 4.8a）
 *
 * 「在一个格中，允许堆叠的**战斗单位**合计上限为 10RE。任意数量的 SP 或运输点数都可以堆叠在
 *   同一格中」→ 只计战斗单位，且只计请求方自己的单位（敌我同格属 4.8c 的极少数情形）。
 */
function stackCombatReAt(
  context: MoveContext,
  hex: { col: number; row: number },
  side: Side,
  excludeUnitId?: string,
): number {
  let total = 0
  for (const unit of context.units) {
    if (unit.hex === null || unit.id === excludeUnitId) continue
    if (!unit.isCombat || unit.side !== side) continue
    if (sameHex(unit.hex, hex)) total += unit.re
  }
  return total
}

/** 格内是否有敌方**战斗**单位（6.3b/8.0：须以突袭处理，不能直接走进） */
function hasEnemyCombatUnit(
  context: MoveContext,
  hex: { col: number; row: number },
  movingSide: Side,
): boolean {
  return context.units.some(
    (unit) =>
      unit.hex !== null && sameHex(unit.hex, hex) && unit.side !== movingSide && unit.isCombat,
  )
}

function reject(reason: MoveRejectReason, rule: string, detail?: string): StepFailure {
  return detail === undefined ? { ok: false, reason, rule } : { ok: false, reason, rule, detail }
}

/* ────────────────────────────── 单步移动 ────────────────────────────── */

/** 单步判定选项 */
export interface StepOptions {
  /** 本轮已消耗的 MP（6.1a 预算；6.1c 最小移动只允许出现在起点格） */
  mpSpent?: number
  /** 是否用于突袭判定（8.1c：不得用道路/桥梁降费，也不得否定禁入地形；不计 MP 预算） */
  forOverrun?: boolean
}

/** 定位单位；找不到返回失败 */
export function findMoveUnit(context: MoveContext, unitId: string): MoveUnitView | null {
  return context.units.find((unit) => unit.id === unitId) ?? null
}

/** 单步取费结果（不含 MP 预算判定） */
interface StepCost {
  ok: true
  cost: number
  hexCost: number
  hexsideCost: number
  roadOverride: boolean
  crossedOnBridge: boolean
  spendsAllMp: boolean
}

/**
 * 13.8b：**本步取费用**的格边（架桥降级之后）
 *
 * 「当与一个大河相邻时，具有工程能力的单位会自动将大河格边的 MP 消耗降至小河格边的 MP 消耗。……
 *   只有友方单位移动**进入或离开**工程能力单位所在格时，移动消耗才能降低。」
 * ⇒ 判据只有一条：本步的**出格或入格**在 `bridgedHexesBySide[本方]` 里。
 *
 * 「攻击单位不能使用架桥能力跨越格边来过河突袭」⇒ `forOverrun` 步骤一律不降级（8.1c）。
 * 湖/禁入不在降级范围（条文只说大河与小河），由 `bridgedCrossing` 内部原样保留。
 */
function crossingForStep(
  context: MoveContext,
  unit: MoveUnitView,
  from: { col: number; row: number },
  to: { col: number; row: number },
  forOverrun: boolean,
): ReturnType<typeof bridgedCrossing> {
  const crossing = context.map.crossingBetween(from, to)
  const bridges = context.bridgedHexesBySide?.[unit.side]
  if (bridges === undefined || bridges.length === 0 || crossing === null) return crossing
  const keyOf = (hex: { col: number; row: number }): string => `${hex.col}.${hex.row}`
  const keys = new Set(bridges.map(keyOf))
  const touchesEngineerHex = keys.has(keyOf(from)) || keys.has(keyOf(to))
  return bridgedCrossing(crossing, {
    touchesEngineerHex,
    // 「当单位不再具备工程能力时，架的桥就会消失」⇒ 调用方给出的格**就是**此刻仍有桥的格
    // （含例外：失去能力者离开自己架的桥那一格时，那一格仍在清单里）
    bridgePresent: true,
    forOverrun,
  })
}

/** 计算一步的取费（不含 MP 预算判定） */
function costOfStep(
  context: MoveContext,
  unit: MoveUnitView,
  from: { col: number; row: number },
  to: { col: number; row: number },
  forOverrun: boolean,
): StepCost | StepFailure {
  // 13.8b：本步的出/入格若在**本方**架桥生效格里，这条格边的河流降一级（突袭步不降）
  const crossing = crossingForStep(context, unit, from, to, forOverrun)
  // 6.2a：沿连续道路移动 → 付道路费率并忽略格/格边其他地形。
  // 判据落到「本步穿越的格边是否承载道路/铁路」——因为同格内所有道路与铁路视为相连，
  // 只要这一步是沿路迈出的，就是「沿一条连续道路移动」；不是沿路迈出即按格内地形计费。
  const followingRoad = !forOverrun && (crossing?.routes ?? []).length > 0
  const result = selectMovementTerrain({
    terrainsPresent: context.map.terrainsAt(to),
    mobility: unit.mobility,
    crossing,
    followingRoad,
    forOverrun,
  })
  if (!result.ok) {
    if (result.reason === 'prohibited')
      // 突袭下「禁入/All」都表现为不可突袭：8.1b 的 All 与 8.1c 的禁入地形
      return reject('prohibited', forOverrun ? '8.1b' : '6.2c', result.terrain)
    if (result.reason === 'unknownTerrain') return reject('unknownTerrain', '6.2', result.terrain)
    return reject('noTerrain', '6.2d', `${to.col}.${to.row}`)
  }
  return {
    ok: true,
    cost: result.totalMp,
    hexCost: result.mp,
    hexsideCost: result.hexsideDelta,
    roadOverride: result.roadOverride,
    crossedOnBridge: result.crossedOnBridge,
    spendsAllMp: result.spendsAllMp,
  }
}

/**
 * 6.1d 互逆性：能从 A 进 B ⇔ 能从 B 进 A
 *
 * 只把「反向为禁入」判为不合法（规则举的例子即禁入地形）；反向的数据缺失不在此拦，
 * 避免把数据问题误判成规则限制。
 *
 * ★ 反向判定必须与正向同口径地带上「是否沿路进入」：正向计费（`costOfStep`）用
 *   `crossing.routes` 判定是否沿路，6.2a/9.1f 允许「沿路进入否则禁入的格」。若反向写死
 *   `followingRoad: false`，则「身处禁入地形格、沿同一条路离开」会被误判为违反互逆性
 *   ——而它恰恰是对称的（反向沿同一条路也进得来），结果是单位**永久卡死**：
 *   任何方向都走不出去（可达格 BFS 同判据，高亮集为空）。
 */
function violatesReciprocity(
  context: MoveContext,
  unit: MoveUnitView,
  from: { col: number; row: number },
  to: { col: number; row: number },
): boolean {
  // 格边是无序对（`hexsideOf` 归一），故 (from, to) 与 (to, from) 取到同一条边；
  // 13.8b 的架桥降级也用同一口径（否则「借自己架的桥离开」会被误判成违反互逆性 ⇒ 单位卡死）
  const crossing = crossingForStep(context, unit, from, to, false)
  const followingRoad = (crossing?.routes ?? []).length > 0
  const back = selectMovementTerrain({
    terrainsPresent: context.map.terrainsAt(from),
    mobility: unit.mobility,
    crossing,
    followingRoad,
    forOverrun: false,
  })
  return !back.ok && back.reason === 'prohibited'
}

/**
 * 逐步移动判定（6.1a/6.1c/6.1d/6.2/4.5a-A/4.5b/12.5a/5.8b）
 *
 * 这是「单位可逐格移动」的唯一入口：UI 每次点一格都调它；
 * 可达格 BFS 走 `evaluateStepFrom`（同一套判据，只是起点由模拟路径给出），
 * 保证「高亮的格」与「真的能走进去」永远一致。
 */
export function evaluateStep(
  context: MoveContext,
  unitId: string,
  to: { col: number; row: number },
  options: StepOptions = {},
): StepOutcome {
  const unit = findMoveUnit(context, unitId)
  if (unit === null) return reject('unitNotFound', '—', unitId)
  if (unit.hex === null) return reject('notOnMap', '6.0', unitId)
  return evaluateStepFrom(context, unit, unit.hex, to, options)
}

/**
 * 从显式起点判定一步（BFS 模拟中间位置用）
 *
 * `from` 由调用方给出，单位视图本身仍保留其真实位置——故堆叠统计、敌方占据与 ZOC 判定
 * 都以**运行状态**为准，只有「这一步从哪里迈出」由参数决定。
 */
export function evaluateStepFrom(
  context: MoveContext,
  unit: MoveUnitView,
  from: { col: number; row: number },
  to: { col: number; row: number },
  options: StepOptions = {},
): StepOutcome {
  const forOverrun = options.forOverrun === true
  const mpSpent = options.mpSpent ?? 0
  const state = modeStateOf(unit)

  // 6.0 / 6.3a / 7.0a / 11.0a：该阶段的行动权
  const phaseCheck = canMoveInPhase(
    { state, side: unit.side, activeSide: context.activeSide },
    context.phase,
  )
  if (!phaseCheck.ok) return reject('phaseNotAllowed', phaseCheck.rule, phaseCheck.reason)

  // 6.1b：无 MA（SP/港口/空军基地/环形工事）不可移动；MA 为 0 同理
  if (unit.ma <= 0) return reject('immobile', '6.1b', unit.id)

  // 4.5b：已承诺本阶段不再消耗 MP 的垫人单位不能再动
  if (unit.mpLockedThisPhase) return reject('mpLocked', '4.5b', unit.id)

  // 12.7：延补队面不可移动——「延补队不能移动」；12.7d 要求先翻回运输点数面（翻面耗半个 MA）
  if (unit.isExtenderFace === true) return reject('extenderCannotMove', '12.7', unit.id)

  // 12.5a：轮式/履带战斗单位要消耗 MP 必须先付燃料
  if (requiresFuel(unit) && !unit.fuelled) return reject('needsFuel', '12.5a', unit.id)

  if (sameHex(from, to)) return reject('notAdjacent', '6.1', `${to.col}.${to.row}`)
  if (!areAdjacent(from, to)) return reject('notAdjacent', '6.1', `${to.col}.${to.row}`)
  if (!context.map.onMap(to)) return reject('destinationOffMap', '专规 1.4', `${to.col}.${to.row}`)

  // 专规 1.1b：敌方**安全边缘格**（作为补给源的地图边格）不得被敌方地面单位进入；
  // 规则明文「可以被常规战斗攻击，但**不可被突袭**（因为可能需要推进）」⇒ 本判据对普通移动与
  // 突袭一体生效（突袭也要进格）。
  if (isEnemySafeEdgeHex(context, to, unit.side))
    return reject('enemySafeEdge', '专规 1.1b', `${to.col}.${to.row}`)

  // 6.3b / 8.0：敌方战斗单位占据的格不能直接走进（须以突袭处理）
  if (!forOverrun && hasEnemyCombatUnit(context, to, unit.side))
    return reject('enemyOccupied', '6.3b', `${to.col}.${to.row}`)

  const cost = costOfStep(context, unit, from, to, forOverrun)
  if (!cost.ok) return cost
  if (violatesReciprocity(context, unit, from, to))
    return reject('reciprocity', '6.1d', `${to.col}.${to.row}`)

  // 4.8a：堆叠上限**不是逐步禁令**——「超堆叠，是指在任何环节或阶段结束时，某一格内的战斗单位
  //   超过 10RE」且「单位在移动过程中可以暂时地超堆叠」。故此处只如实标记「本步造成暂时超堆叠」，
  //   由合法性校验层（legality.stackingObligations）在环节/阶段结束时结算义务。
  //   唯一在本步就要拦的堆叠例外是**突袭**（见 canOverrun）。
  const createsOverstack =
    stackCombatReAt(context, to, unit.side) + (unit.isCombat ? unit.re : 0) > STACKING_LIMIT_RE

  // 4.5a-A：进入未抵消敌方 ZOC 后，轮式必须停止（或突袭）
  const enteringEnemyZoc = inEnemyZocAt(context, to, unit.side)
  // 5.8a：战略模式单位**不可移动进入敌方 ZOC**（与 4.5a-A 的「进入后可停」不同，这里是禁止进入）。
  //   注意只约束「进入」：若单位在本阶段开始时已在敌方 ZOC 内（敌方后来靠上来的情形，5.8a 括注
  //   「如果是敌方单位移动到它们相邻处，不会发生任何特殊情况」），它仍可以走出该 ZOC。
  if (enteringEnemyZoc && hasMarker(state, 'strat'))
    return reject('stratIntoEzoc', '5.8a', `${to.col}.${to.row}`)
  const forcedStop = enteringEnemyZoc && zocEntryEffect(unit.mobility) === 'mustStopOrOverrun'

  // 6.2a/6.2b：MP 预算
  const ma = availableMa(unit, context.phase)
  const remaining = ma - mpSpent
  let minimumMove = false
  if (!forOverrun && cost.cost > remaining) {
    // 6.1c（★ 用户裁定口径）：只要允许移动且 MA > 0，单位**总能进入一格**——即使该格的移动力消耗
    // 大于它剩余（甚至大于印制）的 MA；代价是把剩余的 MP 用完并就此结束本轮。
    // 三个例外照规则书原文：不能用于突袭、不能违反模式限制、不能进入/穿越禁入地形。
    if (mpSpent !== 0 || ma <= 0)
      return reject('notEnoughMp', '6.1a', `${cost.cost} MP > 剩余 ${remaining}`)
    minimumMove = true
  }

  // 6.1c 的最小移动会把剩余 MA 用尽 → 本轮移动结束；4.5a-A 强制停止；6.2b 的 All 亦然
  let mustEndMove = forcedStop || cost.spendsAllMp || minimumMove
  // 5.8b：战略模式单位必须在当前拥有追溯补给的格内结束移动（补齐补给模块前不施加）
  if (mustEndMoveInSupply(state) && context.traceSupplyAt !== undefined) {
    if (!context.traceSupplyAt(to, unit.side)) mustEndMove = true
  }

  return {
    ok: true,
    // 6.1c：最小移动只把「剩余的 MP 用完」（地形实际要多少由 hexCost/hexsideCost 如实带出）
    cost: minimumMove ? Math.min(cost.cost, remaining) : cost.cost,
    hexCost: cost.hexCost,
    hexsideCost: cost.hexsideCost,
    roadOverride: cost.roadOverride,
    crossedOnBridge: cost.crossedOnBridge,
    minimumMove,
    spendsAllMp: cost.spendsAllMp,
    forcedStop,
    mustEndMove,
    // 4.8a：是否造成「暂时超堆叠」——由合法性校验层在环节/阶段末结算义务，此处只记录事实
    createsOverstack,
  }
}

/* ────────────────────────────── 可达格查询（UI 接口） ────────────────────────────── */

/** 定位单位并给出「能不能动 + 可用 MA」前的公共校验 */
function prepareMove(
  context: MoveContext,
  unitId: string,
): { ok: true; unit: MoveUnitView; ma: number; start: { col: number; row: number } } | StepFailure {
  const unit = findMoveUnit(context, unitId)
  if (unit === null) return reject('unitNotFound', '—', unitId)
  if (unit.hex === null) return reject('notOnMap', '6.0', unitId)
  const phaseCheck = canMoveInPhase(
    { state: modeStateOf(unit), side: unit.side, activeSide: context.activeSide },
    context.phase,
  )
  if (!phaseCheck.ok) return reject('phaseNotAllowed', phaseCheck.rule, phaseCheck.reason)
  if (unit.ma <= 0) return reject('immobile', '6.1b', unitId)
  if (unit.mpLockedThisPhase) return reject('mpLocked', '4.5b', unitId)
  // 12.7：延补队面不可移动（高亮可到达格的查询也必须一致地拒绝）
  if (unit.isExtenderFace === true) return reject('extenderCannotMove', '12.7', unitId)
  if (requiresFuel(unit) && !unit.fuelled) return reject('needsFuel', '12.5a', unitId)
  return { ok: true, unit, ma: availableMa(unit, context.phase), start: unit.hex }
}

/**
 * 单位当前可到达的全部格（UI 接口：点击单位后标识可到达格）
 *
 * 算法：以「格 → 最小已耗 MP」为状态做 Dijkstra/BFS（每步取费为正且离散，故用最小堆式松弛）。
 *   ① 每步都走 `evaluateStep` —— 与逐格点击同一套判据，高亮与实走不会不一致；
 *   ② `mustEndMove`（4.5a-A 强制停止 / 6.2b All 地形 / 5.8b 战略补给）标为终点不继续扩展；
 *   ③ 6.1c 最小移动只在起点格生效，故它只贡献「邻格可达」这一条，不递归。
 *
 * 返回值按「距起点格数 → MP → 列 → 行」升序，保证 UI 与回归测试确定性。
 */
export function computeReachableHexes(context: MoveContext, unitId: string): ReachabilityResult {
  const prepared = prepareMove(context, unitId)
  if (!prepared.ok) return prepared
  const { unit, ma, start } = prepared

  const best = new Map<string, ReachableHex>()
  const keyOf = (hex: { col: number; row: number }): string => `${hex.col}.${hex.row}`
  best.set(keyOf(start), {
    hex: start,
    mpSpent: 0,
    minimumMove: false,
    forcedStop: false,
    path: [start],
  })

  const queue: ReachableHex[] = [best.get(keyOf(start))!]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.forcedStop) continue
    for (const direction of HEX_DIRECTIONS) {
      const step = neighbor(current.hex, direction)
      const outcome = evaluateStepFrom(context, unit, current.hex, step, {
        mpSpent: current.mpSpent,
      })
      if (!outcome.ok) continue
      const nextMp = current.mpSpent + outcome.cost
      if (nextMp > ma) continue
      const key = keyOf(step)
      const existing = best.get(key)
      const better =
        existing === undefined ||
        nextMp < existing.mpSpent ||
        (nextMp === existing.mpSpent && existing.minimumMove && !outcome.minimumMove)
      if (!better) continue
      const node: ReachableHex = {
        hex: step,
        mpSpent: nextMp,
        minimumMove: outcome.minimumMove,
        forcedStop: outcome.mustEndMove || nextMp >= ma,
        path: [...current.path, step],
      }
      best.set(key, node)
      queue.push(node)
    }
  }

  best.delete(keyOf(start))
  const reachable = [...best.values()].sort(
    (a, b) =>
      hexDistance(start, a.hex) - hexDistance(start, b.hex) ||
      a.mpSpent - b.mpSpent ||
      a.hex.col - b.hex.col ||
      a.hex.row - b.hex.row,
  )

  return { ok: true, ma, mpSpent: 0, mpRemaining: ma, reachable }
}

/* ────────────────────────────── 突袭资格（8.1） ────────────────────────────── */

/** 突袭资格判定输入 */
export interface OverrunCheckInput {
  context: MoveContext
  /** 参与突袭的单位 id；须同格、须在本阶段开始时即同格堆叠（8.1） */
  unitIds: readonly string[]
  /** 目标格（相邻的敌方战斗单位格） */
  target: { col: number; row: number }
  /** 这些单位在本阶段开始时是否同格堆叠（8.1：只有此阶段开始时就堆叠在一起的可攻击单位才能突袭） */
  startedStackedTogether: boolean
  /** 该堆叠当前剩余 MP */
  mpRemaining: number
}

/** 突袭资格结果 */
export type OverrunCheck = { ok: true; mpCost: number; entryCost: number } | StepFailure

/**
 * 能否突袭（8.0/8.1/8.1a/8.1b/8.1c + 5.10b-C）
 *
 * 只判**资格与费用**，不结算战斗（战斗在 8.0 指向 9.2 流程）。
 * 8.1h（出发格可另有友军）不在此判——用户裁定：突袭由玩家选部分单位作为堆叠发起，
 * 选子集即自然满足 8.1h，待突袭结算单元实现时再处理。
 */
export function canOverrun(input: OverrunCheckInput): OverrunCheck {
  const { context, unitIds, target, mpRemaining } = input
  if (unitIds.length === 0) return reject('unitNotFound', '8.1')
  const units: MoveUnitView[] = []
  for (const id of unitIds) {
    const unit = findMoveUnit(context, id)
    if (unit === null) return reject('unitNotFound', '8.1', id)
    if (unit.hex === null) return reject('notOnMap', '8.1', id)
    units.push(unit)
  }
  const from = units[0]!.hex!
  if (!units.every((unit) => unit.hex !== null && sameHex(unit.hex, from)))
    return reject('notAdjacent', '8.1', '参突单位不在同一格')

  // 4.8a：移动中的暂时超堆叠**不适用于突袭**——「所有参与突袭的单位加上它们所在格内的所有
  //   其他友方单位，合计规模不能超过 10RE」，故突袭发起格此刻就必须满足上限
  const originRe = stackCombatReAt(context, from, units[0]!.side)
  if (originRe > STACKING_LIMIT_RE)
    return reject('stackingLimit', '4.8a', `突袭发起格 ${originRe} RE > ${STACKING_LIMIT_RE} RE`)

  // 8.1：只有在此阶段开始时就堆叠在一起的可攻击单位才能突袭，且须处于战斗/移动/进击模式
  if (!input.startedStackedTogether)
    return reject('phaseNotAllowed', '8.1', '参突单位本阶段开始时未同格堆叠')
  for (const unit of units) {
    if (!unit.attackCapable) return reject('notAttackCapable', '8.1', `${unit.id} 不可攻击`)
    // 8.1 要求「处于战斗、移动或进击模式」；★ 用 5.7b 的规范模式判定：
    // 已释放的预备（标记已移除、回到朝向那一面）与带进击标记的单位都算，故不能看原始 mode 字段
    if (unit.dg) return reject('phaseNotAllowed', '5.10b', `${unit.id} 处于 DG 模式`)
    // 12.7：延补队不能移动，自然也不能突袭
    if (unit.isExtenderFace === true) return reject('extenderCannotMove', '12.7', unit.id)
    const mode = canonicalMode(modeStateOf(unit))
    if (mode !== 'combat' && mode !== 'move')
      return reject('phaseNotAllowed', '8.1', `${unit.id} 不在战斗/移动/进击模式`)
    if (unit.ma <= 0) return reject('immobile', '6.1b', unit.id)
    if (requiresFuel(unit) && !unit.fuelled) return reject('needsFuel', '12.5a', unit.id)
  }

  // 8.1a：每突袭一次消耗 3 MP；剩余 MP 不足 3 的单位不能突袭
  if (mpRemaining < OVERRUN_MP_COST)
    return reject('notEnoughMp', '8.1a', `剩余 ${mpRemaining} MP < ${OVERRUN_MP_COST} MP`)

  // 8.0/8.1d：从相邻格发起
  if (!areAdjacent(from, target))
    return reject('notAdjacent', '8.1d', `${target.col}.${target.row}`)
  if (!context.map.onMap(target))
    return reject('destinationOffMap', '专规 1.4', `${target.col}.${target.row}`)

  // 8.1b：进入格 MP（格内＋格边＋运输破坏）≤ 3；地形为 All 不可突袭
  // 8.1c：不得用道路/桥梁降费、不得否定禁入地形、不得满足 6.1d → 统一用 forOverrun 计费
  const entry = costOfStep(context, units[0]!, from, target, true)
  if (!entry.ok) return entry
  if (entry.spendsAllMp) return reject('prohibited', '8.1b', '地形消耗为 All，不可突袭')
  if (entry.cost > OVERRUN_MAX_ENTRY_MP)
    return reject('prohibited', '8.1b', `进入格 ${entry.cost} MP > ${OVERRUN_MAX_ENTRY_MP} MP`)
  // 8.1c：突袭不得借道路/桥梁把该格 MP 压低（forOverrun 计费已忽略道路；此处再挡一次禁入）
  if (violatesReciprocity(context, units[0]!, from, target))
    return reject('reciprocity', '6.1d 引 8.1c', `${target.col}.${target.row}`)

  return { ok: true, mpCost: OVERRUN_MP_COST, entryCost: entry.cost }
}
