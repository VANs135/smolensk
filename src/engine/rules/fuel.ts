import { rulesConstants } from '@/data'

/**
 * 燃料补给（OCS 12.5）——编队法 / HQ 法 / 单单位法、燃料的持续期与到期时点
 *
 * 条文出处（中文规则书 12.5 / 12.5a–g；5.8b 与 12.6e 另见模式与补给模块）：
 *   - 12.5a 使用轮式或履带 MP 的**战斗单位**要消耗 MP 就必须付燃料，否则**不能消耗任何 MP**；
 *           「即使就移动一格」也要付。步行单位、卡车、舰船、飞机、补给拖取/投递永远不需要燃料。
 *   - 12.5b 需要燃料才能移动的战斗单位，在**攻击、防御、轰炸、撤退、战后推进**时无需燃料；
 *           **突袭**需要——即使堆叠开始移动时就已与防御方相邻。
 *   - 12.5c 三种方法，均在**消耗发生的那一刻**支付：
 *           A) 编队法：1 SP 为一整个多单位编队加油（须共用同一 HQ 投递 / 同一补给站直接拖取，
 *              否则用不同来源的那些单位只能改走单单位法）；翻编队标记到「燃料已补给」面。
 *           B) HQ 法：1 SP 为 HQ 自己 + 其投递距离内的所有独立单位加油；在 HQ 上放燃料已补给标记。
 *           C) 单单位法：每个需要燃料的单位 1 T；任何单位都可用；**只在当前阶段有效**。
 *   - 12.5d 当前阶段玩家必须在**自己的清理阶段**移除 HQ 的燃料已补给标记、并把编队标记翻回未补给面。
 *   - 12.5e 付了 12.5c(B) 后，HQ 可为其投递距离内的所有独立单位「免费」加油（从而省下每单位每阶段 1T）；
 *           投递距离在**所有独立单位移动开始前**计算；已补给的 HQ 每阶段只能在**一个位置**投递燃料。
 *   - 12.5f 增援单位**部署不需要燃料**，但移动离开入场格时需要付燃料；抵达回合没有「免费燃料」。
 *   - 12.5g **部队储备不能用于燃料补给**。
 */

/* ────────────────────────────── 常量 ────────────────────────────── */

/** 多单位编队加油：1 SP（12.5c-A） */
export const FUEL_FORMATION_SP = rulesConstants.fuel.formationSp

/** HQ 加油：1 SP（12.5c-B） */
export const FUEL_HQ_SP = rulesConstants.fuel.hqSp

/** 独立单位加油：1 T（12.5c-C） */
export const FUEL_SINGLE_UNIT_T = rulesConstants.fuel.singleUnitT

/* ────────────────────────────── 词表 ────────────────────────────── */

/** 加油方法（12.5c） */
export type FuelMethod = 'formation' | 'hq' | 'singleUnit'

/** 燃料持续期 */
export type FuelDuration =
  /** 编队法 / HQ 法：持续到下一个**友方清理阶段**（12.5c-A/B、12.5d） */
  | 'untilNextFriendlyCleanUp'
  /** 单单位法：只在本阶段有效（12.5c-C） */
  | 'currentPhaseOnly'

/** 需要标记的形态（12.5c-A/B、12.5d） */
export type FuelMarker = 'formationMarker' | 'hqFuelMarker' | 'none'

/* ────────────────────────────── 需要燃料的单位/行动 ────────────────────────────── */

/**
 * 12.5a：该单位要消耗 MP 是否必须先付燃料
 *
 * 判据 = **战斗单位** ∧ 机动类型为轮式或履带；与 move.ts 的 requiresFuel 同源（12.5a）。
 */
export function requiresFuelToSpendMp(unit: {
  isCombat: boolean
  mobility: 'leg' | 'truck' | 'track'
}): boolean {
  return unit.isCombat && (unit.mobility === 'truck' || unit.mobility === 'track')
}

