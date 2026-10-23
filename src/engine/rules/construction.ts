import { rulesConstants } from '@/data'
import type { HexRef, Side } from '@/data'

import { HEX_DIRECTIONS, neighbor } from '../hex-geometry'
import { fail, succeed, type RuleFailure, type RuleOutcome } from '../result-types'
import type { GamePhase } from '../state-types'
import { isPrintedHedgehogPermanent } from './hedgehog'
import type { MapFacts } from './move-types'
import type { BaseMode } from './modes'
import { selectMovementTerrain, type HexsideCrossing, type MobilityType } from './terrain'

/**
 * 建设与设施（B17，OCS 13.0 / 13.8 / 15.2–15.4 / 16.0；Smolensk 专规 1.3 / 2.3e / 3.5）
 *
 * 本模块覆盖**特殊单位与设施的作业面**：工程能力（13.8a）、架桥（13.8b）、建造（13.8d）、
 * 环形工事的修建与缩减（16.0b/c）、空军基地的修建与改进（15.3）、简易机场（15.2），
 * 以及 Smolensk 专规的印刷永久工事（1.3a）、工事等级上限（1.3b）、苏军禁建期（2.3e）与建造标记（3.5）。
 *
 * ## 条文要点（逐句落实现）
 *   - **13.8a**「指挥部或工程兵必须处于**战斗模式**，或处于 DG 模式并**朝向战斗模式面**（5.10e），
 *     才能被视为具有工程能力。」→ 判定复用 `modes.canEngineer`（唯一实现），本模块只消费结论。
 *   - **13.8b 架桥**「当与一个大河相邻时，具有工程能力的单位会自动将大河格边的 MP 消耗降至小河格边的
 *     MP 消耗。同样……将小河格边降级为『无额外消耗』。只有友方单位移动**进入或离开**工程能力单位所在格时，
 *     移动消耗才能降低。」「攻击单位不能使用架桥能力跨越格边来**过河突袭**。」「架桥对战斗地形效果没有影响，
 *     但在没有桥就无法攻击的情况下，可通过架桥能力而允许发动攻击。」「当单位不再具备工程能力时，架的桥就会
 *     消失。（例外：具有工程能力的单位在通过切换模式或朝向而失去工程能力后，可以使用自己架的桥离开该格。）」
 *   - **13.8d 建造**「在**移动阶段**中（仅限移动阶段），具有工程能力的单位可在**半径为 2 格**的范围内进行建造
 *     （**无视敌方 ZOC**，但地形效果会影响这 2 格的长度计算，**以步行 MP 计算**）……具有工程能力的单位在它
 *     执行建造的阶段中**不能移动**。」「只能在一个格内进行建造，而且只能进行**一种类型**的建造。」
 *     「所有修建/改进/修理任务都需要消耗 SP。而缩减/伤害任务则是**免费**的。」「建造是**立即起效**的。」
 *     ★ 口径（用户 2026-09-15 裁定）：这 2 格**一律按步行价目量**——它是**专门针对工程能力**的限制，
 *       与 6.2「按**该单位自身**机动类型取费」是两套口径；故 `legMpDistanceWithinRadius` **不接受**
 *       调用方注入机动类型（`CONSTRUCTION_WALKING_MOBILITY`）。
 *   - **16.0b 修建**「环形工事只能在**移动阶段**中修建或改进。需要处于**战斗模式的 1RE 的单位**，且**不能移动**，
 *     才能在**自己所在格**修建或改进一个等级的环形工事。一个具有工程能力的单位也可以完成这项工作（13.8d）。
 *     修建和改进的消耗为 **2SP**。」「同一个格中的环形工事**每回合最多提升一级**。」
 *     ★ 判读（用户 2026-09-13 裁定）：「1RE 的单位」＝**在目标格内被指定执行作业的那一小队单位**（堆叠的
 *       子集，RE **合计 ≥ 1**）；作业后**只有这批被指定的单位**本阶段不能再移动，格内其余单位照常行动。
 *   - **16.0c 缩减**「环形工事只能在移动阶段内降低等级。需要处于战斗模式的 1RE 的单位，且不能移动，才能将一个
 *     环形工事降低一个等级。一个具有工程能力单位也可以完成这项工作（13.8d）。缩减工事**无需消耗 SP**。」
 *     「每回合最多降低一个等级。」「如果环形工事的等级降低后**小于 1 级，则将它移除**。」
 *   - **15.3 修建空军基地**「只能在移动阶段中修建或改进，而且只能由**具备工程能力的单位**执行修建（13.8d）。
 *     费用为 **1SP**。」「等级**每回合只能提升一级**。」「永远无法改进大于**三级**。」
 *   - **15.2 简易机场** A) 按 15.3 的流程，建造费用为 **1T**；可支付 **3T** 升级为一级空军基地。
 *     E) 永远不会因伤害而缩减降级，也**不能被玩家自愿缩减降级**（→ 本模块不提供简易机场的缩减入口）。
 *   - **专规 1.3a**「地图上印刷有一些环形工事（OCS 16.0），它们**永久存在且不可降低**。」
 *   - **专规 1.3b**「任何一方都**永远不能**把环形工事改进到 **1 级**以上。」（覆盖 16.0a 的 4 级刻度）
 *   - **专规 2.3e**「苏军单位在 **8 月 1 日**回合之前不能修建环形工事……」
 *   - **专规 3.5 建造标记**「可在任意轴方移动阶段、**单位移动之前**使用，把两面之一放进一个有**轴方战斗单位**的格。
 *     这是**免费**的（不耗补给）。」「作为**桥**时按 OCS 13.8b 的 HQ 架桥处理；作为**简易机场**时按 OCS 15.2 的
 *     标准简易机场处理。」「桥与简易机场**不能移动**。」「**只**在苏方战斗单位进入其格时被摧毁。**不可重建**。」
 *
 * ## 明确不由本模块负责（避免重复实现）
 *   - **15.4 空军基地缩减**：已实现在 `air-mission.ts#canReduceAirBase`（含 15.0c 的 Level-1 下限与每阶段一次）；
 *   - **10.0c 对设施轰炸**：已实现在 `barrage.ts#resolveFacilityOutcome`（含 15.2E：简易机场永不被击降级）；
 *   - **4.8 / 15.0a / 16.0g 每格至多 1 个港口/空军基地/环形工事**：已实现在 `legality.ts`（stacking 族）；
 *   - **9.14e/f 工事与空军基地的夺取**：已实现在 `special-combat.ts`；
 *   - **13.8c 创建火车卸货格**：属铁路子系统，见 `rail.ts` 与 `trace-supply.ts` 的 detrainable 事实。
 */

