import type { HexRef, Side } from '@/data'

import { fail } from '../result-types'
import type { GamePhase } from '../state-types'
import { canOverrun, type OverrunCheck } from './move'
import type { MoveContext } from './move-types'
import { OVERRUN_MP_COST } from './combat'
import type { SurpriseAttackType } from '../tables/surprise'

/**
 * 突袭（B14，OCS 8.0 / 8.1）
 *
 * 突袭是**移动环节里可能发生的一种战斗形式**：把移动中的堆叠挪到目标格**相邻格**、宣布突袭，
 * 然后**照 9.2 的战斗流程**结算（只是奇袭概率更高，见 9.8 的 overrun 行）。
 * 本模块只做「突袭特有」的部分——**资格门槛之外的程序与后果**；战斗本身的判定与结算在 B12
 * （`battle.ts`，以 `attackType: 'overrun'` 调用）。
 *
 * ## 条文索引（中文规则书 8.0 / 8.1）
 *   - 8.0  发生在**各个移动环节**；仅针对**存在敌方战斗单位**的格（若目标格只有非战斗单位、
 *          舰船、飞机，则改走 **9.14 特殊战斗**）；突袭从**相邻格**发起，攻击方实际上**不进入**
 *          防御方格，**除非防御方离开了它所在的格**；
 *          结算照 9.2 流程（奇袭概率更高）；
 *          **未撤退且有足够剩余 MP ⇒ 可继续移动并再次突袭**（对相同或其他目标皆可）；
 *          **防御方撤退或被摧毁 ⇒ 所有攻击单位必须进入该格（无需额外移动消耗）**
 *   - 8.1  参突单位须在**阶段开始时**就堆叠在一起、**可攻击**、处于**战斗/移动/进击模式**；
 *          只要 MA 允许可突袭任意次；同一防御格在一个移动环节内可被突袭任意次；每次单独结算
 *   - 8.1a **每突袭一次消耗 3 MP**；若结果允许占领防御方格，**进入该格无需额外 MP**；
 *          **剩余 MP 不足 3 的单位不能突袭**
 *   - 8.1b 只有**进入该格的 MP ≤ 3**（格内＋格边＋运输破坏之和）才可突袭；写为「全部」的地形不可突袭
 *   - 8.1c 不得用**道路/桥梁**降低该格 MP、不能抵消禁入地形、也不能用来满足 6.1d
 *   - 8.1d 每次突袭针对一个相邻敌方格；同阶段同格可被多次突袭；移动堆叠可多次突袭
 *   - 8.1e **任何单位在突袭时都不会获得进击标记**
 *   - 8.1f 若在**一个或多个选项结果中选择撤退**，则**结束它们在当前阶段中的移动**；不撤退则可继续移动
 *   - 8.1g **只有进行突袭的单位**才能与正在突袭中的堆叠一同移动
 *   - 8.1h 不参与突袭的友方单位可留在突袭格内；它们**计入堆叠上限（4.8a）**但不参与，
 *          且**突袭结果对它们没有任何影响**
 *
 * ## 与既有模块的分工（不重复实现）
 *   - 8.1 / 8.1a / 8.1b / 8.1c / 8.1d 的**资格门槛**（含 4.8a 超堆叠、5.10b DG、12.7 延补队面、
 *     12.5a 燃料、8.1c 的 forOverrun 计费）：`move.ts#canOverrun` —— 本模块直接委托；
 *   - 9.2 战斗流程与 9.13b-B（突袭不给进击）：`battle.ts`；
 *   - 9.8 奇袭表：`tables/surprise.ts` 的 `overrun` 行。
 */

/* ────────────────────────────── 常量与词表 ────────────────────────────── */

/**
 * 可发生突袭的 SOP 段（8.0：「在各个移动环节中」）
 *
 * 即 2.2 的三个移动环节：移动阶段 / 反应阶段 / 进击阶段（各自含他们的战斗环节）。
 */
export const OVERRUN_SEGMENTS: readonly GamePhase[] = ['movement', 'reaction', 'exploitation']

/** 突袭所用的奇袭表行（8.0：突袭的奇袭概率更高，9.8 用 overrun 行） */
export const OVERRUN_ATTACK_TYPE: SurpriseAttackType = 'overrun'

/** 8.1a：每次突袭的 MP 消耗（＝rules-constants.combat.overrunMpCost） */
export const OVERRUN_COST_MP = OVERRUN_MP_COST

