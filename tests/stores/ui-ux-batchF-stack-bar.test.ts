import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  actionGateOf,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

import { airBaseRecord, groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 批 F（用户 2026-11-16）：**堆叠栏只装可操作单位**
 *
 * 口径：
 *   · 点格子时堆叠栏只列该格**战斗单位**；编内卡车（13.2g，运输点数）也要放进来；
 *     机场 / SP / 工事 / 普通运输点 / 补员算子不进这一栏（它们走地图角位或右键菜单）；
 *   · 在堆叠栏里就能点选单位（与地图选中集同一份 `stackSelection`）；
 *   · 右键某枚＝它自己的菜单；右键落在**多选集合**里＝这些单位**共用**的菜单，
 *     按现有可用项取**交集**，不可用项不出现。
 */

const HEX: HexRef = { col: 15, row: 10 }

function stores(side: 'axis' | 'soviet' = 'soviet') {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide(side)
  const mapView = useMapViewStore()
  useHotseatStore().setViewerSide(side)
  return { workbench, mapView }
}

/** B8：把操作台切到本段里允许该动作的环节（与 engine 的闸门表同一处判据） */
function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  expect(store.setSegmentStepIndex(index)).toBe(true)
}

function infantryRecord(side: 'axis' | 'soviet' = 'soviet') {
  return groundRecord(
    side,
    (record) => record.isCombat === true && !record.capabilities?.includes('barrage'),
  )
}

function artilleryRecord(side: 'axis' | 'soviet' = 'soviet') {
  return groundRecord(side, (record) => record.capabilities?.includes('barrage') === true)
}

function truckRecord(side: 'axis' | 'soviet' = 'axis') {
  return groundRecord(side, (record) => record.noncombatKind === 'organic_truck')
}

function addDump(workbench: Workbench): void {
  workbench.spDumps.push({ id: 'd1', hex: { ...HEX }, side: 'axis', sp: 4, t: 0 })
}

describe('批 F：堆叠栏只装战斗单位 + 编内卡车', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    // 编内卡车只在轴方单位库里出现（13.2g）⇒ 这一组按轴方视点摆
    s = stores('axis')
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'move.modeChange')
    placeGround(s.workbench, infantryRecord('axis'), HEX, 'axis', 'inf-a')
    placeGround(s.workbench, truckRecord('axis'), HEX, 'axis', 'truck')
    placeGround(s.workbench, airBaseRecord(1), HEX, 'axis', 'base-1')
    addDump(s.workbench)
  })

  it('★ 只列战斗单位与编内卡车；机场 / SP 不进堆叠栏', () => {
    s.mapView.openPopup(HEX, 0, 0)
    const ids = (s.mapView.popupContent?.units ?? []).map((unit) => unit.id)
    expect(ids).toContain('inf-a')
    expect(ids).toContain('truck')
    expect(ids).not.toContain('base-1')
    expect(ids.some((id) => id.startsWith('sp'))).toBe(false)
    // 可点选的只有本方那两枚；敌方令牌照列但不在 selectableIds
    expect([...(s.mapView.popupContent?.selectableIds ?? [])].sort()).toEqual(['inf-a', 'truck'])
  })

  it('★ 在堆叠栏里点选单位：写入同一份 stackSelection，再点取消', () => {
    s.mapView.openPopup(HEX, 0, 0)
    expect(s.mapView.selectStackChip('inf-a')).toBe(true)
    expect([...s.mapView.stackSelection]).toEqual(['inf-a'])
    expect(s.mapView.selectStackChip('truck')).toBe(true)
    expect([...s.mapView.stackSelection].sort()).toEqual(['inf-a', 'truck'])
    expect(s.mapView.selectStackChip('inf-a')).toBe(true)
    expect([...s.mapView.stackSelection]).toEqual(['truck'])
  })

  it('★ 敌方 / 设施不可从堆叠栏点选（selectableIds 之外一律拒）', () => {
    s.mapView.openPopup(HEX, 0, 0)
    expect(s.mapView.selectStackChip('base-1')).toBe(false)
    expect(s.mapView.selectStackChip('not-there')).toBe(false)
  })
})

describe('批 F：多选右键＝交集共用菜单', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'move.modeChange')
    placeGround(s.workbench, infantryRecord(), HEX, 'soviet', 'inf-a')
    placeGround(s.workbench, artilleryRecord(), HEX, 'soviet', 'arty')
  })

  it('★ 两枚共用的项保留，只有炮兵才有的项不出现', () => {
    s.mapView.openPopup(HEX, 0, 0)
    s.mapView.selectStackChip('inf-a')
    s.mapView.selectStackChip('arty')
    // 右键落在多选集合里 ⇒ 共用菜单（不是某一枚自己的）
    expect(s.mapView.openStackChipContext(HEX, 'arty', { x: 0, y: 0 })).toBe(true)
    const options = s.mapView.contextOptions
    expect(options.map((item) => item.id)).toEqual(['__shared__'])
    const keys = (options[0]?.actions ?? []).map((action) => action.key)
    // 步兵没有炮击能力 ⇒ 炮击类项必须在交集里被剔除
    expect(keys.some((key) => key.startsWith('barrage'))).toBe(false)
    // 两枚都能改模式 ⇒ 至少保留一项共用的
    expect((options[0]?.actions ?? []).some((action) => action.group === '模式改变')).toBe(true)
  })

  it('★ 右键集合外的那一枚 ⇒ 仍出它自己的菜单（不误用共用）', () => {
    s.mapView.openPopup(HEX, 0, 0)
    s.mapView.selectStackChip('inf-a')
    expect(s.mapView.openStackChipContext(HEX, 'arty', { x: 0, y: 0 })).toBe(true)
    expect(s.mapView.contextOptions.map((item) => item.id)).toEqual(['arty'])
  })

  it('★ 源码守卫：栏内点选 / 右键共用入口与过滤口径都在', () => {
    const view = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(view).toContain("token.noncombatKind === 'organic_truck'")
    expect(view).toContain('(token.replKind ?? null) === null')
    expect(view).toContain('selectableIds')
    expect(view).toContain('function selectStackChip')
    expect(view).toContain('function openStackChipContext')
    // 交集：每一位成员都能用才保留
    expect(view).toContain('rest.every((list) => list.some((item) => item.key === action.key))')
    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    expect(popover).toContain('selectableIds')
    expect(popover).toContain('mapView.selectStackChip(id)')
    expect(popover).toContain('mapView.openStackChipContext(hex, unitId')
  })
})
