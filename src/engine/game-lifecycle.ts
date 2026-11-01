import type { Records } from './state-types'
import type { Side } from '@/data'

export interface PhaseTransition {
  changed: boolean
  turnChanged: boolean
  refreshTrace: boolean
  reinforcementKey: string | null
}
/** 2.2：只以会话记录轨决定阶段生命周期，不使用界面为显示提供的兜底阶段。 */
export function phaseTransition(previous: Records, current: Records): PhaseTransition {
  const turnChanged = previous.turn !== current.turn
  const changed =
    turnChanged || previous.phase !== current.phase || previous.activeSide !== current.activeSide
  return {
    changed,
    turnChanged,
    refreshTrace: changed && (current.phase === 'movement' || current.phase === 'supply'),
    reinforcementKey:
      current.phase === 'reinforcement' && current.activeSide !== null
        ? `${current.turn}|${current.activeSide}|reinforcement`
        : null,
  }
}
/** 6.3a / 7.0：操作方与本玩家回合的归属分离。 */
export function actingSideFor(records: Pick<Records, 'phase' | 'activeSide'>): Side | null {
  if (records.activeSide === null) return null
  return records.phase === 'reaction'
    ? records.activeSide === 'axis'
      ? 'soviet'
      : 'axis'
    : records.activeSide
}
