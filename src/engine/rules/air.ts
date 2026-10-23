import { rulesConstants } from '@/data'

import { airCombatLookup, airCombatLossRoll } from '../tables/air-combat'
import { succeed, type RuleOutcome } from '../result-types'
import { AIR_BASE_CAPTURE_NO_LOSS_MIN_DICE } from './combat'

/**
 * 空军（通规 OCS 14.0 / 15.0 → 专规 Smolensk 1.4 / 1.5 / 2.2 / 3.2a）
 *
 * 实现顺序遵循「通规基线 ← 专规覆盖」：
 *   1) 通规（series_rules_v43.air）：低空扫射 14.7d、空战 14.3e、防空 14.4e、
 *      空运成功 14.10d、基地 15.0b/15.1/15.2/15.3、计划空降 14.10b —— 构成默认行为；
 *   2) 专规（exclusive_rules_smolensk）覆盖上述默认：
 *      - 2.2「Red Air Force」**只针对苏联空军**：禁低空扫射 2.2a、禁计划空降 2.2b、
 *        禁反应/进击阶段任务 2.2c、早期 IL-2 单军力 2.2d；
 *      - 3.2a 轴方：天气允许时可低空扫射（axis_special.hip_shoot）。
 * 具体某型是否具备某项能力，另由 aircraft.json 的 airAbilities / specialAbilities 提供。
 */

/** 阵营 */
export type Side = 'axis' | 'soviet'

/* ── 通规常量（series_rules_v43.air） ── */
export const AIRCRAFT_STEPS = rulesConstants.air.aircraftSteps
export const REFIT_T_PER_BASE = rulesConstants.air.refitTPerBase
export const REFIT_AIRCRAFT_PER_LEVEL = rulesConstants.air.refitAircraftPerLevel
export const AIR_BASE_UNLOAD_T_PER_LEVEL_PER_PHASE = rulesConstants.air.unloadTPerLevelPerPhase
export const ACTIVE_STACKING_BASE = rulesConstants.air.activeStackingBase
export const ACTIVE_STACKING_PER_LEVEL = rulesConstants.air.activeStackingPerLevel
/**
 * 14.2a / 14.2f-B：同一次任务最多 4 个激活空军单位（来自多个基地者合计）
 *
 * 该 4 的数值在源库里只登记一次（`barrage.maxAircraftPerMission`），
 * 10.0 空军轰炸与 14.2f 任务序列共用，避免同一规则出现两个数字来源。
 */
export const AIR_MISSION_MAX_AIRCRAFT = rulesConstants.barrage.maxAircraftPerMission
export const BASE_AA_PER_LEVEL = rulesConstants.air.baseAaPerLevel
export const AIRSTRIP_AA_VALUE = rulesConstants.air.airstripAaValue
export const PARADROP_PLANNING_TURNS_ADVANCE = rulesConstants.air.paradropPlanningTurnsAdvance
export const PATROL_ZONE_MAX_HEXES = rulesConstants.air.patrolZoneMaxHexes
export const FLAK_KILL_MIN_DICE = rulesConstants.air.flakKillMinDice
export const FLAK_MODIFIERS = rulesConstants.air.flakModifiers
export const FLAK_APPLIES = rulesConstants.air.flakApplies
export const AIR_TRANSPORT_SUCCESS = rulesConstants.air.airTransportSuccess
export const AIR_COMBAT_ATTACKER_ABORT_MAX_DICE = rulesConstants.air.airCombatAttackerAbortMaxDice
export const AIR_COMBAT_BOTH_ABORT_DICE = rulesConstants.air.airCombatBothAbortDice
export const AIR_COMBAT_DEFENDER_ABORT_MIN_DICE = rulesConstants.air.airCombatDefenderAbortMinDice
export const AIR_COMBAT_LOSS_NO_LOSS_MAX_DICE = rulesConstants.air.airCombatLossNoLossMaxDice
export const AIR_COMBAT_LOSS_STEP_LOSS_MIN_DICE = rulesConstants.air.airCombatLossStepLossMinDice

