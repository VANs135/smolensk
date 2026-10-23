import { arrivalsAxis, chartsSupplyRepl, rulesConstants } from '@/data'
import type { Side } from '@/data'

import { fail, succeed, type RuleOutcome } from '../result-types'
import { matchRowIndex } from '../tables/lookup'
import {
  replTableRoll,
  specialReplRoll,
  supplyTableRoll,
  REPL_ROLL_DRM_FROM_19_AUG,
  type ReplRollResult,
  type SpecialReplResult,
} from '../tables/supply-repl'
import { isInRandomEventPeriod, isRailCapBoosted, isSpecialReplAvailable } from './timing'
import { rollVariableExit, type VariableExitResult } from './variable-exit'

/**
 * 可变增援（通规 13.5 / 1.6b / 1.6c ← 专规 1.6 / 2.3c / 3.3c / 3.6）
 *
 * ## 条文索引
 *   - **13.5 / 1.6b**：「玩家在每个自己的**增援阶段**中，都会根据各自的可变补员表进行掷骰。
 *     通过这种掷骰获得的补员（Repls）是该回合**正常增援之外**的额外补充。」补员分 **Eq（装备）**
 *     与 **Pax（人员）** 两类，用于重建失去的军力或重建单位；补员算子不计入算子上限。
 *     **本作覆盖（专规 1.6 Notes）**：Pax / Eq 是**唯一可跨回合保存**的补员；**Eq 不重建飞机**；
 *     **Ftr / Tac Repl 只补 1 step**（Ftr 限 **F** 型、Tac 限 **T / S / Tpt** 型）且**不可保存**。
 *   - **1.6b 补给表**：掷 2 骰得新增 SP；本作 **19 August 起掷骰 −1** 并取「Late」档。
 *   - **1.6c 特殊补员**：不花 Pax/Eq 的**免费重建**，**19 August 起停止**；死亡堆无对应单位即无重建。
 *     苏方：① 随机 12-2-2 / 11-1-1 / 10-0-1 步兵（或民兵）师重建（返场 −1 step）；
 *     ② Supply Cache 或任一 **Alarm** 单位。轴方：Supply Cache 或任一 **Aufk / Krd** 营。
 *   - **3.3c 可变撤离**（轴方）：19 August 起每个轴方增援阶段掷 1 骰，直到 SS Reich 或 14 Mtr 被移除。
 *   - **3.6 随机事件**（轴方）：**19 July – 15 August（含）**每个轴方增援阶段掷 2 骰；
 *     机型结果 ⇒ 该型飞机**立即全部变 Inactive**（被派去地图外任务）；**Supply Train** ⇒
 *     轴方在**任一可卸货格**获得 **2 SP** 额外补给且**不用 Rail Cap**。
 *     可选 4.1b：Supply Train 在 8 July 与 12 July 自动发生。
 *
 * ## 设计口径
 *   - 掷骰由调用方注入骰面（种子化 RNG 可复算），本模块不含随机；
 *   - 数值与表全部取自 `charts-supply-repl.json` / `arrivals-axis.json` / `rules-constants.json`；
 *   - 本模块**不写状态**：返回「得多少 SP / 哪些补员 / 哪些飞机转非激活」，由调用方落盘。
 */

/** 特殊补员的免费重建内容（1.6c） */
export interface SpecialReplGrant {
  /** 表结果（division_caches / division_alarm / supply_cache / aufk_krd） */
  result: SpecialReplResult
  /** 是否同时免费重建一个「12-2-2 / 11-1-1 / 10-0-1」步兵或民兵师（返场 −1 step） */
  freeDivisionRebuild: boolean
  /** 是否给一枚 Supply Cache 标记（1.7） */
  supplyCache: boolean
  /** 是否给「任一 Alarm 单位」（苏）或「任一 Aufk / Krd 营」（轴） */
  freeAlarmOrRecon: boolean
  detail: string
}

/** 3.6 随机事件结果 */
export interface RandomEventResult {
  /** 原始 2 骰 */
  roll: number
  /** 事件类别 */
  kind: 'aircraft' | 'supplyTrain'
  /** 机型（kind = aircraft 时） */
  aircraftType?: string
  /** 额外 SP（kind = supplyTrain 时，3.6：2 SP、不用 Rail Cap） */
  sp?: number
  detail: string
}

