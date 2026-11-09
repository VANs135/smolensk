import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import {
  CORE_HEX,
  NEAR_HEX,
  airBaseRecord,
  aircraftRecord,
  combatRecord,
  placeAir,
  placeGround,
} from '../flows/sop-harness'

/**
 * 14.7d：移动阶段右键**敌方**算子 ⇒「低空扫射」
 *
 * 用户 2026-11-09 口径：
 *   · 只在 `actionAllowedNow` 放行时出现；缺前置（10.0b 观察员等）就**不出菜单项**，不灰按钮；
 *   · 点菜单项走既有入口（`setAirMissionKind` + `setAirTargetFromText`），选机仍在 `air` 会话里；
 *   · 菜单只负责"把目标带进去"。
 *
 * 夹具：轴方空中任务；基地 + 观察员（战斗单位）在 CORE_HEX，敌人在其邻格 NEAR_HEX。
 */

/** 有低空扫射能力的轴方机型（真实飞机库；能力位在 `airAbilities`） */
function hipShootPlane() {
  return aircraftRecord('axis', (record) => record.airAbilities?.canHipShoot === true)
}

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return useWorkbenchStore()
}

/** 进 C 段移动环节（环节 id 由 SOP 表给，不在这里猜） */
function enterMovement(workbench: ReturnType<typeof stores>): void {
  workbench.setPhase('movement')
  const index = workbench.playerSegmentSteps.findIndex(
    (step) => step.id === 'movement.modeAndMovement',
  )
  expect(index, '本阶段没有 movement.modeAndMovement 环节').toBeGreaterThanOrEqual(0)
  expect(workbench.setSegmentStepIndex(index)).toBe(true)
}

/** 基地 + 能低空扫射的飞机（当前方） */
function plantAir(workbench: ReturnType<typeof stores>): void {
  workbench.setAirActive(true)
  placeGround(workbench, airBaseRecord(), CORE_HEX, 'axis', 'base-1')
  placeAir(workbench, hipShootPlane(), CORE_HEX, 'axis', 'plane-1', 'active')
}

/** 右键该格该枚算子后，菜单里出现的键 */
function menuKeys(hex: typeof NEAR_HEX, instanceId: string): string[] {
  const mapView = useMapViewStore()
  mapView.onHexContext(hex, { x: 0, y: 0 }, { x: 0, y: 0 })
  const target = mapView.contextOptions.find((item) => item.id === instanceId)
  return (target?.actions ?? []).map((item) => item.key)
}

describe('14.7d 右键敌方算子：低空扫射', () => {
  let workbench: ReturnType<typeof stores>

  beforeEach(() => {
    workbench = stores()
    enterMovement(workbench)
    plantAir(workbench)
    // 10.0b：观察员＝与目标相邻的本方战斗单位（放在 CORE_HEX，NEAR_HEX 是其邻格）
    placeGround(workbench, combatRecord('axis'), CORE_HEX, 'axis', 'spotter-1')
    // 敌方目标（4.9a：敌格最上方战斗单位可见）
    placeGround(workbench, combatRecord('soviet'), NEAR_HEX, 'soviet', 'enemy-1')
  })

  it('★ 前置齐全：右键敌格出「低空扫射（14.7d）」', () => {
    expect(menuKeys(NEAR_HEX, 'enemy-1')).toContain('air.mission')
    const action = useMapViewStore()
      .contextOptions.find((item) => item.id === 'enemy-1')!
      .actions.find((item) => item.key === 'air.mission')!
    expect(action.label).toBe('低空扫射（14.7d）')
    expect(action.rule).toBe('14.7d')
    expect(action.disabledReason).toBeNull()
  })

  it('★ 点菜单项：只把目标带进既有空军会话（选机仍在那里）', () => {
    menuKeys(NEAR_HEX, 'enemy-1')
    expect(useMapViewStore().openContextAction('enemy-1', 'air.mission')).toBe(true)
    expect(workbench.airActive).toBe(true)
    expect(workbench.airMissionKind).toBe('hip_shoot')
    expect(workbench.airTargetHex).toEqual(NEAR_HEX)
    // 未勾选飞机（14.2f-A 仍在会话里做）
    expect(workbench.airMissionAirIds).toHaveLength(0)
  })

  it('★ 缺 10.0b 观察员：不出菜单项（不灰按钮）', () => {
    const index = workbench.units.findIndex((unit) => unit.instanceId === 'spotter-1')
    workbench.units.splice(index, 1)
    expect(menuKeys(NEAR_HEX, 'enemy-1')).not.toContain('air.mission')
  })

  it('★ 苏军不得低空扫射（专规 2.2a）：苏军回合右键德军无人出菜单', () => {
    workbench.setActiveSide('soviet')
    expect(menuKeys(NEAR_HEX, 'enemy-1')).not.toContain('air.mission')
  })

  it('★ 无具备低空扫射能力的飞机：不出菜单项', () => {
    const plane = workbench.airUnits.find((air) => air.instanceId === 'plane-1')!
    plane.canHipShoot = false
    expect(menuKeys(NEAR_HEX, 'enemy-1')).not.toContain('air.mission')
  })

  it('★ 右键己方单位不出现低空扫射（那是敌方目标菜单）', () => {
    expect(menuKeys(CORE_HEX, 'spotter-1')).not.toContain('air.mission')
  })
})
