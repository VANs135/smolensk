import { rulesConstants } from '@/data'

import { fail, succeed, type RuleOutcome } from '../result-types'
import type { InternalStocks } from '../state-types'
import { matchRowIndex } from '../tables/lookup'

/**
 * 补给与储备（OCS 12.0）——战斗补给成本 / 补给站爆破 / 部队储备判定
 */

/* ── 常量 ── */
export const SP_TO_T = rulesConstants.supply.spToT
export const TRACE_T_PER_TWO_RE = rulesConstants.supply.tracePerTwoReT
export const COMBAT_SUPPLY_ATTACKER_T_PER_STEP = rulesConstants.supply.combatAttackerTPerStep
export const COMBAT_SUPPLY_DEFENDER_T = rulesConstants.supply.combatDefenderT
export const COMBAT_SUPPLY_DEFENDER_MIN_T = rulesConstants.supply.combatDefenderMinT
export const DIRECT_DRAW_RANGE_MP = rulesConstants.supply.directDrawRangeMp
export const STOCK_LOW_T_PER_RE = rulesConstants.supply.stockLowTPerRe
/* 12.7a 的「5 点同型运输点」常量只有一处：`extender.ts` 的 `EXTENDER_REQUIRED_POINTS`
 * （本模块原有的同名副本 `EXTENDER_TRANSPORT_POINTS` 于批 F 切片 4② 删除）。 */
export const BREAKOUT_RANGE_HEXES = rulesConstants.supply.breakoutRangeHexes
export const BREAKOUT_FIRST_TURN_DRM = rulesConstants.supply.breakoutFirstTurnDrm
/** 12.8e：突围资格的印刷 MA 下限（「印刷的 MA 至少为 1」） */
export const BREAKOUT_MIN_PRINTED_MA = rulesConstants.supply.breakoutMinPrintedMa
/** 12.8e：突围成功的**最低修正骰**（掷骰 5–6 成功 ⇒ 阈值 5） */
export const BREAKOUT_SUCCESS_MIN_DICE = rulesConstants.supply.breakoutSuccessMinDice
export const DUMP_BLOW_PCT = rulesConstants.supply.dumpBlowPct

/* ── 战斗补给（9.5 / 12.4） ── */

export interface CombatSupplyCost {
  attackerT: number
  defenderT: number
}

/**
 * 战斗补给成本（9.5 / 12.4）
 *
 * 12.4 原文：「攻击者的消耗为**每个攻击的军力**各消耗 1T（例外：在《非洲军》中，2 军力的旅消耗为 1T）；
 *   防御者每次战斗的消耗合计为 2T（例外：对于 1RE 或以下规模的防御者，消耗仅为 1T）。」
 * 故**攻方按军力点数（step，3.2）计**、守方按**总 RE** 是否 ≤1 取 1T 或 2T。
 * 本作是斯摩棱斯克而非《非洲军》，故不使用 2 军力旅的例外。
 */
export function computeCombatSupplyCost(opts: {
  /** 参战**攻击军力点数**（step；不是 RE——两者在 9.5 的战斗补给里口径不同） */
  attackerSteps: number
  /** 参战**守方总 RE**（4.6；≤1 时守方只耗 1T） */
  defenderRE: number
}): CombatSupplyCost {
  const attackerT = opts.attackerSteps * COMBAT_SUPPLY_ATTACKER_T_PER_STEP
  const defenderT = opts.defenderRE <= 1 ? COMBAT_SUPPLY_DEFENDER_MIN_T : COMBAT_SUPPLY_DEFENDER_T
  return { attackerT, defenderT }
}

/**
 * 12.4 重要提示：攻方**必须**满足完整的战斗补给消耗要求才能攻击
 *
 * 「无法满足完整战斗补给消耗要求的单位无法攻击」——故这不是「有多少付多少」，
 * 而是**全额付清才可攻**（不足则只能改用部队储备，见 `canUseInternalStocks`，或放弃进攻）。
 */
