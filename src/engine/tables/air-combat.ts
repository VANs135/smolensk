import {
  AIR_COMBAT_ATTACKER_ABORT_MAX_DICE,
  AIR_COMBAT_BOTH_ABORT_DICE,
  AIR_COMBAT_LOSS_NO_LOSS_MAX_DICE,
} from '@/engine/rules'

/**
 * 空战判定（OCS 14.3e）
 *
 * 掷骰：2d6 + 攻方空战值 - 守方空战值（调用方算好修正后掷骰值传入）。
 * 结果：≤6 攻方退出 / =7 双方退出 / ≥8 守方退出；
 * 退出方（或双方）各掷 1 骰判损失：1–4 无损失 / 5–6 军力损失。
 */

export type AirCombatResult = 'attacker_aborts' | 'both_abort' | 'defender_aborts'

/** 空战主判定（输入为已含空战值差的修正骰） */
export function airCombatLookup(modifiedRoll: number): AirCombatResult {
  if (modifiedRoll <= AIR_COMBAT_ATTACKER_ABORT_MAX_DICE) return 'attacker_aborts'
  if (modifiedRoll === AIR_COMBAT_BOTH_ABORT_DICE) return 'both_abort'
  return 'defender_aborts'
}

export type AirCombatLossDiceResult = 'no_loss' | 'step_loss'

/** 空战损失骰：1–4 无损失 / 5–6 军力损失 */
export function airCombatLossRoll(die: number): AirCombatLossDiceResult {
  if (die <= AIR_COMBAT_LOSS_NO_LOSS_MAX_DICE) return 'no_loss'
  return 'step_loss'
}
