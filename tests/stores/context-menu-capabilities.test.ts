import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ConsolePhase,
} from '@/stores'

/**
 * ④ 右键菜单按能力分类（用户 2026-11-09）
 *
 * 口径：「次要功能收进右键菜单，按能力分类（移动 / 战斗 / 运输 / 工程 / 空军 / 补给），
 * 菜单项一律来自既有入口与既有判据，不新增规则判断」。
 *
 * 本组用例只钉**菜单里有没有这一项**（以及轮不到时**没有**）：
 *   · 改模式 / 突围 → 既有 `switchUnitMode` / `breakoutNow`
 *   · 炮击 → 既有 `beginBarrageNow` + `toggleBarrageUnit`（判据 `isBarrageCapableUnit`）
 *   · 建造标记（桥 / 简易机场）→ 既有 `armConstructionMarkerNow`（专规 3.5）
 */

const HEX: HexRef = { col: 36, row: 13 }

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

function recordOf(barrage: boolean) {
  const found = unitChoices('axis').find((record) => {
    const value = record.factors?.combat?.barrage ?? 0
    return record.isCombat === true && (barrage ? value > 0 : value === 0)
  })
  if (found === undefined) throw new Error(`单位库中没有${barrage ? '带' : '不带'}轰炸值的战斗单位`)
  return found
}

function place(
  workbench: ReturnType<typeof stores>['workbench'],
  record: ReturnType<typeof unitChoices>[number],
  instanceId: string,
  side: 'axis' | 'soviet' = 'axis',
) {
  const unit = toConsoleUnit({ record, instanceId, hex: HEX, side })
  workbench.units.push(unit)
  return unit
}

/** 把操作台切到某阶段的某环节（环节 id 由 SOP 表给，不在这里猜） */
function enter(
  workbench: ReturnType<typeof stores>['workbench'],
  phase: ConsolePhase,
  stepId: string,
): void {
  workbench.setPhase(phase)
  const index = workbench.playerSegmentSteps.findIndex((step) => step.id === stepId)
  expect(index, `本阶段没有 ${stepId} 环节`).toBeGreaterThanOrEqual(0)
  expect(workbench.setSegmentStepIndex(index)).toBe(true)
}

/** 右键该格该枚算子后，菜单里出现的键 */
function menuKeys(s: ReturnType<typeof stores>, instanceId: string): string[] {
  s.workbench.selectedId = instanceId
  s.mapView.onHexContext(HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
  const target = s.mapView.contextOptions.find((item) => item.id === instanceId)
  return (target?.actions ?? []).map((item) => item.key)
}

describe('④ 右键菜单：按能力分类的既有入口', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
  })

  it('★ C 段移动环节：战斗单位有「改模式」四项与「建造标记」两项；没有炮击（不在本环节）', () => {
    const { workbench } = s
    place(workbench, recordOf(false), 'inf-1')
    workbench.setConstructionMarkersNow(2)
    enter(workbench, 'movement', 'movement.modeAndMovement')
    const keys = menuKeys(s, 'inf-1')
    expect(keys).toContain('move.mode.combat')
    expect(keys).toContain('move.mode.move')
    expect(keys).toContain('move.mode.reserve')
    expect(keys).toContain('move.mode.strat')
    expect(keys).toContain('move.marker.bridge')
    expect(keys).toContain('move.marker.airStrip')
    expect(keys).not.toContain('barrage.declare')
  })

  it('★ 轰炸环节：带印刷轰炸值的火炮有「炮击」，步枪没有（既有 isBarrageCapableUnit 判据）', () => {
    const { workbench } = s
    enter(workbench, 'combat', 'combat.barrage')
    place(workbench, recordOf(true), 'gun-1')
    place(workbench, recordOf(false), 'rifle-1')
    expect(menuKeys(s, 'gun-1')).toContain('barrage.declare')
    expect(menuKeys(s, 'rifle-1')).not.toContain('barrage.declare')
  })

  it('★ 按方过滤：苏军回合右键轴心国算子不出现菜单（不渲染对方内容）', () => {
    const { workbench } = s
    place(workbench, recordOf(false), 'inf-1', 'axis')
    enter(workbench, 'movement', 'movement.modeAndMovement')
    workbench.setActiveSide('soviet')
    workbench.selectedId = 'inf-1'
    s.mapView.onHexContext(HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
    expect(s.mapView.contextOptions).toEqual([])
  })

  it('★ 点菜单项即执行：落点是既有入口（改模式 / 炮击 / 建造标记）', () => {
    const { workbench, mapView } = s
    const infantry = place(workbench, recordOf(false), 'inf-1')
    enter(workbench, 'movement', 'movement.modeAndMovement')
    menuKeys(s, 'inf-1')
    expect(mapView.openContextAction('inf-1', 'move.mode.move')).toBe(true)
    expect(infantry.mode.orientation).toBe('move')

    const gun = place(workbench, recordOf(true), 'gun-1')
    enter(workbench, 'combat', 'combat.barrage')
    menuKeys(s, 'gun-1')
    expect(mapView.openContextAction('gun-1', 'barrage.declare')).toBe(true)
    expect(workbench.barrageUnitIds).toContain(gun.instanceId)

    enter(workbench, 'movement', 'movement.modeAndMovement')
    workbench.setConstructionMarkersNow(1)
    menuKeys(s, 'inf-1')
    expect(mapView.openContextAction('inf-1', 'move.marker.bridge')).toBe(true)
    expect(workbench.constructionMarkerKind).toBe('bridge')
    expect(workbench.constructionMarkerPicked).toBe(true)
  })
})
