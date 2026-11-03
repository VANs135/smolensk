import { describe, expect, it } from 'vitest'
import {
  airMissionRoster,
  planAirCargoContinuation,
  planRetainedCargoReturn,
  survivingAirMission,
} from '@/engine/rules/air-mission-roster'
import type {
  AirMissionAssignment,
  AirMissionAircraftView,
  AirInteractionState,
} from '@/engine/rules/air-interaction'

const hex = { col: 20, row: 20 }
const assignment: AirMissionAssignment = {
  side: 'axis',
  kind: 'air_transport',
  targetHex: hex,
  aircraftIds: ['flying', 'aborted', 'dead'],
  origins: ['flying', 'aborted', 'dead'].map((aircraftId) => ({
    aircraftId,
    baseHex: hex,
    distanceHexes: 1,
    rangeHexes: 10,
  })),
  cargo: [{ id: 'sp:1', kind: 'sp', t: 1 }],
  cargoCapacity: 6,
  maxDistanceHexes: 1,
  allWithinShortRange: true,
  rule: '14.9a',
}
function plane(id: string, airStatus: 'active' | 'inactive' = 'active'): AirMissionAircraftView {
  return {
    id,
    side: 'axis',
    baseHex: hex,
    airStatus,
    steps: 2,
    aircraftType: 'Tpt',
    transportCapacity: 1,
    airCombatRating: 0,
    canInitiateAirCombat: false,
    canBarrage: false,
    rangeHexes: 10,
    missionsFlownThisPhase: 0,
  }
}
describe('14.1 / 14.9：任务存活名单与整组退运', () => {
  it('中止与摧毁机不提供活动运力，但中止机仍须办理返航', () => {
    const roster = airMissionRoster(assignment, [plane('flying'), plane('aborted', 'inactive')])
    expect(roster).toMatchObject({
      activeIds: ['flying'],
      liveIds: ['flying', 'aborted'],
      destroyedIds: ['dead'],
      activeCapacityT: 2,
      liveCapacityT: 4,
      inactiveCarriers: 1,
    })
  })
  it('部分中止不静默转移货物；整组中止且运力足够可退运', () => {
    const partial = airMissionRoster(assignment, [plane('flying'), plane('aborted', 'inactive')])
    expect(planAirCargoContinuation(assignment.cargo, partial, false)).toMatchObject({
      ok: false,
      reason: 'cargoCarrierAllocationRequired',
    })
    const all = airMissionRoster(assignment, [
      plane('flying', 'inactive'),
      plane('aborted', 'inactive'),
    ])
    expect(planAirCargoContinuation(assignment.cargo, all, false)).toMatchObject({
      ok: true,
      data: { returnOnly: true },
    })
  })
  it('没有承运机时不能投送；货物已全部损失后可收束空任务', () => {
    const empty = airMissionRoster(assignment, [])
    expect(planAirCargoContinuation(assignment.cargo, empty, false).ok).toBe(false)
    expect(planAirCargoContinuation([], empty, false)).toMatchObject({
      ok: true,
      data: { returnOnly: false },
    })
  })
  it('仅防空损失允许有利于货物存活的容量取整', () => {
    const roster = {
      activeIds: [],
      liveIds: ['aborted'],
      destroyedIds: [],
      activeCapacityT: 0,
      liveCapacityT: 0.5,
      inactiveCarriers: 1,
    }
    expect(planAirCargoContinuation(assignment.cargo, roster, false).ok).toBe(false)
    expect(planAirCargoContinuation(assignment.cargo, roster, true)).toMatchObject({
      ok: true,
      data: { returnOnly: true },
    })
  })
  it('G步只保留存活飞机，不能为死亡堆的飞机再次返航', () => {
    const state: AirInteractionState = {
      assignment,
      step: 'returnToBase',
      side: 'axis',
      phase: 'movement',
      kind: 'air_transport',
      targetHex: hex,
      combat: null,
      airCombat: null,
      interception: null,
      flak: null,
      cargo: null,
      missionNote: null,
      returns: [],
      finished: false,
    }
    const filtered = survivingAirMission(state, [
      { id: 'aborted', steps: 1 },
      { id: 'dead', steps: 0 },
    ])
    expect(filtered.assignment.aircraftIds).toEqual(['aborted'])
    expect(filtered.assignment.origins.map((item) => item.aircraftId)).toEqual(['aborted'])
    expect(state.assignment.origins).toHaveLength(3)
  })
  it('留存货物落到共同实际返航基地，分流则明确拒绝', () => {
    const other = { col: 21, row: 20 }
    const base = {
      cargo: assignment.cargo,
      targetHex: hex,
      carriers: [
        { aircraftId: 'a', offMap: false },
        { aircraftId: 'b', offMap: false },
      ],
      stayedIds: [],
    }
    expect(
      planRetainedCargoReturn({
        ...base,
        returns: [
          { aircraftId: 'a', baseHex: other },
          { aircraftId: 'b', baseHex: other },
        ],
      }),
    ).toMatchObject({ ok: true, data: { destination: other, unloadT: 1 } })
    expect(
      planRetainedCargoReturn({
        ...base,
        returns: [
          { aircraftId: 'a', baseHex: other },
          { aircraftId: 'b', baseHex: hex },
        ],
      }),
    ).toMatchObject({ ok: false, reason: 'retainedCargoRequiresCommonReturnBase' })
  })
})
