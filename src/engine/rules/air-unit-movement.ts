import { fail, succeed, type RuleOutcome } from '../result-types'
import { canUseTransport, maMultiplier, type ModeState, type MovementSegmentPhase } from './modes'

/** 4.7d / 14.9d：本阶段已执行的单位空运事实，不以虚假MP消耗代替。 */
export interface AirUnitTransportState {
  kind: 'air_transport' | 'air_drop'
  phase: MovementSegmentPhase
  /** 装载时已释放预备；后续操作不能放宽这项已提交事实。 */
  releasedFromReserve: boolean
}

/** 6.1 / 14.9：已移动事实含空运；零地面MP不能被当成仍未移动。 */
export function hasUnitMovementThisPhase(
  spentMp: number,
  transport?: AirUnitTransportState | null,
): boolean {
  return spentMp > 0 || transport != null
}

/** 14.9d / 4.7d：在正常阶段/模式额度上施加一次运输限制，保留分数。 */
export function limitAirTransportMa(
  normalMa: number,
  transport?: AirUnitTransportState | null,
): number {
  if (transport === undefined || transport === null) return normalMa
  if (transport.kind === 'air_drop') return 0
  if (transport.phase !== 'movement' && !transport.releasedFromReserve) return 0
  return normalMa / 2
}

/** 14.9d：反应/进击中空运的普通单位不能因此攻击；主移动空投不额外禁攻。 */
export function canAttackAfterAirTransport(transport?: AirUnitTransportState | null): boolean {
  return (
    transport === undefined ||
    transport === null ||
    transport.phase === 'movement' ||
    transport.releasedFromReserve
  )
}

/** 5.6a / 14.9c/d / 4.7d：装载前校验真实已耗MP，并生成可持久化的阶段义务。 */
export function planAirUnitTransport(input: {
  kind: AirUnitTransportState['kind']
  phase: MovementSegmentPhase
  mode: ModeState
  ma: number
  spentMp: number
  previous?: AirUnitTransportState | null
}): RuleOutcome<{
  transport: AirUnitTransportState
  maLimit: number
  remainingMp: number
}> {
  if (
    !Number.isFinite(input.ma) ||
    input.ma < 0 ||
    !Number.isFinite(input.spentMp) ||
    input.spentMp < 0
  )
    return fail('14.9d', 'invalidAirTransportMovement')
  if (!canUseTransport(input.mode)) return fail('5.6a / 14.9c', 'cargoUnitCannotUseAirTransport')
  const previous = input.previous
  if (previous !== undefined && previous !== null && previous.phase !== input.phase)
    return fail('14.9d', 'staleAirUnitTransportPhase')
  const transport: AirUnitTransportState = {
    kind: previous?.kind === 'air_drop' ? 'air_drop' : input.kind,
    phase: input.phase,
    releasedFromReserve:
      input.mode.releasedFromReserve === true && previous?.releasedFromReserve !== false,
  }
  const maLimit = limitAirTransportMa(input.ma * maMultiplier(input.mode, input.phase), transport)
  if (input.spentMp > maLimit)
    return transport.kind === 'air_drop'
      ? fail('4.7d', 'airDropUnitAlreadyMoved')
      : fail('14.9d', 'airTransportGroundMovementExceeded')
  return succeed(transport.kind === 'air_drop' ? '4.7d' : '14.9d', {
    transport,
    maLimit,
    remainingMp: maLimit - input.spentMp,
  })
}
