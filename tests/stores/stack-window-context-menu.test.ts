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

import { groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 堆叠/算子排列窗内右键（用户 2026-11-11 实机）
 *
 * 口径：
 *   · 窗内对**某一枚**右键 ⇒ 一定是**它自己**的菜单（不是共用菜单、不是空白、不是原生菜单）；
 *   · 菜单条目仍按该单位能力与本环节闸门筛；非行动方视角只读（不摆可执行项、不越权）；
 *   · 打开菜单不再要求「观察方＝行动方」——4ab30d6 删除自动切屏后两者经常不同。
 */

const HEX: HexRef = { col: 36, row: 13 }

function stores(acting: 'axis' | 'soviet' = 'soviet') {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide(acting)
  useHotseatStore().setViewerSide(acting)
  return { workbench, mapView: useMapViewStore(), hotseat: useHotseatStore() }
}

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

function infantryRecord() {
  return groundRecord(
    'soviet',
    (record) => record.isCombat === true && record.classes?.movementClass === 'leg',
  )
}

describe('堆叠窗内右键：某一枚 ⇒ 它自己的菜单', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores('soviet')
    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'move.modeChange')
  })

  it('★ 观察方≠行动方时仍出**该单位**菜单（只读、无越权条目）', () => {
    const unit = placeGround(s.workbench, infantryRecord(), HEX, 'soviet', 'c1', 'combat')
    // 4ab30d6：观察方由玩家手选，可与行动方不同（看对方视角）
    s.hotseat.setViewerSide('axis')

    expect(
      s.mapView.openUnitContext(HEX, unit.instanceId, { x: 0, y: 0 }, { fromStackWindow: true }),
    ).toBe(true)
    expect(s.mapView.popup?.variant).toBe('context')

    const target = s.mapView.contextOptions.find((item) => item.id === unit.instanceId)
    expect(target, '必须出现这一枚自己的菜单').toBeDefined()
    expect(target!.label).toBe(unit.name)
    // 非行动方 ⇒ 不摆可执行项（既不是共用菜单，也不允许越权）
    expect(target!.actions).toEqual([])
  })

  it('★ 同格多枚：右键哪一枚只出哪一枚，不混入别人', () => {
    const first = placeGround(s.workbench, infantryRecord(), HEX, 'soviet', 'c1', 'combat')
    const second = placeGround(s.workbench, infantryRecord(), HEX, 'soviet', 'c2', 'combat')

    expect(
      s.mapView.openUnitContext(HEX, second.instanceId, { x: 0, y: 0 }, { fromStackWindow: true }),
    ).toBe(true)
    expect(s.mapView.contextOptions.map((item) => item.id)).toEqual([second.instanceId])
    expect(s.mapView.contextOptions[0]!.actions.length).toBeGreaterThan(0)
    expect(s.mapView.contextOptions[0]!.label).toBe(second.name)
    // 另一枚不在这份菜单里
    expect(s.mapView.contextOptions.some((item) => item.id === first.instanceId)).toBe(false)
  })

  it('源码守卫：窗内 chip 的右键绑定到该枚自己的 id', () => {
    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    expect(popover).toContain('@contextmenu.prevent.stop="onChipContext($event, unit.id)"')
    expect(popover).toContain('@contextmenu.prevent.stop="onChipContext($event, air.instanceId)"')
    // Prettier 可能把调用折成多行 ⇒ 用容错空白匹配
    expect(popover).toMatch(/mapView\.openUnitContext\(\s*hex,\s*unitId/)
  })

  it('源码守卫：窗内分支只过硬闸、不因动作列表为空拒开', () => {
    const store = readFileSync('src/stores/map-view.ts', 'utf8')
    const body = store.slice(
      store.indexOf('function openUnitContext('),
      store.indexOf('function contextSelectionAt('),
    )
    expect(body).toContain('options.fromStackWindow === true')
    expect(body).toContain('canOpenCounterMenu()')
    // 地图右键（else 分支）仍保留"无动作不出现"
    expect(body).toContain('if (counterActionsAt(hex, instanceId).length === 0) return false')
  })
})