/* ────────────────────────────── 常量 ────────────────────────────── */

/**
 * 环形工事可建最高等级（专规 1.3b：**1**）
 *
 * 通规 16.0a 的刻度是「无 → Level-1 … Level-4」，但本作 1.3b 明令「任何一方都永远不能把环形工事改进到
 * 1 级以上」——故**生效上限**取专规值（数据在 rules-constants.json 的 construction.hedgehogMaxLevel，
 * 其注释记录了这次覆盖）。因此本作不会出现 Level-2/3/4 的工事（它们只出现在 10.0a 的通用判据里）。
 */
export const HEDGEHOG_MAX_LEVEL = rulesConstants.construction.hedgehogMaxLevel

/** 环形工事：每级 2 SP（16.0b） */
export const HEDGEHOG_COST_SP_PER_LEVEL = rulesConstants.construction.hedgehogCostSpPerLevel

/** 环形工事：每格每回合 ±1 级（16.0b / 16.0c） */
export const HEDGEHOG_LEVELS_PER_TURN = rulesConstants.construction.hedgehogLevelsPerTurn

/** 地图印刷永久工事等级（专规 1.3a：永久且不可降低） */
export const PRINTED_HEDGEHOG_LEVEL = rulesConstants.construction.printedHedgehogLevel

/** 空军基地最高等级 3（15.3：永远无法改进大于三级） */
export const AIR_BASE_MAX_LEVEL = rulesConstants.construction.airBaseMaxLevel

/** 空军基地最低等级 1（15.0c / 15.4：任何空军基地不得低于 1 级） */
export const AIR_BASE_MIN_LEVEL = rulesConstants.construction.airBaseMinLevel

/** 空军基地修建：每级 1 SP（15.3） */
export const AIR_BASE_COST_SP_PER_LEVEL = rulesConstants.construction.airBaseCostSpPerLevel

/** 空军基地：每回合最多 +1 级（15.3） */
export const AIR_BASE_LEVELS_PER_TURN = rulesConstants.construction.airBaseLevelsPerTurn

/** 简易机场修建：1 T（15.2A） */
export const AIRSTRIP_BUILD_T = rulesConstants.construction.airstripBuildT

/** 简易机场升级为一级空军基地：3 T（15.2A） */
export const AIRSTRIP_UPGRADE_T = rulesConstants.construction.airstripUpgradeT

/** 简易机场每整备阶段只能整备 1 架（15.2B） */
export const AIRSTRIP_REFIT_AIRCRAFT = rulesConstants.construction.airstripRefitAircraft

/** 工程作业半径：2 格（13.8d；地形按**步行 MP** 计，无视敌方 ZOC） */
export const CONSTRUCTION_RADIUS_HEXES = rulesConstants.construction.constructionRadiusHexes

/**
 * 施工执行者的最低 **RE 合计**（16.0b/c、15.4 的「1 RE 的单位」）
 *
 * ★ 判读口径（用户 2026-09-13 裁定）：条文说的「1RE 的单位」指的是**在目标格内被指定执行本任务的
 *  那一小队单位**——它们是格内堆叠的**子集**，其 RE **合计 ≥ 1** 即可，而不是整格全部单位、也不是
 *  要求某一个单位自身刚好 1 RE。**多不退、少必须补**：选够 1 RE 即可，多选无妨，不足 1 RE 则必须再补。
 *  例：同格两个 0.5 RE 营 + 一个 4 RE 师 ⇒ 单选师、单派两个营、或全选**皆可**；只选一个营则不行。
 *  作业后**只有这批被指定的单位**在本阶段不能再移动，格内其余单位照常行动
 *  （两个 4RE 师同格，只派其一动手 ⇒ 该师不能移动，另一师照常）。
 * 具工程能力者可**替代**该资格（13.8d）。
 */
