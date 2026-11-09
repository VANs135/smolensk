import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useContainersStore, useWorkbenchStore } from '@/stores'

import { CORE_HEX, NEAR_HEX, airBaseRecord, label, placeGround } from '../flows/sop-harness'

/**
 * 条 14（用户实机）：「飞出盒」必须走完 14.11 的落位流程，不能点完只关窗
 *
 * 现象：盒内飞机点「飞出盒」后只从盒成员里消失，既没有目标基地可选、也没有落位回显，
 * 玩家不知道飞机去了哪；且盒内空军窗与编队窗共用同一个 `<details>` 容器。
 *
 * 规则：专规 1.4a 的「从对应列入场」只约束**飞入盒**的往返航程；飞出盒在规则上等同 14.11
 * 基地转移 —— 目的地须为本方空军基地，距离/激活态由 `planBaseTransfer` 裁。故「飞出盒」
 * 必须选目标基地 → 落位 → 回显 → 再退出盒成员。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 摆一枚**激活**的轴方战斗机（41 格射程）在本方基地格（与 air-box-entry 同一夹具） */
function setupPlane(workbench: ReturnType<typeof newStore>) {
  workbench.setPhase('movement')
  workbench.setActiveSide('axis')
  workbench.setAirActive(true)
  placeGround(workbench, airBaseRecord(), CORE_HEX, 'axis', 'base-1')
  const choice = workbench.airUnitChoices.find((item) => (item.rangeHexes ?? 0) === 41)
  expect(choice, '轴方应有射程 41 的机型（Bf.109e）').toBeDefined()
  expect(workbench.addAirUnit(choice!.aircraftId, label(CORE_HEX))).toBe(true)
  const plane = workbench.airUnits[0]!
  // 14.1d：整备后才转激活；本用例只关心落位判据，故直接置激活
  plane.airStatus = 'active'
  return plane
}

describe('条 14：飞出盒＝完整的 14.11 落位流程', () => {
  it('★ 飞出盒必须给目标基地并真的落位（14.11），不能只关窗', () => {
    const workbench = newStore()
    const containers = useContainersStore()
    const plane = setupPlane(workbench)
    workbench.setAirInBoxMembership(plane.instanceId, true)
    expect(workbench.airBoxMembers).toContain(plane.instanceId)

    // 目标就是原基地（0 格）：14.11 判据下必然可落
    expect(containers.flyOutOfBox(plane.instanceId, label(CORE_HEX))).toBe(true)
    expect(workbench.airBoxMembers).not.toContain(plane.instanceId) // 已退盒
    expect(plane.hex).toEqual(CORE_HEX) // 落位可见
    expect(containers.lastAction?.detail).toContain('落位') // 回显
    expect(workbench.log.some((entry) => entry.rule === '14.11')).toBe(true) // 写日志
    expect(workbench.lastTransfer?.detail).toContain('基地转移') // 14.11 判据结果
  })

  it('★ 目标不是本方空军基地 ⇒ 拒绝、留在盒里、给理由', () => {
    const workbench = newStore()
    const containers = useContainersStore()
    const plane = setupPlane(workbench)
    workbench.setAirInBoxMembership(plane.instanceId, true)

    // NEAR_HEX 是 CORE_HEX 的邻格，本用例没有在那摆基地
    expect(workbench.units.some((unit) => unit.noncombatKind === 'air_base')).toBe(true)
    expect(containers.flyOutOfBox(plane.instanceId, label(NEAR_HEX))).toBe(false)
    expect(workbench.airBoxMembers).toContain(plane.instanceId) // 仍在盒里
    expect(containers.lastAction?.ok).toBe(false)
    expect(containers.lastAction?.rule).toBe('14.11')
    expect(containers.lastAction?.detail).toContain('14.11')
  })

  it('★ 窗外提示：盒内空军窗与编队窗不共用容器', () => {
    const panel = readFileSync('src/components/containers/ContainersPanel.vue', 'utf8')
    // 空军盒独立成 section（自带 box--air 边框/标题），不再套在其它盒共用的 <details> 里
    expect(panel).toMatch(/<section[^>]*class="box box--air"/)
    expect(panel).toMatch(/box--air[\s\S]{0,900}<AircraftRoster/)

    const roster = readFileSync('src/components/air/AircraftRoster.vue', 'utf8')
    expect(roster).toContain('flyOutOfBox')
    expect(roster).toContain('targetBaseHex')

    // 基地格窗口也自带标题容器（修前裸放名册）
    const unitPanel = readFileSync('src/components/game/UnitPanel.vue', 'utf8')
    expect(unitPanel).toContain('roster-window')
  })
})