/** 专规 2.2 的能力标签（aircraft.json specialAbilities 词表） */
export const AIR_SPECIAL_NO_HIP_SHOOT = 'no_hip_shoots'
export const AIR_SPECIAL_NO_REACTION_EXPLOIT_MISSION = 'no_reaction_exploit_mission'
export const AIR_SPECIAL_NO_PLANNED_AIRDROP = 'no_planned_airdrop'
export const AIR_SPECIAL_EARLY_STURMOVIK_ONE_STEP = 'early_sturmovik_one_step'

/* ── 空战（通规 14.3e） ── */

export type AirCombatResultSide = 'attacker' | 'defender' | 'both' | 'neither'

export interface ResolveAirCombatResult {
  abortSide: AirCombatResultSide
  /**
   * 14.3e-C 的损失骰结果（1–4 无损失 / 5–6 损失 1 军力）
   *
   * ★ 双方返航（修正骰 = 7）时**同样掷损失骰**：条文说的是「确定**返航的单位或单位们**
   *   是否还必须承受军力损失」，与是否分出胜负无关（规则书举例即是「双方均返航」后掷损失骰）。
   */
  winnerLossRoll?: 'no_loss' | 'step_loss'
  rawLossRoll?: number
  modifiedRoll: number
  /** 该损失骰适用于哪些返航方（`both` ⇒ 双方返航者都承受） */
  lossAppliesTo?: 'attacker' | 'defender' | 'both'
}

/** 空战修正骰 = 2d6 + 攻方空战值 − 守方空战值（14.3e） */
export function airCombatModifiedRoll(
  die: number,
  attackerACV: number,
  defenderACV: number,
): number {
  return die + attackerACV - defenderACV
}

/**
 * 空战结算（14.3e，表 17-2）
 *
 * 修正 2d6：≤6 攻方返航 / =7 双方返航 / ≥8 守方返航；
 * 随后掷 1 骰「损失」骰：1–4 无损失 / 5–6 返航者损失 1 点军力 —— **双方返航时同样适用**
 * （条文为「返航的单位或单位们」；规则书举例即「双方均返航」后掷损失骰）。
 *
 * ★ 三档阈值与损失骰的**判定只有一处**：`tables/air-combat.ts#airCombatLookup` /
 *   `airCombatLossRoll`（本函数只组装返回值，不再各写一遍比较）。
 *   此前两处各写一遍同阈值的比较——两份结论一致，但「测试测表模块、产品用 rules 那份」
 *   意味着任一处改动都不会被另一处的测试发现。
 */
export function resolveAirCombat(modifiedRoll: number, lossDie?: number): ResolveAirCombatResult {
  const tableResult = airCombatLookup(modifiedRoll)
  const abortSide: AirCombatResultSide =
    tableResult === 'attacker_aborts'
      ? 'attacker'
      : tableResult === 'both_abort'
        ? 'both'
        : 'defender'

  const result: ResolveAirCombatResult = { abortSide, modifiedRoll }
  if (lossDie !== undefined) {
    result.rawLossRoll = lossDie
    result.winnerLossRoll = airCombatLossRoll(lossDie)
    result.lossAppliesTo =
      abortSide === 'both' ? 'both' : abortSide === 'attacker' ? 'attacker' : 'defender'
  }
  return result
}

/* ── 防空（通规 14.4e） ── */

/** 可受防空影响的任务类型 */
export type AirMissionKind =
  | 'barrage'
  | 'hip_shoot'
  | 'trainbusting'
  | 'air_transport'
  | 'air_drop'
  | 'base_transfer'
  | 'fighter_sweep'
  | 'interception'

/**
 * 防空是否适用于该任务（14.4e）
 *
 * always 恒适用 / onlyInPatrolZone 仅当任务格处于敌方巡逻区内 / never 不适用。
 */
export function flakAppliesToMission(mission: AirMissionKind, inEnemyPatrolZone: boolean): boolean {
  if (FLAK_APPLIES.always.includes(mission)) return true
  if (FLAK_APPLIES.onlyInPatrolZone.includes(mission)) return inEnemyPatrolZone
  return false
}