export const CONSTRUCTION_MIN_BUILDER_RE = rulesConstants.construction.minBuilderRe

/** 苏军可建环形工事的起始日（专规 2.3e：1941-08-01 回合之前不可修建） */
export const SOVIET_HEDGEHOG_BUILD_FROM = rulesConstants.smolensk.sovietHedgehogBuildFrom

/** 轴方建造标记的初设枚数（专规 3.5：剧本 1/2 各 3 枚） */
export const CONSTRUCTION_MARKERS_PER_SETUP = rulesConstants.smolensk.constructionMarkersPerSetup

/* ────────────────────────────── 13.8d 建造作业的公共前提 ────────────────────────────── */

/**
 * 13.8d 的建造任务类型
 *
 * 用于「只能进行一种类型的建造」的判定，也用于区分付费/免费任务（13.8d 末段）。
 */
export type ConstructionTask =
  | 'buildHedgehog'
  | 'reduceHedgehog'
  | 'buildAirBase'
  | 'improveAirBase'
  | 'reduceAirBase'
  | 'buildAirstrip'
  | 'upgradeAirstrip'
  | 'repairPort'
  | 'damagePort'

/** 13.8d：任务分「修建/改进/修理」（耗 SP）与「缩减/伤害」（免费）两类 */
const FREE_TASKS: readonly ConstructionTask[] = ['reduceHedgehog', 'reduceAirBase', 'damagePort']

/**
 * 13.8d：该任务是否**消耗 SP**
 *
 * 「所有修建/改进/修理任务都需要消耗 SP。而缩减/伤害任务则是免费的。」
 */
export function constructionTaskCostsSp(task: ConstructionTask): boolean {
  return !FREE_TASKS.includes(task)
}

/** 13.8d 的建造前提（调用方给出的事实） */
export interface ConstructionContext {
  /** 2.2：建造只能在**移动阶段**（13.8d） */
  phase: GamePhase
  /** 13.8a：工程能力（战斗模式，或 DG 但朝向战斗面；判定见 `modes.canEngineer`） */
  engineerCapable: boolean
  /** 13.8d：执行者在本阶段是否已移动（「在它执行建造的阶段中不能移动」） */
  movedThisPhase: boolean
  /** 13.8d：执行者本阶段已施工的**格数**（「只能在一个格内进行建造」） */
  hexesThisPhase: number
  /** 13.8d：本次要执行的建造类型 */
  task: ConstructionTask
  /** 13.8d：执行者本阶段已执行过的建造类型（未执行则 null） */
  previousTaskThisPhase: ConstructionTask | null
}

/**
 * 13.8d：建造作业的公共前提校验
 *
 * 返回 `null` 表示通过；否则为 `{ rule: '13.8d', reason }` 形式的失败。
 * 通过后再按任务分别校验（16.0b/c、15.2、15.3）与**目标格半径**（见 `withinConstructionRange`）。
 */
export function validateConstructionBase(input: ConstructionContext): RuleFailure | null {
  if (input.phase !== 'movement') return fail('13.8d', 'constructionOnlyInMovementPhase')
  if (!input.engineerCapable) return fail('13.8a', 'requiresEngineerCapability')
  if (input.movedThisPhase) return fail('13.8d', 'builderMovedThisPhase')
  if (input.hexesThisPhase >= 1) return fail('13.8d', 'oneHexPerPhase')
  if (input.previousTaskThisPhase !== null && input.previousTaskThisPhase !== input.task)
    return fail('13.8d', 'oneTaskTypePerPhase')
  return null
}

/**
 * 13.8d：目标格是否在**2 格半径**内
 *
 * 「地形效果会影响这 2 格的长度计算，**以步行 MP 计算**」⇒ 调用方须以**步行 MP** 量出距离
 * （不是格数直线距离），并**无视敌方 ZOC**；本函数只按全局常量（`constructionRadiusHexes`）比较。
 * 距离的量取见 `legMpDistanceWithinRadius`（唯一实现：无 ZOC 的地形取费最短路，**固定步行价目**——
 * 用户 2026-09-15 裁定：这是**专门针对工程能力**的限制，与执行者自身机动类型无关）。
 */
export function withinConstructionRange(input: { legMpDistance: number }): boolean {
  return input.legMpDistance <= CONSTRUCTION_RADIUS_HEXES
}

/**
 * 13.8d 的量取口径：**步行 MP**（用户 2026-09-15 裁定）
 *
 * 「13.8d 的 2 格步行 MA 是**专门针对工程能力**的限制，和其它的不一样」——即这 2 格长度
 * **一律按步行（leg）价目量**，与 6.2「按**该单位自身**机动类型取费」是两套口径：
 * 轮式/履带工程单位在林地等地形的 2 格半径，按步行价目算（该收多少就是多少），
 * **不**因为自己是轮式就变便宜或变贵。
 *
 * ★ 唯一实现：`legMpDistanceWithinRadius` 内部只用它，调用方**没有**注入机动类型的入口
 *   （修前该函数收 `mobility: MobilityType`，store 传的是执行者朝向面的机动类型 ⇒ 口径错）。
 */
export const CONSTRUCTION_WALKING_MOBILITY: MobilityType = 'leg'

