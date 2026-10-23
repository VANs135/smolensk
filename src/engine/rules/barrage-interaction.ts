import type { HexRef } from '@/data'

import { fail, succeed, type RuleOutcome } from '../result-types'
import type { GamePhase } from '../state-types'
import {
  barrageColumnShifts,
  barrageEligibility,
  barrageTableMeta,
  canBarrageAtRange,
  canPayBarrageCost,
  resolveBarrage,
  resolveBarrageVsFacility,
  resolveBarrageOutcome,
  resolveFacilityOutcome,
  roundBarrageValue,
  type BarrageEligibility,
  type BarrageKind,
  type BarrageOutcome,
  type BarrageResult,
  type BarrageShiftBreakdown,
  type BarrageTableMeta,
  type BarrageTargetKind,
  type FacilityOutcome,
} from './barrage'
import { modeEffect, type BaseMode } from './modes'
import { combatLineOf, type CombatLine } from './terrain'

/**
 * 轰炸交互（C7，OCS 10.0 章）——**10.0 通用流程的状态机**（纯函数）
 *
 * 定位与 C6 战斗交互（`combat-interaction.ts`）同规：把「宣布整体目标与轰炸值分配 → 按初始列付火炮补给
 * → 目标玩家确认地形横移 → 掷骰 → 结果确认（含损失分配）/ 对设施结果」这一整套交互中**所有需要按规则
 * 裁决的东西**集中于此；界面层只画图与收点击，单位与设施状态由状态层持有（本模块以 `patches` 交还变更，
 * 引擎不写状态）。
 *
 * ## 10.0 通用流程（规则书原文顺序，不可颠倒）
 *   「将轰炸值**加总**，确定在轰炸表应使用**哪一纵列**，按照该列给出的数量来**消耗补给（仅限火炮轰炸）**，
 *    并按照轰炸表的说明**调整纵列的横移**。掷两枚骰子并结算结果。」
 *   「重要提示：**至少需要一点轰炸值**才能『使用轰炸表』（计算横移之前）。不允许用零点轰炸值来轰炸！」
 *
 * 对应到本模块的步骤（`BARRAGE_STEP_IDS`）：
 *   1) 宣布整体目标（10.0d）与参炸单位的轰炸值分配（10.0e-B/F）→ `beginBarrage`
 *   2) 按**初始列**支付火炮战斗补给（10.1b；付不出则取消且**不视为已轰炸过**）→ `planBarrageSupply`
 *   3) 列横移（10.0a 由**目标玩家**选地形 / 10.0b 观察员 / 10.2b 短程）→ `declareBarrageShifts`
 *   4) 掷骰（战斗单位掷 **2 骰**；对设施掷 **1 骰**；`1/2` 需再掷取整骰）→ `resolveBarrageDice`
 *   5) 结果确认（10.0a：DG + 由**目标玩家**选择哪些战斗单位承受损失；10.0c：A/B/C 三类设施结果）
 *      → `planBarrageOutcome`
 *
 * ## 关键条文（逐句落实现）
 *   - **10.0d** 混合目标格：「攻击方玩家都必须宣布一个**整体的目标**（如『战斗单位』或『港口』），
 *     并且轰炸点数**只能用于该目标**」⇒ `targetKind` 在 `beginBarrage` 一次定死。
 *   - **10.0e-A** 每格每阶段只允许被轰炸**一次**（反舰与低空扫射除外）；**已宣布但被防空/拦截完全摧毁
 *     或返航的任务也算**⇒ 由 `facts.hexAlreadyBarragedThisPhase` 传入，`hipShoot` 时放行。
 *   - **10.0e-B** 一个单位每阶段只能轰炸一次、**不能拆分**轰炸值、**不能低于印刷轰炸值**。
 *   - **10.0e-C/D/E** 阶段门槛：空军与海军＝移动/反应/进击；火炮＝战斗/反应/进击。
 *   - **10.0e-F** 一次轰炸只能用**同一类型**（空军/海军/火炮其一）单位。
 *   - **10.0a** 地形横移由**目标玩家**选择；损失由**目标玩家**选择承受单位；密度只算战斗单位，
 *     且单个师（含多单位编队）计入密度时**封顶 3 RE**。
 *   - **10.0b** 无正确观察员 ⇒ 左移 3 列；**低空扫射**必须有正确观察员（无论用哪张表）；
 *     对设施表**不受**观察员影响；**战略轰炸机**的无观察员惩罚**永久生效**。
 *   - **10.0c** 对设施轰炸：须**预先指定**具体目标；**不受修正、无地形横移、不需观察员**；掷**一个骰子**；
 *     A) 空军基地：`(#)` ⇒ 该格**每架**敌机各掷骰、≥# 者损 1 军力；不带括号数字 ⇒ 基地降级、**最低 1 级**、
 *        **简易机场永不降级**；B) 港口：只有 1/2 造成伤害、累计**上限 4 点**；C) 运输破坏：须 `*` 才放置标记。
 *   - **10.1b** 火炮补给用量取**初始列**；付不出则**不能执行**（无惩罚：全部取消，且**不视为已轰炸过**）；
 *     A) 多单位齐射须来自**同一指挥部**，不用指挥部则来自**同一补给站**；C) **永不能用部队储备**。
 *   - **10.2b** **短程效果**：执行轰炸的**所有**飞机都在其基地 10 格及以内 ⇒ 右移 1 列；**战略轰炸机永不享受**。
 *   - **10.2c** 空军轰炸**无补给消耗**。
 *
 * ## 与既有模块的分工（不重复实现规则）
 *   - 表格、列横移、结果解释、资格判定一律委托 `barrage.ts`（10.0 全章唯一实现）；
 *   - 本模块只负责**顺序、状态推进与玩家输入的形状**（谁先宣布、哪一步还没做、哪些输入合法）。
 */

