import { chartsCrt } from '@/data'
import type { HexRef } from '@/data'
import type { GamePhase } from '../state-types'

import { hexDistance, hexesWithin, isOnMap } from '../hex-geometry'
import { fail, succeed, type RuleOutcome } from '../result-types'
import {
  BATTLE_SEQUENCE,
  allocateBattleLosses,
  battleCombatSupply,
  canJoinRetreat,
  declareBattleAr,
  declareBattleTerrain,
  defenderMayIgnoreOptions,
  exploitEligibility,
  resolveAdvanceAfterCombat,
  resolveBattleDice,
  resolveBattleSurprise,
  resolveOptionChoice,
  resolveStackRetreat,
  unitBattleStrength,
  validateBattleComposition,
  validateBattleLossAllocation,
  type BattleComposition,
  type BattleFacts,
  type BattleTerrainResult,
  type BattleUnitView,
  type CombatRole,
  type RetreatFacts,
  type RetreatResult,
  type StackTerrainChoice,
} from './battle'
import {
  battleColumnIndex,
  parseCrtResultCell,
  type CombatResult,
  type CrtTerrainLine,
} from './combat'
import type { SurpriseAttackType, SurpriseSide } from '../tables/surprise'
import { resolveSurprise as surpriseLookup } from '../tables/surprise'

/**
 * 战斗交互（C6，OCS 9.0 章）——**9.2 九步流程的状态机**（纯函数）
 *
 * 定位：把「玩家宣布攻防 → 付/拒战斗补给 → 指定行动值 → 逐堆叠宣布地形 → 掷奇袭与战斗骰
 * → 逐项分配选项 → 选撤退方向 → 战后推进」这一整套交互里**所有需要按规则裁决的东西**集中到本模块；
 * 界面层只画图与收点击，单位状态由状态层持有（本模块以 `patches` 交还变更，引擎不写状态）。
 *
 * ## 9.2 流程总结（顺序很重要，本模块按此推进）
 *   1) 攻方选择攻击格与防御格                    → `beginCombat`（9.1）
 *   2) 双方消耗所需的 SP（攻方全额才可攻；守方可拒付 ⇒ ½ 战斗值）→ `planCombatSupply`
 *   3) 公布行动值，攻方先、防御方后              → `declareCombatAr`
 *   4) 防御方宣布地形选择，然后确定初始攻防比    → `declareCombatTerrain`
 *   5) 用双方的行动值单位确定 DRM（9.6）         ← 第 3 步已给出
 *   6) 掷 2 骰判奇袭，按 9.8 横移纵列             → `resolveSurprise`
 *   7) 掷 2 骰 + DRM − 工事等级得结果（9.9）     → `resolveCombatDice`
 *   8) 结算结果：**攻方先、守方后**，自 AR 单位起算（9.10/9.11）→ `planLosses` / `planOptions`
 *   9) 防御格已空且攻方未撤退 ⇒ 战后推进（9.12g） → `resolveRetreats` / `resolveAdvance`
 *
 * ## 调用约定（重要）
 *   所有 `units` / `attackers` / `defenders` 入参都必须反映**当前**状态 —— 即此前步骤返回的
 *   `patches` 已由状态层落盘（与 C5 移动交互同规）。本模块据此判定 9.11 的损失容量与
 *   9.10c 的「攻方是否已在承受选项前被摧毁」。
 *
 * ## 与既有模块的分工（不重复实现规则）
 *   - 单步判定一律委托 `battle.ts`（9.1 构成 / 9.4 战力 / 9.5 补给 / 9.6 AR / 9.7 比 / 9.8 奇袭 /
 *     9.9 查表 / 9.10 选项 / 9.11 损失 / 9.12 撤退 / 9.12g 推进 / 9.13 进击）；
 *   - 本模块只负责**顺序、状态推进与玩家输入的形状**（谁先宣布、哪一步还没做、哪些输入合法）。
 */

/* ────────────────────────────── 步骤词表 ────────────────────────────── */

/** 战斗交互步骤 id（单一来源 = `battle.ts` 的 9.2 流程清单） */
export const COMBAT_STEP_IDS = BATTLE_SEQUENCE.map((item) => item.step)
export type CombatStep = (typeof COMBAT_STEP_IDS)[number]

/** 第 8 步「结算结果」的子阶段（9.10b：攻方先结算完，守方再决定） */
export const COMBAT_RESOLUTION_STAGES = [
  'attackerLosses',
  'attackerOptions',
  'defenderLosses',
  'defenderOptions',
  'done',
] as const
export type CombatResolutionStage = (typeof COMBAT_RESOLUTION_STAGES)[number]

/* ────────────────────────────── 状态 ────────────────────────────── */

/** 一方的战斗补给决定 */
export interface CombatSideSupply {
  /** 12.4：应付 T */
  requiredT: number
  /** 是否已支付 */
  paid: boolean
  /** 9.5-B：守方是否**主动选择不付**（以一半战斗值防御） */
  declined: boolean
}

/** 3) 行动值宣布（9.6） */
export interface CombatArDeclaration {
  attackerUnitId: string
  defenderUnitId: string
  attackerAr: number
  defenderAr: number
  /** DRM ＝ 攻方 AR − 守方 AR（9.6；奇袭与战斗骰共用） */
  drm: number
}

/** 4) 地形与初始攻防比（9.3b/9.4/9.7） */
export interface CombatOddsResult {
  terrain: BattleTerrainResult
  /** 各单位修正后战力（供日志逐项展示） */
  attackerStrengthById: { unitId: string; strength: number; cannotAttack: boolean }[]
  defenderStrengthById: { unitId: string; strength: number; cannotAttack: boolean }[]
  attackerTotal: number
  defenderTotal: number
  /** 9.7 取整后的攻防比标签（如 `3:1`） */
  oddsLabel: string
  /** 初始列位（9.7a / 9.14a） */
  columnIndex: number
  columnLabel: string
  columnRule: string
}

/** 6) 奇袭（9.8） */
export interface CombatSurpriseResult {
  side: SurpriseSide
  /** 带符号横移列数（攻方奇袭为正） */
  shift: number
  /** 横移后的最终列位 */
  finalColumnIndex: number
  finalColumnLabel: string
  clamped: boolean
  detail: string
}

/** 7) 战斗掷骰结果（9.9） */
export interface CombatDiceResult {
  die: number
  modifiedDice: number
  result: CombatResult
}

