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

describe('专规 1.4：盒内的飞机**不在图上任何一格**（1.4「盒内不允许战斗或轰炸」）', () => {
  /*
   * 原文（专规 1.4）：「In these boxes **no combat or barrage is allowed**.」
   * 1.4a：「Each player has an off-map air box with **infinite basing capacity**.」
   *
   * 本作不把盒内飞机的 `hex` 改掉（那是"回盒再出场"的落点），所以盒成员身份必须在
   * **一切按格判定**的地方生效；否则盒内的飞机会留在原来的基地格上被空战/炮击/夺基地打掉，
   * 或占掉该基地的整备名额 —— 与"在盒里"这件事直接矛盾。
   */
  it('★ 盒内驻机不占图上基地的整备名额（15.1B），也不计入「该格有敌机」', () => {
    const workbench = newStore()
    const plane = setupPlane(workbench)
    const base = workbench.units.find((unit) => unit.noncombatKind === 'air_base')!
    plane.airStatus = 'inactive' // 15.1B 的整备对象是**非激活**飞机

    // 在图上：该基地的整备候选里有它
    expect(workbench.airInactiveAtBase(base.instanceId).map((air) => air.instanceId)).toContain(
      plane.instanceId,
    )

    // 进盒后：整备候选不再含它（盒内走 activateAirBox 的免费整备）
    workbench.setAirInBoxMembership(plane.instanceId, true)
    expect(workbench.airInactiveAtBase(base.instanceId)).toHaveLength(0)
    expect(workbench.onMapAirUnits.map((air) => air.instanceId)).not.toContain(plane.instanceId)

    // 「目标格有敌机」的计数同样不算盒内驻机（14.3/14.5 的前提）
    workbench.setActiveSide('soviet')
    workbench.setAirTargetFromText(label(CORE_HEX))
    expect(workbench.airEnemyAtTarget.activeAircraft).toBe(0)
    expect(workbench.airEnemyAtTarget.canInitiate).toBe(false)

    // 出盒后回到图上：两个投影都恢复
    workbench.setActiveSide('axis')
    workbench.setAirInBoxMembership(plane.instanceId, false)
    expect(workbench.onMapAirUnits.map((air) => air.instanceId)).toContain(plane.instanceId)
    expect(workbench.airInactiveAtBase(base.instanceId).map((air) => air.instanceId)).toContain(
      plane.instanceId,
    )
  })

  it('★ 盒内驻机不再在图上投射巡逻区（14.4c）；出盒后恢复', () => {
    /*
     * 14.4c：巡逻区由**该基地格内的激活战斗机**投射 10 格。盒内驻机不在图上任何一格
     * ⇒ 不应再以"原基地格"投射巡逻区（修前它留在原格上，敌方仍被笼罩）。
     */
    const workbench = newStore()
    const plane = setupPlane(workbench) // 激活的轴方战斗机，停在 CORE_HEX 的基地上
    workbench.setActiveSide('soviet')
    workbench.setAirTargetFromText(label(CORE_HEX))
    expect(workbench.airTargetInEnemyPatrolZone, '在图上时应笼罩（同格）').toBe(true)

    workbench.setActiveSide('axis')
    workbench.setAirInBoxMembership(plane.instanceId, true)
    workbench.setActiveSide('soviet')
    workbench.setAirTargetFromText(label(CORE_HEX))
    expect(workbench.airTargetInEnemyPatrolZone, '盒内驻机不该再投射').toBe(false)

    workbench.setActiveSide('axis')
    workbench.setAirInBoxMembership(plane.instanceId, false)
    workbench.setActiveSide('soviet')
    workbench.setAirTargetFromText(label(CORE_HEX)) // 切方会清目标格，重新指定
    expect(workbench.airTargetInEnemyPatrolZone).toBe(true)
  })
})

describe('专规 1.4a：任务面板的航程判定也按「盒 = 基地」算', () => {
  /*
   * 1.4a 的航程模型：盒内飞机「从对应列入场，剩余航程 = 印刷航程 − 20/30 格」。
   * 修前任务编成阵列（`airMissionJoinChoices`）与 `anyOwnAircraftReaches` 都用 `air.hex`
   * （盒内飞机保留的原位格）算距离 ⇒ 面板会把够得到的盒内飞机灰显成"14.1 够不到"。
   * 轴方盒代价 30、连接列 1；本机 41 格 ⇒ 盒内可用 11 格。
   */
  it('★ 盒内飞机：11 格内不灰显，超出即灰显（10.2b 的「距基地格数」同步按盒算）', () => {
    const workbench = newStore()
    const plane = setupPlane(workbench)
    workbench.setAirInBoxMembership(plane.instanceId, true) // 驻进图外盒

    // 目标 col 10、同行：1 → 10 = 9 格（≤ 11）⇒ 不该灰显
    workbench.setAirTargetFromText(`10.${String(CORE_HEX.row)}`)
    const near = workbench.airMissionJoinChoices.find(
      (item) => item.air.instanceId === plane.instanceId,
    )
    expect(near, '盒内飞机应出现在任务编成阵列里').toBeDefined()
    expect(near!.disabledReason).toBeNull()

    // 目标 col 20：1 → 20 = 19 格（> 11）⇒ 灰显为 14.1 够不到
    workbench.setAirTargetFromText(`20.${String(CORE_HEX.row)}`)
    const far = workbench.airMissionJoinChoices.find(
      (item) => item.air.instanceId === plane.instanceId,
    )
    expect(far!.disabledReason).toBe('14.1：该机航程够不到任务格')
  })
})

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

  it('★ 9.14f + 1.4a：基地被占且图上无处转场 ⇒ 飞回图外盒（进盒成员），不是摧毁', () => {
    /*
     * 用户 2026-10-30 口径：「不可能没有空军基地，因为至少有图外的」。
     * 夹具：全图只有这一座轴方基地、且它被夺取 ⇒ `friendlyBases` 为空；
     * 该机射程 41 ≥ 轴方盒代价 30 ⇒ 应飞回盒并转非激活（修前：直接摧毁）。
     */
    const workbench = newStore()
    const plane = setupPlane(workbench)
    const base = workbench.units.find((unit) => unit.noncombatKind === 'air_base')!
    // 9.14f 表 17-6：强制掷 12（+2 非激活/激活修正后仍无损失）
    workbench.airInputs.baseCaptureDice = 12

    expect(workbench.captureAirBaseNow(base.instanceId)).toBe(true)
    // 飞机还在（没被摧毁），进了图外盒并转非激活
    expect(workbench.airUnits.some((item) => item.instanceId === plane.instanceId)).toBe(true)
    expect(workbench.airBoxMembers).toContain(plane.instanceId)
    expect(workbench.airUnits[0]!.airStatus).toBe('inactive')
    expect(workbench.log.some((entry) => entry.text.includes('飞回图外空军盒'))).toBe(true)
  })
})