/* ────────────────────────────── 步骤词表 ────────────────────────────── */

/**
 * 轰炸交互步骤 id
 *
 * 与 `combat-interaction.ts#COMBAT_STEP_IDS` 同规：`step` 表示**下一步待办**；
 * `beginBarrage` 完成第 1 步「宣布」后落在 `supply`；`done` 为终态。
 */
export const BARRAGE_STEP_IDS = ['declare', 'supply', 'shifts', 'dice', 'outcome', 'done'] as const
export type BarrageStep = (typeof BARRAGE_STEP_IDS)[number]

/** 步骤中文名（供界面清单） */
export const BARRAGE_STEP_LABELS: Record<BarrageStep, string> = {
  declare: '宣布目标与轰炸值',
  supply: '火炮战斗补给（10.1b）',
  shifts: '列横移确认（10.0a/b）',
  dice: '掷骰（10.0 / 10.0c）',
  outcome: '结果确认（10.0a / 10.0c）',
  done: '结束',
}

/* ────────────────────────────── 类型 ────────────────────────────── */

/** 参炸单位（10.0e-B：不得拆分轰炸值、不得低于印刷值） */
export interface BarrageUnitRequest {
  unitId: string
  /** 印刷轰炸值（10.0e-B 的下限） */
  printedValue: number
  /** 本次分配到的轰炸值；缺省 = `printedValue`（即不拆分、按印刷值参炸） */
  assignedValue?: number
  /** 13.4a：火炮是否处于预备/战略模式（该状态不得轰炸） */
  inReserveOrStrat?: boolean
  /**
   * 5.10b-A：该单位是否 DG（**轰炸值减半**）
   *
   * 与 `battle.BattleUnitView.dg` 同源；折算在 `beginBarrage` 一处施加，
   * 故调用方传**印值**即可，不要自行折半（否则会折两次）。
   */
  dg?: boolean
  /** 5.10b-A：生效模式（战略模式轰炸值为零；缺省按战斗模式） */
  mode?: BaseMode
  /** 5.7b：本阶段刚释放的预备（标记已移除，数值回到基础行） */
  releasedFromReserve?: boolean
  /** 10.1a：火炮距目标格数（射程以格为单位，不受天气/地形影响） */
  distanceHexes?: number
  /** 10.1a：火炮射程（格） */
  rangeHexes?: number
  /** 专规 2.3d：该单位所在格（苏炮"同堆叠"判据用；缺省＝不参与该判据） */
  hex?: HexRef
  /** 专规 2.3d：带 `sov_artillery_stack_to_combine` 标签（苏军炮兵合并轰炸须同堆叠） */
  sovArtilleryStackToCombine?: boolean
  /** 10.2b：空军距其基地的格数（**全部**飞机 ≤10 格才享短程 +1） */
  rangeFromBase?: number
  /** 10.2b：是否战略轰炸机（不享短程、无观察员惩罚永久生效） */
  strategicBomber?: boolean
}

/** 10.1b：本次轰炸的补给支付记录 */
export interface BarrageSupplyRecord {
  /** 初始列上的 T 成本（10.1b） */
  requiredT: number
  /** 是否已支付（空军轰炸恒为 true 且 0 成本，见 10.2c） */
  paid: boolean
  /** 是否**无需**补给（空军轰炸 10.2c / 非火炮） */
  waived: boolean
  /** 判断依据的条文 */
  rule: string
}

/** 掷骰记录（10.0：战斗单位 2 骰；10.0c：设施 1 骰） */
export interface BarrageDiceRecord {
  die: number
  /** `1/2` 的取整骰（1–6）；未掷则为 undefined */
  halfDie?: number
  /** 是否仍在等取整骰（`1/2` 结果且未给 `halfDie`） */
  awaitingHalfDie: boolean
}

/** 结果记录（两张表二选一） */
export type BarrageOutcomeRecord =
  | { table: 'barrage'; value: BarrageOutcome }
  | { table: 'barrage-vs-facility'; value: FacilityOutcome }

/** 轰炸对单位/设施的变更（绝对值，交状态层落盘） */
export interface BarrageUnitPatch {
  unitId: string
  /** 5.10：置为 DG */
  dg?: true
  /** 结算后的剩余军力（10.0a 的 `#` 与 `1/2`） */
  steps?: number
}

/** 对设施轰炸产生的设施变更（由状态层落盘） */
export interface FacilityPatch {
  /** 空军基地等级变化后的值（最低 1 级；简易机场不变） */
  baseLevelAfter?: number
  /** 港口累计伤害（上限 4） */
  portDamage?: number
  /** 是否放置运输破坏标记 */
  trainbustingPlaced?: boolean
}

