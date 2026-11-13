import { phaseTransition } from '@/engine/game-lifecycle'
import type { Records } from '@/engine/state-types'

export interface PhaseCoordinatorPorts {
  current(): Records | null
  isInitialSetup(): boolean
  isPlayerPhase(): boolean
  start(): void
  settleObligations(): boolean
  /** 4.8a：自动段也要查的超堆叠义务（返回 false 即本步不许推进） */
  settleOverstack(): boolean
  cleanUp(): boolean
  publishVictory(): void
  resetPhase(): void
  resetTurn(): void
  refreshTrace(): void
  ensureReinforcement(key: string): void
}
/** 正式推进的唯一生命周期协调器；规则后果经端口调用各域现有的纯规则实现。 */
export function createPhaseCoordinator(ports: PhaseCoordinatorPorts) {
  return {
    started: ports.start,
    beforeStep(): boolean {
      if (ports.isInitialSetup()) return false
      /*
       * 4.8a 是**任何环节或阶段末**的义务（含自动段：H 清理的强制吸收本身也可能把一格顶过 10 RE），
       * 所以自动段也要查——否则会带着超堆叠跨过回合收束。
       * ★ 不能直接复用 `settleObligations()`：它带着补给段义务链，而 preTurn 的阶段投影会回落到
       *   本地演练值（可能是 supply），自动段调用会把补给结算误触发。
       */
      if (!ports.settleOverstack()) return false
      if (ports.isPlayerPhase() && !ports.settleObligations()) return false
      if (ports.current()?.phase === 'cleanUp' && !ports.cleanUp()) return false
      ports.publishVictory()
      return true
    },
    afterStep(previous: Records): void {
      const current = ports.current()
      if (current === null) return
      const plan = phaseTransition(previous, current)
      if (plan.changed) ports.resetPhase()
      if (plan.turnChanged) ports.resetTurn()
      if (plan.refreshTrace) ports.refreshTrace()
      if (plan.reinforcementKey !== null) ports.ensureReinforcement(plan.reinforcementKey)
    },
  }
}
