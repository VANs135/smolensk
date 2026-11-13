import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'

/**
 * C 段（移动）核对：**堆叠与拆合**的入口与候选清单（20.0 / 20.0a–d / 20.0g）
 *
 * 用户口径（2026-11-14）：
 *   · 不可用项根本不出现（不摆点不动的入口）；
 *   · 同一件事只有一个入口；
 *   · 能点地图解决的不走下拉。
 *
 * 修前实测：右键**任何**本单位（运输点数 / 空军基地 / 1 军力的拆分单位本身）都会出
 * 「创建拆分单位」，点开后再被 20.0 的军力/类型判据拒——入口是假的；
 * 面板里的「拆分单位」下拉也不按 20.0b（AR ≤ 母单位）过滤，「吸收」下拉不按 20.0d（同格堆叠）过滤。
 */

const HEX: HexRef = { col: 36, row: 13 }
const NEAR: HexRef = { col: 37, row: 13 }

function stores(acting: 'axis' | 'soviet' = 'axis') {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setScenarioId('1')
  workbench.setActiveSide(acting)
  useHotseatStore().setViewerSide(acting)
  workbench.setPhase('movement')
  return { workbench, mapView: useMapViewStore() }
}

/** 多军力「其他」类型步兵师（20.0：只有 other 可拆；最后一点军力不能拆） */
function infantryDivRecord() {
  return groundRecord(
    'axis',
    (record) =>
      record.isCombat === true &&
      record.classes?.combatClass === 'other' &&
      (record.steps?.total ?? 1) >= 2 &&
      record.specialized?.includes('breakdown') !== true,
  )
}

function menuKeysOf(
  mapView: ReturnType<typeof useMapViewStore>,
  hex: HexRef,
  unit: ConsoleUnit,
): string[] {
  expect(
    mapView.openUnitContext(hex, unit.instanceId, { x: 0, y: 0 }, { fromStackWindow: true }),
  ).toBe(true)
  const target = mapView.contextOptions.find((item) => item.id === unit.instanceId)
  expect(target, '必须出现这一枚自己的菜单').toBeDefined()
  return (target?.actions ?? []).map((action) => action.key)
}

beforeEach(() => setActivePinia(createPinia()))

describe('20.0a：创建拆分单位的入口只在真能做时出现', () => {
  it('多军力步兵师 ⇒ 右键出「创建拆分单位」', () => {
    const { workbench, mapView } = stores()
    const parent = placeGround(workbench, infantryDivRecord(), HEX, 'axis', 'p1')
    expect(workbench.canCreateBreakdownNow(parent.instanceId)).toBe(true)
    expect(menuKeysOf(mapView, HEX, parent)).toContain('move.breakdown')
  })

  it('运输点数 / 空军基地 / 拆分单位本身 ⇒ 不出「创建拆分单位」', () => {
    const { workbench, mapView } = stores()
    const transport = placeGround(
      workbench,
      groundRecord('axis', (record) => record.noncombatKind === 'transport_point'),
      HEX,
      'axis',
      'tp1',
    )
    const base = placeGround(
      workbench,
      groundRecord('axis', (record) => record.noncombatKind === 'air_base'),
      NEAR,
      'axis',
      'base1',
    )
    const kid = placeGround(
      workbench,
      groundRecord('axis', (record) => record.specialized?.includes('breakdown') === true),
      { col: 38, row: 13 },
      'axis',
      'kid1',
    )

    for (const [hex, unit] of [
      [HEX, transport],
      [NEAR, base],
      [{ col: 38, row: 13 }, kid],
    ] as const) {
      expect(workbench.canCreateBreakdownNow(unit.instanceId), unit.name).toBe(false)
      expect(menuKeysOf(mapView, hex, unit), unit.name).not.toContain('move.breakdown')
    }
  })
})

describe('20.0b / 20.0g：面板候选按母单位 AR 与可用池过滤', () => {
  it('拆分单位候选只列 AR ≤ 母单位 AR 的记录（AR5 不进 AR4 的清单）', () => {
    const { workbench } = stores()
    const parent = placeGround(workbench, infantryDivRecord(), HEX, 'axis', 'p1')
    const parentAr = parent.faces.combat.ar
    const records = workbench.breakdownRecordChoicesFor(parent.instanceId)
    expect(records.length).toBeGreaterThan(0)
    for (const record of records) {
      expect(record.branch).toBe('breakdown')
      expect(record.factors?.combat?.ar ?? 0).toBeLessThanOrEqual(parentAr)
    }
  })
})

describe('20.0b / 20.0d：吸收候选须同格堆叠、同方、AR ≥ 母单位', () => {
  it('只列与母单位同格的拆分单位（异格 / 敌方不出现）', () => {
    const { workbench } = stores()
    const parent = placeGround(workbench, infantryDivRecord(), HEX, 'axis', 'p1')
    const stacked = placeGround(
      workbench,
      groundRecord('axis', (record) => record.specialized?.includes('breakdown') === true),
      HEX,
      'axis',
      'kid-stacked',
    )
    placeGround(
      workbench,
      groundRecord('axis', (record) => record.specialized?.includes('breakdown') === true),
      NEAR,
      'axis',
      'kid-away',
    )
    placeGround(
      workbench,
      groundRecord('soviet', (record) => record.specialized?.includes('breakdown') === true),
      HEX,
      'soviet',
      'kid-enemy',
    )

    const candidates = workbench.breakdownAbsorbChoicesFor(parent.instanceId)
    expect(candidates.map((unit) => unit.instanceId)).toEqual([stacked.instanceId])
  })
})