/** 需要燃料判定的行动（12.5a/12.5b） */
export const FUEL_RELEVANT_ACTIONS = [
  'move',
  'overrun',
  'attack',
  'defend',
  'barrage',
  'retreat',
  'advanceAfterCombat',
] as const

/** 行动类型 */
export type FuelRelevantAction = (typeof FUEL_RELEVANT_ACTIONS)[number]

/**
 * 12.5b：该行动是否需要付燃料
 *
 * 「需要消耗燃料补给才能移动的战斗单位，在攻击、防御、轰炸、撤退及战后推进时，无需燃料补给。
 *   突袭时，即使堆叠开始移动时已经与防御方相邻，也需要攻击方消耗燃料补给。」
 * 故只有**移动**与**突袭**需要；其余行动一律不需要。
 */
export function actionNeedsFuel(action: FuelRelevantAction): boolean {
  return action === 'move' || action === 'overrun'
}

/** 12.5g：部队储备不能用于燃料补给 */
export function fuelCanUseInternalStocks(): boolean {
  return false
}

/* ────────────────────────────── 费用与持续期 ────────────────────────────── */

/** 燃料费用计算输入 */
export interface FuelCostInput {
  method: FuelMethod
  /**
   * 编队法专用（12.5c-A）：编队内需要加油的单位是否**共用同一来源**
   * （同一 HQ 投递，或同一补给站直接拖取）。false 时规则要求把不同来源的单位改走单单位法。
   */
  commonSource?: boolean
  /** 单单位法专用（12.5c-C）：需要加油的单位数（每单位 1 T） */
  unitsNeedingFuel?: number
}

/** 燃料费用结果 */
export type FuelCostResult =
  | {
      ok: true
      /** 应付 SP 数（HQ 法已含 HQ 自身与其投递距离内的独立单位） */
      sp: number
      /** 应付 T 数 */
      t: number
      duration: FuelDuration
      marker: FuelMarker
      rule: string
    }
  | { ok: false; rule: string; reason: string }

/**
 * 计算一次加油的费用与形态（12.5c）
 *
 * 三种方法互不叠加：单位要么按编队法/HQ 法（到下一个友方清理阶段），要么按单单位法（只本阶段）。
 */
export function computeFuelCost(input: FuelCostInput): FuelCostResult {
  if (input.method === 'formation') {
    if (input.commonSource === false)
      return {
        ok: false,
        rule: '12.5c-A',
        reason: '编队内单位未共用同一 HQ/补给站来源，这些单位只能改走单单位法',
      }
    return {
      ok: true,
      sp: FUEL_FORMATION_SP,
      t: 0,
      duration: 'untilNextFriendlyCleanUp',
      marker: 'formationMarker',
      rule: '12.5c-A',
    }
  }
  if (input.method === 'hq') {
    return {
      ok: true,
      sp: FUEL_HQ_SP,
      t: 0,
      duration: 'untilNextFriendlyCleanUp',
      marker: 'hqFuelMarker',
      rule: '12.5c-B',
    }
  }
  const units = input.unitsNeedingFuel ?? 0
  if (units <= 0)
    return { ok: false, rule: '12.5c-C', reason: '单单位法需要至少一个需要燃料的单位' }
  return {
    ok: true,
    sp: 0,
    t: FUEL_SINGLE_UNIT_T * units,
    duration: 'currentPhaseOnly',
    marker: 'none',
    rule: '12.5c-C',
  }
}

/**
 * 12.5d：燃料何时到期
 *
 * 「当前阶段玩家必须在**自己的清理阶段**移除他指挥部的燃料已补给标记，并将他的编队标记翻面至
 *   燃料未补给的一面。」→ 编队法/HQ 法到期于**己方清理阶段**；单单位法只在本阶段有效。
 */
export function fuelExpiresAt(method: FuelMethod): FuelDuration {
  return method === 'singleUnit' ? 'currentPhaseOnly' : 'untilNextFriendlyCleanUp'
}

