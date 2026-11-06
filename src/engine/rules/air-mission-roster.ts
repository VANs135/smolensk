import type {
  AirMissionAssignment,
  AirMissionAircraftView,
  AirInteractionState,
} from './air-interaction'
import { airTransportProfile, transportCapacityOf } from './air-interaction'
import { fail, succeed, type RuleOutcome } from '../result-types'
import { airCargoTransportT, type AirCargoLoadView } from './air-cargo'
import type { HexRef } from '@/data'
import { sameHex } from '../hex-geometry'

/** 14.9：中止机不再承运；未被摧毁的剩余货物按幸存/活动运力决定继续投送或整组返航。 */
export function planAirCargoContinuation(
  cargo: readonly AirCargoLoadView[],
  roster: Pick<
    ReturnType<typeof airMissionRoster>,
    'activeCapacityT' | 'liveCapacityT' | 'inactiveCarriers'
  > & {
    initialLiveCapacityT?: number
    lostCarriers?: number
    destroyedIds?: readonly string[]
    liveIds?: readonly string[]
    activeIds?: readonly string[]
  },
  flakRounding: boolean,
  cargoByAircraft?: readonly { aircraftId: string; cargoIds: readonly string[] }[],
) {
  const loadedT = cargo.reduce((sum, item) => sum + airCargoTransportT(item), 0)
  if (loadedT === 0)
    return succeed('14.9a', { returnOnly: false, lostCargoIds: [], remainingCargoIds: [] })
  /*
   * 14.9a / 14.9e（T14）：有逐机货单时，被摧毁承运机装载的货物是**确定损失**，
   * 不得静默转给幸存机；剩余货物再按幸存/活动运力判继续投送或整组返航。
   */
  if (cargoByAircraft !== undefined && cargoByAircraft.length > 0) {
    const live = roster.liveIds === undefined ? null : new Set(roster.liveIds)
    const destroyed = new Set(roster.destroyedIds ?? [])
    const active = roster.activeIds === undefined ? null : new Set(roster.activeIds)
    const lostCargoIds: string[] = []
    const remainingCargoIds: string[] = []
    let cargoOnInactiveCarrier = false
    for (const entry of cargoByAircraft) {
      const isLost =
        destroyed.has(entry.aircraftId) || (live !== null && !live.has(entry.aircraftId))
      if (isLost) {
        lostCargoIds.push(...entry.cargoIds)
        continue
      }
      if (active !== null && !active.has(entry.aircraftId) && entry.cargoIds.length > 0)
        cargoOnInactiveCarrier = true
      remainingCargoIds.push(...entry.cargoIds)
    }
    const remainingLoadedT = remainingCargoIds.reduce((sum, id) => {
      const item = cargo.find((entry) => entry.id === id)
      return sum + (item === undefined ? 0 : airCargoTransportT(item))
    }, 0)
    if (remainingLoadedT === 0)
      return succeed('14.9a', { returnOnly: false, lostCargoIds, remainingCargoIds })
    const liveCapacity = flakRounding ? Math.ceil(roster.liveCapacityT) : roster.liveCapacityT
    // 全机中止且无人被毁时，退运按出发时的整组运力判（14.1c），与旧口径一致。
    const returnCapacity =
      roster.lostCarriers === 0
        ? flakRounding
          ? Math.ceil(roster.initialLiveCapacityT ?? roster.liveCapacityT)
          : (roster.initialLiveCapacityT ?? roster.liveCapacityT)
        : liveCapacity
    const activeCapacity = flakRounding ? Math.ceil(roster.activeCapacityT) : roster.activeCapacityT
    if (roster.activeCapacityT === 0 || cargoOnInactiveCarrier)
      return returnCapacity >= remainingLoadedT
        ? succeed('14.1c / 14.9', { returnOnly: true, lostCargoIds, remainingCargoIds })
        : fail('14.9a', 'cargoCannotBeReturned')
    if (activeCapacity < remainingLoadedT) return fail('14.9a', 'cargoExceedsActiveCarrierCapacity')
    return succeed('14.9a', { returnOnly: false, lostCargoIds, remainingCargoIds })
  }
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
    return succeed('14.1c / 14.9', {
      returnOnly: true,
      lostCargoIds: [],
      remainingCargoIds: cargo.map((item) => item.id),
    })
  if (roster.inactiveCarriers > 0) return fail('14.9a', 'cargoCarrierAllocationRequired')
  if (active < loadedT) return fail('14.9a', 'cargoExceedsActiveCarrierCapacity')
  return succeed('14.9a', {
    returnOnly: false,
    lostCargoIds: [],
    remainingCargoIds: cargo.map((item) => item.id),
  })
}

