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
 * 右键 13.9-1 合并：按同格可并伙伴数分流（用户 2026-11-09 第 4 轮）
 *
 * 口径：
 *   · 恰 1 枚伙伴 ⇒「合并单位」一键并（既有行为）；
 *   · ≥2 枚伙伴 ⇒「打开整编会话」，由玩家在既有整编会话里挑，菜单不替他挑；
 *   · 整编会话只列**当前触发该操作的那个堆叠**（同格），不跨格展开成全局清单。
 */

const HEX: HexRef = { col: 36, row: 13 }
const OTHER: HexRef = { col: 37, row: 13 }

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

/** 13.9-1：多军力师（两面印值相同 ⇒ 同一记录放一起即可合并） */
function multiStepRecord() {
  return groundRecord('soviet', (record) => /Tk Div|Rifle Div/i.test(record.vassalName ?? ''))
}

function menuKeys(s: ReturnType<typeof stores>, instanceId: string): string[] {
  s.workbench.selectedId = instanceId
  s.mapView.onHexContext(HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
  return (s.mapView.contextOptions.find((item) => item.id === instanceId)?.actions ?? []).map(
    (item) => item.key,
  )
}

describe('右键 13.9-1：同格多枚伙伴 ⇒ 打开整编会话（不当场并）', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
    s.workbench.setPhase('reinforcement')
    goToActionStep(s.workbench, 'rein.rebuild')
  })

  it('★ 三枚同格可并 ⇒ 菜单是「打开整编会话」，点它只预选、不落账', () => {
    const record = multiStepRecord()
    for (const id of ['a', 'b', 'c']) placeGround(s.workbench, record, HEX, 'soviet', id)

    const keys = menuKeys(s, 'a')
    expect(keys).toContain('rein.consolidate.open')
    expect(keys).not.toContain('rein.consolidate')

    expect(s.mapView.openContextAction('a', 'rein.consolidate.open')).toBe(true)
    expect(s.workbench.consolidationPick?.keepId).toBe('a')
    expect(s.workbench.consolidationPick?.hex).toEqual(HEX)
    // 不替玩家挑：一枚都没并掉
    expect(s.workbench.units).toHaveLength(3)
    expect(s.workbench.lastConsolidation).toBe(null)
  })

  it('★ 恰一枚同格伙伴 ⇒ 仍是「合并单位」一键并', () => {
    const record = multiStepRecord()
    const keep = placeGround(s.workbench, record, HEX, 'soviet', 'k1')
    const remove = placeGround(s.workbench, record, HEX, 'soviet', 'r1')
    keep.steps = 2
    remove.steps = 1

    const keys = menuKeys(s, 'k1')
    expect(keys).toContain('rein.consolidate')
    expect(keys).not.toContain('rein.consolidate.open')

    expect(s.mapView.openContextAction('k1', 'rein.consolidate')).toBe(true)
    expect(s.workbench.units.map((unit) => unit.instanceId)).toEqual(['k1'])
    expect(keep.steps).toBe(3)
  })

  it('★ 整编会话只列当前堆叠：同格三枚 + 别格一枚 ⇒ 别格那枚不进候选', () => {
    const record = multiStepRecord()
    for (const id of ['k1', 'r1', 'r2']) placeGround(s.workbench, record, HEX, 'soviet', id)
    placeGround(s.workbench, record, OTHER, 'soviet', 'far1')

    // 判据本身只看同格
    expect([...s.workbench.mergePartnerIds('k1')].sort()).toEqual(['r1', 'r2'])

    menuKeys(s, 'k1')
    expect(s.mapView.openContextAction('k1', 'rein.consolidate.open')).toBe(true)
    const keepIds = s.workbench.consolidationKeepUnits.map((unit) => unit.instanceId).sort()
    const removeIds = s.workbench
      .mergeRemoveUnits('k1')
      .map((unit) => unit.instanceId)
      .sort()
    expect(keepIds).toEqual(['k1', 'r1', 'r2'])
    expect(removeIds).toEqual(['r1', 'r2'])
    expect([...keepIds, ...removeIds]).not.toContain('far1')
  })
})