export function canAffordAttackSupply(input: {
  requiredT: number
  availableT: number
}): { ok: true; rule: string } | { ok: false; rule: string; reason: string; detail: string } {
  if (input.availableT < input.requiredT)
    return {
      ok: false,
      rule: '12.4',
      reason: 'attackSupplyNotFull',
      detail: `须全额 ${input.requiredT} T，仅有 ${input.availableT} T：无法满足完整战斗补给者不能攻击`,
    }
  return { ok: true, rule: '12.4' }
}

/**
 * 12.4 / 9.5a：防御方的战斗补给取舍
 *
 * 「防御方始终可以选择保留而不消耗战斗补给，以**一半的战斗值**进行防御。」
 * 注意防御方**无需**全额付清即可参战（与攻方不同）：不付即 1/2 战斗值。
 */
export function defenderCombatSupplyOption(input: { provided: boolean }): {
  rule: string
  /** 防御战斗值倍率：付了＝1，未付＝1/2 */
  defenseMultiplier: number
  detail: string
} {
  return input.provided
    ? { rule: '12.4', defenseMultiplier: 1, detail: '守方支付战斗补给' }
    : {
        rule: '12.4',
        defenseMultiplier: 0.5,
        detail: '守方选择不消耗战斗补给：以一半战斗值防御',
      }
}

/**
 * 12.10a：能否使用部队储备
 *
 * 「只有在单位无法从图上补给获得所需 SP 时（通过直接拖取或从指挥部投递），才能使用部队储备。
 *   （例外：如果唯一可用的补给站是装载在编内卡车上的 SP，则可以使用部队储备）」
 */
export function canUseInternalStocks(input: {
  /** 图上补给是否可得（直接拖取或 HQ 投递；由 B10 判定） */
  onMapSupplyAvailable: boolean
  /** 唯一可用的补给站是否只是编内卡车上的 SP（12.10a 的例外） */
  onlyOrganicTruckSp?: boolean
}): { ok: true; rule: string } | { ok: false; rule: string; reason: string; detail: string } {
  if (input.onlyOrganicTruckSp === true) return { ok: true, rule: '12.10a' }
  if (input.onMapSupplyAvailable)
    return {
      ok: false,
      rule: '12.10a',
      reason: 'onMapSupplyAvailable',
      detail: '能从图上补给获得所需 SP 时不得使用部队储备',
    }
  return { ok: true, rule: '12.10a' }
}

/* ── 12.10 部队储备：支付战斗补给（12.10a/b/c/g/h） ── */

/** 部队储备档位（`ready` 用 `null` 表示＝未使用过，与 `InternalStocks` 同口径） */
export type StockLevel = Exclude<InternalStocks, null>

/** 参与付款的一个单位（攻方按**军力**、守方按**整堆叠的一次性需求**，由调用方给所需 T） */
export interface StockFundingUnit {
  unitId: string
  /** 该单位本次需要承担的 T（攻方＝其军力点数；守方＝守方合计需求摊到该单位） */
  requiredT: number
  /** 该单位当前的部队储备档位（`null` ＝ ready，未使用过） */
  internalStocks: InternalStocks
}

/** 某个单位本次用哪种方式付 */
export interface StockFunding {
  unitId: string
  source: 'map' | 'stocks'
  t: number
  /** 用储备者的档位变化（ready→low、low→exhausted） */
  from: StockLevel | null
  to: StockLevel | null
}

/** 12.10 付款规划结论 */
export interface CombatSupplyFunding {
  funding: StockFunding[]
  /** 图上 T 的**实耗**（含 12.10h 的浪费） */
  mapTUsed: number
  /** 12.10h：图上补给被浪费掉的部分（已计入 `mapTUsed`） */
  wastedT: number
  /** 本笔共降级了几个单位（供日志） */
  downgraded: number
  rule: string
  detail: string
}

