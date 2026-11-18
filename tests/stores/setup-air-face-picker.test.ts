import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { findAircraftRecord } from '@/engine/rules'
import { useHotseatStore, useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 初设飞机四栏（2026-11-19）
 *
 * 用户口径：同一型飞机按「激活/未激活 × 完好/减损」分成四份；点哪一枚就落哪一枚，
 * 状态与印值不能串。store 的 `pendingAirFaces` 是四栏的唯一投影，`faceIndex` 指回
 * `planAirSetup` 的三条并列数组（`statuses` / `reduced` / `steps`）。
 */

function stores() {
  setActivePinia(createPinia())
  useHotseatStore().setMode('solo')
  const setup = useSetupStore()
  setup.selectScenario('3')
  return { setup, workbench: useWorkbenchStore() }
}

describe('初设飞机四栏：状态与减损同下标', () => {
  it('pendingAirFaces 与计划逐下标一致，且总量 = 剩余枚数', () => {
    const { setup } = stores()
    const plan = setup.airPlanOf('axis')
    expect(plan).not.toBeNull()
    let checked = 0
    for (const row of plan!.placements) {
      const faces = setup.pendingAirFaces('axis', row.entryIndex)
      expect(faces).toHaveLength(row.count)
      for (const face of faces) {
        expect(face.status).toBe(row.statuses[face.faceIndex])
        expect(face.reduced).toBe(row.reduced[face.faceIndex] === true)
      }
      checked += 1
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('点「减损」那一枚 ⇒ 落到盘面的就是减损面（军力 −1），状态跟随该面', () => {
    const { setup, workbench } = stores()
    const plan = setup.airPlanOf('axis')!
    const row = plan.placements.find(
      (item) => item.reduced.some(Boolean) && item.candidates.length > 0,
    )
    expect(row, '剧本 3 轴心应有带 `*` 减损且基地已就位的机型').toBeDefined()
    const face = setup
      .pendingAirFaces('axis', row!.entryIndex)
      .find((item) => item.reduced && item.status === row!.statuses[item.faceIndex])
    expect(face).toBeDefined()
    const printed = findAircraftRecord(row!.aircraftId)?.steps ?? 2

    expect(setup.beginAirPlacement('axis', row!.entryIndex, face!.status, face!.reduced)).toBe(true)
    expect(setup.placing?.faceIndex).toBe(face!.faceIndex)
    expect(setup.placeAtHex(row!.candidates[0]!)).toBe(true)

    const air = workbench.airUnits.at(-1)
    expect(air?.airStatus).toBe(face!.status)
    expect(air?.steps).toBe(printed - 1)
  })

  it('「入盒」按 faceIndex 放指定那一枚（不再只按机型放下一枚）', () => {
    const { setup, workbench } = stores()
    const plan = setup.airPlanOf('axis')!
    const row = plan.placements.find(
      (item) => item.count > 1 && item.reduced.some(Boolean) && item.candidates.length > 0,
    )
    if (row === undefined) return // 该剧本没有"多枚 + 减损"的机型则本条不适用
    const faces = setup.pendingAirFaces('axis', row.entryIndex)
    // 取一枚与"下一枚"不同的面：优先减损面
    const target = faces.find((item) => item.reduced) ?? faces.at(-1)!
    expect(target).toBeDefined()
    const before = workbench.airUnits.length

    expect(setup.placeAirInOffMapBoxNow('axis', row.entryIndex, target.faceIndex)).toBe(true)
    expect(workbench.airUnits.length).toBe(before + 1)
    const air = workbench.airUnits.at(-1)
    expect(air?.airStatus).toBe(target.status)
    expect(workbench.airBoxMembers).toContain(air!.instanceId)
    const printed = findAircraftRecord(row.aircraftId)?.steps ?? 2
    expect(air?.steps).toBe(target.reduced ? printed - 1 : printed)
  })
})
