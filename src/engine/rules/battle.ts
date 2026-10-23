import { fail, succeed, type RuleOutcome } from '../result-types'
import type { GamePhase, InternalStocks } from '../state-types'
import { HEX_DIRECTIONS, hexDistance, hexesWithin, neighbor } from '../hex-geometry'
import { crtLookup } from '../tables/crt'
import {
  clampColumnIndex,
  resolveSurprise,
  surpriseColumnShift,
  type SurpriseAttackType,
  type SurpriseSide,
} from '../tables/surprise'
import {
  parseCrtResultCell,
  RETREAT_DG_MIN_HEXES,
  type CombatResult,
  type CrtTerrainLine,
} from './combat'
import { computeCombatSupplyCost } from './supply'
import {
  attackMultiplier,
  bestCombatTerrainForDefender,
  combatHexsideTerrains,
  combatLineOf,
  type AttackerType,
  type MobilityType,
} from './terrain'
import { modeEffect } from './modes'

import type { HexRef, Side } from '@/data'

/**
 * 战斗判定与结算（B12，OCS 9.0 章）
 *
 * 本模块只做**一次战斗**的判定与结算，逐步实现 9.2 的九步流程。每一步都是纯函数；玩家的决策
 * （补给取舍 / AR 宣布 / 地形宣布 / 选项与撤退 / 推进）作为**入参**给出，故热座与 AI 走同一条代码路径。
 * 掷骰由调用方注入骰面（种子化 RNG，可复算），本模块不含随机。
 *
 * ## 9.2 流程总结（结算顺序，顺序很重要）
 *   1) 攻方选择攻击格与防御格（9.1）                     → `validateBattleComposition`
 *   2) 双方消耗战斗补给（9.5 / 12.4）                    → `battleCombatSupply`
 *   3) 宣布行动值：攻方先、守方后（9.6）                  → `declareBattleAr`
 *   4) 守方宣布地形（9.3b/9.4b/9.4c）→ 初始攻防比（9.7）   → `declareBattleTerrain` + `battleRatioLabel`
 *   5) 用双方 AR 单位定 DRM（9.6）                       → `declareBattleAr` 返回的 `drm`
 *   6) 掷 2 骰判奇袭并按 9.8 横移纵列                     → `resolveBattleSurprise`
 *   7) 掷 2 骰 + DRM − 工事等级 → 查表（9.9）             → `resolveBattleDice`
 *   8) 结算结果：攻方先、守方后；自 AR 单位起算损失（9.10/9.11）
 *                                                        → `allocateBattleLosses` / `resolveOptionChoice`
 *   9) 防御格已空且攻方未在选项中撤退 ⇒ 战后推进（9.12g）  → `resolveAdvanceAfterCombat`
 *      随后按 9.13 判定进击标记                          → `exploitEligibility`
 *
 * ## 与既有模块的分工（不重复实现）
 *   - CRT 取表与结果记号解析：`combat.ts`（`resolveCombat` / `parseCrtResultCell`）
 *   - 奇袭表与其横移：`tables/surprise.ts`；CRT 行列定位：`tables/crt.ts`
 *   - 地形倍率（含 9.4d 方括号只作用攻方）与地形候选：`terrain.ts`
 *   - 战斗补给成本与「全额才可攻」：`supply.ts`（12.4）；部队储备可否动用：`supply.ts`（12.10a）
 */

/* ────────────────────────────── 常量与词表 ────────────────────────────── */

/** 9.10a：1 点选项 = 1 点军力损失**或** 1 格撤退 */
export const OPTION_POINT_UNIT = 1

/** 9.4e：反坦克等级（无 / 轻 / 重） */
export type AtLevel = 'none' | 'light' | 'heavy'

/** 9.4e：AT 等级的比较秩——守方 AT ≥ 攻方 AT 时把 ×2 降为 ×1.5 */
const AT_RANK: Record<AtLevel, number> = { none: 0, light: 1, heavy: 2 }

/** 战斗中的角色 */
export type CombatRole = 'attacker' | 'defender'

/** 战斗单位视图（字段名照 state-types。**战斗值按印值传入**：模式折算由 `unitBattleStrength` 按角色施加，见 5.10b-A / 5.7 / 5.8） */
export interface BattleUnitView {
  id: string
  side: Side
  hex: HexRef
  /** 3.2a：装甲 / 机械化 / 其他（决定地形倍率与 9.4e 的 AT 等级） */
  attackerType: AttackerType
  /** **模式折算后**的战斗值（调用方算好；本模块不做模式折算） */
  attack: number
  /** 印值行动值（3.2c） */
  ar: number
  /** 是否 DG（9.6a：AR −1） */
  dg: boolean
  /** 基础模式（9.6a：战略模式 AR 归 0；9.1e：战略模式不能攻击） */
  mode: 'combat' | 'move' | 'strat' | 'reserve'
  /** 预备模式是否已释放（9.1e：未释放的预备不能攻击） */
  releasedFromReserve?: boolean
  /** 印值军力点数与当前军力（9.11d：多军力单位的攻防减半） */
  printedSteps: number
  steps: number
  /** 团级当量（4.6） */
  re: number
  /** 部队储备（12.10） */
  internalStocks: InternalStocks
  /** 是否断补（9.5a） */
  outOfSupply: boolean
  /** 机动类型（9.1f/9.3a 的进入合法性） */
  mobility: MobilityType
  /** 3.2b：战斗值带括号的单位只能防御 */
  attackCapable: boolean
  /**
   * 规则能力标签（数据层 `special_abilities`）
   *
   * 专规 2.3b 的 NKVD 判据取自此（`nkvd_border_forced_roll`）；缺省视为无能力标签。
   */
  specialAbilities?: readonly string[]
  /**
   * 9.12d：是否战斗单位（跟随撤退的判据之一）
   *
   * 缺省视为 true（旧调用方给出的视图都来自战斗构成，本就是战斗单位）。
   */
  isCombat?: boolean
  /**
   * 9.12d：非战斗单位类别（`organic_truck` 可跟随撤退；其余一律必须留在原格）
   *
   * 取自数据层的 `noncombat_kind`；战斗单位此字段无意义。
   */
  noncombatKind?: string | null
}

/**
 * 9.12d：该单位**是否可以跟随撤退**
 *
 * 「两个附加条件：未参加战斗的战斗单位和编内卡车可以在它们所在格中加入撤退。其他类型的单位
 *   （舰船、飞机、港口、环形工事、非编内卡车的运输点数及补给站）**不可跟随，必须留在所在格内**。」
 *
 * 判据：战斗单位 ✅；编内卡车（`organic_truck`）✅；其他非战斗单位 ❌。
 */
export function canJoinRetreat(unit: { isCombat?: boolean; noncombatKind?: string | null }): {
  ok: boolean
  rule: string
  reason?: string
} {
  if (unit.isCombat !== false) return { ok: true, rule: '9.12d' }
  if (unit.noncombatKind === 'organic_truck') return { ok: true, rule: '9.12d' }
  return { ok: false, rule: '9.12d', reason: 'neitherCombatUnitNorOrganicTruck' }
}