/** 13.8d 步行 MP 距离的量取输入 */
export interface LegMpRangeInput {
  /** 地图事实（与移动同一来源，保证「能走到的格」与「能建的格」同判据） */
  map: MapFacts
  /** 执行者所在格（半径的圆心） */
  from: HexRef
  /** 目标格 */
  to: HexRef
}

/**
 * 13.8d：**步行 MP** 距离（无视敌方 ZOC）
 *
 * 条文：「具有工程能力的单位可在**半径为 2 格**的范围内进行建造（**无视敌方 ZOC**，但**地形效果
 * 会影响这 2 格的长度计算，以步行 MP 计算**）」。
 *
 * 故本函数只做一件事：从执行者所在格出发，按**步行价目**的地形取费（`selectMovementTerrain`，
 * 与 6.2 移动同源，机动类型固定为 `CONSTRUCTION_WALKING_MOBILITY`）求到目标格的**最小 MP 和**，
 * 返回该值；`withinConstructionRange` 再与半径比较。
 * 与普通移动的三点不同（都是条文明确要求的）：
 *   - **无视敌方 ZOC**（4.5a-A 的强制停止不施加）；
 *   - **不施加 MA 预算**（13.8d 的半径不是「走得动」而是「够得着」）；
 *   - **不施加 6.1c 最小移动**（半径内不足 1 MP 的格也够得着）。
 * 唯一保留的限制是「禁入地形不可穿越」——它是地形本身不可进入（6.2c），不是预算。
 *
 * 返回 `null` 表示**在半径内不可达**（含被禁入地形完全隔断的情形）。
 */
export function legMpDistanceWithinRadius(input: LegMpRangeInput): number | null {
  if (!input.map.onMap(input.from) || !input.map.onMap(input.to)) return null
  const keyOf = (hex: HexRef): string => `${hex.col}.${hex.row}`
  const target = keyOf(input.to)
  const best = new Map<string, number>([[keyOf(input.from), 0]])

  /*
   * 只保留「已耗 MP ≤ 半径」的节点，故无需优先队列：一次宽度扩展 + 松弛即可
   * （取费为正且 ≤ 半径，层数天然有界）。
   */
  let frontier: HexRef[] = [input.from]
  while (frontier.length > 0) {
    const next: HexRef[] = []
    for (const hex of frontier) {
      const spent = best.get(keyOf(hex)) ?? 0
      for (const direction of HEX_DIRECTIONS) {
        const step = neighbor(hex, direction)
        if (!input.map.onMap(step)) continue
        const crossing = input.map.crossingBetween(hex, step)
        const terrain = selectMovementTerrain({
          terrainsPresent: input.map.terrainsAt(step),
          // 13.8d：一律按**步行**价目量（与执行者自身机动类型无关）
          mobility: CONSTRUCTION_WALKING_MOBILITY,
          crossing,
          // 6.2a：沿连续道路移动付道路费率（道路是地形效果的一种，按条文计入）
          followingRoad: crossingCarriesRoute(crossing),
          forOverrun: false,
        })
        // 禁入地形（6.2c）：这一步走不过去 ⇒ 该方向不扩展
        if (!terrain.ok) continue
        /*
         * TEC 的 **All**（步兵过大河，6.1c）：该步把**全部剩余 MP** 用尽 ⇒ 在此处量成「整个半径」，
         * 即：跨大河的邻格算得到（1 格 ⇐ 2 MP 的限额刚好够），但**不能**再由它往外扩展
         * （再走一步就要超过 2 格的长度）。不这样收口就等于让步兵借大河把半径凭空拉长。
         */
        const stepCost = terrain.spendsAllMp ? CONSTRUCTION_RADIUS_HEXES : terrain.totalMp
        const total = spent + stepCost
        if (total > CONSTRUCTION_RADIUS_HEXES) continue
        const key = keyOf(step)
        const known = best.get(key)
        if (known !== undefined && known <= total) continue
        best.set(key, total)
        next.push(step)
      }
    }
    frontier = next
  }

  const distance = best.get(target)
  return distance === undefined ? null : distance
}

/** 6.2a 的判据：本步格边是否承载道路/铁路（承载即沿路取费） */
function crossingCarriesRoute(crossing: HexsideCrossing | null): boolean {
  return (crossing?.routes ?? []).length > 0
}

/* ────────────────────────────── 施工执行者（16.0b/c、15.4 的两条途径） ────────────────────────────── */

/** 16.0b/c：被指定执行施工的**作业单位**（格内堆叠的一支分队） */
export interface ConstructionWorker {
  id: string
  /** 4.6：团级当量（作业单位的 RE **合计**须 ≥ `CONSTRUCTION_MIN_BUILDER_RE`） */
  re: number
  /** 16.0b/c：该单位须处于**战斗模式** */
  mode: BaseMode
  /** 16.0b/c：「且不能移动」——被指定的单位须**本阶段未移动** */
  movedThisPhase: boolean
}

/**
 * 施工执行者的两条途径
 *
 * ① **目标格内指定的一小队单位**（16.0b/c 的「1RE 的单位」）：其 RE **合计 ≥ 1**、每员都处于战斗模式、
 *    且本阶段未移动。★ 只有这批**被指定的单位**作业后不能再移动，格内其余单位照常行动。
 * ② 一个**具工程能力的单位**按 13.8d 在 2 格半径内施工（13.8d：该单位在执行建造的阶段中不能移动）。
 */
