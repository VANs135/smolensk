import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  actionGateOf,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'
import type { ActionKey, ConsolePhase } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 右键 13.5 补员：预选算子 + 按类型**自动映射行键**（用户 2026-11-11）
 *
 * 原文/引擎口径：`rebuildType` 是重建表的**行键**（定费用）。行键由算子类型推出
 * （引擎 `suggestRebuildRow`，唯一出处）；推不出唯一行时才留空由玩家选。右键不得落账。
 */

const HEX: HexRef = { col: 36, row: 13 }

function stores(side: 'axis' | 'soviet' = 'soviet') {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide(side)
  // 2026-11-11：观察方手动选（不再随行动方自动切），测试里与行动方对齐
  useHotseatStore().setViewerSide(side)
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

  it('★ 图上带损本方单位 ⇒ 菜单出「重建（13.5）」；点它即在本格扣点重建（不出高亮）', () => {
    const hqRecord = groundRecord('soviet', (record) => record.specialized?.includes('hq') === true)
    placeGround(s.workbench, hqRecord, HEX, 'soviet', 'hq-1')
    s.workbench.setReplHoldingsNow({ pax: 10, eq: 10, ftr: 0, tac: 0 }, HEX)
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
    expect(keys).toContain('rein.rebuild.onMap')

    expect(s.mapView.openContextAction('hurt', 'rein.rebuild.onMap')).toBe(true)
    // 落点固定本格（13.5a 第 2 项）：不进入点格态
    expect(s.workbench.hexPickView).toBe(null)
    expect(s.workbench.lastRebuild).not.toBe(null)
    expect(s.workbench.units.find((item) => item.instanceId === 'hurt')?.steps).toBeGreaterThan(1)
  })

  it('★ 补员不在本格 ⇒ 菜单不出现该项（13.5a：所需补员须全在该格）', () => {
    const hqRecord = groundRecord('soviet', (record) => record.specialized?.includes('hq') === true)
    placeGround(s.workbench, hqRecord, HEX, 'soviet', 'hq-1')
    const unit = placeGround(
      s.workbench,
      groundRecord('soviet', (record) => /Rifle Div|Tk Div/i.test(record.vassalName ?? '')),
      HEX,
      'soviet',
      'hurt',
    )
    unit.steps = 1
    expect(menuKeys(s, 'hurt')).not.toContain('rein.rebuild.onMap')
  })

  it('★ 未受损、死亡堆也没有 ⇒ 菜单不出现该项', () => {
    placeGround(
      s.workbench,
      groundRecord('soviet', (record) => /Rifle Div|Tk Div/i.test(record.vassalName ?? '')),
      HEX,
      'soviet',
      'full',
    )
    expect(menuKeys(s, 'full')).not.toContain('rein.rebuild.onMap')
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
    expect(menuKeys(s, 'hurt')).not.toContain('rein.rebuild.onMap')
  })
})