/** 战斗事实（注入；由调用方从地图与单位数据构造，保持本模块可独立测试） */
export interface BattleFacts {
  /** 9.1f/9.3a：该单位能否「移动进入」目标格（不能则不得攻击该格；只能沿路进入者不得突袭，见 8.1c） */
  canEnterForAttack(unit: BattleUnitView, from: HexRef, to: HexRef): boolean
  /** 9.9/9.14e：该格的环形工事等级（0＝无） */
  hedgehogLevelAt(hex: HexRef): number
  /** 9.4b：两格之间可选的**格边**地形（如小河的进攻减益）；无则空数组 */
  hexsideTerrainsBetween(from: HexRef, to: HexRef): readonly string[]
  /** 9.4b/9.4c：格内地形候选（契约：只含格内地形，城市/村庄的溢出符号由调用方按 9.3b 过滤） */
  hexTerrainsAt(hex: HexRef): readonly string[]
  /** 9.4e：防御格的 AT 等级 */
  defenderAtLevelAt(hex: HexRef): AtLevel
  /**
   * 9.1c 的**战斗环节攻击账本**（按环节，账本由调用方持有；本模块只问不记）
   *
   * 原文：「在一个战斗环节中，**同一个单位只能攻击一次，同一格只能被攻击一次**。一个格可以被
   * 任意数量的相邻格攻击，由攻击方玩家决定。」紧接的下一条括注把**移动环节的突袭**排除在外
   * ——「在一个移动环节中，同一个单位可以进行多次突袭，突袭同一个格的次数没有限制」。
   * ⇒ 这两条判据只在**常规战斗**（`attackType !== 'overrun'`）上生效，突袭不受限（见 `beginCombat`）。
   *
   * 为什么是**必填**：漏接线时若缺省为「没人攻击过」，9.1c 会**静默失效**（同一单位能在同一环节
   * 反复攻击）；宁可让每个构造点都显式给一份账本（空账本＝ `() => false`）。
   */
  attackedThisSegmentBy(unitId: string): boolean
  /** 9.1c：该格在本战斗环节是否**已被攻击过**（同上，突袭不受限） */
  attackedThisSegmentAt(hex: HexRef): boolean
}

/* ────────────────────────────── ① 9.1 战斗构成 ────────────────────────────── */

export interface BattleComposition {
  /** 防御格（9.1c：一次战斗只打一个格） */
  defendingHex: HexRef
  attackerIds: string[]
  defenderIds: string[]
  /** 参与攻击的格集合（9.13b-C「两个攻击堆叠须彼此相邻」用） */
  attackerHexes: HexRef[]
}

/**
 * 9.1 / 9.2-1：战斗构成校验
 *
 *   9.1a 只有当前阶段玩家的单位可以攻击；
 *   9.1c 一个单位不能拆分战斗值攻击多个格，一次战斗只打**一个**防御格（同格可被任意多相邻格攻击）；
 *   9.1d 防御格内**所有**战斗单位都必须参战（守方不能留人）；
 *   9.1e 战略模式、未释放的预备模式、只能防御（战斗值带括号）的单位不能攻击；
 *   9.1f / 9.3a 单位必须能「移动进入」被攻击格。
 */
export function validateBattleComposition(input: {
  attackers: readonly BattleUnitView[]
  defenders: readonly BattleUnitView[]
  facts: BattleFacts
}): RuleOutcome<BattleComposition> {
  const { attackers, defenders, facts } = input
  if (attackers.length === 0) return fail('9.1b', 'noAttacker')
  if (defenders.length === 0) return fail('9.1d', 'noDefender')

  const defendingHex = defenders[0]!.hex
  if (defenders.some((unit) => !sameHex(unit.hex, defendingHex)))
    return fail('9.1c', 'defendersInMultipleHexes')

  const seen = new Set<string>()
  for (const unit of attackers) {
    if (seen.has(unit.id)) return fail('9.1c', `duplicateAttacker:${unit.id}`)
    seen.add(unit.id)
    if (unit.side === defenders[0]!.side) return fail('9.1a', `friendlyFire:${unit.id}`)
    if (unit.mode === 'strat') return fail('9.1e', `stratCannotAttack:${unit.id}`)
    if (unit.mode === 'reserve' && unit.releasedFromReserve !== true)
      return fail('9.1e', `unreleasedReserveCannotAttack:${unit.id}`)
    if (!unit.attackCapable) return fail('9.1e', `defenseOnlyUnit:${unit.id}`)
    if (!facts.canEnterForAttack(unit, unit.hex, defendingHex))
      return fail('9.1f', `cannotEnterDefendingHex:${unit.id}`)
  }

  const attackerHexes: HexRef[] = []
  for (const unit of attackers)
    if (!attackerHexes.some((hex) => sameHex(hex, unit.hex))) attackerHexes.push(unit.hex)

  return succeed('9.1', {
    defendingHex,
    attackerIds: attackers.map((unit) => unit.id),
    defenderIds: defenders.map((unit) => unit.id),
    attackerHexes,
  })
}

/* ────────────────────────────── ② 9.5 / 12.4 战斗补给 ────────────────────────────── */

export interface BattleSupplyResult {
  /** 12.4：攻方所需 T＝攻击军力点数 ×1T/step */
  attackerRequiredT: number
  /** 12.4：守方所需 T＝2T（守方总 RE ≤1 时 1T） */
  defenderRequiredT: number
  /** 攻方是否付足（12.4：不足则**不能攻击**） */
  attackerReady: boolean
  /** 守方实际是否支付（决定 9.5 的 ½ 战斗值） */
  defenderPaid: boolean
  /** 9.5：守方战斗值倍率（未付/无补给 ⇒ ½） */
  defenderMultiplier: number
}

/**
 * 9.5 / 12.4：战斗补给
 *
 * 「攻方需要先这样消耗战斗补给，如果他无法做到，则**取消攻击**，且防御方不需要消耗任何补给。
 *   如果防御方不消耗补给（或没有补给），攻击会继续，但防御方以**一半的战斗值**战斗。」
 */
export function battleCombatSupply(input: {
  attackers: readonly BattleUnitView[]
  defenders: readonly BattleUnitView[]
  /** 攻方本阶段可动用的 T（SP 与可动用的部队储备之和） */
  attackerAvailableT: number
  /** 守方是否愿意支付战斗补给（9.5-B：守方可选择不付） */
  defenderProvides: boolean
  /** 守方本阶段可动用的 T */
  defenderAvailableT: number
}): RuleOutcome<BattleSupplyResult> {
  const attackerSteps = input.attackers.reduce((sum, unit) => sum + unit.steps, 0)
  const defenderRE = input.defenders.reduce((sum, unit) => sum + unit.re, 0)
  /*
   * ★ 口径唯一（M2④）：成本算式只在 `supply.ts#computeCombatSupplyCost` 一处实现，且**走规则常量**
   *   （`COMBAT_SUPPLY_ATTACKER_T_PER_STEP` / `_DEFENDER_T` / `_DEFENDER_MIN_T`）。
   *   此前这里内联了 `attackerSteps` 与 `defenderRE <= 1 ? 1 : 2`，把 1 / 2 写死 ——
   *   常量一改（例如勘误调整 9.5 的守方消耗），本路径不会跟着变，而那份"看起来没人用"的
   *   函数才会变。同类隐患见 `air-interaction.ts` 里防空击落阈值的硬编码 11。
   */
  const { attackerT: attackerRequiredT, defenderT: defenderRequiredT } = computeCombatSupplyCost({
    attackerSteps,
    defenderRE,
  })
  const attackerReady = input.attackerAvailableT >= attackerRequiredT
  const defenderPaid = input.defenderProvides && input.defenderAvailableT >= defenderRequiredT

  if (!attackerReady) return fail('12.4', 'attackSupplyNotFull')
  return succeed('9.5', {
    attackerRequiredT,
    defenderRequiredT,
    attackerReady,
    defenderPaid,
    defenderMultiplier: defenderPaid ? 1 : 0.5,
  })
}

/* ────────────────────────────── ③ 9.6 行动值 ────────────────────────────── */

/** 9.6a：AR 的模式修正（DG −1；战略模式归 0） */
export function battleArOf(unit: {
  ar: number
  dg: boolean
  mode: BattleUnitView['mode']
}): number {
  if (unit.mode === 'strat') return 0
  return unit.dg ? unit.ar - 1 : unit.ar
}

/**
 * 9.6：宣布 AR 单位并得出 DRM（攻方先宣布、守方后宣布）
 *
 * 「每方只能选择一个单位，且该单位**必须参与战斗**。将攻击方的 AR 减去防御方的 AR，即等于 DRM」
 * 该 DRM 同时用于奇袭判定（9.8）与战斗结算（9.9）。
 */
