import type {
  AirMissionAssignment,
  AirMissionAircraftView,
  AirInteractionState,
} from './air-interaction'
import { airTransportProfile, transportCapacityOf } from './air-interaction'
import { fail, succeed } from '../result-types'
import { airCargoTransportT, type AirCargoLoadView } from './air-cargo'
import type { HexRef } from '@/data'
import { sameHex } from '../hex-geometry'

/** 14.9：中止机不再承运；未分机货单的部分中止不得静默把货转给其他飞机。 */
export function planAirCargoContinuation(
  cargo: readonly AirCargoLoadView[],
  roster: Pick<
    ReturnType<typeof airMissionRoster>,
    'activeCapacityT' | 'liveCapacityT' | 'inactiveCarriers'
  > & { initialLiveCapacityT?: number; lostCarriers?: number },
  flakRounding: boolean,
) {
  const loadedT = cargo.reduce((sum, item) => sum + airCargoTransportT(item), 0)
  if (loadedT === 0) return succeed('14.9a', { returnOnly: false })
  if ((roster.lostCarriers ?? 0) > 0 && !flakRounding)
    return fail('14.9a', 'cargoCarrierAllocationRequired')
  const active = flakRounding ? Math.ceil(roster.activeCapacityT) : roster.activeCapacityT
  // 空战中止且承运机均存活，原装载物随整组退回；14.4g只适用于防空后继续任务。
  const live = flakRounding
    ? Math.ceil(roster.liveCapacityT)
    : roster.lostCarriers === 0
      ? (roster.initialLiveCapacityT ?? roster.liveCapacityT)
      : roster.liveCapacityT
  if (roster.activeCapacityT === 0 && live >= loadedT)
    return succeed('14.1c / 14.9', { returnOnly: true })
  if (roster.inactiveCarriers > 0) return fail('14.9a', 'cargoCarrierAllocationRequired')
  if (active < loadedT) return fail('14.9a', 'cargoExceedsActiveCarrierCapacity')
  return succeed('14.9a', { returnOnly: false })
}

/** 14.1c / 14.9f：整组退运到同一实际基地；没有逐机货单时不能猜测分流。 */
export function planRetainedCargoReturn(input: {
  cargo: readonly AirCargoLoadView[]
  targetHex: HexRef
  carriers: readonly { aircraftId: string; offMap: boolean }[]
  returns: readonly { aircraftId: string; baseHex: HexRef }[]
  stayedIds: readonly string[]
}) {
  const unloadT = input.cargo.reduce((sum, item) => sum + airCargoTransportT(item), 0)
  if (
    !Number.isFinite(unloadT) ||
    unloadT < 0 ||
    new Set(input.cargo.map((item) => item.id)).size !== input.cargo.length
  )
    return fail('14.9', 'invalidRetainedCargo')
  if (input.cargo.length === 0)
    return succeed('14.9', { destination: null as HexRef | null, unloadT: 0 })
  if (input.carriers.length === 0) return fail('14.9', 'retainedCargoHasNoCarrier')
  if (input.carriers.some((carrier) => carrier.offMap))
    return fail('14.9', 'retainedCargoOffMapReturnUnsupported')
  const bases = input.carriers.map((carrier) =>
    input.stayedIds.includes(carrier.aircraftId)
      ? input.targetHex
      : input.returns.find((entry) => entry.aircraftId === carrier.aircraftId)?.baseHex,
  )
  const first = bases[0]
  if (first === undefined || bases.some((hex) => hex === undefined || !sameHex(hex, first)))
    return fail('14.9', 'retainedCargoRequiresCommonReturnBase')
  return succeed('14.9', { destination: first as HexRef | null, unloadT })
}

/** 14.2f-E：没有活动任务机时不再掷防空骰。 */
export function skipEmptyAirMissionFlak(state: AirInteractionState) {
  if (state.step !== 'flak') return fail('14.2f-E', 'notAtFlakStep')
  if (state.interception?.declared && state.interception.combat === null)
    return fail('14.5', 'interceptionCombatPending')
  return succeed('14.2f-E', { state: { ...state, step: 'resolveMission' as const } })
}

/** 14.1 / 14.2：虚拟飞行位置与基地坐标分开；只有存活且激活的任务机仍能执行任务。 */
export function airMissionRoster(
  assignment: AirMissionAssignment,
  aircraft: readonly AirMissionAircraftView[],
  initialAircraft: readonly AirMissionAircraftView[] = aircraft,
) {
  const byId = new Map(aircraft.map((plane) => [plane.id, plane]))
  const initialById = new Map(initialAircraft.map((plane) => [plane.id, plane]))
  const activeIds: string[] = [],
    liveIds: string[] = [],
    destroyedIds: string[] = []
  let activeCapacityT = 0,
    liveCapacityT = 0
  let inactiveCarriers = 0
  let initialLiveCapacityT = 0,
    lostCarriers = 0
  for (const origin of assignment.origins) {
    const plane = byId.get(origin.aircraftId)
    const initial = initialById.get(origin.aircraftId)
    const initialCapacity =
      initial === undefined
        ? 0
        : transportCapacityOf(initial) *
          airTransportProfile({
            distanceHexes: origin.distanceHexes,
            rangeHexes: origin.rangeHexes,
          }).capacityMultiplier
    if (plane === undefined || plane.steps <= 0) {
      destroyedIds.push(origin.aircraftId)
      if (initialCapacity > 0) lostCarriers += 1
      continue
    }
    initialLiveCapacityT += initialCapacity
    liveIds.push(plane.id)
    const capacity =
      transportCapacityOf(plane) *
      airTransportProfile({ distanceHexes: origin.distanceHexes, rangeHexes: origin.rangeHexes })
        .capacityMultiplier
    liveCapacityT += capacity
    if (plane.airStatus === 'active' && assignment.aircraftIds.includes(plane.id)) {
      activeIds.push(plane.id)
      activeCapacityT += capacity
    } else if (capacity > 0) inactiveCarriers += 1
  }
  return {
    activeIds,
    liveIds,
    destroyedIds,
    activeCapacityT,
    liveCapacityT,
    inactiveCarriers,
    initialLiveCapacityT,
    lostCarriers,
  }
}

/** 14.1b / 14.2f-G：已摧毁飞机不需要、也不能再办理返航和出动次数。 */
export function survivingAirMission(
  state: AirInteractionState,
  aircraft: readonly { id: string; steps: number }[],
): AirInteractionState {
  const live = new Set(aircraft.filter((plane) => plane.steps > 0).map((plane) => plane.id))
  return {
    ...state,
    assignment: {
      ...state.assignment,
      aircraftIds: state.assignment.aircraftIds.filter((id) => live.has(id)),
      origins: state.assignment.origins.filter((origin) => live.has(origin.aircraftId)),
    },
  }
}