/** 8) 一方的结算记录 */
export interface CombatSideResolution {
  /** 强制损失 L# 的分配（9.11） */
  forcedLosses?: { unitId: string; steps: number }[]
  /** 被消灭的单位 */
  eliminated?: string[]
  /** 超出行内段而忽略的损失（9.11b） */
  ignoredLosses?: number
  /** 选项分配（9.10a）：撤退格数 + 损失军力数 */
  option?: { points: number; retreatHexes: number; lossPoints: number }
  /** 9.10c：守方是否可以忽略自己的选项 */
  optionIgnorable?: boolean
  /** 守方是否选择行使「忽略」 */
  optionIgnored?: boolean
  /**
   * 9.10c：该方的**选项步被跳过**的原因（目前只有一种）
   *
   * 「如果攻击方已撤退，或**无法完成所有选项**，则防御方便可忽略他的选项。」＋举例 B：
   * 「AL1o1，Do1……**唯一的攻击者因 L1 摧毁**，因此**防御者可以忽略他的选项**。」
   * ⇒ 攻方在承受选项前被摧毁时，**不再进入攻方选项步**（否则玩家面对一个填不动的页面：
   *   损失无处可吃，只能靠"死人撤退"凑过 9.10a），直接交给守方结算强制损失。
   */
  optionsSkipped?: 'attackerWipedOut'
}

/** 9) 撤退与推进 */
export interface CombatRetreatRecord {
  unitId: string
  /** 撤退落点；null = 被消灭 */
  hex: HexRef | null
  destroyed: boolean
  gainsDg: boolean
  dgCompanions: string[]
  fullRetreatDistanceMet: boolean
}

/** 战斗交互的全部累积决策 */
export interface CombatInteractionState {
  /** 下一步待办（已完成到 `step` 之前） */
  step: CombatStep
  attackType: SurpriseAttackType
  phase: GamePhase
  /** 1) 战斗构成（9.1） */
  composition: BattleComposition
  /** 守方是否在任意等级的环形工事内（9.8 的 −1；9.9 的 −等级） */
  defenderInHedgehog: boolean
  /** 防御格环形工事等级（9.9） */
  hedgehogLevel: number
  /** 2) 补给 */
  supply?: { attacker: CombatSideSupply; defender: CombatSideSupply }
  /** 3) AR */
  ar?: CombatArDeclaration
  /** 4) 地形与初始列 */
  odds?: CombatOddsResult
  /** 6) 奇袭 */
  surprise?: CombatSurpriseResult
  /** 7) 掷骰 */
  dice?: CombatDiceResult
  /** 8) 结算（攻方先、守方后） */
  resolution: {
    stage: CombatResolutionStage
    attacker: CombatSideResolution
    defender: CombatSideResolution
  }
  /** 9) 撤退记录 */
  retreats: CombatRetreatRecord[]
  /** 9) 推进结果 */
  advance?: { advanceUnitIds: string[]; mandatory: boolean }
  /** 整场战斗是否已结束 */
  finished: boolean
}

/* ────────────────────────────── 单位变更（交状态层落盘） ────────────────────────────── */

/** 战斗对单位状态的变更（绝对值，便于落盘） */
export interface CombatUnitPatch {
  unitId: string
  /** 结算后的剩余军力（9.11） */
  steps?: number
  /** 置为 DG（5.10） */
  dg?: true
  /** 移动到新格（撤退 9.12 / 推进 9.12g） */
  hex?: HexRef
  /** 获得进击标记（9.13） */
  exploit?: true
}

/* ────────────────────────────── 工具 ────────────────────────────── */

function stepIndex(step: CombatStep): number {
  return COMBAT_STEP_IDS.indexOf(step)
}

/** 该步骤是否已经走到（用于界面提示「还差哪几步」） */
export function hasReachedStep(state: CombatInteractionState, step: CombatStep): boolean {
  return stepIndex(state.step) >= stepIndex(step)
}

/** 该方的参战单位（按构成） */
function unitsOfSide(
  state: CombatInteractionState,
  units: readonly BattleUnitView[],
  side: CombatRole,
): BattleUnitView[] {
  const ids = side === 'attacker' ? state.composition.attackerIds : state.composition.defenderIds
  return ids
    .map((id) => units.find((unit) => unit.id === id))
    .filter((unit): unit is BattleUnitView => unit !== undefined)
}

/** 格号比较（对象坐标不便用 === 比；9.12d 判「跟随者与撤退单位同格」等用） */
function sameHexOf(a: HexRef, b: HexRef): boolean {
  return a.col === b.col && a.row === b.row
}

/**
 * 9.12：图上是否存在与 `from` **直线距离恰为** `distance` 的格
 *
 * 用于「撤退格数是否可行」的闸门（9.12 末段括注）：图外盒不算（专规 1.4b：地面单位不得撤退进出图外盒）。
 */
function hasHexAtExactDistance(from: HexRef, distance: number): boolean {
  if (distance <= 0) return true
  return hexesWithin(from, distance, { onMapOnly: true }).some(
    (hex) => hexDistance(from, hex) === distance,
  )
}

/** 该方在 CRT 结果里的强制损失点（9.10 的 `L#`） */
export function lossesOf(result: CombatResult, side: CombatRole): number {
  return side === 'attacker' ? result.attacker.losses : result.defender.losses
}

/**
 * 该方在 CRT 结果里的选项点（9.10a 的 `o#`）
 *
 * ★ 是**点数**而不是「有没有选项」——`o2` 提供 2 点，可拆成「1 点损失 + 1 格撤退」；
 *   9.10a 要求总点数被完全满足，故这里必须返回数字。
 */
export function optionsOf(result: CombatResult, side: CombatRole): number {
  return side === 'attacker' ? result.attacker.optionPoints : result.defender.optionPoints
}

/** CRT 某地形线的列位标签表（9.9）；数据缺失即抛错，不静默 */
export function columnsFor(combatLine: CrtTerrainLine): readonly string[] {
  const columns = chartsCrt.crt.terrainColumns[combatLine]
  if (columns === undefined) throw new Error(`CRT 无此地形列组：${combatLine}`)
  return columns
}

/* ────────────────────────────── ① 9.1 战斗构成 ────────────────────────────── */

/** 开始一次战斗（9.2-1：攻方选择攻击格与防御格） */
export function beginCombat(input: {
  attackers: readonly BattleUnitView[]
  defenders: readonly BattleUnitView[]
  facts: BattleFacts
  attackType: SurpriseAttackType
  phase: GamePhase
}): RuleOutcome<CombatInteractionState> {
  const composition = validateBattleComposition({
    attackers: input.attackers,
    defenders: input.defenders,
    facts: input.facts,
  })
  if (!composition.ok) return composition

  /*
   * 9.1c（按**战斗环节**记账）：「在一个战斗环节中，同一个单位只能攻击一次，同一格只能被攻击一次」。
   *
   * ★ 只判**常规战斗**：原文紧接的下一条把移动环节排除在外 ——「在一个移动环节中，同一个单位可以进行
   *   多次突袭，突袭同一个格的次数没有限制」⇒ 突袭（8.1，`attackType === 'overrun'`）不受这两条限制。
   * ★ 判据落在**构成校验之后**：构成本身不合法时先报那一条（9.1a/9.1e/9.1f 的原因更具体），
   *   账本冲突只在"这一仗本来是合法的"时才说话。
   */
  if (input.attackType !== 'overrun') {
    const repeated = input.attackers.find((unit) => input.facts.attackedThisSegmentBy(unit.id))
    if (repeated !== undefined) return fail('9.1c', `unitAlreadyAttackedThisSegment:${repeated.id}`)
    if (input.facts.attackedThisSegmentAt(composition.data.defendingHex))
      return fail('9.1c', 'hexAlreadyAttackedThisSegment')
  }

  const hedgehogLevel = input.facts.hedgehogLevelAt(composition.data.defendingHex)
  return succeed('9.1', {
    step: 'combatSupply',
    attackType: input.attackType,
    phase: input.phase,
    composition: composition.data,
    defenderInHedgehog: hedgehogLevel > 0,
    hedgehogLevel,
    resolution: { stage: 'attackerLosses', attacker: {}, defender: {} },
    retreats: [],
    finished: false,
  })
}

