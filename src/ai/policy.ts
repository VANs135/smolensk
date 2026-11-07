/**
 * B3：基线 AI 的**纯决策层**
 *
 * 纪律（硬约束）：
 * - 本文件只吃**只读快照**、只吐一个 `AiAction`，不引用任何 store、不掷骰、不用 `Math.random`；
 * - 合法性判据一律来自快照里的既有投影（`groupReachable` / `legalActionsView` / `barrageUnitChoices` /
 *   `combatRequirement` / `spDumps` …），本文件**不新增规则判据**；
 * - tie-break 只用稳定键（格号、型号；`instanceId` 含时间戳**不能**当先后判据）——
 *   快照里所有「需要挑一个」的列表都由驱动按「格号 + 型号」排好，本文件不再重排。
 */
import { hexDistance } from '@/engine/hex-geometry'

export type AiSide = 'axis' | 'soviet'

export interface AiHex {
  col: number
  row: number
}

export const hexKeyOf = (hex: AiHex): string => `${String(hex.col)}.${String(hex.row)}`

/** 稳定排序：先按格号，再按 id（绝不按传入顺序） */
export const compareHex = (a: AiHex, b: AiHex): number => a.col - b.col || a.row - b.row

export interface AiMoveSnapshot {
  /** 移动交互仍在进行（且未 finished） */
  active: boolean
  /** 本次移动已经落过子（一个单位只落一次，落子后直接结束） */
  hasStepped: boolean
  selectedIds: readonly string[]
  reachableHexes: readonly AiHex[]
  /** 本环节已尝试开拔的单位（稳定序） */
  triedUnits: readonly string[]
  /** 本环节已尝试落子的格 */
  triedTargets: readonly string[]
  /** 本环节可参与移动的单位（已过滤 movementEnded / 敌方） */
  candidates: readonly string[]
  enemyHexes: readonly AiHex[]
}

export interface AiBarrageSnapshot {
  state: { step: string; kind: string; targetHex: AiHex | null; costT: number } | null
  choices: readonly { unitId: string; disabled: boolean }[]
  selectedUnitIds: readonly string[]
  targetHex: AiHex | null
  supplyDumpIds: readonly string[]
  /** 本环节已尝试过的目标格（失败后换下一个） */
  triedTargets: readonly string[]
  enemyHexes: readonly AiHex[]
  outcomeStepLosses: number
  lossTargets: readonly { unitId: string; steps: number }[]
}

export interface AiCombatSnapshot {
  state: { step: string; finished: boolean; declaredAttackerArUnitId?: string } | null
  defenderHex: AiHex | null
  adjacentDefenderHexes: readonly AiHex[]
  attackerDumpIds: readonly string[]
  defenderDumpIds: readonly string[]
  requirement: { side: 'attacker' | 'defender'; losses: number; options: number } | null
  retreatPlans: readonly {
    unitId: string
    chosen: AiHex | null
    destinations: readonly {
      hex: AiHex
      forcedDestruction: boolean
      inEnemyZoc: boolean
      path: readonly AiHex[]
    }[]
  }[]
  triedDefenderHexes: readonly string[]
}

export interface AiSupplySnapshot {
  planLoaded: boolean
  recoverySettled: boolean
  feedingSettled: boolean
  duties: readonly {
    key: string
    applied: boolean
    rolled: boolean
    needAllocation: boolean
    lossesKind: string
    lossesSteps: number
    units: readonly { id: string; steps: number }[]
  }[]
}

export interface AiSnapshot {
  turn: number
  phase: string
  segment: string
  segmentStepIndex: number
  activeSide: AiSide
  terminated: boolean
  awaitingOptionIds: readonly string[]
  setupInProgress: boolean
  /** 会话停在回合准备（天气 / 先手判定，2.2 / 2.3）——此时只能推进，不能按旧环节行动 */
  locked: boolean
  can: ReadonlySet<string>
  advanceAvailable: boolean
  pendingZocConfirm: boolean
  specialPending: boolean
  reserveUnitIds: readonly string[]
  reserveTriedUnitIds: readonly string[]
  move: AiMoveSnapshot
  barrage: AiBarrageSnapshot
  combat: AiCombatSnapshot
  supply: AiSupplySnapshot
}