export type ConstructionExecutor =
  | {
      kind: 'inPlaceUnits'
      /** 16.0b/c：在目标格内**指定执行本任务**的单位（可只取格内一部分单位） */
      units: readonly ConstructionWorker[]
    }
  | {
      kind: 'engineer'
      /** 13.8a：工程能力 */
      engineerCapable: boolean
      /** 13.8d：执行者的单位 id（它在执行建造的阶段中不能移动） */
      unitId: string
      /** 13.8d：该执行者本阶段是否已移动 */
      movedThisPhase: boolean
      /** 13.8d：目标格到执行者的**步行 MP** 距离（无视敌方 ZOC） */
      legMpDistanceToTarget: number
    }

/** 执行者校验结论：成功时给出「作业后本阶段不能再移动」的单位名单 */
export type ExecutorVerdict = RuleOutcome<{ immobileUnitIds: string[] }>

/** 按执行者途径校验资格（不检查阶段/一格一任务——那些在 `validateConstructionBase`） */
function checkExecutor(executor: ConstructionExecutor): ExecutorVerdict {
  if (executor.kind === 'inPlaceUnits') {
    if (executor.units.length === 0) return fail('16.0b', 'noOperatingUnits')
    // 16.0b/c：「且不能移动」——被指定的单位**逐员**须本阶段未移动
    const moved = executor.units.find((unit) => unit.movedThisPhase)
    if (moved !== undefined) return fail('16.0b', `operatingUnitAlreadyMoved:${moved.id}`)
    // 16.0b/c：须**逐个**处于战斗模式（同格可因多个模式标记而混合模式，见 4.8b）
    const notCombat = executor.units.find((unit) => unit.mode !== 'combat')
    if (notCombat !== undefined)
      return fail('16.0b', `operatingUnitMustBeCombatMode:${notCombat.id}`)
    // 16.0b/c：被指定单位的 RE **合计** ≥ 1（不是整格合计）
    const totalRe = executor.units.reduce((sum, unit) => sum + unit.re, 0)
    if (totalRe < CONSTRUCTION_MIN_BUILDER_RE)
      return fail('16.0b', `operatingUnitsReBelowMinimum:${totalRe}`)
    // ★ 只有被指定的单位受「本阶段不能再移动」的约束
    return succeed('16.0b', { immobileUnitIds: executor.units.map((unit) => unit.id) })
  }
  // 13.8a / 13.8d：工程能力 + 2 格半径 + 不可移动
  if (!executor.engineerCapable) return fail('13.8a', 'requiresEngineerCapability')
  if (executor.movedThisPhase) return fail('13.8d', 'builderMovedThisPhase')
  if (!withinConstructionRange({ legMpDistance: executor.legMpDistanceToTarget }))
    return fail(
      '13.8d',
      `targetBeyondConstructionRadius:${executor.legMpDistanceToTarget}>${CONSTRUCTION_RADIUS_HEXES}`,
    )
  return succeed('13.8d', { immobileUnitIds: [executor.unitId] })
}

/* ────────────────────────────── 16.0b / 16.0c 环形工事 ────────────────────────────── */

/** 目标格的工事状态（16.0b/c 的逐格计数） */
export interface HedgehogHexState {
  /** 当前等级（0 = 无工事；含印刷工事） */
  level: number
  /** 专规 1.3a：该格是否为**印刷永久工事**（永久且不可降低） */
  isPrintedPermanent: boolean
  /** 本回合该格**已提升**的级数（16.0b：每回合最多 +1） */
  levelsBuiltThisTurn: number
  /** 本回合该格**已降低**的级数（16.0c：每回合最多 −1） */
  levelsReducedThisTurn: number
}

/** 环形工事修建/改进结论 */
export interface HedgehogBuildResult {
  /** 16.0b：消耗 SP（= HEDGEHOG_COST_SP_PER_LEVEL） */
  costSp: number
  /** 修建后的等级 */
  levelAfter: number
  /**
   * 16.0b：执行本作业、因而**本阶段不能再移动**的单位名单
   *
   * ★ 仅这些单位受约束——格内**未被指定**的其余单位照常行动（用户 2026-09-13 裁定）。
   */
  immobileUnitIds: string[]
  rule: string
  detail: string
}

/**
 * 16.0b：环形工事**修建/改进**（+1 级）
 *
 * 硬条件：移动阶段（13.8d，由 `validateConstructionBase` 判）；执行者合格（16.0b 的**目标格内指定的一小队
 * 单位**——RE 合计 ≥ 1 且逐员处于战斗模式；或 13.8d 的具工程能力单位）；该格本回合未提升过；
 * 未达上限（**专规 1.3b：1 级**）；**苏方在专规 2.3e 的起始日之前不得修建**；SP 足够（2 SP/级）。
 */