export function declareBattleAr(input: {
  attackers: readonly BattleUnitView[]
  defenders: readonly BattleUnitView[]
  attackerUnitId: string
  defenderUnitId: string
}): RuleOutcome<{ attackerAr: number; defenderAr: number; drm: number }> {
  const attacker = input.attackers.find((unit) => unit.id === input.attackerUnitId)
  if (attacker === undefined)
    return fail('9.6', `attackerArUnitNotInBattle:${input.attackerUnitId}`)
  const defender = input.defenders.find((unit) => unit.id === input.defenderUnitId)
  if (defender === undefined)
    return fail('9.6', `defenderArUnitNotInBattle:${input.defenderUnitId}`)
  const attackerAr = battleArOf(attacker)
  const defenderAr = battleArOf(defender)
  return succeed('9.6', { attackerAr, defenderAr, drm: attackerAr - defenderAr })
}

/* ────────────────────────────── ④ 9.3b / 9.4 地形宣布 ────────────────────────────── */

/** 单个攻击堆叠的地形选择（9.4b：格内地形**或**穿越的格边地形，二选一，不累计） */
export interface StackTerrainChoice {
  hex: HexRef
  kind: 'hex' | 'hexside'
  terrain: string
}

export interface BattleTerrainResult {
  /** 9.4b：逐攻击堆叠地形（键＝该堆叠所在格） */
  attackerTerrainByHex: { hex: HexRef; terrain: string; kind: 'hex' | 'hexside' }[]
  /** 9.4c：守方格地形（决定战斗表横行） */
  defenderTerrain: string
  /** 战斗表横行（TEC 战斗线） */
  combatLine: CrtTerrainLine
  /** 攻方逐堆叠所用倍率（已含 9.4d：方括号只作用攻方） */
  attackerMultiplierByHex: { hex: HexRef; armor: number; mech: number; other: number }[]
}

/**
 * 9.3b / 9.4b / 9.4c：地形宣布
 *
 *   - 9.4b「防御方玩家可以为**每一个攻击中的堆叠**选择一种地形来进行修正：可以是防御格内的地形，
 *     或者是该堆叠的攻击穿越的格边地形……只能选择格内或格边地形；这些修正**不能累计**」；
 *   - 9.4c「防御方还可以选择一种地形来修正防御堆叠……**只能选择格内地形**，这一选择也决定了
 *     战斗表的横行使用哪种地形类别」；
 *   - 9.3b 攻击格内的地形**不重要**（末句）。
 */
export function declareBattleTerrain(input: {
  attackers: readonly BattleUnitView[]
  defenders: readonly BattleUnitView[]
  facts: BattleFacts
  /** 攻方逐堆叠宣布（9.4b）；缺省＝全部沿用守方格地形 */
  stackChoices?: readonly StackTerrainChoice[]
  /** 守方防御地形（9.4c）；缺省＝候选集中战斗线最重者（正式对局应由守方手选） */
  defenderTerrain?: string
}): RuleOutcome<BattleTerrainResult> {
  const defendingHex = input.defenders[0]!.hex
  const hexTerrains = [...input.facts.hexTerrainsAt(defendingHex)]

  const defenderTerrain =
    input.defenderTerrain ?? bestCombatTerrainForDefender({ terrainsPresent: hexTerrains })
  if (defenderTerrain === null || !hexTerrains.includes(defenderTerrain))
    return fail('9.4c', `defenderTerrainNotHexTerrain:${String(defenderTerrain)}`)
  const line = combatLineOf(defenderTerrain)
  if (line === null) return fail('9.3c', `noCombatLine:${defenderTerrain}`)

  const attackerTerrainByHex: BattleTerrainResult['attackerTerrainByHex'] = []
  const attackerMultiplierByHex: BattleTerrainResult['attackerMultiplierByHex'] = []
  for (const stack of input.attackers) {
    if (attackerTerrainByHex.some((item) => sameHex(item.hex, stack.hex))) continue
    const choice = input.stackChoices?.find((item) => sameHex(item.hex, stack.hex))
    const resolved =
      choice === undefined
        ? { hex: stack.hex, terrain: defenderTerrain, kind: 'hex' as const }
        : { hex: stack.hex, terrain: choice.terrain, kind: choice.kind }
    const candidates =
      resolved.kind === 'hex'
        ? hexTerrains
        : // 9.4b：格边候选只保留**会产生战斗修正**的格边地形（河/湖）；
          // 铁路/小路/大路的 TEC attack 行为 ot（不产生数值），只与移动与补给有关（用户 2026-09-13 裁定）
          combatHexsideTerrains(input.facts.hexsideTerrainsBetween(stack.hex, defendingHex))
    if (!candidates.includes(resolved.terrain))
      return fail('9.4b', `stackTerrainNotCandidate:${resolved.terrain}`)
    attackerTerrainByHex.push(resolved)
    attackerMultiplierByHex.push({
      hex: stack.hex,
      armor: attackMultiplier(resolved.terrain, 'armor', 'attacker'),
      mech: attackMultiplier(resolved.terrain, 'mech', 'attacker'),
      other: attackMultiplier(resolved.terrain, 'other', 'attacker'),
    })
  }

  return succeed('9.4', {
    attackerTerrainByHex,
    defenderTerrain,
    combatLine: line,
    attackerMultiplierByHex,
  })
}

/* ────────────────────────────── ⑤ 9.4 / 9.4e / 9.5a / 9.11d 单单位战力 ────────────────────────────── */

/**
 * 9.4e：反坦克效果
 *
 * 「攻击中的装甲或机械化单位的『×2』地形效果，有时会被降低为『×1.5』。当防御方的格内有**相同或更高**
 *   等级的反坦克效果时就会这样。」装甲单位视作重型 AT、不带坦克符号的红标（机械化）视作轻型 AT。
 * 规则书算例：守方只有轻型 AT 时，装甲仍 ×2、装甲掷弹兵改 ×1.5；守方有重型 AT 时两者都 ×1.5。
 */
export function antiTankMultiplier(
  base: number,
  attackerType: AttackerType,
  defenderAtLevel: AtLevel,
): number {
  if (base !== 2) return base
  if (attackerType !== 'armor' && attackerType !== 'mech') return base
  const needed: AtLevel = attackerType === 'armor' ? 'heavy' : 'light'
  return AT_RANK[defenderAtLevel] >= AT_RANK[needed] ? 1.5 : base
}

/**
 * 9.4 / 9.4d / 9.4e / 9.5 / 9.5a / 9.11d：单个单位的战斗值
 *
 * 次序即规则次序：印值 → **模式折算**（5.10b-A / 5.7 / 5.8）→ 地形倍率（9.4d 方括号只作用攻方）
 * → 9.4e 反坦克 → 9.11d 多军力单位减半 → 9.5/9.5a 补给。
 * 9.5a 的三种组合：有战斗补给的断补单位 ×½；没有战斗补给的断补单位**完全无法攻击**、防御 ×¼；
 * 攻方没有战斗补给则**不能攻击**（9.5-A）。
 */
