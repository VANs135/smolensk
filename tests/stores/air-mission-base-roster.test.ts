import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { hexDistance } from '@/engine/hex-geometry'
import { useWorkbenchStore } from '@/stores'

import {
  CORE_HEX,
  NEAR_HEX,
  airBaseRecord,
  aircraftRecord,
  bomberRecord,
  fighterRecord,
  placeAir,
  placeGround,
} from '../flows/sop-harness'

/**
 * 空军任务窗口的**基地分栏**（用户 2026-11-09 追加批；2026-11-12 改为全任务类型）
 *
 * 口径：
 *   · **所有**主动空军任务都按本方空军基地分栏列驻机（目标侧发起 ⇒ 窗内按基地选机组队）；
 *   · 每架机给出到当前任务格的距离与自己的航程（14.2d / 14.7c 的判据素材）；
 *   · 点某个基地 ⇒ 地图高亮该基地格（复用 `setHoverHex`，不新开高亮通道）；
 *   · 可选性/原因一律沿用 `airMissionJoinChoices`（14.1a/14.2a/14.2e），本处不另判。
 */

function setup(
  kind: 'barrage' | 'hip_shoot' | 'air_transport' = 'barrage',
  segment: 'movement' | 'barrage' = 'movement',
) {
  setActivePinia(createPinia())
  const w = useWorkbenchStore()
  w.setActiveSide('axis')
  w.setPhase('movement')
  // 14.2e / 10.0 第二段：普通轰炸只在本段的轰炸环节宣布；移动环节只给低空扫射等
  w.setSegmentStepIndex(
    w.playerSegmentSteps.findIndex((step) =>
      segment === 'barrage'
        ? step.id === 'movement.barrage'
        : step.id === 'movement.modeAndMovement',
    ),
  )
  placeGround(w, airBaseRecord(1), CORE_HEX, 'axis', 'base-a')
  placeGround(w, airBaseRecord(2), NEAR_HEX, 'axis', 'base-b')
  placeAir(w, fighterRecord('axis'), CORE_HEX, 'axis', 'f1')
  placeAir(w, bomberRecord('axis'), NEAR_HEX, 'axis', 'b2')
  w.setAirActive(true)
  w.setAirMissionKind(kind)
  w.setAirTargetFromText(`${CORE_HEX.col}.${CORE_HEX.row}`)
  return w
}

describe('空军任务窗口：按基地分栏的驻机名册', () => {
  it('★ 轰炸时按本方基地分栏，每架给出到任务格的距离与航程', () => {
    const w = setup('barrage', 'barrage')
    expect(w.airMissionBaseGroups.map((group) => group.baseId)).toEqual(['base-a', 'base-b'])

    const groupA = w.airMissionBaseGroups.find((group) => group.baseId === 'base-a')!
    const flight = groupA.aircraft.find((item) => item.air.instanceId === 'f1')!
    expect(groupA.hex).toEqual(CORE_HEX)
    expect(flight.distanceToTarget).toBe(hexDistance(CORE_HEX, CORE_HEX))
    expect(flight.inRange).toBe(true)
    expect(w.airMissionKind).toBe('barrage')
    expect(flight.withinShortRange).toBe(true)
    expect(flight.selected).toBe(false)

    const groupB = w.airMissionBaseGroups.find((group) => group.baseId === 'base-b')!
    const bomber = groupB.aircraft.find((item) => item.air.instanceId === 'b2')!
    expect(bomber.distanceToTarget).toBe(hexDistance(NEAR_HEX, CORE_HEX))
  })

  it('★ 低空扫射同样分栏；非轰炸任务只列能执行该任务的机型（2026-11-12）', () => {
    const w = setup('hip_shoot')
    expect(w.airMissionBaseGroups.length).toBe(2)

    const other = setup('air_transport')
    // 战斗机/无运力轰炸机不能执行空运 ⇒ 整架不出现；补一架运输机后只列它
    expect(other.airMissionBaseGroups).toEqual([])
    placeAir(
      other,
      aircraftRecord('axis', (record) => (record.transportCapacity ?? 0) > 0),
      NEAR_HEX,
      'axis',
      't1',
    )
    const groups = other.airMissionBaseGroups
    expect(groups.map((group) => group.baseId)).toEqual(['base-b'])
    expect(groups[0]!.aircraft.map((item) => item.air.instanceId)).toEqual(['t1'])
  })

  it('★ 可选性沿用 airMissionJoinChoices（非激活灰显），本处不另判', () => {
    const w = setup('barrage', 'barrage')
    const inactive = w.airUnits.find((air) => air.instanceId === 'b2')!
    inactive.airStatus = 'inactive'

    const bomber = w.airMissionBaseGroups
      .flatMap((group) => group.aircraft)
      .find((item) => item.air.instanceId === 'b2')!
    expect(bomber.disabledReason).toContain('14.1a')
  })

  it('★ 点基地 ⇒ 地图高亮该基地格，并记住当前聚焦的基地', () => {
    const w = setup('barrage')
    expect(w.focusAirMissionBase('base-b')).toBe(true)
    expect(w.airMissionBaseFocus).toBe('base-b')
    expect(w.hoverHex).toEqual(NEAR_HEX)
    expect(w.focusAirMissionBase('nope')).toBe(false)
  })

  it('★ 任务格未定 ⇒ 距离为空（不拿默认格去猜）', () => {
    const w = setup('barrage')
    w.airTargetHex = null
    const flight = w.airMissionBaseGroups
      .flatMap((group) => group.aircraft)
      .find((item) => item.air.instanceId === 'f1')!
    expect(flight.distanceToTarget).toBe(null)
    expect(flight.inRange).toBe(null)
  })
})