export function planHedgehogBuild(input: {
  side: Side
  /** 2.2：当前日期（专规 2.3e 的闸门） */
  date: string
  executor: ConstructionExecutor
  hex: HedgehogHexState
  /** 可动用的 SP */
  availableSp: number
}): RuleOutcome<HedgehogBuildResult> {
  if (input.hex.levelsBuiltThisTurn >= HEDGEHOG_LEVELS_PER_TURN)
    return fail('16.0b', 'hedgehogAlreadyImprovedThisTurn')
  if (input.hex.level >= HEDGEHOG_MAX_LEVEL)
    return fail('16.0b', `hedgehogAtMaxLevel:${HEDGEHOG_MAX_LEVEL}`)
  // 专规 2.3e：苏军 8 月 1 日回合之前不能修建环形工事
  if (input.side === 'soviet' && input.date < SOVIET_HEDGEHOG_BUILD_FROM)
    return fail('专规 2.3e', `sovietCannotBuildHedgehogBefore:${SOVIET_HEDGEHOG_BUILD_FROM}`)

  const verdict = checkExecutor(input.executor)
  if (!verdict.ok) return verdict

  const costSp = HEDGEHOG_COST_SP_PER_LEVEL
  if (input.availableSp < costSp) return fail('16.0b', `insufficientSpForHedgehog:${costSp}`)

  const levelAfter = input.hex.level + 1
  return succeed('16.0b', {
    costSp,
    levelAfter,
    immobileUnitIds: verdict.data.immobileUnitIds,
    rule: '16.0b',
    detail:
      `修建/改进环形工事至 ${levelAfter} 级（16.0b：${costSp} SP；每格每回合最多 +1 级；` +
      `本作上限 ${HEDGEHOG_MAX_LEVEL} 级，专规 1.3b）；` +
      `本阶段不能再移动：${verdict.data.immobileUnitIds.join('、')}`,
  })
}

/** 环形工事缩减结论 */
export interface HedgehogReduceResult {
  /** 16.0c：缩减免费 */
  costSp: number
  /** 缩减后的等级（0 表示**该工事被移除**） */
  levelAfter: number
  /** 是否因降到 1 级以下而移除（16.0c 末句） */
  removes: boolean
  /** 16.0c：执行本作业、因而**本阶段不能再移动**的单位名单（仅这些单位受约束） */
  immobileUnitIds: string[]
  rule: string
  detail: string
}

/**
 * 16.0c：环形工事**缩减**（−1 级）
 *
 * 硬条件：移动阶段；执行者合格（同上两条途径）；该格本回合未降低过；该格**有**工事；
 * ★ **专规 1.3a：印刷永久工事不可降低**。「如果环形工事的等级降低后小于 1 级，则将它移除。」缩减**不耗 SP**。
 */
export function planHedgehogReduce(input: {
  executor: ConstructionExecutor
  hex: HedgehogHexState
}): RuleOutcome<HedgehogReduceResult> {
  // ★ 专规 1.3a：印刷在地图上的工事永久存在且不可降低
  if (input.hex.isPrintedPermanent)
    return fail('专规 1.3a', 'printedPermanentHedgehogCannotBeReduced')
  if (input.hex.level < 1) return fail('16.0c', 'noHedgehogInHex')
  if (input.hex.levelsReducedThisTurn >= HEDGEHOG_LEVELS_PER_TURN)
    return fail('16.0c', 'hedgehogAlreadyReducedThisTurn')

  const verdict = checkExecutor(input.executor)
  if (!verdict.ok) return verdict

  const levelAfter = input.hex.level - 1
  const removes = levelAfter < 1
  return succeed('16.0c', {
    // 16.0c：缩减工事无需消耗 SP
    costSp: 0,
    levelAfter: removes ? 0 : levelAfter,
    removes,
    immobileUnitIds: verdict.data.immobileUnitIds,
    rule: '16.0c',
    detail: removes
      ? `环形工事降至 1 级以下 ⇒ 移除（16.0c；免费）；本阶段不能再移动：${verdict.data.immobileUnitIds.join('、')}`
      : `环形工事缩减至 ${levelAfter} 级（16.0c：免费；每格每回合最多 −1 级）；` +
        `本阶段不能再移动：${verdict.data.immobileUnitIds.join('、')}`,
  })
}

/* ────────────────────────────── 15.3 空军基地修建 / 改进 ────────────────────────────── */

/** 空军基地修建结论 */
export interface AirBaseBuildResult {
  costSp: number
  levelAfter: number
  rule: string
  detail: string
}

/**
 * 15.3：**修建/改进**空军基地（+1 级）
 *
 * 「只能在移动阶段中修建或改进，而且只能由**具备工程能力的单位**执行修建（13.8d）。费用为 **1SP**。」
 * 「等级每回合只能提升一级。」「永远无法改进大于**三级**。」
 *
 * ★ 与 16.0b 的差别：空军基地**没有**「目标格内指定单位」这条途径，只能由具工程能力的单位（13.8d）施工。
 */