/**
 * 12.5c-C：该加油法的燃料在**换阶段**时是否失效
 *
 * 三种方法的持续期（12.5c）不同，这是本作唯一需要按时点区分的判据：
 *   - **单单位法**（12.5c-C）：「只在**当前阶段**有效」⇒ 换阶段即失效 → 本函数返回 true；
 *   - **编队法**（12.5c-A）/ **HQ 法**（12.5c-B）：持续到**下一个友方清理阶段**，
 *     到该方的清理阶段才由 12.5d 移除标记 → 换阶段不失效，返回 false。
 *
 * 两个时点各自负责一半，故同一枚燃料标记只会被清一次：
 * 换阶段清单单位法（本函数）、本方清理阶段清编队法/HQ 法（`cleanup.ts` 的 `planCleanUp`）。
 *
 * 典型后果：移动阶段用**单单位法**加的油，本阶段一结束就失效——单位若在战斗后拿到进击标记，
 * 进击阶段再移动必须重新加油；而敌方回合中本方反应阶段以**编队法 / HQ 法**加的油，
 * 可一路保留到本方回合的移动与进击阶段。
 */
export function fuelExpiresOnPhaseChange(method: FuelMethod): boolean {
  return fuelExpiresAt(method) === 'currentPhaseOnly'
}

/**
 * 3.2f：**独立单位**判据（12.5c-B/12.5e 的 HQ 法只覆盖独立单位）
 *
 * 「任何既**不属于多单位编队 (3.1c)** 也**不属于多军力单位 (3.2d)** 的单位都是『独立单位』。
 *   这在燃料补给 (12.5e) 中很重要。」
 * ⇒ 判据两项，缺一不可：
 *   ① `formation` 为空（3.1c 的多单位编队归属，**由数据定死**）；
 *   ② `printedSteps ≤ 1`（3.2d 的多军力单位，印值军力 > 1 者不是独立单位）。
 *
 * 用户 2026-09-17 裁定与本条一致：「编队单位肯定是定死的……**编队单位是无法利用 HQ 补给法的**」。
 */
export function isIndependentUnit(input: {
  /** 3.1c：多单位编队番号（`null`/缺省 ＝ 不属于任何编队） */
  formation?: string | null
  /** 3.2d：印值军力点数 */
  printedSteps: number
}): boolean {
  if (typeof input.formation === 'string' && input.formation.length > 0) return false
  return input.printedSteps <= 1
}

/**
 * 12.5c-B / 12.5e：HQ 法**能覆盖谁**
 *
 * 原文（B）「支付 1SP，为**指挥部自己**，及它投递距离内的**所有独立单位**提供燃料补给。」
 * 原文（12.5e）「……可『免费』为其投递距离内的**所有独立单位（定义见 3.2f）**提供燃料补给（从而避免
 *   单独单位使用燃料补给法每单位每阶段消耗 1T 的燃料）。」
 * ⇒ 只有 **①该指挥部自己** 与 **②独立单位** 能被 HQ 法覆盖；**编队单位与多军力单位都不在覆盖内**
 *   —— 它们要么走 12.5c-A 编队法（整编队 1SP），要么走 12.5c-C 单独单位法（每单位 1T；
 *   12.5c-C 明写「无论它是独立单位、多军力单位，还是多单位编队中的单位」）。
 */
export function hqFuelCovers(input: {
  /** 受益单位就是这台被付了 1SP 的指挥部自己 */
  targetIsTheHq: boolean
  /** 受益单位是独立单位（3.2f，见 `isIndependentUnit`） */
  targetIsIndependent: boolean
}): boolean {
  return input.targetIsTheHq || input.targetIsIndependent
}

