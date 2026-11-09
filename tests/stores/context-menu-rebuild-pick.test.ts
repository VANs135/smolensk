import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { actionGateOf, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'
import type { ActionKey, ConsolePhase } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 右键 13.5 补员：预选算子，**行键仍由玩家点**（用户 2026-11-09 第 4 轮）
 *
 * 原文/引擎口径：`rebuildType` 是重建表的**行键**（定费用），工程库没有「算子→行」映射；
 * 引擎 `suggestRebuildRow` 的注释明文禁止静默取建议行。故右键只能把算子带进增援面板，
 * 不得自动写行键、更不得落账。
 */

const HEX: HexRef = { col: 36, row: 13 }

function stores(side: 'axis' | 'soviet' = 'soviet') {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide(side)
  return { workbench, mapView: useMapViewStore() }
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

function menuKeys(s: ReturnType<typeof stores>, instanceId: string): string[] {
  s.workbench.selectedId = instanceId
  s.mapView.onHexContext(HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
  return (s.mapView.contextOptions.find((item) => item.id === instanceId)?.actions ?? []).map(
    (item) => item.key,
  )
}

describe('右键 13.5：补员预选算子（行键仍由玩家选）', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
    s.workbench.setPhase('reinforcement')
    goToActionStep(s.workbench, 'rein.rebuild')
  })

  it('★ 图上带损本方单位 ⇒ 菜单出「补员单位补员」，点它只预选、不写行键、不落账', () => {
    const unit = placeGround(
      s.workbench,
      groundRecord('soviet', (record) => /Rifle Div|Tk Div/i.test(record.vassalName ?? '')),
      HEX,
      'soviet',
      'hurt',
    )
    unit.steps = 1
    expect(unit.steps).toBeLessThan(unit.printedSteps)

    const keys = menuKeys(s, 'hurt')
    expect(keys).toContain('rein.rebuild')

    expect(s.mapView.openContextAction('hurt', 'rein.rebuild')).toBe(true)
    expect(s.workbench.rebuildPickUnitId).toBe('hurt')
    // 行键必须留空：由玩家在重建表里点
    expect(s.workbench.rebuildPickRow).toBe('')
    expect(s.workbench.lastRebuild).toBe(null)
    expect(s.workbench.units).toHaveLength(1)
    expect(s.workbench.units[0]?.steps).toBe(1)
  })

  it('★ 未受损、死亡堆也没有 ⇒ 菜单不出现该项', () => {
    placeGround(
      s.workbench,
      groundRecord('soviet', (record) => /Rifle Div|Tk Div/i.test(record.vassalName ?? '')),
      HEX,
      'soviet',
      'full',
    )
    expect(menuKeys(s, 'full')).not.toContain('rein.rebuild')
  })

  it('★ 非增援段 ⇒ 菜单不出现该项（13.5 的时机闸）', () => {
    const unit = placeGround(
      s.workbench,
      groundRecord('soviet', (record) => /Rifle Div|Tk Div/i.test(record.vassalName ?? '')),
      HEX,
      'soviet',
      'hurt',
    )
    unit.steps = 1

    s.workbench.setPhase('movement')
    goToActionStep(s.workbench, 'move.order')
    expect(menuKeys(s, 'hurt')).not.toContain('rein.rebuild')
  })
})
