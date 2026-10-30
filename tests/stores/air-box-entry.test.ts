import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useWorkbenchStore } from '@/stores'

import { CORE_HEX, airBaseRecord, label, placeGround } from '../flows/sop-harness'

/**
 * 专规 1.4a：图外空军盒的飞机「从对应列入场」（store 级接线）
 *
 * 原文：「Moving between the Soviet player's Red Air Force Box and the map's 62.xx row costs
 * 20 hexes of range. Moving between the Axis player's Luftwaffe Box and the map's 01.xx row
 * costs 30 hexes of range.」
 *
 * 用户 2026-10-30 口径：「两家的图外空军基地的飞机从对应行入场，**剩余航程为航程减去
 * 图外空军基地到那一行的航程**」；且「不可能没有空军基地，因为至少有图外的」。
 *
 * 本用例钉住 store → 引擎这一段：盒成员身份必须真的把可用航程减掉 20/30 格
 * （修前盒成员只是装饰，任务照旧按印刷航程满额飞）。
 * 夹具用**轴方**：CORE_HEX 在 col 2，与轴方入场列（1）相邻，格距算得清。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 摆一枚**激活**的轴方战斗机（41 格射程）在本方基地格 */
function setupPlane(workbench: ReturnType<typeof newStore>) {
  workbench.setPhase('movement')
  workbench.setActiveSide('axis')
  workbench.setAirActive(true)
  placeGround(workbench, airBaseRecord(), CORE_HEX, 'axis', 'base-1')
  const choice = workbench.airUnitChoices.find((item) => (item.rangeHexes ?? 0) === 41)
  expect(choice, '轴方应有射程 41 的机型（Bf.109e）').toBeDefined()
  expect(workbench.addAirUnit(choice!.aircraftId, label(CORE_HEX))).toBe(true)
  const plane = workbench.airUnits[0]!
  // 14.1d：整备后才转激活；本用例只关心航程判据，故直接置激活
  plane.airStatus = 'active'
  return plane
}

describe('专规 1.4a：图外盒起飞的航程扣减（store 级）', () => {
  it('★ 盒里的飞机：近处目标（列差 1 ≤ 剩 11）可以，远处（列差 19）被拒', () => {
    // ① 在盒里：41 − 30（轴方盒代价）= 剩 11 格
    const inBox = newStore()
    const plane = setupPlane(inBox)
    inBox.setAirInBoxMembership(plane.instanceId, true)
    expect(inBox.airBoxMembers).toContain(plane.instanceId)
    inBox.toggleAirMissionUnit(plane.instanceId)
    // 入场列 1 → CORE_HEX.col = 2 ⇒ 只花 1 格
    inBox.setAirTargetFromText(label(CORE_HEX))
    expect(inBox.beginAirMissionNow(), JSON.stringify(inBox.airError ?? null)).toBe(true)

    // ② 远处目标：col 20 ⇒ 列差 19 > 11 ⇒ 拒（理由带 1.4a）
    const far = newStore()
    const plane2 = setupPlane(far)
    far.setAirInBoxMembership(plane2.instanceId, true)
    far.toggleAirMissionUnit(plane2.instanceId)
    far.setAirTargetFromText(`20.${String(CORE_HEX.row)}`)
    expect(far.beginAirMissionNow()).toBe(false)
    expect(far.airState).toBeNull()
    expect(far.log.some((entry) => entry.rule === '专规 1.4a')).toBe(true)
  })

  it('★ 不在盒里的同一架飞机按印刷航程满额 —— 同一远处目标反而够得着', () => {
    /*
     * 对照的一半：等价于"别把判据写成一律拒绝"。
     * 飞机停在自己基地格（col 2）⇒ 到 col 20 = 18 格 ≤ 41。
     */
    const workbench = newStore()
    const plane = setupPlane(workbench)
    expect(workbench.airBoxMembers).not.toContain(plane.instanceId)
    workbench.toggleAirMissionUnit(plane.instanceId)
    workbench.setAirTargetFromText(`20.${String(CORE_HEX.row)}`)
    expect(workbench.beginAirMissionNow(), JSON.stringify(workbench.airError ?? null)).toBe(true)
  })
})
