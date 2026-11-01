import { phaseTransition } from '@/engine/game-lifecycle'
import type { Records } from '@/engine/state-types'

export interface PhaseCoordinatorPorts {
  current(): Records | null
  isInitialSetup(): boolean
  isPlayerPhase(): boolean
  start(): void
  settleObligations(): boolean
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