export type AiAction =
  | { kind: 'answer'; optionId: string }
  | { kind: 'advance' }
  | { kind: 'preset' }
  | { kind: 'modeChange'; unitId: string }
  | { kind: 'moveBegin'; unitId: string }
  | { kind: 'moveClick'; hex: AiHex }
  | { kind: 'moveFinish' }
  | { kind: 'zocConfirm' }
  | { kind: 'specialConfirm' }
  | { kind: 'barrageTarget'; hex: AiHex }
  | { kind: 'barrageToggleUnit'; unitId: string }
  | { kind: 'barrageBegin' }
  | { kind: 'barrageSupply'; dumpId: string | null }
  | { kind: 'barrageShifts' }
  | { kind: 'barrageDice' }
  | { kind: 'barrageOutcome'; losses: readonly { unitId: string; steps: number }[] }
  | { kind: 'barrageCancel' }
  | { kind: 'combatSelect'; hex: AiHex }
  | { kind: 'combatBegin' }
  | { kind: 'combatSupply'; attackerDumpId: string; defenderDumpId: string | null }
  | { kind: 'combatDeclareAr'; side: 'attacker' | 'defender' }
  | { kind: 'combatAutoResolve' }
  | { kind: 'combatLosses' }
  | { kind: 'combatOptions'; retreatHexes: number; lossPoints: number; ignoreOptions: boolean }
  | { kind: 'combatRetreatPaths'; paths: readonly { unitId: string; path: readonly AiHex[] }[] }
  | { kind: 'combatAdvance' }
  | { kind: 'combatSkip' }
  | { kind: 'supplyPlan' }
  | { kind: 'supplyRecovery' }
  | { kind: 'supplyFeeding' }
  | { kind: 'attritionRoll'; key: string }
  | {
      kind: 'attritionApply'
      key: string
      allocation: readonly { unitId: string; steps: number }[]
    }
  | { kind: 'none' }

/** 决策的可读签名（死锁判据用；与盘面状态无关） */
export function actionKeyOf(action: AiAction): string {
  switch (action.kind) {
    case 'answer':
      return `answer:${action.optionId}`
    case 'modeChange':
      return `modeChange:${action.unitId}`
    case 'moveBegin':
      return `moveBegin:${action.unitId}`
    case 'moveClick':
      return `moveClick:${hexKeyOf(action.hex)}`
    case 'barrageTarget':
      return `barrageTarget:${hexKeyOf(action.hex)}`
    case 'barrageToggleUnit':
      return `barrageToggleUnit:${action.unitId}`
    case 'combatSelect':
      return `combatSelect:${hexKeyOf(action.hex)}`
    case 'attritionRoll':
      return `attritionRoll:${action.key}`
    case 'attritionApply':
      return `attritionApply:${action.key}`
    case 'barrageSupply':
      return `barrageSupply:${action.dumpId ?? 'none'}`
    case 'combatSupply':
      return `combatSupply:${action.attackerDumpId}:${action.defenderDumpId ?? 'none'}`
    default:
      return action.kind
  }
}

/** 距离最近敌格的格数（仅作为「往最近敌军方向走」的启发式，不是规则判据） */
function nearestEnemyDistance(hex: AiHex, enemyHexes: readonly AiHex[]): number {
  let best = Number.POSITIVE_INFINITY
  for (const enemy of enemyHexes) best = Math.min(best, hexDistance(hex, enemy))
  return best
}

/**
 * 移动落子：在 `groupReachable.hexes` 里取「离最近敌军最近」的一格；并列按格号稳定排序。
 * 已尝试过的格跳过；没有则返回 null（由驱动结束本次移动）。
 */
function pickMoveTarget(snapshot: AiSnapshot): AiHex | null {
  const tried = new Set(snapshot.move.triedTargets)
  const options = snapshot.move.reachableHexes
    .filter((hex) => !tried.has(hexKeyOf(hex)))
    .slice()
    .sort(
      (a, b) =>
        nearestEnemyDistance(a, snapshot.move.enemyHexes) -
          nearestEnemyDistance(b, snapshot.move.enemyHexes) || compareHex(a, b),
    )
  return options[0] ?? null
}

/** 撤退落点：优先「不被消灭且不进敌方 ZOC」，其次「不被消灭」，最后才接受会被消灭的落点 */
function pickRetreatDestination(
  destinations: readonly {
    hex: AiHex
    forcedDestruction: boolean
    inEnemyZoc: boolean
    path: readonly AiHex[]
  }[],
): readonly AiHex[] | null {
  const rank = (item: { forcedDestruction: boolean; inEnemyZoc: boolean }): number =>
    item.forcedDestruction ? 2 : item.inEnemyZoc ? 1 : 0
  const sorted = destinations
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || compareHex(a.hex, b.hex))
  return sorted[0]?.path ?? null
}