/** 突袭资格判定结果 */
export type OverrunEligibility =
  | { ok: true; rule: string; mpCost: number; entryCost: number }
  | {
      ok: false
      rule: string
      reason: string
      /** 8.0：目标格内没有敌方**战斗**单位 ⇒ 应改走 9.14 特殊战斗，而不是突袭 */
      useSpecialCombat?: boolean
    }

/* ────────────────────────────── 8.0 资格与触发 ────────────────────────────── */

/**
 * 8.0 / 8.1：能否发起这次突袭
 *
 * 顺序即规则顺序：① 必须是移动环节（8.0）；② 目标格必须有**敌方战斗单位**，否则改走 9.14（8.0 末段）；
 * ③ 其余门槛交给 `move.ts#canOverrun`（8.1 系列，含 8.1a 的 3 MP、8.1b 的 ≤3 MP 地形门槛、
 *    8.1c 的「不得用道路降费」、8.1d 的相邻、4.8a 的超堆叠、5.10b 的 DG、12.7 的延补队面）。
 *
 * @param defenders 目标格内的**全部**单位（战斗与非战斗都要给，用于区分 9.14 与 8.0）
 */
export function overrunEligibility(input: {
  /**
   * 当前 SOP 段（8.0：必须是移动环节）
   *
   * 注意与 `context.phase` 的区别：`MoveContext.phase` 的类型只允许三个移动环节
   * （`MovementSegmentPhase`），故「当前是不是移动环节」必须由调用方按真实段位传入。
   */
  phase: GamePhase
  context: MoveContext
  /** 本次参突的单位实例 id（8.1：须阶段开始即同格堆叠） */
  unitIds: readonly string[]
  /** 目标格（相邻的敌方格） */
  target: HexRef
  /** 参突单位剩余的 MP（8.1a：不足 3 不能突袭） */
  mpRemaining: number
  /** 8.1：参突单位本阶段开始时是否同格堆叠在一起 */
  startedStackedTogether: boolean
  /** 目标格内单位（含非战斗单位，用于 8.0 的「只有非战斗单位 ⇒ 走 9.14」判定） */
  defenders: readonly { id: string; isCombat: boolean }[]
}): OverrunEligibility {
  if (!OVERRUN_SEGMENTS.includes(input.phase))
    return fail('8.0', `notAMovementSegment:${input.phase}`)

  // 8.0：突袭仅针对有敌方**战斗**单位的格；否则（只有非战斗单位/舰船/飞机）改走 9.14
  if (!input.defenders.some((unit) => unit.isCombat))
    return { ok: false, rule: '8.0', reason: 'noEnemyCombatUnit', useSpecialCombat: true }

  const check: OverrunCheck = canOverrun({
    context: input.context,
    unitIds: input.unitIds,
    target: input.target,
    mpRemaining: input.mpRemaining,
    startedStackedTogether: input.startedStackedTogether,
  })
  if (!check.ok) return check
  return { ok: true, rule: '8.1', mpCost: check.mpCost, entryCost: check.entryCost }
}

/* ────────────────────────────── 8.0 / 8.1a/f 突袭后的后果 ────────────────────────────── */

export interface OverrunAftermath {
  rule: string
  /** 本次突袭实际消耗的 MP（8.1a：固定 3 MP） */
  mpSpent: number
  /** 结算后剩余的 MP（进入防御方格不再额外扣费，8.1a） */
  mpRemaining: number
  /** 8.0：防御方撤退或被摧毁 ⇒ **所有**攻击单位必须进入该格（无需额外 MP） */
  mustEnterDefenderHex: boolean
  /** 8.0：是否可继续移动并再次突袭 */
  mayContinueMoving: boolean
  /** 8.1f：攻击方在选项中撤退 ⇒ 其在**当前阶段**的移动结束（唯一会让移动结束的情形） */
  movementEndsThisPhase: boolean
  /** 8.1e：突袭永不给予进击标记 */
  exploitGranted: false
  detail: string
}

/**
 * 8.0 末段 / 8.1a / 8.1e / 8.1f：突袭结算后的移动与状态后果
 *
 * 三种收敛情形：
 *   ① 攻击方在**选项中选择撤退** ⇒ 当前阶段移动结束（8.1f），不进入防御方格（8.0）；
 *   ② 攻击方未撤退、**防御方撤退或被摧毁** ⇒ **所有**攻击单位必须进入该格、**不额外消耗 MP**（8.0/8.1a）；
 *   ③ 攻击方未撤退、防御方仍在格内 ⇒ 双方相持，攻击方停在原格。
 * ②③ 两种情形下 **8.1f 都允许继续移动**（不撤退即可继续）；是否还能**再突袭**另看 8.1a 的 3 MP 门槛
 * （`mayContinueMoving` 表达的就是「剩余 ≥3 MP ⇒ 可再突袭」，不是「能否继续移动」）。
 * 任何情形都**不给予进击标记**（8.1e）。
 */
