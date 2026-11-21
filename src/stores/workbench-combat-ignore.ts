/**
 * workbench-combat-ignore.ts —— 9.10c「守方忽略自己的选项」三件
 *
 * B3-2b8（2026-11-21）：整块（攻方全灭判据 / 忽略可用性 / 唯一出口）搬出 facade，函数体零改动。
 *
 * 端口 5 项：`combatNkvdForcedLosses` 在 facade **16690** 才声明（晚于建域点 7810）⇒ 只能给 getter；
 * `confirmCombatOptions` 是函数声明（提升）⇒ 可按值传。二者都只在本域读、不在本域写。
 */
import { computed } from 'vue'
import type { ComputedRef, Ref } from 'vue'

import type { CombatInteractionState } from '@/engine/rules/combat-interaction'
import type { BattleUnitView } from '@/engine/rules/battle'
import type { CombatInputs } from './engagement-inputs'

/** 9.10c 忽略权的端口（5 项，2026-11-21 实测）。 */
export interface CombatIgnoreDeps {
  combatState: Ref<CombatInteractionState | null>
  combatInputs: Ref<CombatInputs>
  /** 攻方参战单位视图（全灭判据取它） */
  combatAttackerViews: ComputedRef<BattleUnitView[]>
  /** 专规 2.3b：NKVD 强制损失场次禁用忽略权（facade 16690 声明 ⇒ getter） */
  combatNkvdForcedLosses: () => boolean
  /** 9.10 选项结算（本域只在行使忽略权后调用一次） */
  confirmCombatOptions: () => boolean
}

export function createCombatIgnoreDomain(deps: CombatIgnoreDeps) {
  const { combatState, combatInputs, combatAttackerViews, confirmCombatOptions } = deps

  /**
   * 16690 才声明 ⇒ 端口只能给 getter。这里就地包成 `computed`，让搬进来的函数体
   * 继续按 `combatNkvdForcedLosses.value` 读（同名、同求值时机，函数体零改写）。
   */
  const combatNkvdForcedLosses = computed(() => deps.combatNkvdForcedLosses())

  /**
   * 9.10c：攻方参战单位是否已全灭（名单里的单位已离盘按 0 军力计入）。
   *
   * 全灭 ⇒ 攻方「无法完成全部选项」⇒ 守方可忽略自己的选项（9.10c），战斗沿正常链路收束。
   */
  const attackerWipedNow = computed(() => {
    const state = combatState.value
    if (state === null || state.resolution.stage !== 'defenderOptions') return false
    return combatAttackerViews.value.every((view) => view.steps <= 0)
  })

  /** 9.10c「忽略守方自己的选项」是否可用（专规 2.3b 的 NKVD 强制损失场次禁用） */
  const optionIgnoreAvailableNow = computed(() => {
    const state = combatState.value
    if (state === null || state.resolution.stage !== 'defenderOptions') return false
    // 攻方撤退（引擎判）或攻方全灭（名单里的单位已离盘）都会让攻方取不齐选项
    if (state.resolution.defender.optionIgnorable !== true && !attackerWipedNow.value) return false
    return !combatNkvdForcedLosses.value
  })

  /** 9.10c 唯一出口：行使忽略权并当场结算（面板只放这一处，不再另设勾选框） */
  function confirmCombatIgnoreOptions(): boolean {
    if (!optionIgnoreAvailableNow.value) return false
    combatInputs.value.ignoreOptions = true
    if (!confirmCombatOptions()) {
      combatInputs.value.ignoreOptions = false
      return false
    }
    return true
  }

  return {
    attackerWipedNow,
    optionIgnoreAvailableNow,
    confirmCombatIgnoreOptions,
  }
}