export interface FlakDrmInput {
  /** 任务飞机数（≥3 时 +1） */
  missionAircraftCount: number
  /** 目标格内有 HQ（+1） */
  targetHasHQ: boolean
  /** 目标格空军基地等级（每级 +1；简易机场为 0） */
  airBaseLevel?: number
  /**
   * 目标格的空中设施是否为**简易机场**
   *
   * 15.2F：「它们**不能提供任何防空值**」⇒ 简易机场的防空点数为 0（`baseAaValue` 的第二个入参）。
   */
  baseIsAirstrip?: boolean
  /** 地图印刷防空值（+value；无则 0） */
  printedFlakValue?: number
  /** 是否处于敌方巡逻区内（只有在这一组修正才生效） */
  inEnemyPatrolZone: boolean
  /**
   * **任务**中是否编有战斗机（14.4e 表 17-3「Target is in Enemy PZ and…」分档）
   *
   * 英文原版图表（权威）：`+1 Mission has at least one Fighter` / `+2 Mission has no Fighters`
   * —— 分档看的是**任务编成里有没有战斗机**，不是「敌方巡逻区里有没有战斗机」。
   */
  missionHasFighter?: boolean
  /** 是否针对铁路实施 trainbusting（在敌方巡逻区内 +1，与该组其它修正**累计**） */
  trainbustingInPatrolZone?: boolean
}

/**
 * 防空修正合计（14.4e，表 17-3）
 *
 * 分组：任务 ≥3 机 +1；目标格内 HQ +1、**目标格基地的防空点数**、地图印刷防空值 +value；
 * **若目标格处于敌方巡逻区内**：任务编有战斗机 +1 / 任务无战斗机 +2，且运输破坏再 +1（累计）。
 *
 * ★ 基地那一项**不再自算** `等级 × 系数`：15.0b-B「空军基地的**防空点数**等于其**等级**」
 *   （简易机场 15.2F：不能提供任何防空值）——唯一实现在 `baseAaValue`，此处只消费它。
 *   修前这里另写了一份 `等级 × FLAK_MODIFIERS.airBaseLevelPerLevel`：两处数值当时恰好都是 1，
 *   但「简易机场为 0」这条只能由 `baseAaValue` 的第二个入参表达，改一处就会漂移。
 */
export function computeFlakDrm(input: FlakDrmInput): number {
  let drm = 0
  if (input.missionAircraftCount >= 3) drm += FLAK_MODIFIERS.missionThreePlusAircraft
  if (input.targetHasHQ) drm += FLAK_MODIFIERS.targetHasHQ
  // 15.0b-B / 15.2F：目标格基地的防空点数（唯一实现 `baseAaValue`；简易机场为 0）
  drm += baseAaValue(input.airBaseLevel ?? 0, input.baseIsAirstrip === true)
  if (input.printedFlakValue) drm += input.printedFlakValue
  if (input.inEnemyPatrolZone) {
    drm += input.missionHasFighter
      ? FLAK_MODIFIERS.inEnemyPatrolZoneWithFighter
      : FLAK_MODIFIERS.inEnemyPatrolZoneNoFighter
  }
  if (input.trainbustingInPatrolZone) drm += FLAK_MODIFIERS.trainbustingInPatrolZone
  return drm
}

/** 防空击落判定：修正 2d6 ≥ 11 击落一架任务机（14.4e） */
export function flakKillCheck(modified2d6: number): boolean {
  return modified2d6 >= FLAK_KILL_MIN_DICE
}

/* ── 空运 / 空投成功表（通规 14.10d，表 17-4） ── */

export interface AirTransportSuccessInput {
  /** **2 骰之和**（14.10d：为每个战斗单位或 1T 补给**分别**掷两枚骰子） */
  die2d6: number
  /**
   * 目标格在**本阶段开始时**是否有友方单位（表 17-4 定义）
   *
   * `true` ⇒ Friendly 列，`false` ⇒ Enemy 列。
   */
  friendly: boolean
  /**
   * 目标格地形是否为 Closed（表 17-4 定义）
   *
   * `Clear` ＝ Open 或 Village，或**任何含空军基地的格**；其余为 `Closed`。
   * 便捷判据见 `airTransportTerrainIsClosed`。
   */
  closed: boolean
  /** 苏军空投（−1，任何时间；表 17-4 DRM） */
  sovietAirdrop?: boolean
  /** 滑翔机降落（+1，14.10e-E；表 17-4 DRM） */
  glider?: boolean
  /** 可选规则 21.12e 的地形修正（Very Close −1 / Extr Close −2；见 `optionalAirdropTerrainDrm`） */
  optionalTerrainDrm?: number
}