/** 轰炸交互的全部累积决策 */
export interface BarrageInteractionState {
  /** 下一步待办（已完成到 `step` 之前） */
  step: BarrageStep
  kind: BarrageKind
  phase: GamePhase
  /** 10.0d：本次宣布的**整体目标**（轰炸值只能用于它） */
  targetKind: BarrageTargetKind
  /** 目标格 */
  targetHex: HexRef
  /** 参炸单位与其轰炸值分配 */
  units: BarrageUnitRequest[]
  /** 资格判定通过的条文（10.0e 等） */
  eligibilityRule: string
  /**
   * 10.0：加总后的轰炸值（已按 4.2 **取整**）——确定纵列与 T 成本用的就是它
   */
  totalValue: number
  /**
   * 4.2：取整**之前**的合并值（仅当带小数时与 `totalValue` 不同）
   *
   * 供结算明细展示「合并得 2.5 → 取整 3」这一步；规则结论一律以 `totalValue` 为准。
   */
  rawTotalValue: number
  /** 10.0：初始列（横移前）与**该列**的 T 成本（10.1b） */
  table: BarrageTableMeta
  /** 10.1b：补给支付 */
  supply?: BarrageSupplyRecord
  /** 10.0a：由**目标玩家**选择的地形线 */
  terrainLine?: CombatLine
  /**
   * 第 3 步收到的横移输入（原样保存）
   *
   * 第 4 步掷骰时把它**原样**交给 `barrage.resolveBarrage`，从而保证「展示给玩家的横移」
   * 与「查表实际用的列位」出自**同一实现、同一输入**（纯函数 ⇒ 同结果），不会两处漂移。
   */
  shiftInput?: BarrageShiftInput
  /** 列横移明细（10.0a/b/10.2b） */
  shifts?: BarrageShiftBreakdown
  /** 横移后的最终列位（可越界，已夹取） */
  finalColumn?: number
  /** 最终列标签 */
  finalColumnLabel?: string
  /** 掷骰 */
  dice?: BarrageDiceRecord
  /** 表结果（格值等） */
  result?: BarrageResult
  /** 结果解释 */
  outcome?: BarrageOutcomeRecord
  /** 10.0a：由**目标玩家**选择的承受损失单位分配 */
  losses: { unitId: string; steps: number }[]
  /** 整次轰炸是否已结束 */
  finished: boolean
}

/* ────────────────────────────── 工具 ────────────────────────────── */

function stepIndex(step: BarrageStep): number {
  return BARRAGE_STEP_IDS.indexOf(step)
}

/**
 * 该步骤是否**已到达**（`step` 为「下一步待办」，故到达某步即「该步待执行或已执行完」）
 *
 * 与 `combat-interaction.ts#hasReachedStep` 同语义，供界面提示「还差哪几步」。
 */
export function hasReachedBarrageStep(state: BarrageInteractionState, step: BarrageStep): boolean {
  return stepIndex(state.step) >= stepIndex(step)
}

/** 界面用的步骤清单（已走过的步骤标 done） */
export function barrageStepChecklist(
  state: BarrageInteractionState,
): { step: BarrageStep; label: string; done: boolean }[] {
  return BARRAGE_STEP_IDS.map((step) => ({
    step,
    label: BARRAGE_STEP_LABELS[step],
    done: stepIndex(step) < stepIndex(state.step),
  }))
}

/** 10.0c：本次是否走**对设施轰炸表** */
export function isFacilityBarrage(state: BarrageInteractionState): boolean {
  return state.targetKind !== 'combatUnits'
}

/** 10.0c：对设施轰炸**没有**列横移（不受修正、无地形横移、不需观察员） */
const NO_SHIFTS: BarrageShiftBreakdown = {
  density: 0,
  hedgehog: 0,
  terrain: 0,
  spotter: 0,
  stratMode: 0,
  shortRange: 0,
  total: 0,
  detail: ['10.0c：对设施轰炸不受修正、无地形横移、不需观察员'],
}

function clampColumn(index: number, columnCount: number): number {
  return Math.max(0, Math.min(columnCount - 1, index))
}

/* ────────────────────────────── ① 宣布目标与轰炸值（10.0d / 10.0e） ────────────────────────────── */

/** `beginBarrage` 的资格事实（由调用方按当前局面给出） */
export interface BarrageFacts {
  /** 10.0e-A：该格本阶段是否已被轰炸过 */
  hexAlreadyBarragedThisPhase?: boolean
  /** 10.0e-B：是否已有单位本阶段轰炸过 */
  unitAlreadyBarragedThisPhase?: boolean
  /** 10.0e-B：是否把轰炸值拆分到多次轰炸 */
  splitValue?: boolean
  /** 10.0e-B：是否以低于印刷值参炸 */
  belowPrintedValue?: boolean
  /** 10.0e-F：参炸单位是否含不同类型 */
  mixedKinds?: boolean
  /** 10.0b：是否为低空扫射（须有正确观察员） */
  hipShoot?: boolean
  /** 10.0b：是否有正确的观察员 */
  hasSpotter?: boolean
}

/**
 * 第 1 步：宣布整体目标（10.0d）并分配轰炸值（10.0e-B/F），随后确定初始列与补给用量
 *
 * 完成后 `step` 落在 `supply`（按初始列付火炮补给）。资格判定整体委托 `barrageEligibility`；
 * 轰炸值 = 各参炸单位 `assignedValue ?? printedValue` 之和（10.0e-B 禁止拆分与低于印刷值）。
 */