export function unitBattleStrength(input: {
  unit: BattleUnitView
  role: CombatRole
  /** 9.4b/9.4c：该单位适用的地形（攻方逐堆叠、守方用防御格地形） */
  terrain: string
  /** 9.4e：防御格 AT 等级（仅攻方需要） */
  defenderAtLevel?: AtLevel
  /** 9.5：该方本场是否付了战斗补给 */
  combatSupplyPaid: boolean
}): { strength: number; rule: string; cannotAttack: boolean } {
  const { unit, role } = input
  if (role === 'attacker' && !input.combatSupplyPaid)
    return { strength: 0, rule: '9.5-A', cannotAttack: true }

  /*
   * 5.10b-A / 5.7 / 5.8：模式折算
   *
   * - 5.10b-A：DG 单位的**战斗、轰炸与移动值**都减半（对攻守两个角色都生效）；
   * - 5.7：**预备模式的守方**防御值减半（攻方不受影响）；
   * - 5.8：战略模式的战斗值降为零。
   *
   * ★ 攻方取 `combatMult`、守方取 `defenseMult`——同一单位在两个角色上的倍率不同
   *   （预备守方 ×½ 而预备攻方不变），故**不能**预先折算成一个 `attack` 字段，
   *   必须在按角色取值时就地施加。倍率与后面的各次减半同为乘法，先后无关。
   */
  const effect = modeEffect({
    mode: unit.mode,
    dg: unit.dg,
    releasedFromReserve: unit.releasedFromReserve,
  })
  const modeMultiplier = role === 'attacker' ? effect.combatMult : effect.defenseMult

  const base = attackMultiplier(input.terrain, unit.attackerType, role)
  const terrainMultiplier =
    role === 'attacker'
      ? antiTankMultiplier(base, unit.attackerType, input.defenderAtLevel ?? 'none')
      : base

  let value = unit.attack * modeMultiplier * terrainMultiplier

  // 9.11d：多军力单位的减半（攻方只要有损失；守方损失 ≥ 印值一半）
  if (unit.printedSteps > 1) {
    const lost = unit.printedSteps - unit.steps
    if (role === 'attacker' && lost > 0) value *= 0.5
    if (role === 'defender' && lost >= unit.printedSteps / 2) value *= 0.5
  }

  // 9.5：守方未付（或无补给）⇒ ½；9.5a：断补 ⇒ 再 ½（无战斗补给的断补守方 = ¼）
  if (role === 'defender' && !input.combatSupplyPaid) value *= 0.5
  if (unit.outOfSupply) value *= 0.5

  return { strength: value, rule: '9.4', cannotAttack: false }
}

/* ────────────────────────────── ⑥ 9.7 攻防比与列位 ────────────────────────────── */
// 9.7 / 9.7a / 9.7b / 9.1g / 9.14a 的实现见 `combat.ts`，本模块直接复用，不自持第二份口径：
//   battleOdds             9.7 除以较小者 + 4.2 四舍五入 → `N:1` / `1:N`
//   battleRatioLabel       同上口径的标签（显示/日志用）
//   resolveRatioColumnIndex 9.7a 取「≤ 取整后比值」的最大列
//   battleColumnIndex      叠加 9.14a 零战斗值的左右端列特例
// ★ 4.2 是**四舍五入**（小数 ≥ .5 进位），不是向下取整——两处若口径不一，列位会系统性偏移。

/* ────────────────────────────── ⑦ 9.8 奇袭与横移 ────────────────────────────── */

export interface BattleSurpriseResult {
  side: SurpriseSide
  /** 带符号的横移列数（攻方奇袭为正，守方为负，未奇袭为 0） */
  shift: number
  /** 横移后夹取回表内的最终列位（9.1g） */
  columnIndex: number
  clamped: boolean
  detail: string
}

/** 9.8 / 9.1g：奇袭判定与纵列横移 */
export function resolveBattleSurprise(input: {
  die: number
  arDifferential: number
  attackType: SurpriseAttackType
  defenderInHedgehog: boolean
  /** 发生奇袭时的横移骰（1–6） */
  shiftDie?: number
  /** 初始列位（9.7a/9.14a 算出） */
  columnIndex: number
  columnCount: number
}): BattleSurpriseResult {
  const lookup = resolveSurprise({
    die: input.die,
    arDifferential: input.arDifferential,
    attackType: input.attackType,
    defenderInHedgehog: input.defenderInHedgehog,
  })
  const shift = surpriseColumnShift({
    side: lookup.side,
    ...(input.shiftDie === undefined ? {} : { shiftDie: input.shiftDie }),
  })
  const clamped = clampColumnIndex(input.columnIndex + shift.shift, input.columnCount)
  return {
    side: lookup.side,
    shift: shift.shift,
    columnIndex: clamped.index,
    clamped: clamped.clamped,
    detail: shift.detail,
  }
}

/* ────────────────────────────── ⑧ 9.9 战斗掷骰取表 ────────────────────────────── */

/** 9.9 重要提示：修正骰＝2d6 + 攻方 AR − 守方 AR − 环形工事**完整等级**（奇袭只 −1） */
export function battleModifiedDice(input: {
  die: number
  attackerAr: number
  defenderAr: number
  hedgehogLevel: number
}): { modifiedDice: number; rule: '9.9' } {
  if (!Number.isInteger(input.die) || input.die < 2 || input.die > 12)
    throw new RangeError(`[battle] 战斗骰应为 2–12 的两个骰之和，收到 ${input.die}`)
  return {
    modifiedDice: input.die + input.attackerAr - input.defenderAr - input.hedgehogLevel,
    rule: '9.9',
  }
}

/** 9.9：查表得结果（用横移后的列位标签直接取列） */
export function resolveBattleDice(input: {
  die: number
  attackerAr: number
  defenderAr: number
  hedgehogLevel: number
  combatLine: CrtTerrainLine
  /** 横移后的最终列位标签（如 `3:1`） */
  columnLabel: string
}): RuleOutcome<CombatResult> {
  const { modifiedDice } = battleModifiedDice(input)
  const lookup = crtLookup(modifiedDice, input.combatLine, input.columnLabel)
  const parsed = parseCrtResultCell(lookup.code)
  parsed.modifiedDice = modifiedDice
  parsed.terrainLine = input.combatLine
  parsed.ratio = lookup.columnLabel
  return succeed('9.9', parsed)
}

/* ────────────────────────────── ⑨ 9.11 损失 / 9.10 选项 ────────────────────────────── */

/**
 * 9.11 / 9.11a-c：战斗中的军力损失分配
 *
 * 「在战斗中，AR 单位（9.6）必须承受己方**第一点**军力损失。在有多点损失的情况下，所有单位
 *   必须先**各承受一点**损失，然后才能有单位承受第二点损失。」「任何单位承受的军力损失都不能超过
 *   它的可用军力总量」「超出承受范围的损失**忽略**」（9.11b）。
 * 故分布形状由规则锁定（谁先谁后无自由度），本函数给出规范分布。
 */
export function allocateBattleLosses(input: {
  required: number
  units: readonly { id: string; steps: number }[]
  /** 该方用于确定 AR 的单位（9.6）；缺省按输入顺序 */
  arUnitId?: string
}): {
  rule: '9.11c'
  allocation: { unitId: string; steps: number }[]
  totalLost: number
  eliminated: string[]
  /** 因超出承受能力而被忽略的损失（9.11b） */
  ignored: number
} {
  const order = [...input.units]
  if (input.arUnitId !== undefined) {
    const index = order.findIndex((unit) => unit.id === input.arUnitId)
    if (index > 0) order.unshift(order.splice(index, 1)[0]!)
  }
  const remaining = new Map(order.map((unit) => [unit.id, Math.max(0, unit.steps)]))
  const lost = new Map<string, number>()
  let owed = Math.max(0, Math.trunc(input.required))

  // 逐轮「每人一点」（9.11c）
  while (owed > 0) {
    let placed = false
    for (const unit of order) {
      if (owed <= 0) break
      const left = remaining.get(unit.id) ?? 0
      if (left <= 0) continue
      remaining.set(unit.id, left - 1)
      lost.set(unit.id, (lost.get(unit.id) ?? 0) + 1)
      owed -= 1
      placed = true
    }
    if (!placed) break
  }

  const allocation = order
    .map((unit) => ({ unitId: unit.id, steps: lost.get(unit.id) ?? 0 }))
    .filter((item) => item.steps > 0)
  return {
    rule: '9.11c',
    allocation,
    totalLost: allocation.reduce((sum, item) => sum + item.steps, 0),
    eliminated: order.filter((unit) => (remaining.get(unit.id) ?? 0) <= 0).map((unit) => unit.id),
    ignored: owed,
  }
}

