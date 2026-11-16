import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useMapViewStore, useSetupStore } from '@/stores'

import { CORE_HEX, airBaseRecord, newConsole, placeGround } from '../flows/sop-harness'

/**
 * A 段措辞（用户 2026-11-17）：「没有基地」与「有基地但没飞机」必须分开说
 *
 * 修前两种情况共用「本阶段没有可整备的基地」——盘面上明明有基地，提示却与事实矛盾。
 */

const newStores = () => {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return { workbench: newConsole(), mapView: useMapViewStore() }
}

describe('A 整备提示按盘面事实分档', () => {
  it('没有任何本方空军基地 ⇒ 说「没有空军基地」', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('aircraftRefit')
    expect(workbench.segmentStep?.id).toBe('aircraftRefit.refit')
    expect(workbench.ownAirBases.length).toBe(0)

    expect(mapView.actionHint).toContain('没有本方空军基地')
  })

  it('有基地但没有待整备的飞机 ⇒ 说「没有待整备的飞机」，不再说没有基地', () => {
    const { workbench, mapView } = newStores()
    placeGround(workbench, airBaseRecord(), CORE_HEX, 'axis', 'base-ax')
    workbench.setPhase('aircraftRefit')
    expect(workbench.ownAirBases.length).toBeGreaterThan(0)
    expect(workbench.refitStartBases.length).toBe(0)

    expect(mapView.actionHint).toContain('没有待整备的飞机')
    expect(mapView.actionHint).not.toContain('没有本方空军基地')
    expect(mapView.actionHint).toContain('空军基地格')
  })
})