export interface AirTransportSuccessResult {
  success: boolean
  /** 所需最低**修正后**骰值（表 17-4 的四档） */
  threshold: number
  /** 修正后骰值 */
  modified: number
  /** 本次合计的 DRM */
  drm: number
}

/**
 * 空投/空运是否成功（14.10d，表 17-4）
 *
 * 四档门槛（Friendly+Clear 5 / Friendly+Closed 6 / Enemy+Clear 6 / Enemy+Closed 7），
 * DRM 只有三项：苏军空投 −1、滑翔机 +1、可选 21.12e 的地形 −1/−2。
 * ★ 14.10d：**每个战斗单位或每 1T 补给分别掷两枚骰子** —— 故骰面是 2 骰之和，逐件调用。
 * 成功 ⇒ 该件置于空投格（其本阶段移动结束）；失败 ⇒ 被摧毁。
 */
export function resolveAirTransportSuccess(
  input: AirTransportSuccessInput,
): AirTransportSuccessResult {
  const s = AIR_TRANSPORT_SUCCESS
  const threshold = input.friendly
    ? input.closed
      ? s.friendlyClosedMin
      : s.friendlyClearMin
    : input.closed
      ? s.enemyClosedMin
      : s.enemyClearMin
  let drm = 0
  if (input.sovietAirdrop) drm += s.sovietAirdropDrm
  if (input.glider) drm += s.gliderDrm
  if (input.optionalTerrainDrm) drm += input.optionalTerrainDrm
  const modified = input.die2d6 + drm
  return { success: modified >= threshold, threshold, modified, drm }
}

/**
 * 表 17-4 的 `Clear / Closed` 判据
 *
 * 「`Clear` ＝ Open 或 Village，或**任何含空军基地的格**；否则为 `Closed`」。
 */
export function airTransportTerrainIsClosed(input: {
  /** 目标格的**格内**地形名（含 spillover 判读后的结果；只需能识别 Open / Village 两项） */
  terrainsInHex: readonly string[]
  /** 该格是否有（任意等级的）空军基地或简易机场 */
  hasAirBase: boolean
}): boolean {
  if (input.hasAirBase) return false
  return !input.terrainsInHex.some((name) => name === 'Open' || name === 'Village')
}

/**
 * 可选规则 21.12e：空投的地形 DRM（Very Close −1 / Extr Close −2）
 *
 * 默认关闭（21.x 为可选规则）——由调用方决定是否把结果传进 `resolveAirTransportSuccess`。
 */
export function optionalAirdropTerrainDrm(combatLine: string | null): number {
  const s = AIR_TRANSPORT_SUCCESS
  if (combatLine === 'Very Close') return s.optional21_12eVeryCloseDrm
  if (combatLine === 'Extr Close') return s.optional21_12eExtrCloseDrm
  return 0
}

/* ── 空军基地夺取（通规 9.14f） ── */

/** 每个空军单位掷 2d6：≥7 无损失，≤6 损失 1 军力 */
export function resolveAirBaseCapture(roll2d6: number): 'no_loss' | 'step_loss' {
  return roll2d6 >= AIR_BASE_CAPTURE_NO_LOSS_MIN_DICE ? 'no_loss' : 'step_loss'
}

/* ── 基地能力（通规 15.0b / 14.2a / 15.1） ── */

/** 基地防空值 = 等级 × BASE_AA_PER_LEVEL；简易机场固定 AIRSTRIP_AA_VALUE（15.0b） */
export function baseAaValue(level: number, isAirstrip = false): number {
  return isAirstrip ? AIRSTRIP_AA_VALUE : level * BASE_AA_PER_LEVEL
}