function decideBarrageSettlement(snapshot: AiSnapshot): AiAction | null {
  const state = snapshot.barrage.state
  if (state === null || state.step === 'done') return null
  switch (state.step) {
    case 'supply':
      if (
        state.kind === 'artillery' &&
        state.costT > 0 &&
        snapshot.barrage.supplyDumpIds.length === 0
      )
        return { kind: 'barrageCancel' }
      return { kind: 'barrageSupply', dumpId: snapshot.barrage.supplyDumpIds[0] ?? null }
    case 'shifts':
      return { kind: 'barrageShifts' }
    case 'dice':
      return { kind: 'barrageDice' }
    case 'outcome': {
      const losses: { unitId: string; steps: number }[] = []
      let remaining = snapshot.barrage.outcomeStepLosses
      for (const target of snapshot.barrage.lossTargets) {
        if (remaining <= 0) break
        const take = Math.min(remaining, target.steps)
        if (take <= 0) continue
        losses.push({ unitId: target.unitId, steps: take })
        remaining -= take
      }
      return { kind: 'barrageOutcome', losses }
    }
    default:
      return null
  }
}

function decideCombatSettlement(snapshot: AiSnapshot): AiAction | null {
  const state = snapshot.combat.state
  if (state === null || state.finished) return null
  switch (state.step) {
    case 'combatSupply': {
      const attackerDumpId = snapshot.combat.attackerDumpIds[0]
      if (attackerDumpId === undefined) return { kind: 'combatSkip' }
      return {
        kind: 'combatSupply',
        attackerDumpId,
        defenderDumpId: snapshot.combat.defenderDumpIds[0] ?? null,
      }
    }
    case 'declareAr':
      return {
        kind: 'combatDeclareAr',
        side: state.declaredAttackerArUnitId === undefined ? 'attacker' : 'defender',
      }
    case 'declareTerrain':
    case 'surprise':
    case 'battleDice':
      return { kind: 'combatAutoResolve' }
    case 'losses':
      return { kind: 'combatLosses' }
    case 'options': {
      const requirement = snapshot.combat.requirement
      if (requirement === null) return null
      return {
        kind: 'combatOptions',
        retreatHexes: requirement.options,
        lossPoints: 0,
        ignoreOptions: false,
      }
    }
    case 'retreat': {
      const paths: { unitId: string; path: readonly AiHex[] }[] = []
      for (const plan of snapshot.combat.retreatPlans) {
        const path = plan.chosen === null ? pickRetreatDestination(plan.destinations) : null
        if (path !== null) paths.push({ unitId: plan.unitId, path })
      }
      return { kind: 'combatRetreatPaths', paths }
    }
    case 'advance':
      return { kind: 'combatAdvance' }
    default:
      return null
  }
}

function decideBarrageStart(snapshot: AiSnapshot): AiAction | null {
  if (!snapshot.can.has('barrage.declare')) return null
  // 只有真正的**轰炸环节**才由「点地图」选目标（移动环节里的 air/ship 轰炸走另一条入口，基线不碰）
  if (!snapshot.segment.endsWith('.barrage')) return null
  if (snapshot.barrage.state !== null) return null
  // 快照里的合法参炸单位已按「格号 + 型号」稳定排序（见 driver），此处不再按 instanceId 重排
  const legalUnits = snapshot.barrage.choices
    .filter((choice) => !choice.disabled)
    .map((choice) => choice.unitId)
  if (legalUnits.length === 0) return null
  if (snapshot.barrage.enemyHexes.length === 0) return null

  const tried = new Set(snapshot.barrage.triedTargets)
  const target = snapshot.barrage.targetHex
  const untriedEnemies = snapshot.barrage.enemyHexes
    .slice()
    .sort(compareHex)
    .filter((hex) => !tried.has(hexKeyOf(hex)))
  if (target === null || tried.has(hexKeyOf(target))) {
    const next = untriedEnemies[0]
    return next === undefined ? null : { kind: 'barrageTarget', hex: next }
  }
  if (snapshot.barrage.selectedUnitIds.length === 0)
    return { kind: 'barrageToggleUnit', unitId: legalUnits[0]! }
  return { kind: 'barrageBegin' }
}

function decideCombatStart(snapshot: AiSnapshot): AiAction | null {
  if (!snapshot.can.has('combat.declare')) return null
  const tried = new Set(snapshot.combat.triedDefenderHexes)
  const untried = snapshot.combat.adjacentDefenderHexes
    .slice()
    .sort(compareHex)
    .filter((hex) => !tried.has(hexKeyOf(hex)))
  if (snapshot.combat.defenderHex !== null) {
    if (snapshot.combat.state !== null) return null
    if (tried.has(hexKeyOf(snapshot.combat.defenderHex))) return { kind: 'combatSkip' }
    if (snapshot.combat.attackerDumpIds.length === 0) return { kind: 'combatSkip' }
    return { kind: 'combatBegin' }
  }
  const next = untried[0]
  return next === undefined ? null : { kind: 'combatSelect', hex: next }
}