export function beginBarrage(input: {
  kind: BarrageKind
  phase: GamePhase
  /** 10.0d：本次宣布的**整体目标** */
  targetKind: BarrageTargetKind
  targetHex: HexRef
  units: readonly BarrageUnitRequest[]
  facts?: BarrageFacts
}): RuleOutcome<BarrageInteractionState> {
  if (input.units.length === 0) return fail('10.0', 'noBarrageUnit')

  /*
   * 5.10b-A：DG 单位的轰炸值减半；5.8：战略模式轰炸值为零（`modeEffect` 给出倍率）。
   *
   * ★ 折算**只在这一处**施加（与 `battle.unitBattleStrength` 同一份模式矩阵、同一条优先级链）。
   *   调用方传印值即可——若调用方也折半，会折两次。
   * ★ 按单位折半后**再合并**，随后按 4.2 对合并值取整（取整必须在合并之后）。
   */
  const units = input.units.map((unit) => {
    const multiplier = modeEffect({
      mode: unit.mode ?? 'combat',
      dg: unit.dg,
      releasedFromReserve: unit.releasedFromReserve,
    }).barrageMult
    return { ...unit, assignedValue: (unit.assignedValue ?? unit.printedValue) * multiplier }
  })

  /*
   * 专规 2.3d（第五批 A4）：「To combine for a single Barrage, all of the firing Soviet artillery
   * units must be stacked together.」（Smolensk_Rules_v1.1.txt:329-331）⇒ 带
   * `sov_artillery_stack_to_combine` 标签的参炸苏军炮兵 ≥2 时，必须**全部同格**。
   * 标签驱动 ⇒ 无标签炮（含德军炮兵）不受此限；缺 hex 的单位不参与该判据
   * （调用方契约：store 的 `toBarrageUnitRequest` 恒传 hex）。
   */
  const sovietTagged = units.filter(
    (unit) => unit.sovArtilleryStackToCombine === true && unit.hex !== undefined,
  )
  if (sovietTagged.length >= 2) {
    const stackHexes = new Set(sovietTagged.map((unit) => `${unit.hex?.col}.${unit.hex?.row}`))
    if (stackHexes.size > 1) return fail('专规 2.3d', 'sovietArtilleryMustStackTogether')
  }
  /*
   * 10.1a（第六批条 20 的引擎内核）：**火炮射程以格为单位，不受天气与地形影响**
   *   「射程为 '3' 的火炮单位可以对 1 到 3 个格上的目标进行轰炸。」
   * ⇒ 每个参炸火炮**逐个**校验（不是取最好/最差的那一枚敷衍）：任一枚够不着 ⇒ 整次宣布被拒。
   *
   * ★ 修前 `canBarrageAtRange` **零调用**：候选是"全图本方有印值炮"，于是 1～2 射程的炮
   *   能炸 3 格外的目标。判据只在**火炮**上生效——空军走的是 14.2d 的航程（另一条判据，
   *   由 `air-interaction` 管），其请求不带 `rangeHexes`。
   * ★ 判据放在资格之前：射程是"能不能参炸"的前提，够不着就不该进入 10.0e 的资格链。
   */
  const outOfRange = units.find(
    (unit) =>
      unit.rangeHexes !== undefined &&
      unit.distanceHexes !== undefined &&
      !canBarrageAtRange({ rangeHexes: unit.rangeHexes, distanceHexes: unit.distanceHexes }),
  )
  if (outOfRange !== undefined)
    return fail(
      '10.1a',
      `artilleryOutOfRange:${outOfRange.unitId}:${outOfRange.distanceHexes}>${outOfRange.rangeHexes}`,
    )

  const rawTotalValue = units.reduce((sum, unit) => sum + (unit.assignedValue ?? 0), 0)
  // 4.2：合并后取整，取整值即确定纵列与 T 成本所用的值
  const totalValue = roundBarrageValue(rawTotalValue)

  const facts = input.facts ?? {}
  const eligibility: BarrageEligibility = barrageEligibility({
    kind: input.kind,
    phase: input.phase,
    declaredTarget: input.targetKind,
    unitCount: units.length,
    totalValue,
    hexAlreadyBarragedThisPhase: facts.hexAlreadyBarragedThisPhase,
    unitAlreadyBarragedThisPhase: facts.unitAlreadyBarragedThisPhase,
    splitValue: facts.splitValue,
    belowPrintedValue: facts.belowPrintedValue,
    mixedKinds: facts.mixedKinds,
    // 13.4a：只要有一个参炸火炮处于预备/战略模式即拒绝
    artilleryInReserveOrStrat: units.some((unit) => unit.inReserveOrStrat === true),
    hipShoot: facts.hipShoot,
    hasSpotter: facts.hasSpotter,
  })
  if (!eligibility.ok) return fail(eligibility.rule, eligibility.reason)

  // 10.0：加总轰炸值 → 确定初始列（★ 横移之前），并按该列取 T 成本（10.1b）
  const table = barrageTableMeta({ target: input.targetKind, valueRange: totalValue })

  return succeed(eligibility.rule, {
    step: 'supply',
    kind: input.kind,
    phase: input.phase,
    targetKind: input.targetKind,
    targetHex: input.targetHex,
    units,
    eligibilityRule: eligibility.rule,
    totalValue,
    rawTotalValue,
    table,
    losses: [],
    finished: false,
  })
}

