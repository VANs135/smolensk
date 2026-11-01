import type { CombatInteractionState } from './combat-interaction'
import type { BarrageInteractionState } from './barrage-interaction'

/** 9.12：先处理第一份未选齐的路径，全部选齐后停在最后一方确认。 */
export function pendingRetreatPlan<T extends { side: 'attacker' | 'defender'; complete: boolean }>(
  plans: readonly T[],
): T | null {
  return plans.find((plan) => !plan.complete) ?? plans[plans.length - 1] ?? null
}

/** 9.6/9.10/10.0a：需要玩家决定时的角色，热坐和面板共用。 */
export function engagementDecisionRole(
  combat: CombatInteractionState | null,
  barrage: BarrageInteractionState | null,
  retreatPlans: readonly { side: 'attacker' | 'defender'; complete: boolean }[] = [],
): 'attacker' | 'defender' {
  if (combat !== null && !combat.finished) {
    if (
      combat.step === 'declareTerrain' ||
      (combat.step === 'declareAr' && combat.declaredAttackerArUnitId !== undefined)
    )
      return 'defender'
    if (combat.step === 'losses' || combat.step === 'options')
      return combat.resolution.stage.startsWith('defender') ? 'defender' : 'attacker'
    if (combat.step === 'retreat' && retreatPlans.length > 0)
      return pendingRetreatPlan(retreatPlans)!.side
    if (combat.step === 'retreat')
      return (combat.resolution.attacker.option?.retreatHexes ?? 0) > 0 ? 'attacker' : 'defender'
  }
  if (
    barrage !== null &&
    !barrage.finished &&
    barrage.targetKind === 'combatUnits' &&
    (barrage.step === 'shifts' || barrage.step === 'outcome')
  )
    return 'defender'
  return 'attacker'
}

/** 9.2：补给提交之后必须完成战果与撤退/推进，不能丢弃现场。 */
export function combatIsCommitted(state: CombatInteractionState | null): boolean {
  return state !== null && !state.finished && state.supply?.attacker.paid === true
}
/** 10.0 / 10.1b：已付款或已掷骰的轰炸保留到结果落盘。 */
export function barrageIsCommitted(state: BarrageInteractionState | null): boolean {
  return (
    state !== null && !state.finished && (state.supply?.paid === true || state.dice !== undefined)
  )
}