function decideSupply(snapshot: AiSnapshot): AiAction | null {
  if (snapshot.phase !== 'supply') return null
  const segment = snapshot.segment
  // 12.10e：恢复只在 D 段第一环
  if (segment === 'supply.recovery') {
    if (!snapshot.supply.planLoaded) return { kind: 'supplyPlan' }
    if (!snapshot.supply.recoverySettled) return { kind: 'supplyRecovery' }
    return null
  }
  // 12.6 / 12.8：喂养 + 断补损耗只在 D 段第二环（补给检定）
  if (segment !== 'supply.check') return null
  if (!snapshot.supply.planLoaded) return { kind: 'supplyPlan' }
  if (!snapshot.supply.feedingSettled) return { kind: 'supplyFeeding' }
  for (const duty of snapshot.supply.duties) {
    if (duty.applied) continue
    const key = duty.key
    if (!duty.rolled) return { kind: 'attritionRoll', key }
    const allocation: { unitId: string; steps: number }[] = []
    if (duty.needAllocation) {
      let remaining = duty.lossesKind === 'allSteps' ? Number.POSITIVE_INFINITY : duty.lossesSteps
      for (const unit of duty.units) {
        if (remaining <= 0) break
        const take = Math.min(remaining, unit.steps)
        if (take <= 0) continue
        allocation.push({ unitId: unit.id, steps: take })
        remaining -= take
      }
    }
    return { kind: 'attritionApply', key, allocation }
  }
  return null
}

/**
 * B3 基线策略：一次只给**一个**动作；优先级与任务书一致。
 *
 * 说明：本函数不做长链搜索、不预测合法性；任何「提交被拒」都由驱动记录后换下一个候选。
 */
export function decideAiAction(snapshot: AiSnapshot): AiAction {
  if (snapshot.terminated) return { kind: 'none' }

  // 1) 盘面提问：先答第一个选项（与既有 UI 的「第一选项」同一语义）
  if (snapshot.awaitingOptionIds.length > 0)
    return { kind: 'answer', optionId: snapshot.awaitingOptionIds[0]! }

  // 会话停在回合准备（天气/先手判定）：workbench 仍挂着上一环节的旧闸门，只能交给推进
  if (snapshot.locked) return { kind: 'advance' }

  // 2) 未结算的战斗 / 轰炸 / 补给义务 → 先结清
  if (snapshot.pendingZocConfirm) return { kind: 'zocConfirm' }
  if (snapshot.specialPending) return { kind: 'specialConfirm' }
  const combatSettle = decideCombatSettlement(snapshot)
  if (combatSettle !== null) return combatSettle
  const barrageSettle = decideBarrageSettlement(snapshot)
  if (barrageSettle !== null) return barrageSettle

  // 3) 初设：一键预设（对打用例在开局前已预设，此处只兜底界面内启动）
  if (snapshot.setupInProgress) return { kind: 'preset' }

  // 正在移动 → 已经落子就直接结束；否则落第一子
  if (snapshot.move.active) {
    if (snapshot.move.hasStepped) return { kind: 'moveFinish' }
    const target = pickMoveTarget(snapshot)
    return target === null ? { kind: 'moveFinish' } : { kind: 'moveClick', hex: target }
  }

  // 4) 预备 → 战斗（只在闸门放行的环节；每环节每单位只试一次）
  if (snapshot.can.has('move.modeChange')) {
    // 快照已按「格号 + 型号」稳定排序（instanceId 含时间戳，不能当先后判据）
    const unitId = snapshot.reserveUnitIds.find((id) => !snapshot.reserveTriedUnitIds.includes(id))
    if (unitId !== undefined) return { kind: 'modeChange', unitId }
  }

  // 5) 移动：每环节最多 4 个单位；候选按「格号 + 型号」稳定排序（见 driver）
  if (snapshot.can.has('move.order') && snapshot.move.triedUnits.length < 4) {
    const unitId = snapshot.move.candidates.find((id) => !snapshot.move.triedUnits.includes(id))
    if (unitId !== undefined) return { kind: 'moveBegin', unitId }
  }

  // 6) 炮击（有合法参炸单位时）
  const barrageStart = decideBarrageStart(snapshot)
  if (barrageStart !== null) return barrageStart

  // 7) 战斗（仅相邻、有补给时声明；失败由驱动记录并换下一格）
  const combatStart = decideCombatStart(snapshot)
  if (combatStart !== null) return combatStart

  // 8) 补给付款 / 喂养 / 损耗
  const supply = decideSupply(snapshot)
  if (supply !== null) return supply

  // 9) 推进
  if (snapshot.advanceAvailable) return { kind: 'advance' }

  return { kind: 'none' }
}