/* ────────────────────────────── ② 火炮战斗补给（10.1b / 10.2c） ────────────────────────────── */

export interface BarrageSupplyInput {
  /** 可动用的 T（**只能来自 SP**：同一 HQ 或同一 dump，不含部队储备） */
  availableT: number
  /** 10.1b-A：是否来自同一指挥部 */
  fromSameHq?: boolean
  /** 10.1b-A：是否来自同一补给站 */
  fromSameDump?: boolean
  /** 10.1b-C：是否动用了部队储备（明令禁止） */
  usedInternalStocks?: boolean
}

/**
 * 第 2 步：支付火炮战斗补给（10.1b）
 *
 * 「消耗量会在对应轰炸表的顶部给出；请使用轰炸的**初始列**（计算任何横移之前）上的消耗量。」
 * 「如果无法满足轰炸所需的 SP 消耗，则**不能执行此次轰炸**。（这没有惩罚——所有单位取消轰炸，
 *   也**不视为已轰炸过**。）」⇒ 失败即整次取消（调用方直接丢弃该交互，不得登记「已轰炸」）。
 *
 * 10.2c：**空军轰炸无补给消耗**；海军同规（本作无海军，专规 1.1c）。
 */
export function planBarrageSupply(
  state: BarrageInteractionState,
  input: BarrageSupplyInput,
): RuleOutcome<{ state: BarrageInteractionState }> {
  if (state.step !== 'supply') return fail('10.0', `notAtSupplyStep:${state.step}`)

  // 10.2c：非火炮（空军/海军）不消耗战斗补给
  if (state.kind !== 'artillery') {
    return succeed('10.2c', {
      state: {
        ...state,
        supply: { requiredT: 0, paid: true, waived: true, rule: '10.2c' },
        step: 'shifts',
      },
    })
  }

  const verdict = canPayBarrageCost({
    requiredT: state.table.costT,
    availableT: input.availableT,
    unitCount: state.units.length,
    fromSameHq: input.fromSameHq,
    fromSameDump: input.fromSameDump,
    usedInternalStocks: input.usedInternalStocks,
  })
  if (!verdict.ok) return fail(verdict.rule, verdict.reason)

  return succeed('10.1b', {
    state: {
      ...state,
      supply: { requiredT: state.table.costT, paid: true, waived: false, rule: verdict.rule },
      step: 'shifts',
    },
  })
}

/* ────────────────────────────── ③ 列横移确认（10.0a / 10.0b / 10.2b） ────────────────────────────── */

/** 列横移所需的目标格事实 */
export interface BarrageShiftInput {
  /** 10.0a：目标格内**战斗单位**的 RE 合计（只算战斗单位；单个师封顶 3 RE） */
  enemyREInHex?: number
  /** 10.0a：目标格环形工事等级（任意等级 ⇒ 左移 1） */
  hedgehogLevel?: number
  /**
   * 10.0a：由**目标玩家**选择的、可能提供横移的地形所属战斗线
   *
   * 「由目标玩家选择可能提供横移的地形」⇒ 这是**防守方（目标玩家）**的输入，不是轰炸方的选择。
   * 给出 `hexTerrains` 时会校验该线确实由目标格地形产生（见 `barrageTerrainLines`）。
   */
  terrainLine?: CombatLine
  /** 10.0a：目标格内的**格内**地形候选（9.3b 的候选集，含 spillover 例外）；用于校验 `terrainLine` */
  terrainCandidates?: readonly string[]
  /** 10.0b：是否有正确的观察员（与目标格相邻的友方战斗单位） */
  hasSpotter?: boolean
  /** 10.0a：目标格内是否有单位处于战略模式（有 ⇒ 右移 3） */
  stratModeInHex?: boolean
  /**
   * 10.2b：任务中**最远**飞机距其基地的格数（全部 ≤10 才右移 1）
   *
   * 省略时由参炸单位自动汇总（见 `barrageAircraftFacts`）——调用方无须自己挑「最远者」，
   * 避免「只看了一架飞机」这类口径错误。
   */
  rangeFromBase?: number
  /** 10.2b / 14.1e：本次是否有战略轰炸机参炸（不享短程、且无观察员惩罚永久生效）；省略时自动汇总 */
  strategicBomber?: boolean
}

/**
 * 10.2b：从参炸单位汇总**任务级**空军事实
 *
 *   - 「如果执行轰炸的**所有**飞机都在它们基地的 10 格上或 10 格以内」⇒ 取各机 `rangeFromBase` 的
 *     **最大值**（最远者决定整次任务是否享 +1）；
 *   - 「例外：永远不要将此横移用于**战略轰炸机**」+ 14.1e（战略轰炸机的轰炸**总被认为没有观察员**）
 *     ⇒ 只要有任意一架战略轰炸机参炸，整次任务都按「战略轰炸机任务」处理（从严判读）。
 *
 * 非空军参炸单位不带 `rangeFromBase`（火炮射程另由 10.1a 的 `canBarrageAtRange` 判），故不参与汇总。
 */
