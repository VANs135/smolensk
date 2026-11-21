/**
 * workbench-combat-options.ts —— 9.10a 选项战果「草稿账本」（F1 逐次点选 + 撤销）
 *
 * B3-2b7（2026-11-21）：整族（1 banner + 13 声明）原样搬出 facade，函数体零改动。
 * 族内只有 9 个外部名，且全部声明在建域点之前 ⇒ 无需 getter；端口 1 束 9 项。
 *
 * ★ 解构位置有硬约束：`clearCombat`（8802）与 `confirmCombatOptions`（10398）在原块位**之前**
 *   就引用 `resetOptionDraft` / `optionDraftLog` / `optionDraftRemaining`。搬走后这些名字从
 *   "函数声明（提升）"变成"const 解构"，所以装配+解构必须留在 facade 的建域区（fuel 域之后），
 *   不能留在原块位 —— 否则那两处调用在建店期会 TDZ。
 */
import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'

import {
  currentResolver,
  optionsOf,
  type CombatInteractionState,
} from '@/engine/rules/combat-interaction'
import type { BattleUnitView, CombatRole } from '@/engine/rules/battle'
import type { CombatInputs } from './engagement-inputs'
import type { ConsoleUnit } from './workbench-model'

/** 9.10a 草稿账本的端口：战斗交互状态 + 视图 + 撤销族登记（9 项，2026-11-21 实测）。 */
export interface CombatOptionsDeps {
  /** 战斗交互状态机（fireResolution 域） */
  combatState: Ref<CombatInteractionState | null>
  /** 9.5/9.10 的结算输入（草稿直接寄居在 `optionLossPoints` 等字段上） */
  combatInputs: Ref<CombatInputs>
  /** C6：参战攻方单位 */
  combatAttackers: ComputedRef<ConsoleUnit[]>
  /** 已选定交战的守方单位（9.3b/9.6） */
  battleDefenders: ComputedRef<ConsoleUnit[]>
  /** C6：攻方/守方单位视图（9.11c 的军力分配判据取它） */
  combatAttackerViews: ComputedRef<BattleUnitView[]>
  combatDefenderViews: ComputedRef<BattleUnitView[]>
  nameOf: (unitId: string) => string
  /**
   * 撤销族登记只收 `'draft'`（本族只撤自己的草稿流水）——facade 的 `UndoFamily`
   * 是 setup 内的局部别名、不导出，故这里按**用到的字面量**收窄，避免复制一份联合类型。
   */
  noteUndoable: (family: 'draft', label: string, snapshot?: unknown) => number
  dropUndoOf: (family: 'draft') => void
}