/* ────────────────────────────── ② 9.5 / 12.4 战斗补给 ────────────────────────────── */

export interface CombatSupplyStepInput {
  attackers: readonly BattleUnitView[]
  defenders: readonly BattleUnitView[]
  /** 攻方本阶段可动用的 T（SP 与可动用部队储备之和） */
  attackerAvailableT: number
  /** 9.5-B：守方是否愿意支付战斗补给 */
  defenderProvides: boolean
  defenderAvailableT: number
  /**
   * 9.5b 例：攻方付不出全额时可以**减少参战单位**再试
   *
   * 给出即表示玩家把参战单位缩到这几个（须为原攻方的子集且在同一个格序列内）。
   */
  attackerUnitIds?: readonly string[]
}

/**
 * 第 2 步：双方消耗战斗补给（9.5 / 12.4）
 *
 * 「攻方需要先这样消耗战斗补给，如果他无法做到，则**取消攻击**，且防御方不需要消耗任何补给。
 *   如果防御方不消耗补给（或没有补给），攻击会继续，但防御方以**一半的战斗值**战斗。」
 */
export function planCombatSupply(
  state: CombatInteractionState,
  input: CombatSupplyStepInput,
): RuleOutcome<{ state: CombatInteractionState }> {
  if (state.step !== 'combatSupply') return fail('9.2', `notAtSupplyStep:${state.step}`)

  let composition = state.composition
  if (input.attackerUnitIds !== undefined) {
    if (input.attackerUnitIds.length === 0) return fail('9.5b', 'noAttackerAfterReduction')
    const unknown = input.attackerUnitIds.filter(
      (id) => !state.composition.attackerIds.includes(id),
    )
    if (unknown.length > 0) return fail('9.5b', `attackerNotInComposition:${unknown.join(',')}`)
    composition = { ...composition, attackerIds: [...input.attackerUnitIds] }
  }

  const attackers = unitsOfSide({ ...state, composition }, input.attackers, 'attacker')
  const defenders = unitsOfSide(state, input.defenders, 'defender')
  const supply = battleCombatSupply({
    attackers,
    defenders,
    attackerAvailableT: input.attackerAvailableT,
    defenderProvides: input.defenderProvides,
    defenderAvailableT: input.defenderAvailableT,
  })
  if (!supply.ok) return supply

  return succeed('9.5', {
    state: {
      ...state,
      step: 'declareAr',
      composition,
      supply: {
        attacker: {
          requiredT: supply.data.attackerRequiredT,
          paid: true,
          declined: false,
        },
        defender: {
          requiredT: supply.data.defenderRequiredT,
          paid: supply.data.defenderPaid,
          declined: !input.defenderProvides,
        },
      },
    },
  })
}

/* ────────────────────────────── ③ 9.6 行动值 ────────────────────────────── */

/**
 * 第 3 步：公布行动值（9.6）
 *
 * 「每位玩家各选择一个单位，该单位将决定己方在战斗中的行动值（AR），由**攻击方先宣布**自己的选择。
 *   每方只能选择一个单位，且该单位**必须参与战斗**。」
 * 9.6 的时机由界面保证（先收攻方的选择，再收守方的）——本函数同时收两项，若只给攻方则报 `defenderArPending`。
 */
export function declareCombatAr(
  state: CombatInteractionState,
  input: {
    attackers: readonly BattleUnitView[]
    defenders: readonly BattleUnitView[]
    attackerUnitId: string
    /** 守方尚未宣布时省略（界面据此提示「等守方宣布」） */
    defenderUnitId?: string
  },
): RuleOutcome<{ state: CombatInteractionState; awaitingDefender: boolean }> {
  if (state.step !== 'declareAr') return fail('9.2', `notAtArStep:${state.step}`)
  if (input.defenderUnitId === undefined) return succeed('9.6', { state, awaitingDefender: true })

  const declared = declareBattleAr({
    attackers: unitsOfSide(state, input.attackers, 'attacker'),
    defenders: unitsOfSide(state, input.defenders, 'defender'),
    attackerUnitId: input.attackerUnitId,
    defenderUnitId: input.defenderUnitId,
  })
  if (!declared.ok) return declared

  return succeed('9.6', {
    state: {
      ...state,
      step: 'declareTerrain',
      ar: {
        attackerUnitId: input.attackerUnitId,
        defenderUnitId: input.defenderUnitId,
        attackerAr: declared.data.attackerAr,
        defenderAr: declared.data.defenderAr,
        drm: declared.data.drm,
      },
    },
    awaitingDefender: false,
  })
}

/* ────────────────────────────── ④ 9.3b / 9.4 地形与初始攻防比 ────────────────────────────── */

/**
 * 第 4 步：防御方宣布地形，然后确定初始攻防比（9.3b / 9.4b / 9.4c / 9.7）
 *
 * 「9.4b 防御方玩家可以为**每一个攻击中的堆叠**选择一种地形来进行修正：可以是防御格内的地形，
 *   或者是该堆叠的攻击穿越的格边地形……这些修正**不能累计**」；「9.4c 守方还可以选择一种地形来
 *   修正防御堆叠……**只能选择格内地形**，这一选择也决定了战斗表的横行」。
 * 逐单位战力一律走 `battle.ts#unitBattleStrength`（含 9.4d 方括号、9.4e 反坦克、9.11d、9.5/9.5a）。
 */