export function barrageAircraftFacts(units: readonly BarrageUnitRequest[]): {
  /** 任务中**最远**飞机距其基地的格数；无飞机参炸时为 null */
  rangeFromBase: number | null
  /** 是否有战略轰炸机参炸（机型 S，14.1e） */
  strategicBomber: boolean
} {
  const ranges = units
    .map((unit) => unit.rangeFromBase)
    .filter((value): value is number => value !== undefined)
  return {
    rangeFromBase: ranges.length === 0 ? null : Math.max(...ranges),
    strategicBomber: units.some((unit) => unit.strategicBomber === true),
  }
}

/**
 * 10.0a：目标格地形**可能提供**的战斗线集合（界面选项与引擎校验共用）
 *
 * 「由目标玩家选择**可能提供横移**的地形」⇒ 可选项只来自**目标格内**的格内地形（9.3b 的候选集）；
 * 格边地形（河/湖/路/铁）一律不参与本项（10.0c 也明言对设施「没有地形产生横移」）。
 * 返回顺序照 TEC 战斗线（Open → Close → Very Close → Extr Close），便于界面照序显示。
 */
export function barrageTerrainLines(candidates: readonly string[]): CombatLine[] {
  const order: CombatLine[] = ['Open', 'Close', 'Very Close', 'Extr Close']
  const found = new Set<CombatLine>()
  for (const name of candidates) {
    const line = combatLineOf(name)
    if (line !== null) found.add(line)
  }
  return order.filter((line) => found.has(line))
}

/**
 * 第 3 步：确认列横移（10.0a / 10.0b / 10.2b）
 *
 * 逐条来源见 `barrage.ts#barrageColumnShifts`；本步只记录**目标玩家**的地形选择与最终列位。
 * 对设施（10.0c）**没有**任何横移，故直接落 `NO_SHIFTS` 并把最终列位定为初始列。
 *
 * ★ 10.0a 的地形横移取自「**目标玩家选择可能提供横移的地形**」——即**目标格内实际存在**的地形：
 * 故给了 `hexTerrains` 时必须校验所选战斗线确实由该格地形产生（否则可任取最有利的一条白拿左移）。
 */
export function declareBarrageShifts(
  state: BarrageInteractionState,
  input: BarrageShiftInput,
): RuleOutcome<{ state: BarrageInteractionState }> {
  if (state.step !== 'shifts') return fail('10.0', `notAtShiftsStep:${state.step}`)

  // 10.0c：对设施轰炸不受修正、无地形横移、不需观察员
  if (isFacilityBarrage(state)) {
    return succeed('10.0c', {
      state: {
        ...state,
        shifts: NO_SHIFTS,
        finalColumn: state.table.initialColumn,
        finalColumnLabel: state.table.columnLabel,
        step: 'dice',
      },
    })
  }

  // 10.0a：所选地形线必须由**目标格内**的格内地形产生（候选集含 9.3b 的 spillover 例外；格边地形不参与本项）
  if (input.terrainLine !== undefined && input.terrainCandidates !== undefined) {
    const allowed = barrageTerrainLines(input.terrainCandidates)
    if (!allowed.includes(input.terrainLine))
      return fail('10.0a', `terrainLineNotInTargetHex:${input.terrainLine}`)
  }

  // 10.2b：调用方未给时，由参炸**飞机**自动汇总「最远者距基地格数」与「是否有战略轰炸机（14.1e）」
  const taskAircraft = barrageAircraftFacts(state.units)
  const rangeFromBase = input.rangeFromBase ?? taskAircraft.rangeFromBase ?? undefined
  const strategicBomber = input.strategicBomber ?? taskAircraft.strategicBomber

  const shifts = barrageColumnShifts({
    enemyREInHex: input.enemyREInHex,
    hedgehogLevel: input.hedgehogLevel,
    terrainLine: input.terrainLine,
    hasSpotter: input.hasSpotter,
    stratModeInHex: input.stratModeInHex,
    ...(rangeFromBase === undefined ? {} : { rangeFromBase }),
    kind: state.kind,
    strategicBomber,
  })
  // 10.0：横移可叠加、可越界，故夹取到表列范围
  const finalColumn = clampColumn(state.table.initialColumn + shifts.total, state.table.columnCount)

  return succeed('10.0a', {
    state: {
      ...state,
      terrainLine: input.terrainLine,
      // ★ 把**汇总后**的空军事实写回 shiftInput：掷骰步原样复用它，保证展示与查表口径一致
      shiftInput: {
        ...input,
        ...(rangeFromBase === undefined ? {} : { rangeFromBase }),
        strategicBomber,
      },
      shifts,
      finalColumn,
      finalColumnLabel: state.table.columnLabel,
      step: 'dice',
    },
  })
}

/* ────────────────────────────── ④ 掷骰（10.0 / 10.0c） ────────────────────────────── */

/** `resolveBarrageDice` 的结论 */
export interface BarrageDiceStepResult {
  state: BarrageInteractionState
  /** `1/2` 结果但未给 `halfDie` ⇒ 须**再掷 1 枚取整骰**（停在 dice 步） */
  awaitingHalfDie: boolean
}

/**
 * 第 4 步：掷骰结算
 *
 * 战斗单位（10.0a）掷 **2 骰**（2–12）；对设施（10.0c）掷 **1 骰**（1–6）。
 * 若格值为 `1/2` 且未给 `halfDie`，则返回 `awaitingHalfDie: true` 并**停在 dice 步**
 * （与 C6 奇袭须再掷横移骰同规：不前进、不抛错）。
 *
 * 列横移**不在此重算**：第 3 步存下的 `shiftInput` 原样交给 `barrage.resolveBarrage`，
 * 由它按同一实现给出最终列位与格值；`[1/2]` 的三条件判定同样复用 shiftInput 的事实。
 */