export function createCombatOptionsDomain(deps: CombatOptionsDeps) {
  const {
    combatState,
    combatInputs,
    combatAttackers,
    battleDefenders,
    combatAttackerViews,
    combatDefenderViews,
    nameOf,
    noteUndoable,
    dropUndoOf,
  } = deps

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * 条 15/16（批 F·F1）：选项战果页「草稿账本」＋「受损 / 撤退（1 格）」双按钮
   *
   * 用户口径：选项点数的消耗改成**逐次点选**（点单位图即受损、点可撤退格即撤退），
   * 每次应用只进**草稿账本**（不落盘）；最后按「提交」才一次性交给引擎
   * （`planOptions` 仍是一发结算，引擎不改）。
   *
   * 草稿直接寄居在 `combatInputs.option*` 三个字段上（提交路径完全复用旧链路），
   * 另配 `optionDraftLog` 记流水供「撤销上一次」。
   * ───────────────────────────────────────────────────────────────────────────
   */

  /** 草稿流水（逐次应用；撤销按此回退） */
  const optionDraftLog = ref<{ kind: 'loss' | 'retreat'; unitId?: string; amount: number }[]>([])

  /** 当前结算方的可用选项点数（9.10a） */
  const optionDraftPoints = computed(() => {
    const state = combatState.value
    if (state === null || state.dice === undefined || state.step !== 'options') return 0
    return optionsOf(state.dice.result, currentResolver(state))
  })

  /** 草稿已用点数 */
  const optionDraftUsed = computed(
    () => combatInputs.value.optionLossPoints + combatInputs.value.optionRetreatHexes,
  )

  /** 草稿剩余点数（9.10a：总数必须完全满足 ⇒ 提交时须为 0） */
  const optionDraftRemaining = computed(() =>
    Math.max(0, optionDraftPoints.value - optionDraftUsed.value),
  )

  /** 草稿流水（面板展示用；最新在末尾） */
  const optionDraftEntries = computed(() =>
    optionDraftLog.value.map((entry, index) => ({
      index,
      kind: entry.kind,
      unitId: entry.unitId ?? null,
      amount: entry.amount,
      label:
        entry.kind === 'loss'
          ? `${nameOf(entry.unitId ?? '')} 受损 ${entry.amount} 军力`
          : entry.unitId !== undefined && entry.unitId !== ''
            ? `${nameOf(entry.unitId)} → 撤退 ${entry.amount} 格（全体）`
            : `撤退 ${entry.amount} 格（全体）`,
    })),
  )

  /**
   * 9.10a / 9.12（用户 2026-11-18 第 3 条）：选项步的**撤退点选对象**
   *
   * 撤退是「整方各撤 1 格」的战果 ⇒ 点该方任一存活参战单位即分配 1 点；
   * 不再先点地图上「单位后面的格子」。落点仍留到第 9 步按既有候选选。
   */
  const optionRetreatUnits = computed<ConsoleUnit[]>(() => {
    const state = combatState.value
    if (state === null || state.step !== 'options') return []
    if (optionDraftRemaining.value <= 0) return []
    const side = currentResolver(state)
    return (side === 'attacker' ? combatAttackers.value : battleDefenders.value).filter(
      (unit) => unit.steps > 0,
    )
  })

  /**
   * 9.11c：在既有分配上再给 `unitId` 记 1 点是否合法（强制损失与选项损失共用这一条规则）
   *
   * ① 第一点必须由该方的 AR 单位承担（9.6 的领军单位；AR 单位已不在/无军力时退回均匀展开）；
   * ② 之后只能给当前受损最少的单位，保证"每人各受一点后才有人受第二点"。
   */
  function combatLossPointLegal(
    side: CombatRole,
    allocation: Record<string, number>,
    unitId: string,
  ): boolean {
    const state = combatState.value
    if (state === null) return false
    const views = side === 'attacker' ? combatAttackerViews.value : combatDefenderViews.value
    const target = views.find((unit) => unit.id === unitId)
    if (target === undefined || target.steps <= (allocation[unitId] ?? 0)) return false
    const total = views.reduce((sum, unit) => sum + (allocation[unit.id] ?? 0), 0)
    if (total === 0) {
      const arUnitId = side === 'attacker' ? state.ar?.attackerUnitId : state.ar?.defenderUnitId
      const arUnit = views.find((unit) => unit.id === arUnitId)
      if (arUnit === undefined || arUnit.steps <= 0) return true
      return unitId === arUnitId
    }
    const min = Math.min(...views.map((unit) => allocation[unit.id] ?? 0))
    return (allocation[unitId] ?? 0) === min
  }

  /** 9.11c：当前结算方还能把下一点损失记给谁（面板据此决定哪些候选出现） */
  function canTakeOptionLossPoint(unitId: string): boolean {
    const state = combatState.value
    if (state === null || state.step !== 'options') return false
    return combatLossPointLegal(
      currentResolver(state),
      combatInputs.value.optionLossAllocation,
      unitId,
    )
  }

  /**
   * 「受损」：给某参战单位记 1 点军力损失（草稿；9.11a 的逐单位分配）
   *
   * 约束（与强制损失同一套 9.11c 规则）：① 剩余选项点数 > 0；② 该点合法（`combatLossPointLegal`）。
   */
  function applyOptionDraftLoss(unitId: string): boolean {
    const state = combatState.value
    if (state === null || state.step !== 'options') return false
    if (optionDraftRemaining.value <= 0) return false
    if (!canTakeOptionLossPoint(unitId)) return false
    combatInputs.value.optionLossAllocation = {
      ...combatInputs.value.optionLossAllocation,
      [unitId]: (combatInputs.value.optionLossAllocation[unitId] ?? 0) + 1,
    }
    combatInputs.value.optionLossPoints += 1
    optionDraftLog.value = [...optionDraftLog.value, { kind: 'loss', unitId, amount: 1 }]
    noteUndoable('draft', '战果草稿：损失 +1')
    return true
  }

  /** 「撤退（1 格）」：记 distance 格撤退（草稿；点数不够时按剩余截断） */
  function applyOptionDraftRetreat(distance = 1): boolean {
    const state = combatState.value
    if (state === null || state.step !== 'options') return false
    const room = optionDraftRemaining.value
    if (room <= 0) return false
    const applied = Math.min(Math.max(1, Math.round(distance)), room)
    combatInputs.value.optionRetreatHexes += applied
    optionDraftLog.value = [...optionDraftLog.value, { kind: 'retreat', amount: applied }]
    noteUndoable('draft', '战果草稿：撤退 +1 格')
    return true
  }

  /**
   * 点选项步的某一枚参战单位 ⇒ 该方全体各撤 1 格（消耗 1 点）
   *
   * 用户 2026-11-18 第 3 条：战果窗口里直接点单位，不再先点「单位后面的格子」。
   * 撤退的落点仍留到第 9 步按 9.12 既有候选判据选（本函数不产生落点）。
   */
  function applyOptionDraftRetreatFor(unitId: string): boolean {
    if (!optionRetreatUnits.value.some((unit) => unit.instanceId === unitId)) return false
    const before = combatInputs.value.optionRetreatHexes
    if (!applyOptionDraftRetreat(1)) return false
    const log = optionDraftLog.value
    const last = log[log.length - 1]
    if (last !== undefined && last.kind === 'retreat') {
      optionDraftLog.value = [...log.slice(0, -1), { ...last, unitId }]
    }
    return combatInputs.value.optionRetreatHexes > before
  }

  /** 撤销上一次草稿应用（流水末条按 amount 精确回退） */
  function undoOptionDraftLast(): boolean {
    const last = optionDraftLog.value[optionDraftLog.value.length - 1]
    if (last === undefined) return false
    dropUndoOf('draft')
    optionDraftLog.value = optionDraftLog.value.slice(0, -1)
    if (last.kind === 'loss' && last.unitId !== undefined) {
      const next = (combatInputs.value.optionLossAllocation[last.unitId] ?? 0) - last.amount
      const allocation = { ...combatInputs.value.optionLossAllocation }
      if (next <= 0) delete allocation[last.unitId]
      else allocation[last.unitId] = next
      combatInputs.value.optionLossAllocation = allocation
      combatInputs.value.optionLossPoints = Math.max(
        0,
        combatInputs.value.optionLossPoints - last.amount,
      )
    } else {
      combatInputs.value.optionRetreatHexes = Math.max(
        0,
        combatInputs.value.optionRetreatHexes - last.amount,
      )
    }
    return true
  }

  /** 收起草稿（提交后 / 离开选项步 / 清理战斗时调用） */
  function resetOptionDraft(): void {
    optionDraftLog.value = []
  }

  /**
   * 公开面清单（P2）：原 facade `workbench.ts` return 区属于本域的键，搬回域内。
   *
   * 为什么搬：这批键是对外承诺的接口，以前登记在 facade 的 1,005 键 return 表里，
   * 于是任何本域改动都要去共享文件登记一次 —— 两人并行改 store 必在 return 区冲突。
   * 搬到域内后，本域的改动人只改本文件；facade 只留一行 `...xxx.publicSurface`。
   *
   * 纪律：增删对外键时**同步改这里的清单**，否则公开面快照（1,013 键）会红。
   */
  const publicSurface = {
    optionDraftPoints,
    optionDraftUsed,
    optionDraftRemaining,
    optionDraftEntries,
    optionRetreatUnits,
    applyOptionDraftLoss,
    canTakeOptionLossPoint,
    applyOptionDraftRetreat,
    applyOptionDraftRetreatFor,
    undoOptionDraftLast,
    resetOptionDraft,
  }
  return {
    publicSurface,
    optionDraftLog,
    optionDraftPoints,
    optionDraftUsed,
    optionDraftRemaining,
    optionDraftEntries,
    optionRetreatUnits,
    combatLossPointLegal,
    canTakeOptionLossPoint,
    applyOptionDraftLoss,
    applyOptionDraftRetreat,
    applyOptionDraftRetreatFor,
    undoOptionDraftLast,
    resetOptionDraft,
  }
}