/**
 * 9.10 / 9.10a：选项结算
 *
 * 「选项的数字为受影响的玩家提供了该数量的选择」「可将**撤退格数和损失军力数任意组合**，
 *   但选项总数必须**完全被满足**。例如，损失一点军力加上撤退一格可满足 `o2`。」
 */
export function resolveOptionChoice(input: {
  points: number
  retreatHexes: number
  lossPoints: number
}): RuleOutcome<{ points: number; retreatHexes: number; lossPoints: number }> {
  const { points, retreatHexes, lossPoints } = input
  if (!Number.isInteger(retreatHexes) || retreatHexes < 0)
    return fail('9.10a', `badRetreatHexes:${retreatHexes}`)
  if (!Number.isInteger(lossPoints) || lossPoints < 0)
    return fail('9.10a', `badLossPoints:${lossPoints}`)
  if (retreatHexes * OPTION_POINT_UNIT + lossPoints !== points)
    return fail('9.10a', `optionNotFullySatisfied:${retreatHexes}+${lossPoints}!=${points}`)
  return succeed('9.10a', { points, retreatHexes, lossPoints })
}

/**
 * 9.11a + 9.11c：校验玩家给出的军力损失分配
 *
 * 9.11a「**在 9.11c 的限制范围内**，由**拥有者玩家**决定由哪个或哪些单位承受军力损失。」
 * ⇒ 玩家确实有选择权，只是被 9.11c 的两条**约束**框住：
 *   ① **AR 单位必须承受己方第一点**（有 AR 单位且它还有可用军力时）；
 *   ② **多点损失时，所有单位必须先各承受一点，然后才能有单位承受第二点**（"均匀展开"）。
 * ⇒ 只要满足这两条，**谁多受那一点由拥有者选**（例：三点损失落在三个未受损单位上时，
 *   第一点归 AR 单位，第二、第三点分配给另外两枚中的哪一枚由拥有者定 —— 两种分配都合法）。
 *
 * ★ 批 F 切片 2 修正（§17.94 登记的**过度约束**）：修前本函数要求玩家提交的分配与
 *   「规范分配」**逐单位一致**（`normalized(player) === normalized(canonical)`），
 *   于是"同样是未受损单位之间选谁承受"会被误判违规并报 `9.11c` —— 与 9.11a 的授权冲突。
 *   现在改成**判约束**：
 *     · 逐单位不得超过其可用军力（9.11：「任何单位承受的军力损失都不能超过它的可用的军力总量」）；
 *     · **步数多重集**（把各单位的损失点数排序）必须与规范分配一致 —— 这就是 9.11c 的"均匀展开"；
 *     · AR 单位必须 ≥1（若它还有容量且总损失 ≥1）。
 * ★ 该约束**不适用于**轰炸与撤退造成的军力损失（9.11c 末段：那两种情形玩家可自由指定）。
 */
export function validateBattleLossAllocation(input: {
  required: number
  units: readonly { id: string; steps: number }[]
  arUnitId?: string
  allocation: readonly { unitId: string; steps: number }[]
}): RuleOutcome<{ allocation: { unitId: string; steps: number }[]; eliminated: string[] }> {
  const known = new Set(input.units.map((unit) => unit.id))
  for (const item of input.allocation) {
    if (!known.has(item.unitId)) return fail('9.11a', `unknownUnit:${item.unitId}`)
    if (!Number.isInteger(item.steps) || item.steps < 0)
      return fail('9.11b', `badSteps:${item.unitId}:${item.steps}`)
  }
  const canonical = allocateBattleLosses({
    required: input.required,
    units: input.units,
    ...(input.arUnitId === undefined ? {} : { arUnitId: input.arUnitId }),
  })
  const canonicalByUnit = new Map(canonical.allocation.map((item) => [item.unitId, item.steps]))
  const capacityOf = (unitId: string): number =>
    input.units.find((unit) => unit.id === unitId)?.steps ?? 0

  // ① 逐单位不得超过可用军力（9.11 末句）
  for (const item of input.allocation) {
    if (item.steps > capacityOf(item.unitId))
      return fail(
        '9.11',
        `lossExceedsUnitSteps:${item.unitId}:${item.steps}>${capacityOf(item.unitId)}`,
      )
  }
  // ② 总量必须与规范分配相同（9.11b 的超限由规范分配夹取，故以它为准）
  const totalOf = (items: readonly { steps: number }[]): number =>
    items.reduce((sum, item) => sum + item.steps, 0)
  const chosen = input.allocation.filter((item) => item.steps > 0)
  if (totalOf(chosen) !== totalOf(canonical.allocation))
    return fail(
      '9.11c',
      `lossTotalMismatch:玩家 ${String(totalOf(chosen))} ≠ 应付 ${String(totalOf(canonical.allocation))}`,
    )
  // ③ 均匀展开：步数多重集必须一致（谁能多受由拥有者选，但"各受一点之前不许有人受第二点"是死的）
  const shape = (items: readonly { steps: number }[]): string =>
    items
      .map((item) => item.steps)
      .sort((a, b) => b - a)
      .join(',')
  const chosenShape = shape(chosen)
  const canonicalShape = shape(canonical.allocation)
  if (chosenShape !== canonicalShape)
    return fail('9.11c', `lossAllocationViolatesSpreadRule:${chosenShape} ≠ ${canonicalShape}`)
  // ④ AR 单位必须承受第一点（9.11c 首句；它已无容量时这一条自然落空）
  const arId = input.arUnitId
  if (arId !== undefined && totalOf(canonical.allocation) >= 1 && capacityOf(arId) >= 1) {
    const arSteps = chosen.find((item) => item.unitId === arId)?.steps ?? 0
    if (arSteps < 1) return fail('9.11c', `arUnitMustTakeFirstLoss:${arId}`)
  }

  /*
   * 返回**玩家给的**分配（这是 9.11a 的授权所在）——只补上没提到的单位（0 点）。
   * `eliminated` 取"按这份分配结算后归零"的单位（与规范分配同口径，因为最终步数一致）。
   */
  const eliminated = input.units
    .filter((unit) => (canonicalByUnit.get(unit.id) ?? 0) >= unit.steps)
    .map((unit) => unit.id)
  return succeed('9.11c', {
    allocation: input.allocation.map((item) => ({ unitId: item.unitId, steps: item.steps })),
    eliminated,
  })
}

/**
 * 9.10c：守方是否可以忽略自己的选项
 *
 * 「如果攻击方已撤退，或无法完成所有选项，则防御方便可忽略他的选项。（但防御方主动希望撤退时，
 *   可以选择结算他的全部选项）。攻击方**始终**必须完成他的所有选项。」
 */
export function defenderMayIgnoreOptions(input: {
  attackerRetreated: boolean
  attackerCompleted: boolean
}): { mayIgnore: boolean; rule: '9.10c'; detail: string } {
  const mayIgnore = input.attackerRetreated || !input.attackerCompleted
  return {
    mayIgnore,
    rule: '9.10c',
    detail: mayIgnore
      ? '攻方已撤退或未能完成全部选项：守方可忽略自己的选项（也可主动结算全部）'
      : '攻方完成全部选项：守方必须结算自己的选项',
  }
}

/**
 * 9.10d / 9.13 / 9.13b：进击标记的判定（**逐单位**）
 *
 * 「9.10d 当战斗结果同时包含选项和进击数字时，攻击方必须把他的**全部选项选为军力损失**才能获得
 *   进击标记；如果攻击方在选项中选择撤退，则**必须忽略**所有的进击结果。」
 * 「9.13 只有实际参与了攻击、且可攻击的单位才能获得进击标记。」
 * 「9.13b 忽略进击结果的情形：A) 攻击单位处于 DG（**非 DG 的攻击单位可正常结算**）；
 *   B) 这次攻击是**突袭**，或是在**进击阶段**中的攻击；C) 攻击单位中任意**两个攻击堆叠不彼此相邻**
 *   ——故为获得进击结果最多只能有**两个**堆叠且必须相邻。」
 *
 * 图表第 2 页：`e# Attackers with action ratings of # or more are exploitation marked` —— 是
 * **逐单位**的判据：参战单位中 AR ≥ e# 且**自身未 DG**者各自获得进击标记。
 * 故本函数返回**可标记的 unitId 清单**，而不是一个总布尔。
 *
 * 战斗级的闸门（无 e# / 突袭 / 非战斗阶段 / 选项全为军力损失 / 攻击格数）先判：它们一旦不满足，
 * **没有**任何单位能获得标记；通过后再逐单位按「AR ≥ e# 且未 DG」判。
 */
