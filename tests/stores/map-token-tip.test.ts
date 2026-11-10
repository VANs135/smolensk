import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import {
  CORE_HEX,
  NEAR_HEX,
  aircraftRecord,
  groundRecord,
  placeAir,
  placeGround,
} from '../flows/sop-harness'

/**
 * 悬停浮现（2026-11-10 队列 #4）
 *
 * 地图令牌的 `tip` 必须带**全称 + 关键信息**，`MapCanvas` 的既有 `hoverTip` 直接读它：
 *   · 地面：全称｜A / AR / MA｜阵营 · 模式｜DG｜断补｜移动已结束
 *   · 飞机：全称｜机型｜航程｜Active / Inactive
 */
function newStores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

describe('悬停浮现：全称与关键信息', () => {
  it('★ 地面算子：全称 + 印值 + 阵营/模式（3.4b 之外的普牌也有提示）', () => {
    const { workbench, mapView } = newStores()
    const unit = placeGround(
      workbench,
      groundRecord('axis', (record) => record.isCombat === true),
      CORE_HEX,
      'axis',
      'u-1',
    )
    const token = mapView.overlay.tokens.find((item) => item.id === unit.instanceId)
    expect(token?.tip).toBeDefined()
    expect(token!.tip!).toContain(unit.name)
    expect(token!.tip!).toMatch(/A \d+ \/ AR \d+ \/ MA \d+/)
    expect(token!.tip!).toContain('轴心')
  })

  it('★ 状态入提示：DG 与断补出现在同一条 `tip` 里', () => {
    const { workbench, mapView } = newStores()
    const unit = placeGround(
      workbench,
      groundRecord('axis', (record) => record.isCombat === true),
      CORE_HEX,
      'axis',
      'u-dg',
    )
    unit.mode.dg = true
    unit.hasTraceSupply = false
    const token = mapView.overlay.tokens.find((item) => item.id === unit.instanceId)
    expect(token!.tip!).toContain('DG')
    expect(token!.tip!).toContain('断补')
  })

  it('★ 飞机：全称 + 机型 + 航程 + 出勤状态', () => {
    const { workbench, mapView } = newStores()
    const air = placeAir(
      workbench,
      aircraftRecord('axis', () => true),
      NEAR_HEX as HexRef,
      'axis',
      'air-tip',
    )
    const token = mapView.overlay.tokens.find((item) => item.id === air.instanceId)
    expect(token?.tip).toBeDefined()
    expect(token!.tip!).toContain(air.name)
    expect(token!.tip!).toContain('航程')
    expect(token!.tip!).toMatch(/Active|Inactive/)
  })
})