export function declareCombatTerrain(
  state: CombatInteractionState,
  input: {
    attackers: readonly BattleUnitView[]
    defenders: readonly BattleUnitView[]
    facts: BattleFacts
    stackChoices?: readonly StackTerrainChoice[]
    defenderTerrain?: string
  },
): RuleOutcome<{ state: CombatInteractionState }> {
  if (state.step !== 'declareTerrain') return fail('9.2', `notAtTerrainStep:${state.step}`)
  if (state.supply === undefined || state.ar === undefined)
    return fail('9.2', 'supplyOrArMissingBeforeTerrain')

  const attackers = unitsOfSide(state, input.attackers, 'attacker')
  const defenders = unitsOfSide(state, input.defenders, 'defender')

  const terrain = declareBattleTerrain({
    attackers,
    defenders,
    facts: input.facts,
    ...(input.stackChoices === undefined ? {} : { stackChoices: input.stackChoices }),
    ...(input.defenderTerrain === undefined ? {} : { defenderTerrain: input.defenderTerrain }),
  })
  if (!terrain.ok) return terrain

  const defenderAtLevel = input.facts.defenderAtLevelAt(state.composition.defendingHex)
  const attackerPaid = state.supply.attacker.paid
  const defenderPaid = state.supply.defender.paid

  const attackerStrengthById = attackers.map((unit) => {
    const stackTerrain = terrain.data.attackerTerrainByHex.find(
      (item) => item.hex.col === unit.hex.col && item.hex.row === unit.hex.row,
    )
    const resolved = unitBattleStrength({
      unit,
      role: 'attacker',
      terrain: stackTerrain?.terrain ?? terrain.data.defenderTerrain,
      defenderAtLevel,
      combatSupplyPaid: attackerPaid,
    })
    return { unitId: unit.id, strength: resolved.strength, cannotAttack: resolved.cannotAttack }
  })
  const defenderStrengthById = defenders.map((unit) => {
    const resolved = unitBattleStrength({
      unit,
      role: 'defender',
      terrain: terrain.data.defenderTerrain,
      combatSupplyPaid: defenderPaid,
    })
    return { unitId: unit.id, strength: resolved.strength, cannotAttack: resolved.cannotAttack }
  })

  const attackerTotal = attackerStrengthById.reduce((sum, item) => sum + item.strength, 0)
  const defenderTotal = defenderStrengthById.reduce((sum, item) => sum + item.strength, 0)

  // 9.7 / 9.7a / 9.14a：取整后的攻防比 → 列位（零战斗值走端列）
  const columns = columnsFor(terrain.data.combatLine)
  const column = battleColumnIndex(columns, attackerTotal, defenderTotal)
  // 9.7 的标签与列位同口径：直接用列标签（列位即「≤ 取整后比值」的最大列）
  const oddsLabel = columns[column.index]!

  return succeed('9.4', {
    state: {
      ...state,
      step: 'surprise',
      odds: {
        terrain: terrain.data,
        attackerStrengthById,
        defenderStrengthById,
        attackerTotal,
        defenderTotal,
        oddsLabel,
        columnIndex: column.index,
        columnLabel: oddsLabel,
        columnRule: column.rule,
      },
    },
  })
}

/* ────────────────────────────── ⑤⑥ 9.8 奇袭与横移 ────────────────────────────── */

/**
 * 第 6 步：奇袭判定与纵列横移（9.8）
 *
 * 「掷两枚骰子，并加上 9.6 中判定的 DRM。如果防御方有任意等级的环形工事，则从掷骰结果中减 1……
 *   如果发生奇袭，则**掷一枚骰子**，并将战斗表上的最终攻防比纵列进行若干列的横移。」
 * 发生奇袭时须**再掷一颗横移骰**，故未给 `shiftDie` 时本函数只回 `awaitingShiftDie: true`
 * 并停在原步（由界面提示玩家掷骰），不前进也不抛错。
 */
export function resolveSurprise(
  state: CombatInteractionState,
  input: { die: number; shiftDie?: number },
): RuleOutcome<{ state: CombatInteractionState; awaitingShiftDie: boolean }> {
  if (state.step !== 'surprise') return fail('9.2', `notAtSurpriseStep:${state.step}`)
  if (state.ar === undefined || state.odds === undefined)
    return fail('9.2', 'arOrOddsMissingBeforeSurprise')

  const columns = columnsFor(state.odds.terrain.combatLine)
  const lookup = surpriseLookup({
    die: input.die,
    arDifferential: state.ar.drm,
    attackType: state.attackType,
    defenderInHedgehog: state.defenderInHedgehog,
  })
  if (lookup.side !== null && input.shiftDie === undefined) {
    return succeed('9.8', { state, awaitingShiftDie: true })
  }

  const surprise = resolveBattleSurprise({
    die: input.die,
    arDifferential: state.ar.drm,
    attackType: state.attackType,
    defenderInHedgehog: state.defenderInHedgehog,
    ...(input.shiftDie === undefined ? {} : { shiftDie: input.shiftDie }),
    columnIndex: state.odds.columnIndex,
    columnCount: columns.length,
  })

  return succeed('9.8', {
    state: {
      ...state,
      step: 'battleDice',
      surprise: {
        side: surprise.side,
        shift: surprise.shift,
        finalColumnIndex: surprise.columnIndex,
        finalColumnLabel: columns[surprise.columnIndex]!,
        clamped: surprise.clamped,
        detail: surprise.detail,
      },
    },
    awaitingShiftDie: false,
  })
}

/* ────────────────────────────── ⑦ 9.9 战斗掷骰 ────────────────────────────── */

/**
 * 第 7 步：掷 2 骰 + DRM − 工事完整等级 → 查表（9.9），并**立即落实 9.12a 的守方 DG**
 *
 * 9.9：「加上行动值 DRM（9.6）并减去防御方环形工事的**完整等级值**」（与 9.8 的 −1 不同）。
 *
 * 9.12a：「战斗表上的『DG』结果会**强制所有防御单位立即进入 DG 模式**。**在开始任何撤退之前**
 *   进行此操作（由于 9.12e 的规定，这非常重要）。」
 *   故在掷骰这一步就把 `dg: true` 交给状态层落盘（早于损失/选项/撤退步），这样 9.12e 的
 *   「撤退堆叠在进入敌方 ZOC **之前**已是 DG ⇒ 该堆叠损失 1 点」才会被正确判定。
 *   注意 DG 只改 AR 与战斗模式（5.4a），**不回改**已经宣布过的 AR 与已掷出的骰值。
 */
export function resolveCombatDice(
  state: CombatInteractionState,
  input: { die: number },
): RuleOutcome<{ state: CombatInteractionState; patches: CombatUnitPatch[] }> {
  if (state.step !== 'battleDice') return fail('9.2', `notAtDiceStep:${state.step}`)
  if (state.ar === undefined || state.odds === undefined)
    return fail('9.2', 'arOrOddsMissingBeforeDice')

  const columnLabel = state.surprise?.finalColumnLabel ?? state.odds.columnLabel
  const dice = resolveBattleDice({
    die: input.die,
    attackerAr: state.ar.attackerAr,
    defenderAr: state.ar.defenderAr,
    hedgehogLevel: state.hedgehogLevel,
    combatLine: state.odds.terrain.combatLine,
    columnLabel,
  })
  if (!dice.ok) return dice

  // 9.12a：战斗表 DG ⇒ 全部防御单位立即 DG（先于任何撤退）
  const patches: CombatUnitPatch[] = dice.data.defender.disorganized
    ? state.composition.defenderIds.map((unitId) => ({ unitId, dg: true as const }))
    : []

  return succeed('9.9', {
    state: {
      ...state,
      step: 'losses',
      dice: { die: input.die, modifiedDice: dice.data.modifiedDice, result: dice.data },
    },
    patches,
  })
}