/**
 * 12.5c-A：编队法**覆盖谁**（与 `hqFuelCovers` 同一层的姊妹判据）
 *
 * 原文：「为一整个多单位编队支付 1SP，便可为**整个**多单位编队提供燃料补给。……在需要燃料补给的编队中，
 *   检查每个单位使用了哪个指挥部或补给站进行补给的**投递或拖取**。如果为其中一些单位投递补给的不是
 *   同一个指挥部，或者一些单位直接拖取补给的来源不是同一个补给站，那么**这些使用不同来源的单位只能按
 *   单独单位燃料补给法**来获得燃料补给。」
 * ⇒ 覆盖 = ①属于**该编队**（3.1c 番号一致，本函数判这一半） ∧ ②该单位**能从本次付款的那个来源取到**
 *   （来源那一半按盘面事实由调用方判，分工同 `hqFuelCovers`）。
 *
 * ★ 用户 2026-09-18 报告第 7 条把这一条明确成界面行为：点一枚编队单位付编队法后，**同编队且在本次
 *   来源范围内**的其余单位（**含未被点选**的、也含当前朝向为**徒步面的摩托化单位** —— 它们日后转
 *   移动面开拔时油必须已经加好）一并加注；**来源范围之外**的同编队单位不参与，日后开拔按 12.5c-C
 *   单独单位法付。
 *
 * 与 `hqFuelCovers`（12.5c-B）互不替代：编队单位走不了 HQ 法、独立单位走不了编队法（用户 2026-09-17 裁定）。
 */
export function formationFuelCovers(input: {
  /** 3.1c：该单位的编队番号（`null`/缺省 ＝ 不属于任何编队） */
  unitFormation?: string | null
  /** 本次付款覆盖的编队番号（编队法要求受益单位同属一个编队） */
  fuelFormation?: string | null
}): boolean {
  const fuel = input.fuelFormation
  if (typeof fuel !== 'string' || fuel.length === 0) return false
  return input.unitFormation === fuel
}

/** 12.5c：某一种加油法**对本次受益单位集**是否成立（不成立时给出原因，供界面灰显） */
export interface FuelMethodAvailability {
  method: FuelMethod
  available: boolean
  /** 不可用的原因（含规则号）；可用时为 null */
  reason: string | null
}

/**
 * 12.5c：三种加油法**各自的适用范围**（用户 2026-09-17 的界面口径：点谁决定能点哪一法）
 *
 * 用户原话：「需要加油的单位点击时未加油都可以点**单独法**，**编队单位**有额外的**编队加油法**，
 *   点击 **HQ** 时才能加 **HQ 法**，因为 HQ 要移动本身也要按自身属性和规则来判断。」
 *
 * 与条文一一对应：
 *   · **12.5c-C 单独单位法**：「为每个需要燃料补给的单位支付 1T。**任何单位都可以使用此方法**，无论其
 *     RE 规模或军力多少，也无论它是独立单位、多军力单位，还是多单位编队中的单位。」⇒ 恒可用；
 *   · **12.5c-A 编队法**：「为**一整个多单位编队**支付 1SP」⇒ 需要受益单位**同属一个多单位编队**
 *     （3.1c 的番号，**由数据定死**），且（13.7a）共用同一来源 —— 来源那一半在 store 里按盘面事实另判；
 *   · **12.5c-B 指挥部法**：「支付 1SP，为**指挥部自己**，及它投递距离内的**所有独立单位**提供燃料补给。」
 *     ⇒ 受益单位里必须**有一台指挥部**（它才是付款与投递的主体；用户：「点击 HQ 时才能加 HQ 法」），
 *     且其余受益单位都必须是独立单位（3.2f）—— 编队单位与多军力单位都不在内。
 */