export function resolveOverrunAftermath(input: {
  /** 本次突袭前的剩余 MP（8.1a：不足 3 无法突袭，故应 ≥3） */
  mpRemainingBefore: number
  /** 攻击方是否在（一个或多个）选项结果中选择了撤退（8.1f） */
  attackerRetreatedInOptions: boolean
  /** 防御方是否已离开该格：撤退或被摧毁（8.0） */
  defenderLeftHex: boolean
}): OverrunAftermath {
  if (input.mpRemainingBefore < OVERRUN_COST_MP)
    throw new RangeError(
      `[overrun] 剩余 ${input.mpRemainingBefore} MP < ${OVERRUN_COST_MP} MP，本不应发起突袭（8.1a）`,
    )

  // 8.1a：每次突袭固定 3 MP；进入防御方格不额外扣费
  const mpRemaining = input.mpRemainingBefore - OVERRUN_COST_MP

  if (input.attackerRetreatedInOptions) {
    return {
      rule: '8.1f',
      mpSpent: OVERRUN_COST_MP,
      mpRemaining,
      mustEnterDefenderHex: false,
      movementEndsThisPhase: true,
      mayContinueMoving: false,
      exploitGranted: false,
      detail: '攻击方在选项中撤退：其在当前阶段中的移动结束（8.1f）',
    }
  }

  const mayContinueMoving = mpRemaining >= OVERRUN_COST_MP
  if (input.defenderLeftHex) {
    return {
      rule: '8.0',
      mpSpent: OVERRUN_COST_MP,
      mpRemaining,
      mustEnterDefenderHex: true,
      movementEndsThisPhase: false,
      mayContinueMoving,
      exploitGranted: false,
      detail:
        `防御方已撤退或被摧毁：所有攻击单位必须进入该格（无需额外 MP）；` +
        `剩余 ${mpRemaining} MP${mayContinueMoving ? '，可继续移动并再次突袭' : '，仍可继续移动（但不足以再次突袭）'}`,
    }
  }

  return {
    rule: '8.0',
    mpSpent: OVERRUN_COST_MP,
    mpRemaining,
    mustEnterDefenderHex: false,
    movementEndsThisPhase: false,
    mayContinueMoving,
    exploitGranted: false,
    detail:
      `防御方仍在格内：攻击方停在原格；剩余 ${mpRemaining} MP` +
      `${mayContinueMoving ? '，可继续移动并再次突袭' : '，仍可继续移动（但不足以再次突袭）'}`,
  }
}

/**
 * 8.0 / 8.1a / 8.1f / 8.1g：把突袭后果换算成**移动记账**（供状态层落盘）
 *
 * 引擎不写状态（CODE_SPEC §3.1），故这里只产出补丁；状态层的移动交互据此更新
 * 各单位的位置与已耗 MP，并决定是否把参突单位移入防御方格。
 *
 * 逐条对照：
 *   - **8.1a**：每次突袭固定花 3 MP（`aftermath.mpSpent`）；进入防御方格**不额外扣费**；
 *   - **8.1g**：只有参突单位随堆叠移动 —— 留驻者不进补丁、其 MP 分文不动；
 *   - **8.1h**：留驻者不受结果影响（故也不在 `endedIds` 里）；
 *   - **8.1f**：**只有**攻击方在选项中撤退才结束其本阶段移动（唯一来源是
 *     `aftermath.movementEndsThisPhase`）；未撤退则继续移动，剩余不足 3 MP 只是不能再突袭；
 *   - **8.0**：防御方离开该格 ⇒ 参突单位**必须**进入该格。
 */
export interface OverrunMovePatch {
  unitId: string
  /** 8.1a：突袭后的累计已耗 MP */
  spentMp: number
  /** 需要移入防御方格时给出目标格；null = 留在原格 */
  hex: HexRef | null
  /** 8.1f：本阶段移动是否就此结束（仅在选项中选择撤退时为真） */
  ended: boolean
}

export interface OverrunMovePlan {
  rule: string
  /** 参突单位（8.1g）的记账补丁；留驻者不在其中 */
  patches: OverrunMovePatch[]
  /** 8.0：是否须把参突单位移入防御方格（状态层应在防御格**确实清空**后执行） */
  enterDefenderHex: boolean
  /** 8.1g：参突单位 id */
  participantIds: string[]
  /** 8.1f / 8.0：本阶段不得再动的单位 */
  endedIds: string[]
  /** 8.0：是否可继续移动并再次突袭 */
  mayContinueMoving: boolean
  /** 给状态层记账的活跃单位里找不到的参突者（如实报出，不静默） */
  missingParticipantIds: string[]
  detail: string
}