/* ────────────────────────────── ⑧ 9.10 / 9.11 结算 ────────────────────────────── */

/** 当前该由哪一方结算（9.10b：攻方先、守方后） */
export function currentResolver(state: CombatInteractionState): CombatRole {
  return state.resolution.stage.startsWith('attacker') ? 'attacker' : 'defender'
}

/**
 * 第 8 步（强制损失）：9.11 军力损失
 *
 * 「永远攻击方先结算，并在防御方决定要做什么之前，先结算其战斗结果。**攻击方先承受强制的军力损失**，
 *   然后再结算他的选项。」分配形状由 9.11c 唯一确定（AR 单位先受第一点；所有单位各受一点后才有人受第二点），
 * 故本函数接受玩家的分配方案并校验（`validateBattleLossAllocation`），再给出落盘变更。
 */
export function planLosses(
  state: CombatInteractionState,
  input: {
    units: readonly BattleUnitView[]
    /** 玩家提交的分配；省略＝接受规范分配（界面默认给规范值） */
    allocation?: readonly { unitId: string; steps: number }[]
  },
): RuleOutcome<{ state: CombatInteractionState; patches: CombatUnitPatch[]; rule: string }> {
  if (state.step !== 'losses') return fail('9.2', `notAtLossesStep:${state.step}`)
  if (state.dice === undefined || state.ar === undefined)
    return fail('9.2', 'diceOrArMissingBeforeLosses')

  const side = currentResolver(state)
  const stage: CombatResolutionStage = side === 'attacker' ? 'attackerLosses' : 'defenderLosses'
  if (state.resolution.stage !== stage)
    return fail('9.2', `notAtLossStage:${state.resolution.stage}`)

  const units = unitsOfSide(state, input.units, side)
  const required = lossesOf(state.dice.result, side)
  const arUnitId = side === 'attacker' ? state.ar.attackerUnitId : state.ar.defenderUnitId

  const canonical = allocateBattleLosses({
    required,
    units: units.map((unit) => ({ id: unit.id, steps: unit.steps })),
    arUnitId,
  })
  const checked = validateBattleLossAllocation({
    required,
    units: units.map((unit) => ({ id: unit.id, steps: unit.steps })),
    arUnitId,
    allocation: input.allocation === undefined ? canonical.allocation : [...input.allocation],
  })
  if (!checked.ok) return checked

  const patches: CombatUnitPatch[] = units.map((unit) => ({
    unitId: unit.id,
    steps:
      unit.steps - (checked.data.allocation.find((item) => item.unitId === unit.id)?.steps ?? 0),
  }))

  /*
   * 9.10c（例 B）：攻方在**承受选项前**被摧毁 ⇒ 防御者可以忽略他的选项 ⇒
   * **不再进攻方选项步**，直接把下一子阶段交给守方的强制损失（否则玩家会面对一个填不动的
   * 选项页：名单已空、损失无处可吃，只能靠"死人撤退"凑过 9.10a）。
   * 判据只取「该方**全部**参战单位打完这一笔后军力 ≤ 0」——这正是"无法完成所有选项"。
   */
  const wipedOut = patches.every((patch) => (patch.steps ?? Number.POSITIVE_INFINITY) <= 0)
  const attackerWipedOut = side === 'attacker' && wipedOut
  const nextStage: CombatResolutionStage = attackerWipedOut
    ? 'defenderLosses'
    : side === 'attacker'
      ? 'attackerOptions'
      : 'defenderOptions'
  const sideRecord: CombatSideResolution = {
    forcedLosses: checked.data.allocation,
    eliminated: checked.data.eliminated,
    ignoredLosses: canonical.ignored,
    ...(attackerWipedOut ? { optionsSkipped: 'attackerWipedOut' as const } : {}),
  }

  return succeed(attackerWipedOut ? '9.10c' : '9.11', {
    state: {
      ...state,
      // 第 8 步的两个子环节在 9.2 里合成「结算结果」一条；为使流程清单可读，`step` 在
      // 「强制损失」与「选项」之间来回切换（`resolution.stage` 才是权威的进度）
      step: attackerWipedOut ? 'losses' : 'options',
      resolution: {
        ...state.resolution,
        stage: nextStage,
        ...(side === 'attacker' ? { attacker: sideRecord } : { defender: sideRecord }),
      },
    },
    patches,
    rule: attackerWipedOut ? '9.10c' : '9.11c',
  })
}

/**
 * 第 8 步（选项）：9.10 结果与选项
 *
 * 「可将撤退格数和损失军力数任意组合，但选项总数必须完全被满足」；
 * 9.10b 攻方先结算；9.10c 攻方已撤退或未能完成全部选项时，守方**可忽略**自己的选项（也可主动行使）。
 */
