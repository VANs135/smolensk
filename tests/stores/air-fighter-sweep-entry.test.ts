import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { hexCanvasPoint } from '@/render/map-layout'
import {
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ConsoleAirUnit,
} from '@/stores'

import {
  CORE_HEX,
  NEAR_HEX,
  airBaseRecord,
  aircraftRecord,
  combatRecord,
  fighterRecord,
  placeAir,
  placeGround,
} from '../flows/sop-harness'

/**
 * 14.6 **战机扫荡**：目标侧入口（用户 2026-11-18）
 *
 * 原文归属：14.2e 的移动环节；14.6 只对「有敌方**激活**飞机的敌方空军基地格」执行；
 * 14.1 只有战斗机能在空战中作为攻击者 ⇒ 参战机只列战斗机。
 *
 * 口径：右键敌方空军基地所在格 ⇒「空军任务」组里出现「战机扫荡」；
 * 该环节做不了 / 该格没有激活敌机 ⇒ 整项不出现（不摆灰项）。
 */

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('axis')
  useHotseatStore().setViewerSide('axis')
  workbench.setPhase('movement')
  const index = workbench.playerSegmentSteps.findIndex(
    (step) => step.id === 'movement.modeAndMovement',
  )
  expect(index, '移动阶段没有 movement.modeAndMovement 环节').toBeGreaterThanOrEqual(0)
  expect(workbench.setSegmentStepIndex(index)).toBe(true)
  return { workbench, mapView: useMapViewStore() }
}

/** 本方基地 + 本方战斗机（扫荡的参战机来源）；可另加轰炸机 / 运输机 */
function plantOwnAir(
  workbench: ReturnType<typeof stores>['workbench'],
  extras: readonly ConsoleAirUnit[] = [],
): ConsoleAirUnit {
  placeGround(workbench, airBaseRecord(), CORE_HEX, 'axis', 'own-base')
  const fighter = placeAir(workbench, fighterRecord('axis'), CORE_HEX, 'axis', 'own-fighter')
  for (const air of extras) workbench.airUnits.push(air)
  return fighter
}

/** 敌方空军基地格 + 一架敌方飞机（状态由调用方定） */
function plantEnemyBase(
  workbench: ReturnType<typeof stores>['workbench'],
  airStatus: 'active' | 'inactive',
): void {
  placeGround(workbench, airBaseRecord(), NEAR_HEX, 'soviet', 'enemy-base')
  placeAir(workbench, fighterRecord('soviet'), NEAR_HEX, 'soviet', 'enemy-fighter', airStatus)
}

/** 右键该格（点在格心，命中基地算子）后菜单里的全部动作键 */
function contextKeys(hex: typeof NEAR_HEX): string[] {
  const mapView = useMapViewStore()
  mapView.onHexContext(hex, hexCanvasPoint(hex), { x: 100, y: 100 }, 1)
  return mapView.contextOptions.flatMap((option) => option.actions.map((action) => action.key))
}

/** 在本方基地再摆一架指定机型（真实飞机库） */
function plantPlane(
  workbench: ReturnType<typeof stores>['workbench'],
  instanceId: string,
  predicate: Parameters<typeof aircraftRecord>[1],
): ConsoleAirUnit {
  return placeAir(workbench, aircraftRecord('axis', predicate), CORE_HEX, 'axis', instanceId)
}

describe('14.6 战机扫荡：目标侧入口与参战机', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
  })

  it('★ 移动环节右键敌方空军基地格（有激活敌机）⇒「空军任务」组出现战机扫荡', () => {
    plantOwnAir(s.workbench)
    plantEnemyBase(s.workbench, 'active')

    expect(contextKeys(NEAR_HEX)).toContain('air.target:fighter_sweep')
  })

  it('★ 点该任务项 ⇒ 进入 air 会话且任务类型已是战机扫荡', () => {
    plantOwnAir(s.workbench)
    plantEnemyBase(s.workbench, 'active')

    const mapView = useMapViewStore()
    mapView.onHexContext(NEAR_HEX, hexCanvasPoint(NEAR_HEX), { x: 100, y: 100 }, 1)
    const option = mapView.contextOptions.find((item) =>
      item.actions.some((action) => action.key === 'air.target:fighter_sweep'),
    )
    expect(option).toBeDefined()
    expect(mapView.openContextAction(option!.id, 'air.target:fighter_sweep')).toBe(true)

    expect(mapView.session?.kind).toBe('air')
    expect(s.workbench.airMissionKind).toBe('fighter_sweep')
    expect(s.workbench.airTargetHex).toEqual(NEAR_HEX)
  })

  it('★ 敌机不是激活态 ⇒ 该项不出现', () => {
    plantOwnAir(s.workbench)
    plantEnemyBase(s.workbench, 'inactive')

    expect(contextKeys(NEAR_HEX)).not.toContain('air.target:fighter_sweep')
  })

  it('★ 非移动环节（战斗阶段的炮击环节）⇒ 该项不出现', () => {
    plantOwnAir(s.workbench)
    plantEnemyBase(s.workbench, 'active')
    s.workbench.setPhase('combat')
    const index = s.workbench.playerSegmentSteps.findIndex((step) => step.id === 'combat.barrage')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(s.workbench.setSegmentStepIndex(index)).toBe(true)

    expect(contextKeys(NEAR_HEX)).not.toContain('air.target:fighter_sweep')
  })

  it('★ 敌基地格上还有敌方战斗单位（右键命中算子出射击菜单）⇒ 扫荡仍须在菜单里', () => {
    // 本方：基地 + 战斗机 + 低空扫射机 + 与目标相邻的观察员
    plantOwnAir(s.workbench)
    plantPlane(s.workbench, 'own-hip', (record) => record.airAbilities?.canHipShoot === true)
    placeGround(s.workbench, combatRecord('axis'), CORE_HEX, 'axis', 'spotter')
    // 敌方：基地 + 激活战斗机 + 战斗单位
    plantEnemyBase(s.workbench, 'active')
    placeGround(s.workbench, combatRecord('soviet'), NEAR_HEX, 'soviet', 'enemy-combat')

    const keys = contextKeys(NEAR_HEX)
    // 右键命中算子时先出的是射击菜单（低空扫射确实可打）；目标格空军任务不能因此被吞掉
    expect(keys).toContain('ops.hipShoot')
    expect(keys).toContain('air.target:fighter_sweep')
  })

  it('★ 参战机候选只列战斗机（轰炸机 / 运输机不出现）', () => {
    plantOwnAir(s.workbench)
    plantPlane(s.workbench, 'own-bomber', (record) => record.aircraftType === 'T')
    plantPlane(s.workbench, 'own-transport', (record) => (record.transportCapacity ?? 0) > 0)
    plantEnemyBase(s.workbench, 'active')

    const mapView = useMapViewStore()
    mapView.onHexContext(NEAR_HEX, hexCanvasPoint(NEAR_HEX), { x: 100, y: 100 }, 1)
    const option = mapView.contextOptions.find((item) =>
      item.actions.some((action) => action.key === 'air.target:fighter_sweep'),
    )
    expect(mapView.openContextAction(option!.id, 'air.target:fighter_sweep')).toBe(true)

    const listed = s.workbench.airMissionBaseGroupsWithBox.flatMap((group) =>
      group.aircraft.map((item) => item.air.instanceId),
    )
    expect(listed).toEqual(['own-fighter'])
  })
})
