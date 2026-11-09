import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { hexDistance } from '@/engine/hex-geometry'
import { useWorkbenchStore } from '@/stores'

import {
  CORE_HEX,
  NEAR_HEX,
  airBaseRecord,
  bomberRecord,
  fighterRecord,
  placeAir,
  placeGround,
} from '../flows/sop-harness'

/**
 * 空军任务窗口的**基地分栏**（用户 2026-11-09 追加批）
 *
 * 口径：
 *   · 只在**轰炸 / 低空扫射**时按本方空军基地分栏列驻机（其它任务类型不展开）；
 *   · 每架机给出到当前任务格的距离与自己的航程（14.2d / 14.7c 的判据素材）；
 *   · 点某个基地 ⇒ 地图高亮该基地格（复用 `setHoverHex`，不新开高亮通道）；
 *   · 可选性/原因一律沿用 `airMissionJoinChoices`（14.1a/14.2a/14.2e），本处不另判。
 */

function setup(kind: 'barrage' | 'hip_shoot' | 'air_transport' = 'barrage') {
  setActivePinia(createPinia())
  const w = useWorkbenchStore()
  w.setActiveSide('axis')
  w.setPhase('movement')
  w.setSegmentStepIndex(
    w.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement'),
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
    const w = setup('barrage')
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

  it('★ 低空扫射同样分栏；空运等其它任务类型不展开', () => {
    const w = setup('hip_shoot')
    expect(w.airMissionBaseGroups.length).toBe(2)

    const other = setup('air_transport')
    expect(other.airMissionBaseGroups).toEqual([])
  })

  it('★ 可选性沿用 airMissionJoinChoices（非激活灰显），本处不另判', () => {
    const w = setup('barrage')
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
