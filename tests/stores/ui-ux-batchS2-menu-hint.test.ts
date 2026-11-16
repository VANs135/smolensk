import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  actionGateOf,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

import {
  CORE_HEX,
  NEAR_HEX,
  artilleryRecord,
  groundRecord,
  newConsole,
  placeGround,
} from '../flows/sop-harness'

/**
 * S2（用户 2026-11-17）：提示文案必须与真实菜单层级对齐
 *
 * 右键敌方格的一级菜单是「射击」，其下才是「炮击 / 轰炸 / 低空扫射」；
 * 修前提示照字面写「选『炮击』」，玩家按提示找不到入口。
 */

const newStores = () => {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

function enterStep(
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
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('S2：右键菜单层级与提示一致', () => {
  it('F 炮击环节：提示写「射击 → 炮击」，而不是只有「炮击」', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('combat')
    enterStep(workbench, 'barrage.declare')
    expect(workbench.segmentStep?.id).toBe('combat.barrage')
    placeGround(workbench, artilleryRecord('axis'), CORE_HEX, 'axis', 'art-1')
    placeGround(workbench, groundRecord('soviet', (r) => r.isCombat === true), NEAR_HEX, 'soviet', 'def-1')
    workbench.spDumps.push({ id: 'dump-1', hex: { ...CORE_HEX }, side: 'axis', sp: 0, t: 20 })

    expect(workbench.barrageTargetsNow.length).toBeGreaterThan(0)
    expect(mapView.actionHint).toContain('射击')
    expect(mapView.actionHint).toContain('炮击')
  })

  it('G 进击射击环节：提示同样先指向「射击」', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('exploitation')
    enterStep(workbench, 'barrage.declare')
    expect(workbench.segmentStep?.id).toBe('exploitation.barrage')
    const gun = placeGround(workbench, artilleryRecord('axis'), CORE_HEX, 'axis', 'g-gun')
    gun.mode = { ...gun.mode, mode: 'reserve', releasedFromReserve: true }
    placeGround(workbench, groundRecord('soviet', (r) => r.isCombat === true), NEAR_HEX, 'soviet', 'g-def')
    workbench.spDumps.push({ id: 'dump-g', hex: { ...CORE_HEX }, side: 'axis', sp: 0, t: 20 })

    expect(workbench.barrageTargetsNow.length).toBeGreaterThan(0)
    expect(mapView.actionHint).toContain('射击')
    expect(mapView.actionHint).toContain('轰炸')
  })

  it('源码里不再出现「选『炮击』/『轰炸』」这种缺一级入口的写法', () => {
    const src = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(src).not.toContain('选「炮击」')
    expect(src).not.toContain('选「轰炸」')
    expect(src).toContain('射击 → 炮击')
    expect(src).toContain('射击 → 轰炸')
  })
})
