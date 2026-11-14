import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { SOP_STEPS } from '@/engine/session-flow'
import { HEX_RADIUS_PX, hexCanvasPoint } from '@/render/map-layout'
import {
  useGameSessionStore,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

import {
  CORE_HEX,
  NEAR_HEX,
  airBaseRecord,
  combatRecord,
  fighterRecord,
  label,
  placeAir,
  placeGround,
} from '../flows/sop-harness'

/**
 * Ⓐ 飞机整备（15.1）阶段的**界面投影**核对
 *
 * 引擎与 `refitBaseNow` 的规则判定已有 `tests/flows/10-phase-a-aircraft-refit.test.ts` 钉住；
 * 本文件只管"入口给不给、能不能走到头"：
 *   · 15.1C 未抵消敌 ZOC 内的基地 / 14.2a 激活堆叠已满的基地 ⇒ **不出整备入口**（不摆灰项）；
 *   · 15.1B 容量（等级×2、简易机场 1）⇒ 勾机时就拦住，不能等到付款才被引擎拒；
 *   · 地图小窗的「整备」按钮只在 `refitStartBases` 之内出现。
 */

function refitStage() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('axis')
  useHotseatStore().setViewerSide('axis')
  workbench.setAirActive(true)
  const base = placeGround(workbench, airBaseRecord(1), CORE_HEX, 'axis', 'base-1')
  const planes = [0, 1, 2].map((index) =>
    placeAir(workbench, fighterRecord('axis'), CORE_HEX, 'axis', `air-${index}`, 'inactive'),
  )
  workbench.setSupplyActive(true)
  workbench.spDumpDraft = { hexText: label(CORE_HEX), sp: 2, t: 0 }
  workbench.addSpDump()
  workbench.setPhase('aircraftRefit')
  return { workbench, mapView: useMapViewStore(), base, planes }
}

describe('Ⓐ 15.1C：未抵消敌 ZOC 内的基地不摆整备入口', () => {
  it('基地高亮 / 右键整备项 / 开整备按钮 一起消失', () => {
    const s = refitStage()
    placeGround(s.workbench, combatRecord('soviet'), NEAR_HEX, 'soviet', 'enemy-1')

    expect(s.workbench.airBases[0]?.inUnnegatedEnemyZoc).toBe(true)
    expect(s.workbench.refitStartBases).toHaveLength(0)
    expect(s.workbench.refitAirbaseHexes).toHaveLength(0)
    // 右键菜单的设施动作项：不出现「整备飞机」
    expect(s.mapView.unitActionOptions('base-1')).toEqual([])
    // 直接调入口也当场拒（不能等玩家勾完机、付完款才说不行）
    expect(s.workbench.beginRefitNow('base-1')).toBe(false)
    expect(s.workbench.refitBase).toBeNull()
  })
})

describe('Ⓐ 14.2a：激活堆叠已满的基地不摆整备入口', () => {
  it('满堆叠 ⇒ 无可整备名额，整备入口不出现', () => {
    const s = refitStage()
    // 1 级基地激活上限 5（4 + 等级）：先塞满
    for (let index = 0; index < 5; index += 1)
      placeAir(s.workbench, fighterRecord('axis'), CORE_HEX, 'axis', `filler-${index}`, 'active')

    expect(s.workbench.refitStartBases).toHaveLength(0)
    expect(s.workbench.refitAirbaseHexes).toHaveLength(0)
    expect(s.mapView.unitActionOptions('base-1')).toEqual([])
    expect(s.workbench.beginRefitNow('base-1')).toBe(false)
    expect(s.workbench.refitBase).toBeNull()
  })
})

describe('Ⓐ 15.1B：勾机阶段就按容量收口（等级×2 / 简易机场 1）', () => {
  it('1 级基地最多勾 2 架；第 3 架勾不上并留痕', () => {
    const s = refitStage()
    expect(s.workbench.beginRefitNow('base-1')).toBe(true)
    expect(s.workbench.refitSelectLimit).toBe(2)

    s.workbench.toggleRefitAircraft('air-0')
    s.workbench.toggleRefitAircraft('air-1')
    s.workbench.toggleRefitAircraft('air-2')

    expect(s.workbench.refitSelectedIds).toEqual(['air-0', 'air-1'])
    expect(s.workbench.log.some((entry) => entry.rule === '15.1B')).toBe(true)
    // 不超出容量 ⇒ 可以正常进入付款步
    expect(s.workbench.confirmRefitSelectionNow()).toBe(true)
    expect(s.workbench.refitStage).toBe('pay')
  })
})