/** Active 堆叠上限 = ACTIVE_STACKING_BASE + 等级 × ACTIVE_STACKING_PER_LEVEL（14.2a） */
export function activeStackingLimit(level: number): number {
  return ACTIVE_STACKING_BASE + level * ACTIVE_STACKING_PER_LEVEL
}

/** 基地可整备飞机数 = 等级 × REFIT_AIRCRAFT_PER_LEVEL（15.1） */
export function refitCapacityPerLevel(level: number): number {
  return level * REFIT_AIRCRAFT_PER_LEVEL
}

/**
 * 15.0b-C / 15.2C：**每移动环节**在该格能空运卸载的 T 上限
 *
 * 原文：**15.0b-C**「每个移动环节中，只能卸载 空军基地**等级×2T** 数量的货物……」；
 * **15.2C**「（简易机场）每个移动环节中，它们的**卸载容量上限为 2T**。」
 * ⇒ 简易机场按 **1 级**计（＝2T），与 15.2C 的明示值一致；无基地/零级传 `baseLevel: 0` ⇒ 上限 0。
 */
export function airUnloadLimitT(input: { baseLevel: number; isAirstrip: boolean }): number {
  const level = input.isAirstrip ? 1 : Math.max(0, Math.trunc(input.baseLevel))
  return level * AIR_BASE_UNLOAD_T_PER_LEVEL_PER_PHASE
}

/**
 * 14.9f / 15.0b-C / 15.2C：**空运卸载的限额判定**
 *
 * 原文：**14.9f**「同一个空军基地在每个移动环节中，只能使用**空运**卸载 2T 乘上其**基地等级**的货物量。
 *   但是，如果货物超过此限额，**如果超出部分对应的运输机在目的地格变为非激活状态**，则可以卸载超额部分
 *   的货物。」**15.0b-C** 另列两条无限制：「……（**或者是空投或滑翔机行动，则无限制**）。**装载货物没有限制**。」
 *
 * 故判据三条：
 *   ① `kind === 'air_drop'`（空投，含滑翔机降落）⇒ **不设上限**；
 *   ② 空运 ⇒ 上限 `airUnloadLimitT(...)`，可用**余额**＝上限 − 本格本环节**已卸载**的 T（`usedT`）；
 *   ③ 超出余额的部分，只有在 `overLimitAircraftInactive`（该部分运输机在目的地变非激活，14.9e-A 的双程飞法）
 *      时才能一并卸下；否则**只卸余额、如实报出被拒的 T**（不静默丢弃、也不静默放行）。
 *
 * ★ 「装载货物没有限制」也在同一条里 ⇒ 本函数只管**卸载**，不参与装载。
 */
export function planAirUnload(input: {
  /** 任务类型：空投（含滑翔机）无卸载上限；空运受限 */
  kind: 'air_transport' | 'air_drop'
  /** 目的地格基地等级（简易机场传任意值，按 `isAirstrip` 记 1 级） */
  baseLevel: number
  /** 目的地格是否简易机场（15.2C） */
  isAirstrip: boolean
  /** 本格本移动环节**已**空运卸载的 T（首次传 0） */
  usedT: number
  /** 本次要卸载的 T */
  cargoT: number
  /** 14.9f 的例外：超出部分对应的运输机**在目的地格变为非激活** */
  overLimitAircraftInactive: boolean
}): RuleOutcome<{
  allowedT: number
  refusedT: number
  limitT: number | null
  rule: string
  detail: string
}> {
  const cargoT = Math.max(0, Math.trunc(input.cargoT))
  if (input.kind === 'air_drop') {
    return succeed('15.0b-C', {
      allowedT: cargoT,
      refusedT: 0,
      limitT: null,
      rule: '15.0b-C',
      detail: `空投不设卸载上限（15.0b-C）：卸载 ${String(cargoT)} T`,
    })
  }
  const limitT = airUnloadLimitT({ baseLevel: input.baseLevel, isAirstrip: input.isAirstrip })
  const remaining = Math.max(0, limitT - Math.max(0, Math.trunc(input.usedT)))
  if (cargoT <= remaining) {
    return succeed('14.9f', {
      allowedT: cargoT,
      refusedT: 0,
      limitT,
      rule: '14.9f',
      detail: `空运卸载 ${String(cargoT)} T（本格本环节已卸 ${String(input.usedT)}/${String(limitT)} T；14.9f）`,
    })
  }
  if (input.overLimitAircraftInactive) {
    return succeed('14.9f', {
      allowedT: cargoT,
      refusedT: 0,
      limitT,
      rule: '14.9f',
      detail:
        `空运卸载 ${String(cargoT)} T：超出上限 ${String(limitT)} T 的部分由**在目的地格变为非激活**的运输机` +
        `承运 ⇒ 允许一并卸载（14.9f / 14.9e-A）`,
    })
  }
  const allowedT = remaining
  return succeed('14.9f', {
    allowedT,
    refusedT: cargoT - allowedT,
    limitT,
    rule: '14.9f',
    detail:
      `空运卸载上限 ${String(limitT)} T（15.0b-C${input.isAirstrip ? ' / 15.2C' : ''}）：` +
      `本格本环节已卸 ${String(input.usedT)} T ⇒ 本次只能卸 ${String(allowedT)} T，` +
      `${String(cargoT - allowedT)} T **不能卸载**（除非承运机在目的地格变为非激活，14.9e-A）`,
  })
}