export function planOverrunMove(input: {
  /** 当前活跃的移动单位（来自 `MoveInteractionState` 的运行期视图） */
  runtime: readonly { unitId: string; hex: HexRef; spentMp: number; ended: boolean }[]
  /** 8.1g：本次参突单位（留驻者不参与） */
  participantIds: readonly string[]
  /** 防御方格 */
  target: HexRef
  /** `resolveOverrunAftermath` 的结论 */
  aftermath: OverrunAftermath
}): OverrunMovePlan {
  const { aftermath } = input
  const patches: OverrunMovePatch[] = []
  const endedIds: string[] = []
  const missingParticipantIds: string[] = []

  for (const unitId of input.participantIds) {
    const unit = input.runtime.find((item) => item.unitId === unitId)
    if (unit === undefined) {
      missingParticipantIds.push(unitId)
      continue
    }
    // 8.1f：**只有**「在选项结果中选择撤退」才结束其在当前阶段中的移动。
    // 剩余 MP < 3 只是「不能再突袭」（8.1a），普通移动照旧可用 ⇒ 这里不置 ended。
    const ended = aftermath.movementEndsThisPhase
    patches.push({
      unitId,
      spentMp: unit.spentMp + aftermath.mpSpent,
      hex: aftermath.mustEnterDefenderHex ? { ...input.target } : null,
      ended,
    })
    if (ended) endedIds.push(unitId)
  }

  const enterText = aftermath.mustEnterDefenderHex
    ? `；参突 ${patches.length} 枚须进入 ${input.target.col}.${input.target.row}（不额外扣 MP）`
    : '；参突单位留在原格'
  return {
    rule: aftermath.rule,
    patches,
    enterDefenderHex: aftermath.mustEnterDefenderHex,
    participantIds: [...input.participantIds],
    endedIds,
    mayContinueMoving: aftermath.mayContinueMoving,
    missingParticipantIds,
    detail: `突袭记账（8.1a 每次 ${aftermath.mpSpent} MP）${enterText}${aftermath.detail}`,
  }
}

/* ────────────────────────────── 8.1g / 8.1h 参突堆叠 ────────────────────────────── */

export interface OverrunStackSplit {
  rule: string
  /** 8.1g：只有进行突袭的单位才与突袭堆叠一同移动 */
  participantIds: string[]
  /** 8.1h：不参与突袭的友方单位留在原格；结果对它们没有任何影响 */
  stayIds: string[]
  /** 8.1h：原格堆叠规模仍需满足 4.8a（留驻单位照常计入） */
  originStackRe: number
  detail: string
}

/**
 * 8.1g / 8.1h：把「同格友军」拆成参突者与留驻者
 *
 * 「只有进行突袭的单位，才能与正在突袭中的堆叠一同移动」（8.1g）；
 * 「其他不进行突袭的友方单位可以位于进行突袭的格内……影响该格的堆叠限制（4.8a），
 *   但不参与突袭。突袭的战斗结果对这些单位没有任何影响」（8.1h）。
 * 故原格留驻单位仍计入堆叠规模（4.8a 的判定已由 `canOverrun` 在执行时把关）。
 */
export function splitOverrunStack(input: {
  side: Side
  /** 同格的全部友方单位（含不参突者） */
  friendlyUnits: readonly { id: string; re: number; isCombat: boolean }[]
  /** 参与本次突袭的单位 id */
  participantIds: readonly string[]
}): OverrunStackSplit {
  const participantIds = input.friendlyUnits
    .filter((unit) => input.participantIds.includes(unit.id))
    .map((unit) => unit.id)
  const stayIds = input.friendlyUnits
    .filter((unit) => !input.participantIds.includes(unit.id))
    .map((unit) => unit.id)
  // 4.8a：只计**战斗单位**的 RE（与非战斗单位的堆叠规则见 4.8）
  const originStackRe = input.friendlyUnits
    .filter((unit) => unit.isCombat)
    .reduce((sum, unit) => sum + unit.re, 0)
  return {
    rule: '8.1g',
    participantIds,
    stayIds,
    originStackRe,
    detail: `参突 ${participantIds.length} 个单位随堆叠移动；留驻 ${stayIds.length} 个（8.1h：计入 4.8a 但不参突、不受结果影响）`,
  }
}
