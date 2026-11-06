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
  cargoByAircraft: [],
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
  it('逐机货单：被摧毁承运机的货物确定损失，不转给幸存机（14.9e）', () => {
    const cargo = [
      { id: 'sp:1', kind: 'sp' as const, t: 1 },
      { id: 'sp:2', kind: 'sp' as const, t: 1 },
    ]
    const roster = {
      activeIds: ['b'],
      liveIds: ['b'],
      destroyedIds: ['a'],
      activeCapacityT: 1,
      liveCapacityT: 1,
      inactiveCarriers: 0,
    }
    const continuation = planAirCargoContinuation(cargo, roster, false, [
      { aircraftId: 'a', cargoIds: ['sp:1'] },
      { aircraftId: 'b', cargoIds: ['sp:2'] },
    ])
    expect(continuation).toMatchObject({
      ok: true,
      data: {
        returnOnly: false,
        lostCargoIds: ['sp:1'],
        remainingCargoIds: ['sp:2'],
      },
    })
  })
  it('逐机货单：剩余货物在活动运力不足但可随幸存机返航时整组退回', () => {
    const cargo = [
      { id: 'sp:1', kind: 'sp' as const, t: 1 },
      { id: 'sp:2', kind: 'sp' as const, t: 1 },
    ]
    const roster = {
      activeIds: [],
      liveIds: ['a', 'b'],
      destroyedIds: [],
      activeCapacityT: 0,
      liveCapacityT: 2,
      inactiveCarriers: 2,
    }
    expect(
      planAirCargoContinuation(cargo, roster, false, [
        { aircraftId: 'a', cargoIds: ['sp:1'] },
        { aircraftId: 'b', cargoIds: ['sp:2'] },
      ]),
    ).toMatchObject({
      ok: true,
      data: { returnOnly: true, lostCargoIds: [], remainingCargoIds: ['sp:1', 'sp:2'] },
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
  it('留存货物按逐机货单回到各自基地，留场飞机的货物落目标格（14.9e）', () => {
    const other = { col: 21, row: 20 }
    const cargo = [
      { id: 'sp:1', kind: 'sp' as const, t: 1 },
      { id: 'sp:2', kind: 'sp' as const, t: 1 },
    ]
    const base = {
      cargo,
      targetHex: hex,
      carriers: [
        { aircraftId: 'a', offMap: false, baseHex: other },
        { aircraftId: 'b', offMap: false, baseHex: hex },
      ],
      returns: [
        { aircraftId: 'a', baseHex: other },
        { aircraftId: 'b', baseHex: { col: 22, row: 20 } },
      ],
      stayedIds: ['b'],
      cargoByAircraft: [
        { aircraftId: 'a', cargoIds: ['sp:1'] },
        { aircraftId: 'b', cargoIds: ['sp:2'] },
      ],
    }
    const result = planRetainedCargoReturn(base)
    expect(result).toMatchObject({
      ok: true,
      data: {
        destination: null,
        unloadT: 2,
        allocations: [
          { aircraftId: 'a', destination: other, unitIds: [], t: 1 },
          { aircraftId: 'b', destination: hex, unitIds: [], t: 1 },
        ],
      },
    })
    // 无法归属的留存货物仍明确拒绝，不猜分流。
    expect(
      planRetainedCargoReturn({
        ...base,
        cargoByAircraft: [{ aircraftId: 'a', cargoIds: ['sp:1'] }],
      }),
    ).toMatchObject({ ok: false, reason: 'retainedCargoUnassigned:sp:2' })
  })
})