describe('Ⓐ 入口回归：可整备的基地仍给入口', () => {
  it('基地有非激活机 + 可达补给 ⇒ 右键有「整备飞机」，可开整备', () => {
    const s = refitStage()
    expect(s.workbench.refitStartBases.map((base) => base.id)).toEqual(['base-1'])
    expect(s.mapView.unitActionOptions('base-1').map((item) => item.key)).toContain('air.refit')
    expect(s.workbench.beginRefitNow('base-1')).toBe(true)
  })

  it('地图上方提示说的是整备，不教玩家点算子看移动范围', () => {
    const s = refitStage()
    expect(s.mapView.actionHint).toContain('整备')
    expect(s.mapView.actionHint).not.toContain('可移动范围')
  })

  it('简易机场（15.2B）勾机上限为 1', () => {
    const s = refitStage()
    s.workbench.toggleAirstripBase('base-1')
    expect(s.workbench.beginRefitNow('base-1')).toBe(true)
    expect(s.workbench.refitSelectLimit).toBe(1)
    s.workbench.toggleRefitAircraft('air-0')
    s.workbench.toggleRefitAircraft('air-1')
    expect(s.workbench.refitSelectedIds).toEqual(['air-0'])
  })

  it('地图小窗的「整备」按钮只在可整备基地上出现（源码守卫）', () => {
    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    expect(popover).toContain('refitAllowedHere')
    // 段标题仍按 A 段闸门展示；按钮本身必须再收一层"这一格真能整备"
    expect(popover).toMatch(/refitHere\s*\|\|\s*refitDoneHere\s*\|\|\s*refitAllowedHere/)
  })
})

describe('Ⓐ 15.1：同格有飞机时，空军基地必须能从堆叠里选到', () => {
  it('★ 点压在基地上的飞机令牌 ⇒ 不得吞掉这一击，要开出该格小窗（里面有基地的整备入口）', () => {
    setActivePinia(createPinia())
    useSetupStore().finished = true
    const workbench = useWorkbenchStore()
    workbench.setActiveSide('axis')
    useHotseatStore().setViewerSide('axis')
    workbench.setAirActive(true)
    placeGround(workbench, airBaseRecord(1), CORE_HEX, 'axis', 'base-1')
    placeAir(workbench, fighterRecord('axis'), CORE_HEX, 'axis', 'air-0', 'inactive')
    workbench.setSupplyActive(true)
    workbench.spDumpDraft = { hexText: label(CORE_HEX), sp: 2, t: 0 }
    workbench.addSpDump()
    workbench.setPhase('aircraftRefit')
    const mapView = useMapViewStore()
    expect(workbench.refitStartBases.map((base) => base.id)).toEqual(['base-1'])

    // 两枚令牌常态摊开：0 号槽（左）是飞机，1 号槽（右）是基地
    const center = hexCanvasPoint(CORE_HEX)
    const planePoint = { x: center.x - 0.28 * HEX_RADIUS_PX, y: center.y }
    mapView.onHexClick(CORE_HEX, { x: center.x, y: center.y }, planePoint)

    // 修前：命中飞机 ⇒ 「不参与本环节」把这一击吞掉，小窗不开，基地的整备入口出不来
    expect(mapView.popup?.hex).toEqual(CORE_HEX)
    expect(mapView.popupContent?.units.some((unit) => unit.id === 'base-1')).toBe(true)
  })
})

describe('Ⓐ 状态记录与日志：一笔整备在三处一致（15.1 / ⒁ 接线）', () => {
  it('lastRefit / 本阶段已整备名单 / 结算日志同源', () => {
    setActivePinia(createPinia())
    useSetupStore().finished = true
    const workbench = useWorkbenchStore()
    const gameSession = useGameSessionStore()
    expect(gameSession.startGame()).toBe(true)
    for (
      let guard = 0;
      guard < SOP_STEPS.length && gameSession.records?.phase !== 'aircraftRefit';
      guard += 1
    )
      gameSession.advanceToNextStop()
    expect(gameSession.records?.phase).toBe('aircraftRefit')

    workbench.setActiveSide('axis')
    workbench.setAirActive(true)
    placeGround(workbench, airBaseRecord(1), CORE_HEX, 'axis', 'base-1')
    placeAir(workbench, fighterRecord('axis'), CORE_HEX, 'axis', 'air-1', 'inactive')
    workbench.setSupplyActive(true)
    workbench.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    workbench.addSpDump()

    expect(workbench.beginRefitNow('base-1')).toBe(true)
    workbench.toggleRefitAircraft('air-1')
    expect(workbench.confirmRefitSelectionNow()).toBe(true)
    expect(workbench.pickRefitPayDump(workbench.refitPayDumps[0]!.id)).toBe(true)
    expect(workbench.confirmRefitPaymentNow()).toBe(true)

    expect(workbench.lastRefit).toMatchObject({ costT: 1, activateAircraftIds: ['air-1'] })
    expect(workbench.refitDoneBases.map((base) => base.id)).toEqual(['base-1'])
    const entry = gameSession.log.find((item) => item.action === 'airRefit')
    expect(entry).toBeDefined()
    const outcome = entry?.outcome
    if (outcome === undefined || !outcome.ok) throw new Error('airRefit 应成功入账')
    expect(outcome.rule).toBe('15.1')
    expect(outcome.data['costT']).toBe(1)
    expect(outcome.data['activateAircraftIds']).toEqual(['air-1'])
  })
})