/**
 * 12.10a/b/c/g/h：战斗补给付款时**能不能动用部队储备、动了之后怎么标记**
 *
 * 条文（12.10 全段，逐句落实）：
 *   · 「部队储备是指，当单位**无法获得所需的 SP** 时，单位可以使用的弹药补给。部队储备**只能**用于
 *     战斗补给（见 9.5b），不能用于轰炸、追溯补给、燃料补给等。无论单位使用部队储备还是图上补给，
 *     单位的战斗值都是一样的。」⇒ 本函数只服务 9.5b 的战斗补给；
 *   · **12.10a**「只有在单位无法从图上补给获得所需 SP 时（通过直接拖取或从指挥部投递），才能使用
 *     部队储备。（例外：如果唯一可用的补给站是装载在编内卡车上的 SP，则可以使用部队储备）」；
 *   · **12.10b**「当一个单位从其部队储备中获得战斗补给时，将它标记为部队储备低下。如果该单位已
 *     标记为部队储备低下，则将标记翻面为部队储备耗尽。」⇒ **用一次就降一级**，不存在"折算多少 T"；
 *   · **12.10c**「……如果无法使用正常的战斗补给，则**带有耗尽标记的单位无法攻击**」；
 *   · **12.10g**「部队储备和 SP 可以**混合**在一起用于支付战斗补给。（例外：**单个算子**——即使
 *     是多军力的算子，例如一个师，**要么使用部队储备，要么使用图上补给**。）」⇒ 逐单位**全额**二选一；
 *   · **12.10h**「如果一个多军力单位因为没有足够的图上补给，而选择使用部队储备，此时图上补给也会
 *     被消耗掉（图上补给直接被浪费）」。
 *
 * 规则书两个例子（本实现复现）：
 *   ① 3 个 1RE 单位攻击、手上 1T ⇒ 1T 付其中一个单位，另两个被标记低下（`wastedT = 0`）；
 *   ② 同样攻击由一个多军力单位（需 3T）完成、手上 1T ⇒ 该单位被标记低下，而**那 1T 被浪费**。
 */
export function planCombatSupplyFunding(input: {
  units: readonly StockFundingUnit[]
  /** 图上可动用的 T（12.3a 直接拖取 ∪ 12.3b 指挥部投递的**实得**量） */
  availableMapT: number
  /**
   * 12.10a 的例外：该单位所需 SP 的唯一可用来源是**编内卡车上的 SP** ⇒ 允许用储备
   *
   * 缺省按「图上 T 不足以全额支付该单位」判定（即 12.10a 的正面条件）。
   */
  onlyOrganicTruck?: (unitId: string) => boolean
}): RuleOutcome<CombatSupplyFunding> {
  const totalRequired = input.units.reduce((sum, unit) => sum + Math.max(0, unit.requiredT), 0)
  if (totalRequired <= 0)
    return succeed('12.10', {
      funding: [],
      mapTUsed: 0,
      wastedT: 0,
      downgraded: 0,
      rule: '12.10',
      detail: '无需战斗补给（需求为 0）',
    })

  let remainingMapT = Math.max(0, input.availableMapT)
  const funding: StockFunding[] = []
  let downgraded = 0

  for (const unit of input.units) {
    const need = Math.max(0, unit.requiredT)
    if (need <= 0) continue
    // 12.10g：单个算子全额二选一 —— 只有图上 T 能**全额**付清它时才走图上
    if (remainingMapT >= need) {
      remainingMapT -= need
      funding.push({ unitId: unit.unitId, source: 'map', t: need, from: null, to: null })
      continue
    }
    // 走部队储备：先过 12.10a 的闸门
    const verdict = canUseInternalStocks({
      onMapSupplyAvailable: false,
      ...(input.onlyOrganicTruck?.(unit.unitId) === true ? { onlyOrganicTruckSp: true } : {}),
    })
    if (!verdict.ok) return fail(verdict.rule, verdict.reason)
    // 12.10c：已耗尽者无法再用 ⇒ 攻方不满足全额需求即不得攻击（12.4 重要提示）
    if (unit.internalStocks === 'exhausted')
      return fail('12.10c', `internalStocksExhausted:${unit.unitId}`)
    const from: StockLevel | null = unit.internalStocks ?? null
    const to: StockLevel = from === 'low' ? 'exhausted' : 'low'
    downgraded += 1
    funding.push({ unitId: unit.unitId, source: 'stocks', t: need, from, to })
  }

  const byStocks = funding.filter((item) => item.source === 'stocks')
  const mapAssigned = Math.max(0, input.availableMapT) - remainingMapT
  /*
   * 12.10h：「如果一个多军力单位因为没有足够的图上补给，而选择使用部队储备，此时图上补给
   * 也会被消耗掉（图上补给直接被浪费）」——只有**真有人改用储备**时，凑不满任何单位的那点
   * 图上 T 才会被消耗（规则书例②：需 3T 的多军力单位 + 手上 1T ⇒ 标记低下且那 1T 浪费）。
   * 若全部单位都由图上付清，剩下的 T 只是**没取用**，不算消耗。
   */
  const wastedT = byStocks.length > 0 ? remainingMapT : 0
  const mapTUsed = mapAssigned + wastedT

  return succeed('12.10', {
    funding,
    mapTUsed,
    wastedT,
    downgraded,
    rule: '12.10',
    detail:
      `战斗补给付款：图上取用 ${mapAssigned} T` +
      (wastedT > 0 ? `（另有 ${wastedT} T 因单个算子不得混用而浪费，12.10h）` : '') +
      (byStocks.length === 0
        ? '，未动用部队储备'
        : `；${byStocks.length} 个单位动用部队储备（12.10b：${byStocks
            .map((item) => `${item.unitId} ${item.from ?? 'ready'}→${item.to}`)
            .join('、')}）`),
  })
}