export function exploitEligibility(input: {
  /** CRT 结果里的 e#（无则不判） */
  eThreshold: number | undefined
  /** 参战攻方单位及各自的 AR / DG（由调用方从参战单位取，9.13「实际参与攻击」） */
  attackers: readonly { unitId: string; ar: number; dg: boolean }[]
  attackerRetreatedInOptions: boolean
  /** 攻方是否把全部选项都选成了军力损失（9.10d） */
  attackerAllOptionsAsLosses: boolean
  attackType: SurpriseAttackType
  phase: GamePhase
  attackerHexes: readonly HexRef[]
}): RuleOutcome<{ granted: boolean; grantedUnitIds: string[]; reason: string }> {
  const none = (rule: string, reason: string) =>
    succeed(rule, { granted: false, grantedUnitIds: [], reason })

  if (input.eThreshold === undefined) return none('9.13', 'noEResult')
  if (input.attackType === 'overrun') return none('9.13b-B', 'overrunNoExploit')
  // 9.13b-B + 辅助卡战斗结果说明：`e#` **只对战斗阶段发起的攻击生效**。
  // 进击阶段也有战斗环节（2.2 的 G 段），但那里的攻击不给进击标记；反应阶段无战斗环节。
  if (input.phase !== 'combat') return none('9.13b-B', 'exploitOnlyInCombatPhase')
  if (input.attackerRetreatedInOptions) return none('9.10d', 'retreatedIgnoresExploit')
  if (!input.attackerAllOptionsAsLosses) return none('9.10d', 'optionsNotAllLosses')
  // 9.13b-C + 战斗结果说明注 4：「涉及**三个或更多攻击格**、或**任意两个不相邻的攻击格**的攻击
  //   永远不产生进击结果」。故为取得进击标记，攻击格至多两个且必须彼此相邻。
  if (input.attackerHexes.length > 2) return none('9.13b-C', 'moreThanTwoStacks')
  if (
    input.attackerHexes.length === 2 &&
    !areAdjacent(input.attackerHexes[0]!, input.attackerHexes[1]!)
  )
    return none('9.13b-C', 'twoStacksNotAdjacent')

  // 9.13 / 9.13b-A：逐单位判
  const qualified = input.attackers.filter((unit) => unit.ar >= input.eThreshold!)
  const grantedUnitIds = qualified.filter((unit) => !unit.dg).map((unit) => unit.unitId)
  if (grantedUnitIds.length > 0)
    return succeed('9.13', { granted: true, grantedUnitIds, reason: 'ok' })
  if (qualified.length > 0) return none('9.13b-A', 'attackerDg')
  return none('9.13', 'arBelowThreshold')
}

/* ────────────────────────────── ⑩ 9.12 撤退与 9.12g 推进 ────────────────────────────── */

/** 撤退事实（注入） */
export interface RetreatFacts {
  /** 9.12f：该格是否有敌方战斗单位（撤退不可穿越战斗开始时含敌方战斗单位的格） */
  enemyCombatUnitAt(hex: HexRef, side: Side): boolean
  /** 9.12e：该格是否在敌方未抵消 ZOC 内 */
  inEnemyZocAt(hex: HexRef, side: Side): boolean
  /** 9.12：该格是否禁止该机动类型进入（穿禁入地形者被消灭） */
  prohibitedFor(mobility: MobilityType, hex: HexRef): boolean
  /** 9.12e：「恰好」在该格的友方战斗单位（一并 DG） */
  friendlyCombatUnitsAt(hex: HexRef, side: Side): readonly string[]
  /** 9.12b：该单位在任何模式下都不可移动（被迫撤退时直接摧毁） */
  immobile(unitId: string): boolean
}

export interface RetreatResult {
  rule: string
  unitId: string
  /** 撤退落点；null＝被消灭 */
  hex: HexRef | null
  destroyed: boolean
  /** 撤退后是否 DG（9.12a 的 2 格规则 / 9.12e 进入敌方 ZOC） */
  gainsDg: boolean
  /** 9.12e：与撤退单位同格的友方战斗单位一并 DG */
  dgCompanions: string[]
  /** 9.12e：撤退堆叠在进入 ZOC 前已有 DG 单位 ⇒ 额外损失 1 军力（由拥有者从这些单位中选） */
  extraLoss: number
  /**
   * 9.12：结束格与起始格的**直线距离**是否等于完整撤退距离
   *
   * 「撤退结束格与其开始撤退的格的**直线距离**，必须等于上述的格数，这被称为『完整撤退距离』；
   *   撤退的路径不一定要是直线，它可以之字形避开禁入地形，但**最后进入的格**必须满足该距离要求。」
   * 为 false 时该撤退不合法，命令层应拒绝该落点（本函数仍给出沿路径的中间态，便于界面提示）。
   */
  fullRetreatDistanceMet: boolean
  /** 9.12b：MA 为 0 的单位可在撤退前切换到移动模式 */
  maySwitchToMoveMode: boolean
}

/**
 * 9.12 / 9.12a-f：单个单位的撤退
 *
 *   9.12 撤退结束格与起始格的直线距离必须等于完整撤退距离；路径可之字形避开禁入地形；
 *        必须穿过敌方占据格或禁入地形者被**消灭**；
 *   9.12a 撤退 2 格及以上时，进入**第 2 格**的瞬间承受一次 DG；
 *   9.12b MA 为 0 的单位可先切到移动模式；在任何模式下都不可移动者**直接消灭**；
 *   9.12e 进入敌方 ZOC 立即 DG，且「恰好」在该格的友方战斗单位一并 DG；若撤退堆叠中任何单位在
 *         进入 ZOC **之前**已是 DG，则该堆叠**损失一点军力**（从这些 DG 单位中选）。
 *         ★ 次序要点：9.12a 的 DG 是在**进入第 2 格那一刻**才获得，故第 2 格本身即 ZOC 格时
 *         不构成「进入 ZOC 之前已 DG」，不触发该额外损失；且该损失是**每次撤退至多 1 点**
 *         （原文作「该堆栈损失一点军力」）；
 *   9.12f 撤退不可穿越战斗开始时含敌方战斗单位的格。
 */
