/** 12.10e-A / 12.6 / 12.8：D段退出时必须按次序处理的义务。 */
export interface SupplyPhaseProgress {
  step: string | undefined
  wholePhase: boolean
  recoverySettled: boolean
  feedingSettled: boolean
  pendingAttrition: readonly string[]
}
export type SupplyPhaseObligation =
  | { kind: 'recovery' }
  | { kind: 'enterCheck' }
  | { kind: 'feeding' }
  | { kind: 'attrition'; hexKey: string }
  | { kind: 'complete' }

/** 只生成下一项义务，不选供养对象或替玩家分配可选择的损失。 */
export function nextSupplyPhaseObligation(state: SupplyPhaseProgress): SupplyPhaseObligation {
  if (state.step === 'supply.recovery') {
    if (!state.recoverySettled) return { kind: 'recovery' }
    return { kind: state.wholePhase ? 'enterCheck' : 'complete' }
  }
  if (state.step === 'supply.check') {
    if (!state.feedingSettled) return { kind: 'feeding' }
    const hexKey = state.pendingAttrition[0]
    if (hexKey !== undefined) return { kind: 'attrition', hexKey }
  }
  return { kind: 'complete' }
}