export function resolveBarrageDice(
  state: BarrageInteractionState,
  input: { die: number; halfDie?: number },
): RuleOutcome<BarrageDiceStepResult> {
  if (state.step !== 'dice') return fail('10.0', `notAtDiceStep:${state.step}`)

  if (isFacilityBarrage(state)) {
    // 10.0c：掷**一个骰子**定结果；不受修正、无横移、不需观察员
    const result = resolveBarrageVsFacility(input.die, state.totalValue)
    return succeed('10.0c', {
      state: {
        ...state,
        dice: { die: input.die, awaitingHalfDie: false },
        result,
        step: 'outcome',
      },
      awaitingHalfDie: false,
    })
  }

  // 10.0a：2 骰 + 全部列横移（唯一实现仍是 `barrage.resolveBarrage`）
  const shiftInput = state.shiftInput ?? {}
  const result = resolveBarrage({
    die: input.die,
    valueRange: state.totalValue,
    kind: state.kind,
    ...(shiftInput.enemyREInHex === undefined ? {} : { enemyREInHex: shiftInput.enemyREInHex }),
    ...(shiftInput.hedgehogLevel === undefined ? {} : { hedgehogLevel: shiftInput.hedgehogLevel }),
    ...(shiftInput.terrainLine === undefined ? {} : { terrainLine: shiftInput.terrainLine }),
    ...(shiftInput.hasSpotter === undefined ? {} : { hasSpotter: shiftInput.hasSpotter }),
    ...(shiftInput.stratModeInHex === undefined
      ? {}
      : { stratModeInHex: shiftInput.stratModeInHex }),
    ...(shiftInput.rangeFromBase === undefined ? {} : { rangeFromBase: shiftInput.rangeFromBase }),
    ...(shiftInput.strategicBomber === undefined
      ? {}
      : { strategicBomber: shiftInput.strategicBomber }),
  })

  // 结果解释（10.0a）；`1/2` 需取整骰，未给则停在 dice 步等它
  const outcome = resolveBarrageOutcome({
    code: result.code,
    ...(shiftInput.hedgehogLevel === undefined ? {} : { hedgehogLevel: shiftInput.hedgehogLevel }),
    ...(shiftInput.hasSpotter === undefined ? {} : { hasSpotter: shiftInput.hasSpotter }),
    ...(shiftInput.strategicBomber === undefined
      ? {}
      : { strategicBomber: shiftInput.strategicBomber }),
    kind: state.kind,
    ...(input.halfDie === undefined ? {} : { halfDie: input.halfDie }),
  })
  if (outcome.needsHalfDie) {
    // 10.0a 游戏提示：三枚骰（2 轰炸骰 + 1 取整骰）一起掷，正是为加快此步
    return succeed('10.0a', {
      state: { ...state, dice: { die: input.die, awaitingHalfDie: true }, result },
      awaitingHalfDie: true,
    })
  }

  return succeed('10.0a', {
    state: {
      ...state,
      dice: {
        die: input.die,
        ...(input.halfDie === undefined ? {} : { halfDie: input.halfDie }),
        awaitingHalfDie: false,
      },
      result,
      // 解释一次即定：结果确认步只做「损失分配 + 生成变更」
      outcome: { table: 'barrage', value: outcome },
      step: 'outcome',
    },
    awaitingHalfDie: false,
  })
}

/* ────────────────────────────── ⑤ 结果确认（10.0a / 10.0c） ────────────────────────────── */

/** 损失分配容量（10.0a：目标玩家选择哪些战斗单位承受） */
export interface BarrageLossCapacity {
  /** 该结果要求造成的军力点合计 */
  required: number
  /** 已分配合计 */
  allocated: number
  /** 分配是否合法（只允许目标格内、且已足额） */
  ok: boolean
  reason?: string
}

/**
 * 10.0a：校验损失分配
 *
 * 「他还需要选择堆叠中的哪些战斗单位来承受此次轰炸造成的军力损失」——
 * 分配须**足额**（合计 = 结果要求点数），且只能落在**目标格内的战斗单位**上（调用方给出候选）。
 */
export function validateBarrageLossAllocation(input: {
  required: number
  losses: readonly { unitId: string; steps: number }[]
  /** 目标格内可作为承受者的战斗单位 id */
  eligibleUnitIds: readonly string[]
}): BarrageLossCapacity {
  const allocated = input.losses.reduce((sum, loss) => sum + loss.steps, 0)
  const unknown = input.losses.find((loss) => !input.eligibleUnitIds.includes(loss.unitId))
  if (unknown !== undefined)
    return {
      required: input.required,
      allocated,
      ok: false,
      reason: `unitNotInTargetHex:${unknown.unitId}`,
    }
  const invalid = input.losses.find((loss) => !Number.isInteger(loss.steps) || loss.steps < 0)
  if (invalid !== undefined)
    return {
      required: input.required,
      allocated,
      ok: false,
      reason: `invalidSteps:${invalid.unitId}`,
    }
  if (allocated !== input.required)
    return {
      required: input.required,
      allocated,
      ok: false,
      reason: `lossAllocationMismatch:${allocated}!=${input.required}`,
    }
  return { required: input.required, allocated, ok: true }
}