export function resolveRetreat(input: {
  unit: {
    id: string
    side: Side
    hex: HexRef
    mobility: MobilityType
    dg: boolean
  }
  /** 撤退路径（含落点、不含起始格）；长度即完整撤退距离 */
  path: readonly HexRef[]
  facts: RetreatFacts
}): RetreatResult {
  const { unit, path, facts } = input
  const lastHex = path.length === 0 ? unit.hex : path[path.length - 1]!
  // 9.12：结束格与起始格的**直线距离**必须等于完整撤退距离（之字形路径允许，但落点须刚好在该距离上）
  const fullRetreatDistanceMet = hexDistance(unit.hex, lastHex) === path.length
  const base = {
    unitId: unit.id,
    dgCompanions: [] as string[],
    extraLoss: 0,
    fullRetreatDistanceMet,
    maySwitchToMoveMode: true,
  }
  if (facts.immobile(unit.id))
    return { ...base, rule: '9.12b', hex: null, destroyed: true, gainsDg: false }

  let current = unit.hex
  let dg = unit.dg
  let extraLoss = 0
  let dgCompanions: string[] = []

  for (let index = 0; index < path.length; index += 1) {
    const next = path[index]!
    if (facts.enemyCombatUnitAt(next, unit.side) || facts.prohibitedFor(unit.mobility, next))
      return {
        ...base,
        rule: '9.12',
        hex: null,
        destroyed: true,
        gainsDg: true,
        extraLoss,
        dgCompanions,
      }
    // ★ 次序：9.12e 的「进入 ZOC **之前**是否已 DG」须用进入该格前的状态判定
    //   （9.12a 的 DG 是在**进入该格那一刻**才获得，故第 2 格本身为 ZOC 格时不算「之前已 DG」）
    const dgBeforeEntering = dg
    if (facts.inEnemyZocAt(next, unit.side)) {
      // 9.12e：进入敌方 ZOC ⇒ 立刻 DG；同格友方战斗单位一并 DG；此前已 DG ⇒ 该堆叠损失 1 点军力
      dgCompanions = [...facts.friendlyCombatUnitsAt(next, unit.side)]
      if (dgBeforeEntering) extraLoss = 1
      dg = true
    }
    // 9.12a：进入第 2 格即 DG（放在 ZOC 判定之后，故不影响同格的「之前已 DG」判断）
    if (index + 1 >= RETREAT_DG_MIN_HEXES) dg = true
    current = next
  }

  return {
    rule: '9.12',
    unitId: unit.id,
    hex: current,
    destroyed: false,
    gainsDg: dg,
    dgCompanions,
    extraLoss,
    fullRetreatDistanceMet,
    maySwitchToMoveMode: true,
  }
}

/**
 * 9.12c / 9.12e：**堆叠**撤退
 *
 * 9.12c「双方玩家分别撤退自己的单位。撤退单位时，可以以**一整个堆叠**进行撤退，也可以将单位
 *   分开撤退」——故每个单位各给一条路径（整堆叠走同一条路径时各路径相同）。
 * 9.12e 的「额外损失」是**堆叠级**的：「如果撤退的堆叠中有任何单位在进入敌方 ZOC 之前是 DG 的，
 *   则该堆叠损失**一点**军力（由拥有者玩家从撤退中的 DG 单位中选择）」——故整堆叠每次撤退至多
 *   损失 1 点，而不是逐单位各扣 1 点。
 *
 * 调用约定：`facts.friendlyCombatUnitsAt` 只报**恰好在该格**的友方战斗单位（不含正在撤退的这些单位）。
 */
export function resolveStackRetreat(input: {
  units: readonly {
    id: string
    side: Side
    hex: HexRef
    mobility: MobilityType
    dg: boolean
  }[]
  /** 各单位的撤退路径（含落点、不含起始格），长度即各自的完整撤退距离 */
  paths: readonly { unitId: string; path: readonly HexRef[] }[]
  facts: RetreatFacts
}): {
  rule: string
  results: RetreatResult[]
  /** 9.12e：整堆叠的额外军力损失（至多 1 点）；由拥有者从撤退中的 DG 单位中选承受者 */
  extraLoss: number
  /** 9.12e：与撤退单位同格、被一并 DG 的友方战斗单位（去重） */
  dgCompanions: string[]
} {
  const results: RetreatResult[] = []
  for (const unit of input.units) {
    const entry = input.paths.find((item) => item.unitId === unit.id)
    results.push(
      resolveRetreat({
        unit,
        path: entry?.path ?? [],
        facts: input.facts,
      }),
    )
  }
  const dgCompanions = [...new Set(results.flatMap((result) => result.dgCompanions))]
  return {
    rule: '9.12c',
    results,
    extraLoss: results.some((result) => result.extraLoss > 0) ? 1 : 0,
    dgCompanions,
  }
}

/**
 * 一个**可撤退落点**的规划结论（供界面把「能退到哪」画到地图上、并让玩家点格即选）
 *
 * 纪律：本类型只是**规划**，不是判定。落点与路径仍要交给 `resolveRetreat` 复核后才生效。
 */
export interface RetreatDestinationPlan {
  /** 落点格 */
  hex: HexRef
  /** 9.12e：该格是否在敌方未抵消 ZOC 内（进入即 DG，且撤退堆叠此前已 DG 时再损失 1 点） */
  inEnemyZoc: boolean
  /** 起始格 → 落点的合法路径（含落点、**不含**起始格；长度＝完整撤退距离） */
  path: HexRef[]
  /**
   * 9.12 / 9.12b：选这个落点会**被消灭**
   *
   * 情形：撤退必然穿过敌方战斗单位/禁入地形（9.12：「则消灭这些单位」），或该单位在任何模式下
   * 都不可移动（9.12b：「在被迫撤退时会被直接摧毁」）。界面须把这类落点单独标注，由玩家自负后果。
   */
  forcedDestruction: boolean
}

/** 单调走法搜索（私有）：`passable` 决定是否绕开禁入格 */
function monotonePath(input: {
  from: HexRef
  to: HexRef
  distance: number
  passable: (hex: HexRef) => boolean
}): HexRef[] | null {
  const { from, to, distance } = input
  if (distance <= 0) return null
  if (hexDistance(from, to) !== distance) return null
  const path: HexRef[] = []
  const walk = (current: HexRef, remaining: number): boolean => {
    if (remaining === 0) return sameHex(current, to)
    const currentGap = hexDistance(current, to)
    for (const direction of HEX_DIRECTIONS) {
      const next = neighbor(current, direction)
      // 必须更贴近落点一格（单调），保证路径长度恰好等于直线距离
      if (hexDistance(next, to) !== currentGap - 1) continue
      if (!input.passable(next)) continue
      path.push(next)
      if (walk(next, remaining - 1)) return true
      path.pop()
    }
    return false
  }
  return walk(from, distance) ? [...path] : null
}

/**
 * 9.12：求**一条**从 `from` 到 `to` 的合法撤退路径（纯函数，供地图点选落点用）
 *
 * 规则依据（原文要点）：
 *   · 「撤退结束格与其开始撤退的格的**直线距离**，必须等于上述的格数」⇒ 先要求
 *     `hexDistance(from, to) === distance`，否则根本不可能合法；
 *   · 「撤退的路径不一定要是直线，它可以之字形避开禁入地形」⇒ 允许之字形，
 *     故按「每一步都**贴近落点**一格」的单调走法搜索（单调走法恰好给了
 *     `路径长度 == 直线距离`，这正是 9.12 的完整撤退距离条件），并在中途绕开禁入格；
 *   · 「必须穿过敌方占据格或禁入地形者被**消灭**」⇒ 本函数只给**不会必死**的路径，
 *     找不到就返回 null（必死路径由 `planRetreatDestinations` 另行标注，不在此伪装成合法）。
 *
 * 走法顺序固定按 `HEX_DIRECTIONS`，故同一输入永远给出同一条路径（可复算、可测试）。
 */
export function retreatPathTo(input: {
  from: HexRef
  to: HexRef
  /** 完整撤退距离（＝9.10a 选项里的撤退格数） */
  distance: number
  mobility: MobilityType
  side: Side
  facts: RetreatFacts
}): HexRef[] | null {
  const { from, facts } = input
  return monotonePath({
    from: input.from,
    to: input.to,
    distance: input.distance,
    // 9.12f/9.12：不穿敌方战斗单位格、不进禁入地形、也不绕回起点
    passable: (hex) =>
      !sameHex(hex, from) &&
      !facts.prohibitedFor(input.mobility, hex) &&
      !facts.enemyCombatUnitAt(hex, input.side),
  })
}