/* ── 专规覆盖（2.2 苏联 / 3.2a 轴心） ── */

const EXCLUSIVE_AIR = rulesConstants.smolensk.air

/** 任务阶段（2.2c 分别约束反应 / 进击阶段） */
export type AirMissionPhase = 'movement' | 'reaction' | 'exploitation'

/**
 * 低空扫射可用性（通规 14.7d ← 专规覆盖）
 *
 * 通规允许；专规覆盖：苏军不得执行（2.2a），轴方天气允许时可执行（3.2a）。
 *
 * ★ 口径唯一（M2⑤）：**「天气是否允许低空扫射」只有这一处实现**。天气层的
 *   `weather.ts#isHipShootAllowed` 曾另持一份只看天气的比较，二者并存 ⇒ 已删除该副本，
 *   天气那一半由本函数开头的 `if (!weatherNormal) return false` 承担。
 */
export function canHipShoot(side: Side, weatherNormal: boolean): boolean {
  if (!weatherNormal) return false
  if (side === 'soviet') return !EXCLUSIVE_AIR.soviet.noHipShoot
  return EXCLUSIVE_AIR.axis.hipShootWhenWeatherPermits
}

/**
 * 型别/阵营是否可在指定阶段执行任务（通规默认允许 ← 专规 2.2c 覆盖苏联）
 */
export function canMissionInPhase(side: Side, phase: AirMissionPhase): boolean {
  if (phase === 'movement') return true
  if (side === 'soviet') return !EXCLUSIVE_AIR.soviet.noReactionOrExploitationMission
  return true
}

/**
 * 计划空降可用性（通规 14.10b ← 专规 2.2b 覆盖苏联）
 *
 * 苏联不得执行需计划的空降；补给空投不受此限。若给出型别资料，还须该型具备空投能力。
 */
export function canPlannedAirdrop(side: Side, profile?: AircraftAirProfile): boolean {
  if (side === 'soviet' && EXCLUSIVE_AIR.soviet.noPlannedAirdrop) return false
  if (profile && profile.airAbilities?.canAirDrop === false) return false
  return true
}

/**
 * 空军型别的最小能力视图（对应 aircraft.json 的 airAbilities / specialAbilities 子集）
 */
export interface AircraftAirProfile {
  readonly airAbilities?: {
    readonly canHipShoot?: boolean | null
    readonly missionInReactionPhase?: boolean | null
    readonly missionInExploitationPhase?: boolean | null
    readonly canAirDrop?: boolean | null
  } | null
  readonly specialAbilities?: readonly string[] | null
}

/** 是否为早期 IL-2（仅单军力，专规 2.2c；由型别数据标记） */
export function isEarlySturmovikOneStep(profile: AircraftAirProfile): boolean {
  return (profile.specialAbilities ?? []).includes(AIR_SPECIAL_EARLY_STURMOVIK_ONE_STEP)
}