export function fuelMethodAvailability(input: {
  /** 本次受益单位（界面里已选中的那一批；空数组即"没选单位"） */
  targets: readonly {
    /** 该单位是不是指挥部 */
    isHq: boolean
    /** 3.1c：多单位编队番号（null ＝ 不属于任何编队） */
    formation: string | null
    /** 3.2f：是不是独立单位（`isIndependentUnit` 的结论） */
    isIndependent: boolean
  }[]
}): FuelMethodAvailability[] {
  const targets = input.targets
  const hqIndex = targets.findIndex((target) => target.isHq)

  /* 12.5c-C：任何单位都可以，逐个 1T ⇒ 只要有受益单位就成立 */
  const singleUnit: FuelMethodAvailability =
    targets.length === 0
      ? { method: 'singleUnit', available: false, reason: '12.5c-C：先选中要加油的单位' }
      : { method: 'singleUnit', available: true, reason: null }

  /* 12.5c-A：一整个多单位编队 ⇒ 受益单位须同属**一个**编队（3.1c 的番号非空且一致） */
  const formations = new Set(targets.map((target) => target.formation))
  const formationName = targets[0]?.formation ?? null
  const formationAvailable = targets.length > 0 && formations.size === 1 && formationName !== null
  const formation: FuelMethodAvailability = formationAvailable
    ? { method: 'formation', available: true, reason: null }
    : {
        method: 'formation',
        available: false,
        reason:
          targets.length === 0
            ? '12.5c-A：先选中要加油的单位'
            : formationName === null
              ? '12.5c-A：编队法只对**多单位编队**（3.1c）成立 —— 选中的单位不属于任何编队'
              : '12.5c-A：编队法要**一整个多单位编队** ⇒ 选中的单位来自多个编队，请分开付',
      }

  /* 12.5c-B：指挥部自己 + 其投递距离内的**独立单位** ⇒ 选中里须有 HQ，其余须是独立单位 */
  const nonHqIneligible = targets.filter(
    (target, index) => index !== hqIndex && !target.isIndependent,
  )
  const hqAvailable = hqIndex >= 0 && nonHqIneligible.length === 0
  const hq: FuelMethodAvailability = hqAvailable
    ? { method: 'hq', available: true, reason: null }
    : {
        method: 'hq',
        available: false,
        reason:
          hqIndex < 0
            ? '12.5c-B：HQ 法由**指挥部**付款并投递 ⇒ 先点选那台指挥部（点 HQ 才能加 HQ 法）'
            : `12.5c-B/3.2f：HQ 法只覆盖**独立单位**，而选中的单位里有非独立单位` +
              `${nonHqIneligible.length === 0 ? '' : `（${String(nonHqIneligible.length)} 枚）`}` +
              ` ⇒ 请改用编队法（12.5c-A）或单独单位法（12.5c-C）`,
      }

  return [singleUnit, formation, hq]
}

/**
 * 12.5e：HQ 法覆盖范围说明（供调用方判定谁被「免费」加油）
 *
 * 付了 12.5c(B) 的 1 SP 后，HQ 自己与其**投递距离内的所有独立单位**都获得燃料，不再逐单位付 1T。
 * 两点调用约定：
 *   ① 投递距离在**所有独立单位移动开始前**计算（移动中的 HQ 需要选起始格或结束格之一作为投递位置）；
 *   ② 已补给的 HQ 每阶段只能在**一个位置**投递燃料。
 */
export function hqFuelCoverage(throwRangeHexes: readonly number[]): {
  rule: string
  /** 投递距离须在移动前一次性确定（12.5e） */
  countBeforeMovement: true
  /** 每阶段只允许一个投递位置（12.5e） */
  singleThrowLocationPerPhase: true
  /** 各 HQ 的投递距离（格），由调用方按 13.1b 的印值给出 */
  throwRangeHexes: readonly number[]
} {
  return {
    rule: '12.5e',
    countBeforeMovement: true,
    singleThrowLocationPerPhase: true,
    throwRangeHexes,
  }
}

/**
 * 12.5f：增援单位的燃料待遇
 *
 * 「增援单位的部署不需要燃料补给，但是移动离开入场格时，则需要支付燃料补给（如有）。
 *   增援单位在抵达的回合，不会获得『免费的燃料补给』。」
 */
export function reinforcementFuelNeeded(options: {
  /** 本回合是否仍停留在入场格内（含仅部署） */
  stillInEntryHex: boolean
}): { needsFuel: boolean; rule: string } {
  return {
    needsFuel: !options.stillInEntryHex,
    rule: '12.5f',
  }
}