export function planAirBaseBuild(input: {
  executor: Extract<ConstructionExecutor, { kind: 'engineer' }>
  /** 目标格当前基地等级（0 = 尚无基地） */
  currentLevel: number
  /** 本回合该格**已提升**的级数（15.3：每回合 +1） */
  levelsBuiltThisTurn: number
  /** 可动用的 SP */
  availableSp: number
}): RuleOutcome<AirBaseBuildResult> {
  if (input.currentLevel >= AIR_BASE_MAX_LEVEL)
    return fail('15.3', `airBaseAtMaxLevel:${AIR_BASE_MAX_LEVEL}`)
  if (input.levelsBuiltThisTurn >= AIR_BASE_LEVELS_PER_TURN)
    return fail('15.3', 'airBaseAlreadyImprovedThisTurn')

  const executorFailure = checkExecutor(input.executor)
  if (!executorFailure.ok) return executorFailure

  const costSp = AIR_BASE_COST_SP_PER_LEVEL
  if (input.availableSp < costSp) return fail('15.3', `insufficientSpForAirBase:${costSp}`)

  const levelAfter = input.currentLevel + 1
  return succeed('15.3', {
    costSp,
    levelAfter,
    rule: '15.3',
    detail:
      `空军基地${input.currentLevel === 0 ? '新建' : '改进'}至 ${levelAfter} 级` +
      `（15.3：${costSp} SP/级；每回合 +1 级；上限 ${AIR_BASE_MAX_LEVEL} 级）`,
  })
}

/* ────────────────────────────── 15.2 简易机场 ────────────────────────────── */

/**
 * 15.2A：**修建**简易机场（1 T）
 *
 * 「按照 15.3 中的流程，它们的建造费用为 1T」⇒ 时机与执行者与 15.3 相同（移动阶段、具工程能力单位）。
 */
export function planAirstripBuild(input: {
  executor: Extract<ConstructionExecutor, { kind: 'engineer' }>
  /** 该格是否已有设施（简易机场或空军基地）——一格至多一个（4.8 / 15.0a） */
  hexHasAirFacility: boolean
  /** 可动用的 T */
  availableT: number
}): RuleOutcome<{ costT: number; rule: string; detail: string }> {
  if (input.hexHasAirFacility) return fail('4.8', 'airFacilityPerHexLimit')
  const executorFailure = checkExecutor(input.executor)
  if (!executorFailure.ok) return executorFailure
  if (input.availableT < AIRSTRIP_BUILD_T)
    return fail('15.2A', `insufficientTForAirstrip:${AIRSTRIP_BUILD_T}`)
  return succeed('15.2A', {
    costT: AIRSTRIP_BUILD_T,
    rule: '15.2A',
    detail: `修建简易机场（15.2A：${AIRSTRIP_BUILD_T} T；每整备阶段仅整备 ${AIRSTRIP_REFIT_AIRCRAFT} 架，15.2B）`,
  })
}

/**
 * 15.2A：**升级**简易机场为一级空军基地（3 T）
 */
export function planAirstripUpgrade(input: {
  executor: Extract<ConstructionExecutor, { kind: 'engineer' }>
  /** 该格是否确为简易机场（升级的前提） */
  hexHasAirstrip: boolean
  /** 可动用的 T */
  availableT: number
}): RuleOutcome<{ costT: number; levelAfter: number; rule: string; detail: string }> {
  if (!input.hexHasAirstrip) return fail('15.2A', 'noAirstripToUpgrade')
  const executorFailure = checkExecutor(input.executor)
  if (!executorFailure.ok) return executorFailure
  if (input.availableT < AIRSTRIP_UPGRADE_T)
    return fail('15.2A', `insufficientTForAirstripUpgrade:${AIRSTRIP_UPGRADE_T}`)
  return succeed('15.2A', {
    costT: AIRSTRIP_UPGRADE_T,
    // 15.2A：升级为**一级**空军基地
    levelAfter: AIR_BASE_MIN_LEVEL,
    rule: '15.2A',
    detail: `简易机场升级为一级空军基地（15.2A：${AIRSTRIP_UPGRADE_T} T）`,
  })
}

/** 15.2E：简易机场**永远不能**被（伤害或玩家）缩减降级 —— 供命令层拒绝任何缩减入口 */
export function canReduceAirstrip(): false {
  return false
}

/* ────────────────────────────── 13.8b 架桥 ────────────────────────────── */

/** 13.8b：架桥把格边河流**降一级** 的映射（大河→小河、小河→无额外消耗） */
const BRIDGED_RIVER: Record<string, string | null> = {
  'Major River': 'Minor River',
  'Minor River': null,
}

/**
 * 13.8b：**架桥**对格边的影响
 *
 * 「当与一个大河相邻时，具有工程能力的单位会自动将大河格边的 MP 消耗降至小河格边的 MP 消耗。同样……
 *   将小河格边降级为『无额外消耗』。**只有友方单位移动进入或离开工程能力单位所在格时**，移动消耗才能降低。」
 *   - 故调用方只在「本步穿越**工程能力单位所在格**的格边」时传 `touchesEngineerHex: true`；
 *   - 「攻击单位不能使用架桥能力跨越格边来**过河突袭**」⇒ `forOverrun: true` 时**不做降级**；
 *   - 「架桥对**战斗地形效果**没有影响，但在没有桥就无法攻击的情况下，可通过架桥能力而**允许发动攻击**」⇒
 *     本函数只改移动取费用的 crossing；把它交给 `selectMovementTerrain` / `canEnterForCombat` 即可同时满足
 *     9.1f 的「能进入才可攻击」，而战斗表的列位仍按原 crossing 查 `facts.hexTerrainsAt`。
 *   - 「当单位不再具备工程能力时，架的桥就会消失。（例外：具有工程能力的单位在通过切换模式或朝向而失去工程
 *     能力后，可以**使用自己架的桥离开该格**。）」⇒ `bridgePresent` 由调用方按此例外给出（单位自身离开该格时，
 *     即使此刻已失去工程能力，仍可用**自己架的**桥）。
 *
 * ★ 湖/禁入（`Lake/Blocked`）**不在** 13.8b 的降级范围内（条文只说大河与小河），故原样保留，不臆造。
 */