export function planOptions(
  state: CombatInteractionState,
  input: {
    units: readonly BattleUnitView[]
    /** 撤退格数（每格 1 点） */
    retreatHexes?: number
    /** 以军力损失满足的选项点数 */
    lossPoints?: number
    /** 9.10c：守方选择行使「忽略选项」的权利 */
    ignore?: boolean
    /**
     * 9.11a/9.11c：拥有者玩家给出的**选项损失分配**（缺省＝按 `allocateBattleLosses` 的规范分配）。
     * 给出时按 `validateBattleLossAllocation` 严格校验（AR 先受第一点、均匀展开、逐单位不超容量）。
     */
    lossAllocation?: readonly { unitId: string; steps: number }[]
  },
): RuleOutcome<{
  state: CombatInteractionState
  patches: CombatUnitPatch[]
  /** 该方需要撤退的格数（第 9 步据此收撤退方向） */
  retreatHexes: number
  rule: string
}> {
  if (state.step !== 'options') return fail('9.2', `notAtOptionsStep:${state.step}`)
  if (state.dice === undefined) return fail('9.2', 'diceMissingBeforeOptions')
  const side = currentResolver(state)
  const stage: CombatResolutionStage = side === 'attacker' ? 'attackerOptions' : 'defenderOptions'
  if (state.resolution.stage !== stage)
    return fail('9.2', `notAtOptionStage:${state.resolution.stage}`)

  const points = optionsOf(state.dice.result, side)
  const units = unitsOfSide(state, input.units, side)
  const current = state.resolution[side]

  // 9.10c（辅助卡战斗结果说明注 2）：守方在**攻方用选项撤退**或**攻方在承受选项前已被摧毁**时
  // 可以忽略自己的选项（也可主动行使全部选项）。攻方永远必须完成自己的选项。
  const attackerUnits = unitsOfSide(state, input.units, 'attacker')
  const attackerWipedOut = attackerUnits.every((unit) => unit.steps <= 0)
  const ignorable =
    side === 'defender'
      ? defenderMayIgnoreOptions({
          attackerRetreated: (state.resolution.attacker.option?.retreatHexes ?? 0) > 0,
          attackerCompleted: !attackerWipedOut,
        }).mayIgnore
      : false

  if (side === 'defender' && input.ignore === true) {
    if (!ignorable) return fail('9.10c', 'defenderMayNotIgnoreOptions')
    return succeed('9.10c', {
      state: {
        ...state,
        step: 'retreat',
        resolution: {
          ...state.resolution,
          stage: 'done',
          defender: { ...current, optionIgnorable: ignorable, optionIgnored: true },
        },
      },
      patches: [],
      retreatHexes: 0,
      rule: '9.10c',
    })
  }

  // 9.10d：结果同时含选项与进击数字时，攻方把全部选项选成军力损失才能取得进击标记
  const hasExploitResult = state.dice.result.attacker.exploitationAR !== undefined
  const exploitPenalty = side === 'attacker' && hasExploitResult && (input.retreatHexes ?? 0) > 0

  const choice = resolveOptionChoice({
    points,
    retreatHexes: input.retreatHexes ?? 0,
    lossPoints: input.lossPoints ?? 0,
  })
  if (!choice.ok) return choice

  // 选项损失也是**战斗结果中的军力损失** ⇒ 不得超出该方**当前**可用军力总量
  // （9.11：「任何单位承受的军力损失都不能超过它的可用的军力总量」）。
  const capacity = units.reduce((sum, unit) => sum + unit.steps, 0)
  if (choice.data.lossPoints > capacity)
    return fail('9.11', `optionLossExceedsAvailableSteps:${choice.data.lossPoints}>${capacity}`)

  // 9.12 末段括注：「（有时这会限制可选为撤退的选项数量）」——撤退格数受**可撤退性**限制：
  // 只要有一个参战单位在图上不存在直线距离恰为该格数的落点（几何上无解），就不允许这样的分配，
  // 否则玩家会在第 9 步无法给出任何合法路径、流程卡死。
  if (choice.data.retreatHexes > 0) {
    const infeasible = units.find(
      (unit) => !hasHexAtExactDistance(unit.hex, choice.data.retreatHexes),
    )
    if (infeasible !== undefined)
      return fail('9.12', `retreatEndHexUnavailable:${infeasible.id}:${choice.data.retreatHexes}`)
  }

  // 9.11a/9.11c：选项损失也是**战斗结果中的军力损失** ⇒ 与强制损失同一条判据
  // （AR 单位先受第一点；各受一点后才能有单位受第二点）。9.11c 末段只豁免「**轰炸或撤退**」
  // 造成的损失（txt:1377-1380）——修前的注释把这条豁免误读成也适用于选项，并按
  // 「剩余军力从高到低」硬分 ⇒ AR 单位可能不受第一点。分配的授权在拥有者玩家（9.11a）：
  //   · 玩家给了 `lossAllocation` ⇒ `validateBattleLossAllocation` 严格校验（与强制损失同一处判据）；
  //   · 未给 ⇒ 按 `allocateBattleLosses` 的规范分配（AR 优先＋均匀展开）——同样合法。
  const arUnitId =
    (side === 'attacker' ? state.ar?.attackerUnitId : state.ar?.defenderUnitId) ?? undefined
  const lossUnits = units.map((unit) => ({ id: unit.id, steps: unit.steps }))
  let allocation: { unitId: string; steps: number }[]
  if (input.lossAllocation === undefined) {
    allocation = allocateBattleLosses({
      required: choice.data.lossPoints,
      units: lossUnits,
      ...(arUnitId === undefined ? {} : { arUnitId }),
    }).allocation
  } else {
    const validated = validateBattleLossAllocation({
      required: choice.data.lossPoints,
      units: lossUnits,
      ...(arUnitId === undefined ? {} : { arUnitId }),
      allocation: input.lossAllocation,
    })
    if (!validated.ok) return validated
    allocation = validated.data.allocation
  }
  const patches: CombatUnitPatch[] = []
  const remainingAfter = new Map(units.map((unit) => [unit.id, unit.steps]))
  for (const item of allocation) {
    if (item.steps <= 0) continue
    const left = (remainingAfter.get(item.unitId) ?? 0) - item.steps
    remainingAfter.set(item.unitId, left)
    patches.push({ unitId: item.unitId, steps: left })
  }

  const nextStage: CombatResolutionStage = side === 'attacker' ? 'defenderLosses' : 'done'
  const sideRecord: CombatSideResolution = {
    ...current,
    option: { points, retreatHexes: choice.data.retreatHexes, lossPoints: choice.data.lossPoints },
    optionIgnorable: ignorable,
    optionIgnored: false,
  }

  return succeed(exploitPenalty ? '9.10d' : '9.10a', {
    state: {
      ...state,
      step: side === 'defender' ? 'retreat' : 'losses',
      resolution: {
        ...state.resolution,
        stage: nextStage,
        ...(side === 'attacker' ? { attacker: sideRecord } : { defender: sideRecord }),
      },
    },
    patches,
    retreatHexes: choice.data.retreatHexes,
    rule: exploitPenalty ? '9.10d' : '9.10a',
  })
}

/* ────────────────────────────── ⑨ 9.12 撤退与 9.12g 推进 ────────────────────────────── */

/**
 * 第 9 步：撤退（9.12 / 9.12d）
 *
 * 「所有参与战斗的单位必须撤退，且必须撤退的格数等于**剩余的选项的数量**。撤退结束格与其开始撤退的
 *   格的**直线距离**，必须等于上述的格数（完整撤退距离）」。整堆叠/分开撤退由 9.12c 允许，故按单位收路径。
 *
 * 9.12d：`tagalongIds` 里的**未参战战斗单位 / 编内卡车**随其所在格的撤退堆叠一起撤退；
 *   其余非战斗单位（补给站、非编内卡车运输点、飞机、港口、环形工事等）不得跟随，必须留在原格。
 * 9.12 末段：「如果单位撤退时，必须穿过敌方占据的格或禁入地形，则消灭这些单位」——故路径本身
 *   允许穿越（由 `resolveStackRetreat` 判为被消灭），但**落点必须满足完整撤退距离**。
 */