/* ── 补给站爆破（12.11a） ── */

/**
 * 补给站爆破损失百分比（12.11a）
 *
 * DUMP_BLOW_PCT 为「骰面值段 → 损失%」表（键如 `1` / `2-3` / `4-5` / `6`）；
 * 骰值按区间命中对应百分比。
 */
export function computeDumpBlowLoss(die: number): number {
  const labels = Object.keys(DUMP_BLOW_PCT)
  if (labels.length === 0) return 0
  const index = matchRowIndex(labels, die, 'dump_blow')
  return DUMP_BLOW_PCT[labels[index]!] ?? 0
}

/* ────────────────── 13.2g-B：编内卡车的 SP 只许同一编队拖取 ────────────────── */

/**
 * 13.2g-B：**从运输点数算子拖取 SP 的资格**
 *
 * 原文：**13.2g**「编内卡车……与其他运输点数基本一样，但有几点例外：……**B) 只允许同一多单位编队内的
 *   单位拖取它们的 SP**……」；同段末句：「玩家可以使用指挥部，将装载于**编内卡车**的补给，投递给
 *   **同一多单位编队内**的单位。」
 *
 * ⇒ 判据两条：
 *   ① **只有编内卡车**受此限（13.2g 讲的是编内卡车；常规运输点数按 13.2f/12.1b 照常可拖）；
 *   ② 编内卡车 ⇒ 拖取方须与其**同属一个多单位编队**（3.1c 的番号相等，且**两者都非空** ——
 *      数据缺编队号的编内卡车**不**因此变成"谁都能拖"）。
 *
 * ★ 用户 2026-09-17 裁定「编队单位肯定是定死的」⇒ 编队号一律来自数据（`unit.formation`），不由玩家声明。
 */
export function canDrawFromCarrier(input: {
  /** 承运算子是不是**编内卡车**（13.2g / 13.2h） */
  carrierIsOrganicTruck: boolean
  /** 承运算子的编队番号（3.1c；非编内卡车传 null 亦可） */
  carrierFormation: string | null
  /** 拖取方的编队番号（3.1c） */
  drawerFormation: string | null
}): boolean {
  if (!input.carrierIsOrganicTruck) return true
  if (input.carrierFormation === null || input.drawerFormation === null) return false
  return input.carrierFormation === input.drawerFormation
}
