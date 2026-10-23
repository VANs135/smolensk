import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  canAddAircraftAtStep,
  canIntercept,
  canJoinMission,
  canPerformMissionThisPhase,
  canVoluntarilyReturn,
  missionSegmentOf,
  planInterceptionResponse,
} from '@/engine/rules'
import { baseAaValue, computeFlakDrm } from '@/engine/rules/air'
import {
  airBoxRefitCapacity,
  edgeBoxRules,
  isEdgeBoxExitFuelFree,
} from '@/engine/rules/air-mission'
import { useWorkbenchStore } from '@/stores'

import { CORE_HEX, aircraftRecord, placeAir } from '../flows/sop-harness'

/**
 * M6③ 空军资格族（store 级）＋ 三处**重复实现**的收口
 *
 * 条文：
 *   · **14.2a** 一次任务合计上限 4 个空军单位；**14.2e** 同一机一阶段只执行一次任务、
 *     且各任务分属**不同环节**；**14.2f** 步骤 C 之后不能再向任务添加飞机；
 *   · **14.3d** 主动返航窗口：空战前（须留 ≥1 架）/ 空战中（禁止）/ 空战后（允许）；
 *   · **14.5** 拦截资格四门槛（已拦截 / 巡逻区 / 14.4a 受防空影响 / 有可用激活战斗机）；
 *   · **15.0b-B** 空军基地防空点数＝等级（**15.2F**：简易机场不提供防空值）；
 *   · **专规 1.4a** 空军盒整备额度（容量无限、免费）；**1.4b** 离开边缘盒免费加油。
 *
 * ★ 修前这 9 项**全部零消费**，而其中 4 项在引擎内部另有**同义的第二份实现**：
 *   `planInterceptionResponse` 把 14.5 的四个门槛又判了一遍；`assignAirMission` 自算
 *   `length > 4`（14.2a）与 `missionsFlownThisPhase >= 1`（14.2e）；
 *   `computeFlakDrm` 自算 `等级 × 系数`（15.0b-B）。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('14.2a / 14.2e：参战机的两道上限（引擎唯一实现）', () => {
  it('canJoinMission：合计 ≤ 4，第 5 架即拒', () => {
    expect(canJoinMission(3, 1)).toMatchObject({ ok: true })
    expect(canJoinMission(4, 1)).toMatchObject({
      ok: false,
      rule: '14.2a',
      reason: 'missionAircraftLimitExceeded:5',
    })
    // 已有 4 架时再加 0 架（复核现状）应当通过
    expect(canJoinMission(4, 0).ok).toBe(true)
  })

  it('canPerformMissionThisPhase：一阶段一次', () => {
    expect(canPerformMissionThisPhase(0)).toBe(true)
    expect(canPerformMissionThisPhase(1)).toBe(false)
    expect(canPerformMissionThisPhase(2)).toBe(false)
  })

  it('canAddAircraftAtStep：步骤 C 之后不能再加飞机', () => {
    expect(canAddAircraftAtStep('declare')).toBe(true)
    expect(canAddAircraftAtStep('move')).toBe(true)
    expect(canAddAircraftAtStep('airCombat')).toBe(false)
    expect(canAddAircraftAtStep('interception')).toBe(false)
    expect(canAddAircraftAtStep('flak')).toBe(false)
    expect(canAddAircraftAtStep('resolveMission')).toBe(false)
    expect(canAddAircraftAtStep('returnToBase')).toBe(false)
  })

  it('missionSegmentOf：三类环节各归其位（14.2e）', () => {
    expect(missionSegmentOf('barrage')).toBe('barrageSegment')
    expect(missionSegmentOf('trainbusting')).toBe('barrageSegment')
    expect(missionSegmentOf('hip_shoot')).toBe('movementSegment')
    expect(missionSegmentOf('fighter_sweep')).toBe('movementSegment')
    expect(missionSegmentOf('air_drop')).toBe('movementSegment')
    expect(missionSegmentOf('base_transfer')).toBe('movementSegment')
    expect(missionSegmentOf('interception')).toBe('interceptStep')
  })

  it('store：参战机上限由引擎裁定（选 4 架后再选第 5 架被拒，且不写进选集）', () => {
    const store = newStore()
    const fighter = aircraftRecord('axis', (record) => record.aircraftType === 'F')
    for (let index = 0; index < 5; index += 1)
      placeAir(store, fighter, CORE_HEX, 'axis', `f${index}`)
    for (let index = 0; index < 4; index += 1) store.toggleAirMissionUnit(`f${index}`)
    expect(store.airMissionAirIds).toHaveLength(4)
    expect(store.airJoinRemaining).toBe(0)

    store.toggleAirMissionUnit('f4')
    expect(store.airMissionAirIds).toHaveLength(4)
    expect(store.airError).toMatchObject({ rule: '14.2a' })
  })

  it('store：14.2e —— 本阶段已执行过任务的飞机不能再被选入', () => {
    const store = newStore()
    const fighter = aircraftRecord('axis', (record) => record.aircraftType === 'F')
    const plane = placeAir(store, fighter, CORE_HEX, 'axis', 'f0')
    plane.missionsFlownThisPhase = 1
    store.toggleAirMissionUnit('f0')
    expect(store.airMissionAirIds).toEqual([])
    expect(store.airError?.rule).toBe('14.2e')
  })

  it('store：`airMissionSegment` 与 `missionSegmentOf` 同源（界面标注用）', () => {
    const store = newStore()
    store.setAirMissionKind('trainbusting')
    expect(store.airMissionSegment).toBe('barrageSegment')
    store.setAirMissionKind('air_drop')
    expect(store.airMissionSegment).toBe('movementSegment')
  })
})

describe('14.3d：主动返航的三个窗口', () => {
  it('引擎判据：空战前须留 1 架；空战中禁止；空战后自由', () => {
    expect(
      canVoluntarilyReturn({ window: 'beforeAirCombat', friendlyActiveRemainingAfterReturn: 1 }),
    ).toMatchObject({ ok: true, rule: '14.3d-A' })
    expect(
      canVoluntarilyReturn({ window: 'beforeAirCombat', friendlyActiveRemainingAfterReturn: 0 }),
    ).toMatchObject({ ok: false, reason: 'mustKeepOneActiveUnitInCombat' })
    expect(
      canVoluntarilyReturn({ window: 'duringAirCombat', friendlyActiveRemainingAfterReturn: 3 }),
    ).toMatchObject({ ok: false, rule: '14.3d-B', reason: 'noVoluntaryReturnDuringAirCombat' })
    expect(
      canVoluntarilyReturn({ window: 'afterAirCombat', friendlyActiveRemainingAfterReturn: 0 }),
    ).toMatchObject({ ok: true, rule: '14.3d-C' })
  })

  it('store：未宣布任务时拒绝主动返航', () => {
    const store = newStore()
    expect(store.voluntaryReturnNow(['x'])).toBe(false)
    expect(store.airError?.rule).toBe('14.3d')
  })
})

describe('14.5：拦截资格——判定只有一处（`canIntercept`）', () => {
  const base = {
    missionKind: 'barrage' as const,
    missionHexInPatrolZone: true,
    hasActiveFighterInPatrolZone: true,
    alreadyIntercepted: false,
  }

  it('三个门槛与「每任务只拦一次」', () => {
    expect(canIntercept(base)).toMatchObject({ ok: true, data: { interceptorCount: 1 } })
    expect(canIntercept({ ...base, alreadyIntercepted: true })).toMatchObject({
      reason: 'missionAlreadyIntercepted',
    })
    expect(canIntercept({ ...base, missionHexInPatrolZone: false })).toMatchObject({
      reason: 'missionHexOutsidePatrolZone',
    })
    expect(canIntercept({ ...base, hasActiveFighterInPatrolZone: false })).toMatchObject({
      reason: 'noActiveFighterInPatrolZone',
    })
  })

  it('14.4a：不受防空影响的任务（战机扫荡）永不可被拦截', () => {
    expect(canIntercept({ ...base, missionKind: 'fighter_sweep' })).toMatchObject({
      rule: '14.4a',
      reason: 'missionNotFlakAffected:fighter_sweep',
    })
  })

  it('`planInterceptionResponse` 与 `canIntercept` **同源**（修前各判一遍）', () => {
    // 没有基地/飞机 ⇒ 巡逻区不覆盖任务格 ⇒ 两者的第一道结论必须一致
    const response = planInterceptionResponse({
      side: 'soviet',
      missionKind: 'barrage',
      missionHex: CORE_HEX,
      alreadyIntercepted: false,
      aircraft: [],
      bases: [],
    })
    const verdict = canIntercept({
      missionKind: 'barrage',
      missionHexInPatrolZone: false,
      hasActiveFighterInPatrolZone: false,
      alreadyIntercepted: false,
    })
    expect(response.eligible).toBe(verdict.ok)
    expect(response.rule).toBe(verdict.ok ? '14.5' : verdict.rule)
    expect(verdict.ok ? null : response.reason).toBe(verdict.ok ? null : verdict.reason)
  })

  it('已拦截过 ⇒ 两者都拒（且原因码相同）', () => {
    const response = planInterceptionResponse({
      side: 'soviet',
      missionKind: 'barrage',
      missionHex: CORE_HEX,
      alreadyIntercepted: true,
      aircraft: [],
      bases: [],
    })
    expect(response).toMatchObject({
      eligible: false,
      rule: '14.5',
      reason: 'missionAlreadyIntercepted',
    })
  })
})

describe('15.0b-B / 15.2F：基地防空点数（14.4e 的基地那一项）', () => {
  it('`baseAaValue`＝等级；简易机场为 0', () => {
    expect(baseAaValue(0)).toBe(0)
    expect(baseAaValue(3)).toBe(3)
    expect(baseAaValue(3, true)).toBe(0)
  })

  it('`computeFlakDrm` 的基地项与 `baseAaValue` 同源（修前自算 等级×系数）', () => {
    const baseInput = {
      missionAircraftCount: 1,
      targetHasHQ: false,
      inEnemyPatrolZone: false,
    }
    expect(computeFlakDrm({ ...baseInput, airBaseLevel: 3 })).toBe(baseAaValue(3))
    expect(computeFlakDrm({ ...baseInput, airBaseLevel: 3, baseIsAirstrip: true })).toBe(0)
    expect(computeFlakDrm({ ...baseInput, airBaseLevel: 2, printedFlakValue: 1 })).toBe(
      baseAaValue(2) + 1,
    )
  })
})

describe('专规 1.4a / 1.4b：地图外盒的两项事实', () => {
  it('1.4a：空军盒整备额度＝容量无限 + 费用 0T', () => {
    const refit = airBoxRefitCapacity()
    expect(refit.capacity).toBe(Number.POSITIVE_INFINITY)
    expect(refit.unlimited).toBe(true)
    expect(refit.costT).toBe(0)
  })

  it('1.4b：离开边缘盒免费加油 —— 规则对象与该事实同源（唯一实现）', () => {
    expect(isEdgeBoxExitFuelFree()).toBe(true)
    expect(edgeBoxRules().exitFuelsFree).toBe(isEdgeBoxExitFuelFree())
  })
})