export function resolveRetreats(
  state: CombatInteractionState,
  input: {
    units: readonly BattleUnitView[]
    /** 各单位的撤退路径（含落点、不含起始格）；长度即该单位的撤退格数 */
    paths: readonly { unitId: string; path: readonly HexRef[] }[]
    facts: RetreatFacts
    /** 9.12d：加入撤退的**跟随者**（未参战战斗单位 / 编内卡车；可一次传两方的，引擎按方取用） */
    tagalongIds?: readonly string[]
  },
): RuleOutcome<{
  state: CombatInteractionState
  patches: CombatUnitPatch[]
  results: RetreatResult[]
  /**
   * 9.12e：撤退堆叠的额外军力损失
   *
   * 「如果撤退的堆叠中有任何单位在进入敌方 ZOC **之前**是 DG 的，则该堆叠损失**一点**军力
   *   （由拥有者玩家从撤退中的 DG 单位中选择承受损失）」——故损失归属是玩家的选择，
   *   本函数只报「该由哪些单位中选」与「共几点」，实际落盘由状态层按玩家选择写入。
   */
  extraLoss: { points: number; eligibleUnitIds: string[] }
}> {
  if (state.step !== 'retreat') return fail('9.2', `notAtRetreatStep:${state.step}`)

  const retreatingSides: CombatRole[] = []
  if ((state.resolution.attacker.option?.retreatHexes ?? 0) > 0) retreatingSides.push('attacker')
  if ((state.resolution.defender.option?.retreatHexes ?? 0) > 0) retreatingSides.push('defender')
  if (retreatingSides.length === 0) {
    return succeed('9.12', {
      state: { ...state, step: 'advance' },
      patches: [],
      results: [],
      extraLoss: { points: 0, eligibleUnitIds: [] },
    })
  }

  const patches: CombatUnitPatch[] = []
  const results: RetreatResult[] = []
  const records: CombatRetreatRecord[] = []
  const eligibleUnitIds: string[] = []
  let extraLossPoints = 0

  for (const side of retreatingSides) {
    const required = side === 'attacker' ? state.resolution.attacker : state.resolution.defender
    const distance = required.option?.retreatHexes ?? 0
    const sideUnits = unitsOfSide(state, input.units, side).map((unit) => ({
      id: unit.id,
      side: unit.side,
      hex: unit.hex,
      mobility: unit.mobility,
      dg: unit.dg,
    }))

    // ── 9.12d：跟随者（未参战战斗单位 / 编内卡车），须与某一撤退单位同格 ──
    const faction = sideUnits[0]?.side
    const joiners: typeof sideUnits = []
    for (const id of input.tagalongIds ?? []) {
      const view = input.units.find((unit) => unit.id === id)
      if (view === undefined) return fail('9.12d', `tagalongUnknownUnit:${id}`)
      // 跟随者只随**自己那一方**的撤退走：调用方可以一次把两方的跟随者都传进来，
      // 故这里按方过滤（不属于当前撤退方的留给它自己那一方处理）。
      if (faction !== undefined && view.side !== faction) continue
      if (sideUnits.some((unit) => unit.id === id)) continue // 参战者本就要撤，无需「跟随」
      const allowed = canJoinRetreat(view)
      if (!allowed.ok) return fail(allowed.rule, `${allowed.reason}:${id}`)
      if (!sideUnits.some((unit) => sameHexOf(unit.hex, view.hex)))
        return fail('9.12d', `tagalongNotInRetreatingHex:${id}`)
      joiners.push({
        id: view.id,
        side: view.side,
        hex: view.hex,
        mobility: view.mobility,
        dg: view.dg,
      })
    }
    // 跟随者与该格的主撤退单位走同一条路径（9.12c「以一整个堆叠进行撤退」）
    const stackUnits = [...sideUnits, ...joiners]
    const resolvedPaths: { unitId: string; path: readonly HexRef[] }[] = [
      ...input.paths.filter((item) => sideUnits.some((unit) => unit.id === item.unitId)),
    ]
    const sidePaths = resolvedPaths
    const missing = sideUnits.filter(
      (unit) => !sidePaths.some((item) => item.unitId === unit.id) && distance > 0,
    )
    if (missing.length > 0)
      return fail('9.12', `retreatPathMissing:${missing.map((unit) => unit.id).join(',')}`)
    const wrongDistance = sidePaths.find((item) => item.path.length !== distance)
    if (wrongDistance !== undefined)
      return fail(
        '9.12',
        `retreatDistanceMustEqualOptions:${wrongDistance.unitId}:${wrongDistance.path.length}!==${distance}`,
      )
    // 专规 1.4b：图外盒（图外空军盒 / 东北、东南边缘盒）**不得撤退进出**
    //   （原文：地面单位只在**移动阶段**可进出边缘盒，且明文「no retreats」）
    const offMap = sidePaths.find((item) => item.path.some((hex) => !isOnMap(hex)))
    if (offMap !== undefined) return fail('专规 1.4b', `retreatOffMapForbidden:${offMap.unitId}`)
    // 9.12：落点与起撤格的**直线距离**必须等于撤退格数（「完整撤退距离」是硬条件，不只是提示）
    for (const item of sidePaths) {
      const unit = sideUnits.find((candidate) => candidate.id === item.unitId)!
      const last = item.path[item.path.length - 1] ?? unit.hex
      if (hexDistance(unit.hex, last) !== distance)
        return fail(
          '9.12',
          `retreatMustEndAtFullDistance:${item.unitId}:${hexDistance(unit.hex, last)}!==${distance}`,
        )
    }
    for (const joiner of joiners) {
      const explicit = input.paths.find((item) => item.unitId === joiner.id)
      if (explicit !== undefined) {
        if (explicit.path.length !== distance)
          return fail(
            '9.12',
            `retreatDistanceMustEqualOptions:${joiner.id}:${explicit.path.length}!==${distance}`,
          )
        const last = explicit.path[explicit.path.length - 1] ?? joiner.hex
        if (hexDistance(joiner.hex, last) !== distance)
          return fail(
            '9.12',
            `retreatMustEndAtFullDistance:${joiner.id}:${hexDistance(joiner.hex, last)}!==${distance}`,
          )
        resolvedPaths.push({ unitId: joiner.id, path: explicit.path })
        continue
      }
      const host = sideUnits.find((unit) => sameHexOf(unit.hex, joiner.hex))!
      const hostPath = resolvedPaths.find((item) => item.unitId === host.id)!
      resolvedPaths.push({ unitId: joiner.id, path: hostPath.path })
    }

    const stack = resolveStackRetreat({
      units: stackUnits,
      paths: resolvedPaths,
      facts: input.facts,
    })
    if (stack.extraLoss > 0) {
      extraLossPoints += stack.extraLoss
      // 9.12e：承受者只能在「撤退中的、进入 ZOC 前已是 DG 的」单位里选
      eligibleUnitIds.push(...stackUnits.filter((unit) => unit.dg).map((unit) => unit.id))
    }
    for (const result of stack.results) {
      results.push(result)
      records.push({
        unitId: result.unitId,
        hex: result.hex,
        destroyed: result.destroyed,
        gainsDg: result.gainsDg,
        dgCompanions: result.dgCompanions,
        fullRetreatDistanceMet: result.fullRetreatDistanceMet,
      })
      patches.push(
        result.destroyed
          ? { unitId: result.unitId, steps: 0 }
          : {
              unitId: result.unitId,
              hex: result.hex!,
              ...(result.gainsDg ? { dg: true as const } : {}),
            },
      )
      // 9.12e：与撤退单位「恰好」同格的友方战斗单位一并 DG
      for (const companion of result.dgCompanions) {
        patches.push({ unitId: companion, dg: true })
      }
    }
  }

  return succeed('9.12', {
    state: { ...state, step: 'advance', retreats: [...state.retreats, ...records] },
    patches,
    results,
    extraLoss: { points: extraLossPoints, eligibleUnitIds: [...new Set(eligibleUnitIds)] },
  })
}