/** 可变增援的输入（骰面全部由调用方注入） */
export interface VariableReinforcementInput {
  side: Side
  /** 当前 ISO 日期（19 Aug 边界与 3.6 事件期由它判定） */
  date: string
  /** 1.6b 补给表：2 骰之和 */
  supplyDice: number
  /** 1.6b 补员表：2 骰之和（原始值；19 Aug 起由本模块施加 −1） */
  replDice: number
  /** 1.6c 特殊补员：1 骰（19 Aug 起不掷，可省略） */
  specialDie?: number
  /** 3.3c 可变撤离：1 骰（轴方、19 Aug 起） */
  variableExitDie?: number
  /**
   * 3.3c：本局的**可变撤离是否已了结**
   *
   * 「19 August 起在 Axis Reinforcement Phase 掷骰，**直到一个师被移除为止**」⇒ 已移除过即不再掷。
   */
  variableExitResolved?: boolean
  /** 3.6 随机事件：2 骰（轴方、19 Jul–15 Aug） */
  randomEventDice?: number
  /** 可选 4.1b：8 Jul / 12 Jul 自动发生 Supply Train */
  option4_1b?: boolean
}

/** 可变增援的结论 */
export interface VariableReinforcementPlan {
  rule: string
  /** 1.6b 补给表所得 SP */
  sp: number
  /** 1.6b 补员表所得（19 Aug −1 已施加） */
  repl: ReplRollResult
  /** 1.6c 特殊补员的免费重建（未掷则不适用） */
  special: SpecialReplGrant | null
  /** 3.3c 可变撤离结论（轴方、19 Aug 起；否则 null） */
  variableExit: VariableExitResult | null
  /** 3.6 随机事件结论（轴方事件期；否则 null） */
  randomEvent: RandomEventResult | null
  detail: string
}

/** 19 Aug 边界（1.6b 的「Late」档与 −1 掷骰修正共用） */
const LATE_SUPPLY_FROM = rulesConstants.smolensk.variableExitStart

/** 3.6：Supply Train 给出的额外 SP（不用 Rail Cap） */
const RANDOM_EVENT_SUPPLY_TRAIN_SP = 2

/**
 * 13.5 / 1.6b / 1.6c / 3.3c / 3.6：一次增援阶段的全部掷表结算
 *
 * 顺序照 SOP 与条文：① 补给表（1.6b）→ ② 补员表（1.6b，19 Aug −1）→ ③ 特殊补员（1.6c，19 Aug 前）
 * → ④ 轴方可变撤离（3.3c，19 Aug 起）→ ⑤ 轴方随机事件（3.6，19 Jul–15 Aug）。
 */
export function planVariableReinforcement(
  input: VariableReinforcementInput,
): RuleOutcome<VariableReinforcementPlan> {
  const { side, date } = input
  const late = date >= LATE_SUPPLY_FROM

  if (!Number.isInteger(input.supplyDice) || input.supplyDice < 2 || input.supplyDice > 12)
    return fail('1.6b', `supplyDiceOutOfRange:${input.supplyDice}`)
  if (!Number.isInteger(input.replDice) || input.replDice < 2 || input.replDice > 12)
    return fail('1.6b', `replDiceOutOfRange:${input.replDice}`)

  // ① 1.6b 补给表（19 Aug 起取 Late 档）
  const sp = supplyTableRoll(side, late, input.supplyDice)
  // ② 1.6b 补员表（19 Aug 起 −1）
  const effectiveRepl = input.replDice + (late ? REPL_ROLL_DRM_FROM_19_AUG : 0)
  const repl = replTableRoll(side, effectiveRepl)

  // ③ 1.6c 特殊补员（19 Aug 前）
  let special: SpecialReplGrant | null = null
  if (isSpecialReplAvailable(date)) {
    if (input.specialDie === undefined) return fail('1.6c', `specialReplDieRequired:${date}`)
    special = buildSpecialGrant(side, input.specialDie)
  }

  // ④ 3.3c 可变撤离（轴方、19 Aug 起；已了结则不再掷）
  let variableExit: VariableExitResult | null = null
  if (side === 'axis' && late && input.variableExitResolved !== true) {
    if (input.variableExitDie === undefined)
      return fail('3.3c', 'variableExitDieRequired:1941-08-19')
    variableExit = rollVariableExit(input.variableExitDie, date)
  }

  // ⑤ 3.6 随机事件（轴方、19 Jul–15 Aug）
  let randomEvent: RandomEventResult | null = null
  if (side === 'axis') {
    randomEvent = planRandomEvent({
      date,
      dice: input.randomEventDice,
      option4_1b: input.option4_1b,
    })
    if (randomEvent === null && isInRandomEventPeriod(date) && input.randomEventDice === undefined)
      return fail('3.6', `randomEventDieRequired:${date}`)
  }

  const parts = [
    `补给表（1.6b${late ? '，19 Aug 起 Late 档' : ''}）：2 骰 ${input.supplyDice} ⇒ **${sp} SP**`,
    `补员表（1.6b${late ? '，19 Aug 起 −1' : ''}）：有效值 ${effectiveRepl} ⇒ ` +
      `Ftr ${repl.ftr} / Tac ${repl.tac} / Pax ${repl.pax} / Eq ${repl.eq}`,
  ]
  if (special !== null) parts.push(`特殊补员（1.6c）：${special.detail}`)
  if (variableExit !== null) parts.push(`可变撤离（3.3c）：${variableExit.description}`)
  if (randomEvent !== null) parts.push(`随机事件（3.6）：${randomEvent.detail}`)

  return succeed('1.6b', {
    rule: late ? '1.6b' : '1.6b',
    sp,
    repl,
    special,
    variableExit,
    randomEvent,
    detail: `${side === 'axis' ? '轴心' : '苏联'}方 ${date} 可变增援：${parts.join('；')}`,
  })
}