/** `planBarrageOutcome` 的输入 */
export interface BarrageOutcomeInput {
  /** 10.0a：目标格内可作为损失承受者的战斗单位 id */
  eligibleUnitIds?: readonly string[]
  /** 10.0a：由目标玩家给出的损失分配（合计须等于结果点数） */
  losses?: readonly { unitId: string; steps: number }[]
  /* ── 以下仅对设施轰炸（10.0c）有效 ── */
  /** 10.0c-A：空军基地当前等级 */
  baseLevel?: number
  /** 10.0c-A：目标是否为**简易机场**（永不降低等级） */
  isAirstrip?: boolean
  /** 10.0c-A：该格内每架飞机的掷骰（1d6；调用方掷） */
  aircraft?: readonly { id: string; roll: number }[]
  /** 10.0c-B：港口既有累计伤害（0–4） */
  portDamageBefore?: number
}

/** `planBarrageOutcome` 的结论 */
export interface BarrageOutcomeStepResult {
  state: BarrageInteractionState
  /** 10.0a：对战斗单位的变更（DG / 剩余军力） */
  patches: BarrageUnitPatch[]
  /** 10.0c：设施变更 */
  facility?: FacilityPatch
  /** 10.0c-A：掷骰 ≥# 的飞机 id（各损 1 军力；飞机不走地面 patches，由 store 逐一落盘） */
  aircraftLossIds?: readonly string[]
}

/**
 * 第 5 步：结果确认
 *
 * 战斗单位（10.0a）：`-` 无效果 / `DG` 该格全体 DG / `#` 损 # 点军力并 DG /
 * `1/2` 掷取整骰 4-6 损 1 点并 DG、其他只 DG。**DG 为强制的**（全体），损失分配由目标玩家给出。
 * 对设施（10.0c）：A 空军基地降级（最低 1 级；简易机场永不降级）与逐机掷骰、B 港口累计伤害（≤4）、
 * C 运输破坏放置标记。
 */
export function planBarrageOutcome(
  state: BarrageInteractionState,
  input: BarrageOutcomeInput = {},
): RuleOutcome<BarrageOutcomeStepResult> {
  if (state.step !== 'outcome') return fail('10.0', `notAtOutcomeStep:${state.step}`)
  if (state.result === undefined) return fail('10.0', 'noBarrageResult')

  /* ── 10.0c：对设施 ── */
  if (isFacilityBarrage(state)) {
    const value = resolveFacilityOutcome({
      code: state.result.code,
      target: state.targetKind as Exclude<BarrageTargetKind, 'combatUnits'>,
      baseLevel: input.baseLevel,
      isAirstrip: input.isAirstrip,
      portDamageBefore: input.portDamageBefore,
      aircraft: input.aircraft,
    })
    const facility: FacilityPatch = {}
    if (value.baseLevelAfter !== undefined) facility.baseLevelAfter = value.baseLevelAfter
    if (value.portDamage !== undefined) facility.portDamage = value.portDamage
    if (value.trainbustingPlaced !== undefined)
      facility.trainbustingPlaced = value.trainbustingPlaced
    return succeed(value.rule, {
      state: {
        ...state,
        outcome: { table: 'barrage-vs-facility', value },
        step: 'done',
        finished: true,
      },
      patches: [],
      facility,
      // 10.0c-A：逐机掷骰的损失结论原样上交（修前在这里被丢弃 ⇒ 格内飞机永远不会掉步）
      aircraftLossIds: (value.aircraftLosses ?? [])
        .filter((loss) => loss.stepLoss)
        .map((loss) => loss.id),
    })
  }

  /* ── 10.0a：对战斗单位 ── */
  // 解释在**掷骰步**已一次定妥（`state.outcome`），这里只做「损失分配 + 生成变更」
  if (state.outcome === undefined || state.outcome.table !== 'barrage')
    return fail('10.0a', 'barrageOutcomeNotResolved')
  const outcome = state.outcome.value

  // 损失分配（10.0a：目标玩家选择承受单位）
  const losses = [...(input.losses ?? [])]
  if (outcome.stepLosses > 0) {
    const capacity = validateBarrageLossAllocation({
      required: outcome.stepLosses,
      losses,
      eligibleUnitIds: input.eligibleUnitIds ?? [],
    })
    if (!capacity.ok) return fail('10.0a', capacity.reason ?? 'invalidLossAllocation')
  } else if (losses.length > 0) {
    return fail('10.0a', `noLossExpected:${losses.length}`)
  }

  // DG 强制作用于**该格全体战斗单位**（10.0a：表结果对战斗单位的主要目的是把它们 DG）
  const patches: BarrageUnitPatch[] = []
  if (outcome.dg) {
    for (const unitId of input.eligibleUnitIds ?? []) patches.push({ unitId, dg: true })
  }
  for (const loss of losses) {
    if (loss.steps <= 0) continue
    patches.push({ unitId: loss.unitId, steps: loss.steps })
  }

  return succeed(outcome.rule, {
    state: {
      ...state,
      losses,
      step: 'done',
      finished: true,
    },
    patches,
  })
}