/**
 * 第 9 步：战后推进（9.12g）
 *
 * 「如果所有防御方单位都被摧毁或撤退，则攻击单位就可以进入防御方所在格。
 *   A) 只有消耗了战斗补给的单位（包括战斗值为零的）才能推进；
 *   B) 如果攻击方在选项中选择撤退，则无法推进；
 *   D) 成功的突袭后**必须**战后推进；常规战斗后由拥有者选择。」
 * 随后按 9.13 判进击标记（`exploitEligibility`）。
 */
export function resolveAdvance(
  state: CombatInteractionState,
  input: {
    /** 防御格是否已无防御方单位（全被消灭或撤退） */
    defendingHexCleared: boolean
    /** 候选推进单位（含各自是否付了战斗补给；`immobile` ＝ 9.12b 的不可移动单位） */
    candidates: readonly { id: string; paidCombatSupply: boolean; immobile?: boolean }[]
    /** 玩家选择的推进单位（常规战斗可省略＝不推进） */
    chosenUnitIds?: readonly string[]
    /** 9.13：攻方 AR 单位是否 DG（9.13b-A） */
    attackerArDg?: boolean
    /**
     * 9.13：**参战攻方单位各自的 AR / DG**（逐单位判进击标记）
     *
     * 图表第 2 页写的是 `e# Attackers with action ratings of # or more are exploitation marked`，
     * 9.13b-A 又规定「**非 DG 的攻击单位可正常结算**」——故必须逐单位给。
     * 省略时退回"只看宣布的 AR 单位"的旧口径（供既有调用方与测试保持行为）。
     */
    attackerUnits?: readonly { unitId: string; ar: number; dg: boolean }[]
    /** 9.13：攻方是否把全部选项都选成了军力损失（9.10d） */
    attackerAllOptionsAsLosses?: boolean
    /** 专规 1.1b：防御格是敌方安全边缘格（补给源边格）⇒ 不得推进进去 */
    advanceIntoForbiddenHex?: boolean
  },
): RuleOutcome<{
  state: CombatInteractionState
  patches: CombatUnitPatch[]
  advanceUnitIds: string[]
  /**
   * 9.13b-A：进击标记是**逐单位**授予的（AR ≥ e# 且自身未 DG 的参战单位各自获得）
   *
   * `granted` 只是"有没有人拿到"；真正拿到的是 `unitIds`（E3：日志要列实际受标单位，
   * 不能写死"授予 AR 单位"）。实现里已在 `exploit.ok` 时带上本字段。
   */
  exploit: { granted: boolean; reason: string; unitIds?: readonly string[] }
}> {
  if (state.step !== 'advance') return fail('9.2', `notAtAdvanceStep:${state.step}`)
  if (state.ar === undefined || state.dice === undefined)
    return fail('9.2', 'arOrDiceMissingBeforeAdvance')

  const attackerRetreated = (state.resolution.attacker.option?.retreatHexes ?? 0) > 0
  // 9.12g-B：攻方在选项中撤退 ⇒ **不得推进**（这是合法结果，不是错误；不向调用方报错）
  let advanceUnitIds: string[] = []
  let mandatory = false
  if (!attackerRetreated) {
    const advance = resolveAdvanceAfterCombat({
      attackType: state.attackType,
      defendingHexCleared: input.defendingHexCleared,
      attackerRetreated,
      candidates: input.candidates,
      ...(input.chosenUnitIds === undefined ? {} : { chosenUnitIds: input.chosenUnitIds }),
      ...(input.advanceIntoForbiddenHex === undefined
        ? {}
        : { advanceIntoForbiddenHex: input.advanceIntoForbiddenHex }),
    })
    // 9.12g-A：选了未付战斗补给的推进单位 ⇒ 非法选择，报错让界面纠正
    if (!advance.ok) return advance
    advanceUnitIds = advance.data.advanceUnitIds
    mandatory = advance.data.mandatory
  }
  const patches: CombatUnitPatch[] = advanceUnitIds.map((unitId) => ({
    unitId,
    hex: state.composition.defendingHex,
  }))

  const exploit = exploitEligibility({
    eThreshold: state.dice.result.attacker.exploitationAR,
    // 9.13 逐单位：调用方给全参战单位时按各自 AR/DG 判；否则退回"只看宣布的 AR 单位"
    attackers: input.attackerUnits ?? [
      { unitId: state.ar.attackerUnitId, ar: state.ar.attackerAr, dg: input.attackerArDg === true },
    ],
    attackerRetreatedInOptions: attackerRetreated,
    attackerAllOptionsAsLosses:
      input.attackerAllOptionsAsLosses ??
      (state.resolution.attacker.option?.lossPoints ?? 0) ===
        (state.resolution.attacker.option?.points ?? 0),
    attackType: state.attackType,
    phase: state.phase,
    attackerHexes: state.composition.attackerHexes,
  })
  const exploitGranted = exploit.ok && exploit.data.granted
  // 9.13：**逐单位**发补丁——AR ≥ e# 且自身未 DG 的参战单位各自获得（9.13b-A 的同伴照常结算）
  if (exploitGranted && exploit.ok)
    for (const unitId of exploit.data.grantedUnitIds) patches.push({ unitId, exploit: true })

  return succeed('9.12g', {
    state: {
      ...state,
      step: 'advance',
      advance: { advanceUnitIds, mandatory },
      finished: true,
    },
    patches,
    advanceUnitIds,
    exploit: {
      granted: exploitGranted,
      reason: exploit.ok ? exploit.data.reason : exploit.reason,
      ...(exploit.ok ? { unitIds: exploit.data.grantedUnitIds } : {}),
    },
  })
}

/* ────────────────────────────── 便捷查询 ────────────────────────────── */

/** 该方是否还需要在选项中撤退（决定第 9 步是否要收撤退方向） */
export function needsRetreat(state: CombatInteractionState, side: CombatRole): boolean {
  return (state.resolution[side].option?.retreatHexes ?? 0) > 0
}

/** 战斗结果里该方文本（供日志） */
export function resultTextOf(result: CombatResult): string {
  return result.raw
}

/** 解析 CRT 单元格（供界面按 raw 复算显示） */
export function parseResultCell(cell: string): CombatResult {
  return parseCrtResultCell(cell)
}

/** 该场战斗的 9.2 流程清单（含本步已否） */
export function stepChecklist(
  state: CombatInteractionState,
): { step: CombatStep; rule: string; note: string; done: boolean; current: boolean }[] {
  return BATTLE_SEQUENCE.map((item) => ({
    step: item.step,
    rule: item.rule,
    note: item.note,
    done: stepIndex(item.step) < stepIndex(state.step) || state.finished,
    current: item.step === state.step && !state.finished,
  }))
}