/** 1.6c：按骰面组装免费重建内容 */
function buildSpecialGrant(side: Side, die: number): SpecialReplGrant {
  const result = specialReplRoll(side, die)
  switch (result.kind) {
    case 'division_caches':
      return {
        result,
        freeDivisionRebuild: true,
        supplyCache: true,
        freeAlarmOrRecon: false,
        detail: `${result.label}：免费重建一个 12-2-2 / 11-1-1 / 10-0-1 步兵（或民兵）师（返场 −1 step）＋ 一枚 Supply Cache（1.7）`,
      }
    case 'division_alarm':
      return {
        result,
        freeDivisionRebuild: true,
        supplyCache: false,
        freeAlarmOrRecon: true,
        detail: `${result.label}：免费重建一个 12-2-2 / 11-1-1 / 10-0-1 步兵（或民兵）师（返场 −1 step）＋ 任一 Alarm 单位（1.6c：Alarm 单位只能经特殊补员重建）`,
      }
    case 'supply_cache':
      return {
        result,
        freeDivisionRebuild: false,
        supplyCache: true,
        freeAlarmOrRecon: false,
        detail: `${result.label}：获得一枚 Supply Cache（1.7）`,
      }
    case 'aufk_krd':
      return {
        result,
        freeDivisionRebuild: false,
        supplyCache: false,
        freeAlarmOrRecon: true,
        detail: `${result.label}：免费重建任一 Aufk / Krd 营（3.3a：这两个兵种只能经特殊补员重建）`,
      }
  }
}

/**
 * 3.6：轴方随机事件
 *
 * 事件期内（19 Jul–15 Aug）必掷；可选 4.1b 另在 8 Jul 与 12 Jul 自动发生 Supply Train。
 * 返回 null 表示「当前不掷（不在事件期且无 4.1b 自动项）或未给骰面」。
 */
export function planRandomEvent(input: {
  date: string
  dice?: number
  option4_1b?: boolean
}): RandomEventResult | null {
  // 4.1b：8 Jul / 12 Jul 自动 Supply Train
  if (input.option4_1b === true && (input.date === '1941-07-08' || input.date === '1941-07-12')) {
    return {
      roll: 0,
      kind: 'supplyTrain',
      sp: RANDOM_EVENT_SUPPLY_TRAIN_SP,
      detail: `可选 4.1b：${input.date} 自动发生 Supply Train ⇒ 任一可卸货格 +${RANDOM_EVENT_SUPPLY_TRAIN_SP} SP（不用 Rail Cap）`,
    }
  }
  if (!isInRandomEventPeriod(input.date)) return null
  if (input.dice === undefined) return null

  const table = arrivalsAxis.randomEvents?.table ?? {}
  const labels = Object.keys(table)
  const rowLabel = labels[matchRowIndex(labels, input.dice, 'random-events')]!
  const value = table[rowLabel] ?? ''

  if (/Supply\s+Train/i.test(value)) {
    return {
      roll: input.dice,
      kind: 'supplyTrain',
      sp: RANDOM_EVENT_SUPPLY_TRAIN_SP,
      detail: `2 骰 ${input.dice} ⇒ Supply Train（${rowLabel}）：任一可卸货格 +${RANDOM_EVENT_SUPPLY_TRAIN_SP} SP，**不用 Rail Cap**（3.6）`,
    }
  }
  return {
    roll: input.dice,
    kind: 'aircraft',
    aircraftType: value,
    detail: `2 骰 ${input.dice} ⇒ ${value}（${rowLabel}）：该型飞机**立即全部变非激活**（被派往地图外任务，3.6）`,
  }
}

/** 1.2：当日铁路容量（提示用；值取自 rules-constants） */
export function railCapacityAt(date: string, side: Side): number {
  const boosted = isRailCapBoosted(date)
  const table = boosted
    ? rulesConstants.smolensk.railCapAfter
    : rulesConstants.smolensk.railCapBefore
  return table[side]
}

/** 1.6c：特殊补员的免费重建所需的重建表行（供界面提示） */
export function specialReplRebuildRows(side: Side): readonly string[] {
  const rows = chartsSupplyRepl.rebuild[side]
  return rows.filter((row) => row.rebuild.kind === 'special').map((row) => row.unitType)
}