export interface RetainedCargoReturnPlan {
  destination: HexRef | null
  unloadT: number
  allocations: {
    aircraftId: string
    destination: HexRef | null
    offMap?: boolean
    box?: string
    unitIds: string[]
    t: number
  }[]
}

/** 14.1c / 14.9f：留存货物按逐机货单回到**各自**的返航基地（或留在目标格）。 */
export function planRetainedCargoReturn(input: {
  cargo: readonly AirCargoLoadView[]
  targetHex: HexRef
  carriers: readonly {
    aircraftId: string
    offMap: boolean
    baseHex?: HexRef
    offMapBox?: string
  }[]
  returns: readonly { aircraftId: string; baseHex: HexRef }[]
  stayedIds: readonly string[]
  /** 14.9a/14.9e（T15）：逐机货单；给出时按各机自载留存货物分流。 */
  cargoByAircraft?: readonly { aircraftId: string; cargoIds: readonly string[] }[]
}): RuleOutcome<RetainedCargoReturnPlan> {
  const unloadT = input.cargo.reduce((sum, item) => sum + airCargoTransportT(item), 0)
  if (
    !Number.isFinite(unloadT) ||
    unloadT < 0 ||
    new Set(input.cargo.map((item) => item.id)).size !== input.cargo.length
  )
    return fail('14.9', 'invalidRetainedCargo')
  if (input.cargo.length === 0)
    return succeed('14.9', { destination: null as HexRef | null, unloadT: 0, allocations: [] })
  if (input.carriers.length === 0) return fail('14.9', 'retainedCargoHasNoCarrier')

  // 无逐机货单时保留旧口径：整组退到同一实际基地，无法归属才拒绝。
  if (input.cargoByAircraft === undefined || input.cargoByAircraft.length === 0) {
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
    return succeed('14.9', {
      destination: first as HexRef | null,
      unloadT,
      allocations: [
        {
          aircraftId: input.carriers[0]!.aircraftId,
          destination: first,
          unitIds: input.cargo.filter((item) => item.kind === 'unit').map((item) => item.id),
          t: unloadT,
        },
      ],
    })
  }

  /*
   * 14.9a / 14.9e（T15）：每架只带回**自己装载**的留存货物。
   * 承运飞机留在目标格时，其留存货物落目标格；否则回自己的返航基地（离图机回离图盒）。
   */
  const cargoById = new Map(input.cargo.map((item) => [item.id, item]))
  const assigned = new Map<string, string>()
  for (const entry of input.cargoByAircraft)
    for (const id of entry.cargoIds)
      if (cargoById.has(id)) {
        if (assigned.has(id)) return fail('14.9', 'duplicateRetainedCargoAssignment')
        assigned.set(id, entry.aircraftId)
      }
  const unassigned = input.cargo.find((item) => !assigned.has(item.id))
  if (unassigned !== undefined) return fail('14.9', `retainedCargoUnassigned:${unassigned.id}`)
  const carrierById = new Map(input.carriers.map((carrier) => [carrier.aircraftId, carrier]))
  const allocations: {
    aircraftId: string
    destination: HexRef | null
    offMap?: boolean
    box?: string
    unitIds: string[]
    t: number
  }[] = []
  for (const entry of input.cargoByAircraft) {
    const ids = entry.cargoIds.filter((id) => cargoById.has(id))
    if (ids.length === 0) continue
    const carrier = carrierById.get(entry.aircraftId)
    if (carrier === undefined) continue
    const stayed = input.stayedIds.includes(entry.aircraftId)
    const returned = input.returns.find((item) => item.aircraftId === entry.aircraftId)
    const destination = stayed ? input.targetHex : (returned?.baseHex ?? carrier.baseHex)
    const offMap = !stayed && carrier.offMap
    if (destination === undefined && !offMap)
      return fail('14.9', `retainedCargoCarrierWithoutReturnBase:${entry.aircraftId}`)
    const unitIds = ids.filter((id) => cargoById.get(id)!.kind === 'unit')
    if (offMap && unitIds.length > 0) return fail('14.9', 'retainedCargoOffMapReturnUnsupported')
    allocations.push({
      aircraftId: entry.aircraftId,
      destination: destination ?? null,
      ...(offMap ? { offMap: true, box: carrier.offMapBox } : {}),
      unitIds,
      t: ids.reduce((sum, id) => sum + airCargoTransportT(cargoById.get(id)!), 0),
    })
  }
  const first = allocations[0]?.destination
  const destination =
    first !== undefined &&
    first !== null &&
    allocations.every((entry) => entry.destination !== null && sameHex(entry.destination, first))
      ? first
      : null
  return succeed('14.9', { destination, unloadT, allocations })
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