export function bridgedCrossing(
  crossing: HexsideCrossing | null,
  input: {
    /** 本步是否穿越「工程能力单位所在格」的格边（13.8b：只有进出该格时才能降低） */
    touchesEngineerHex: boolean
    /** 该格边上的**桥**是否存在（含 13.8b 的例外：失去能力者可用自己架的桥离格） */
    bridgePresent: boolean
    /** 本步是否为**突袭**（8.1c/13.8b：不得借架桥过河突袭） */
    forOverrun: boolean
  },
): HexsideCrossing | null {
  if (crossing === null) return null
  if (!input.touchesEngineerHex || !input.bridgePresent || input.forOverrun) return crossing
  const river = crossing.river ?? null
  if (river === null) return crossing
  if (!(river in BRIDGED_RIVER)) return crossing // 湖/禁入等不在 13.8b 范围内
  return { ...crossing, river: BRIDGED_RIVER[river] ?? null }
}

/* ────────────────────────────── 专规 3.5 建造标记（轴方） ────────────────────────────── */

/** 专规 3.5：建造标记的两面 */
export type ConstructionMarkerKind = 'bridge' | 'airStrip'

/**
 * 专规 3.5：**放置**一枚建造标记
 *
 * 「可在**任意轴方移动阶段**、**单位移动之前**使用，把两面之一放进一个有**轴方战斗单位**的格。这是**免费**的
 *   （不耗补给）。」「三枚标记是剧本 1 与 2 初设的一部分（其他剧本没有）。每枚只能**使用一次**。」
 * 作为桥时按 13.8b 的 HQ 架桥处理（→ 见 `bridgedCrossing`）；作为简易机场时按 15.2 的标准简易机场处理。
 */
export function planConstructionMarkerUse(input: {
  kind: ConstructionMarkerKind
  side: Side
  phase: GamePhase
  /** 3.5：须在「单位移动之前」（该阶段尚未开始移动） */
  beforeMovement: boolean
  /** 3.5：目标格须有**轴方战斗单位** */
  hexHasAxisCombatUnit: boolean
  /** 3.5：该枚标记尚未使用过 */
  markerAvailable: boolean
}): RuleOutcome<{ costSp: number; rule: string; detail: string }> {
  if (input.side !== 'axis') return fail('专规 3.5', 'constructionMarkerIsAxisOnly')
  if (input.phase !== 'movement') return fail('专规 3.5', 'constructionMarkerOnlyInMovementPhase')
  if (!input.beforeMovement) return fail('专规 3.5', 'constructionMarkerMustBePlacedBeforeMovement')
  if (!input.markerAvailable) return fail('专规 3.5', 'constructionMarkerAlreadyUsed')
  if (!input.hexHasAxisCombatUnit)
    return fail('专规 3.5', 'constructionMarkerRequiresAxisCombatUnit')
  return succeed('专规 3.5', {
    // 3.5：免费（不耗补给）
    costSp: 0,
    rule: '专规 3.5',
    detail:
      input.kind === 'bridge'
        ? '放置建造标记（桥）：按 OCS 13.8b 的 HQ 架桥处理，免费'
        : '放置建造标记（简易机场）：按 OCS 15.2 的标准简易机场处理，免费',
  })
}

/**
 * 专规 3.5：该建造标记（桥或简易机场）是否被摧毁
 *
 * 「桥与简易机场**不能移动**。」「**只**在苏方战斗单位进入其格时被摧毁。**不可重建**。」
 */
export function isConstructionMarkerDestroyed(input: {
  /** 是否有苏方**战斗**单位进入该格 */
  enteredBySovietCombatUnit: boolean
}): boolean {
  return input.enteredBySovietCombatUnit
}

/* ────────────────────────────── 建造花费（供界面/命令层预显） ────────────────────────────── */

/**
 * 建造环形工事花费（16.0b）：每级 HEDGEHOG_COST_SP_PER_LEVEL 点 SP
 *
 * 等级按**本作上限**（专规 1.3b 的 1 级）封顶；超限时按上限计（合法性由 `planHedgehogBuild` 报错）。
 */
export function hedgehogBuildCostSp(levels: number): number {
  return Math.min(levels, HEDGEHOG_MAX_LEVEL) * HEDGEHOG_COST_SP_PER_LEVEL
}

/**
 * 修建空军基地花费（15.3）：每级 AIR_BASE_COST_SP_PER_LEVEL 点 SP
 */
export function airBaseBuildCostSp(levels: number): number {
  return Math.min(levels, AIR_BASE_MAX_LEVEL) * AIR_BASE_COST_SP_PER_LEVEL
}

/**
 * 目标格是否有**印刷永久工事**（专规 1.3a）——`planHedgehogReduce` 的 `hex.isPrintedPermanent` 取此值
 */
export function printedPermanentHedgehogAt(hex: { col: number; row: number }): boolean {
  return isPrintedHedgehogPermanent(hex.col, hex.row)
}