/**
 * 9.12 / 9.12a / 9.12b / 9.12e：罗列某单位在给定撤退格数下的**全部落点**（含路径）
 *
 * 用途：地图优先交互把「安全撤退格 / 有控制区影响的撤退格 / 必被消灭的落点」分别画出来，
 * 玩家点格即选定（`combatInputs.retreatPaths` 需要的就是这里的 `path` 文本）。
 *
 *   · 落点集合＝`hexesWithin(from, distance)` 中**直线距离恰为 distance** 的格（9.12 的完整撤退距离）；
 *   · 逐格先求**不会必死**的路径（`retreatPathTo`）；求不出再求纯几何单调路径并标
 *     `forcedDestruction: true` —— 9.12「必须穿过敌方占据格或禁入地形者被消灭」与 9.12b
 *     「任何模式下都不可移动者被迫撤退时被直接摧毁」都属于**规则允许的结果**，故必须可选，
 *     否则玩家在「必须撤退」的局面下无路可走（流程卡死）；
 *   · 两种路径都求不出（几何上不存在单调路线）者剔除 —— 那种格**连必死撤退都不成立**。
 *
 * 结果按 距离 → 列 → 行 排序（与 `hexesWithin` 同口径，确定性）。
 */
export function planRetreatDestinations(input: {
  from: HexRef
  /** 完整撤退距离（＝9.10a 选项里的撤退格数）；≤0 时无落点 */
  distance: number
  mobility: MobilityType
  side: Side
  facts: RetreatFacts
  /**
   * 9.12b：该单位在任何模式下都不可移动
   *
   * ⇒ 它无法「走到」任何落点，但**被迫撤退时会被直接摧毁**（原文），故仍列出纯几何落点并全部
   * 标成 `forcedDestruction: true`，让界面能如实呈现「这一步只能是这个单位被消灭」。
   */
  immobile?: boolean
  /** 可选的额外禁入判据（如落点已被堆叠占满、超出地图范围；由调用方给） */
  blocked?: (hex: HexRef) => boolean
}): RetreatDestinationPlan[] {
  if (input.distance <= 0) return []
  const plans: RetreatDestinationPlan[] = []
  const candidates = hexesWithin(input.from, input.distance, { onMapOnly: true }).filter(
    (hex) => hexDistance(input.from, hex) === input.distance,
  )
  for (const hex of candidates) {
    if (input.blocked?.(hex) === true) continue
    const clean = retreatPathTo({
      from: input.from,
      to: hex,
      distance: input.distance,
      mobility: input.mobility,
      side: input.side,
      facts: input.facts,
    })
    // 9.12b：不可移动者没有「合法路径」，只能被消灭
    const path =
      clean ??
      monotonePath({
        from: input.from,
        to: hex,
        distance: input.distance,
        passable: (candidate) => !sameHex(candidate, input.from),
      })
    if (path === null) continue
    plans.push({
      hex,
      inEnemyZoc: input.facts.inEnemyZocAt(hex, input.side),
      path,
      forcedDestruction: clean === null || input.immobile === true,
    })
  }
  return plans
}

/**
 * 9.12g：战后推进
 *
 * 「如果**所有**防御方单位都被摧毁或撤退，则攻击单位就可以进入防御方所在格。」
 *   A) 只有**消耗了战斗补给**的单位（含战斗值为零的）才能推进；
 *   B) 如果攻击方在**选项中选择了撤退**，则无法推进；
 *   C) 战后推进可夺取或摧毁敌方舰船、飞机与非战斗单位（走 9.14 判定）；
 *   D) **成功的突袭后必须**战后推进；常规战斗后由拥有者选择哪些攻击单位推进（可都不推）。
 *
 * 9.12b 末句：「在任何模式下都不可移动的单位，在被迫撤退时会被直接摧毁（**这种单位也无法
 *   战后推进**）」⇒ `candidates[].immobile` 为真者即便付过战斗补给也不得推进。
 */
export function resolveAdvanceAfterCombat(input: {
  attackType: SurpriseAttackType
  /** 防御格是否已无防御方单位（全被消灭或撤退） */
  defendingHexCleared: boolean
  /** 攻方是否在选项中选择了撤退 */
  attackerRetreated: boolean
  /** 候选推进单位（须为已付战斗补给者；`immobile` ＝ 9.12b 的不可移动单位） */
  candidates: readonly { id: string; paidCombatSupply: boolean; immobile?: boolean }[]
  /** 玩家选择的推进单位（常规战斗可省略＝不推进） */
  chosenUnitIds?: readonly string[]
  /**
   * 专规 1.1b：防御格是**敌方安全边缘格**（作为补给源的地图边格）⇒ 不得推进进去
   *
   * 该格「可以被常规战斗攻击，但不可被突袭（因为可能需要推进）」——故常规战斗下攻方只能不推进，
   * 而突袭本就不会被允许发起到这种格上（进入判据在 `move.isEnemySafeEdgeHex` 已拦）。
   */
  advanceIntoForbiddenHex?: boolean
}): RuleOutcome<{ advanceUnitIds: string[]; mandatory: boolean }> {
  if (input.attackerRetreated) return fail('9.12g-B', 'attackerRetreatedNoAdvance')
  if (!input.defendingHexCleared) return succeed('9.12g', { advanceUnitIds: [], mandatory: false })
  // 专规 1.1b：安全边缘格不可进入 ⇒ 不推进
  if (input.advanceIntoForbiddenHex === true)
    return succeed('专规 1.1b', { advanceUnitIds: [], mandatory: false })
  // 9.12g-A + 9.12b：付过战斗补给 **且** 并非「任何模式下都不可移动」
  const eligible = input.candidates.filter(
    (unit) => unit.paidCombatSupply && unit.immobile !== true,
  )
  const chosen = input.chosenUnitIds ?? []
  if (
    chosen.some((id) => input.candidates.some((unit) => unit.id === id && unit.immobile === true))
  )
    return fail('9.12b', 'immobileUnitCannotAdvance')
  if (input.attackType === 'overrun') {
    // ★ B33：无人可推（候选为空）是**合法结果**；有候选却没人付过补给才拒（见 9.12g-A）
    if (input.candidates.length === 0)
      return succeed('9.12g-D', { advanceUnitIds: [], mandatory: true })
    if (eligible.length === 0) return fail('9.12g-A', 'noUnitPaidCombatSupply')
    return succeed('9.12g-D', { advanceUnitIds: eligible.map((unit) => unit.id), mandatory: true })
  }
  if (chosen.some((id) => !eligible.some((unit) => unit.id === id)))
    return fail('9.12g-A', 'chosenUnitDidNotPayCombatSupply')
  return succeed('9.12g', { advanceUnitIds: [...chosen], mandatory: false })
}

/* ────────────────────────────── 工具与流程清单 ────────────────────────────── */

function sameHex(a: HexRef, b: HexRef): boolean {
  return a.col === b.col && a.row === b.row
}

/** 六角格邻接（复用 hex-geometry 的唯一几何实现） */
function areAdjacent(a: HexRef, b: HexRef): boolean {
  return HEX_DIRECTIONS.some((direction) => sameHex(neighbor(a, direction), b))
}

/** 9.2 九步流程的机器可读清单（供界面与日志按序提示；顺序即规则要求的结算顺序） */
export const BATTLE_SEQUENCE: readonly { step: string; rule: string; note: string }[] = [
  { step: 'composition', rule: '9.1', note: '攻方选择攻击格与防御格' },
  { step: 'combatSupply', rule: '9.5', note: '双方消耗战斗补给（守方可选择不付）' },
  { step: 'declareAr', rule: '9.6', note: '宣布 AR 单位：攻方先、守方后' },
  { step: 'declareTerrain', rule: '9.4', note: '守方宣布地形并确定初始攻防比' },
  { step: 'surprise', rule: '9.8', note: '掷 2 骰判奇袭并按 9.8 横移纵列' },
  { step: 'battleDice', rule: '9.9', note: '掷 2 骰 + DRM − 工事等级查战斗表' },
  { step: 'losses', rule: '9.11', note: '结算损失：攻方先、守方后，自 AR 单位起' },
  { step: 'options', rule: '9.10', note: '结算选项：撤退格数与损失军力任意组合' },
  { step: 'retreat', rule: '9.12', note: '撤退（含 DG 与敌方 ZOC 效果）' },
  { step: 'advance', rule: '9.12g', note: '防御格已空且攻方未撤退 ⇒ 战后推进' },
]
