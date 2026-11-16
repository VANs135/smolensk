import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useWorkbenchStore } from '@/stores'

/**
 * B2（用户 2026-11-17）：增援铁路撤回条的寿命跟着段和方走
 *
 *   · 离段 / 换方即失效并收起（切回来也不再出现）；
 *   · 撤回记的是哪一方，运力就退给哪一方，不看 activeSide；
 *   · 不可撤时给出原因，不能「条消失但什么都没恢复」。
 */

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 与前一轮审计一致的筛选：剧本 1 轴心第一回合里入铁路网的增援条目 */
const AXIS_RAIL_ENTRY = new Set(['8.0', '1.7', '1.19', '1.3'])

function seekRailArrival(store: ReturnType<typeof useWorkbenchStore>) {
  for (let turn = 1; turn <= 40; turn += 1) {
    store.setTurn(turn)
    store.setPhase('reinforcement')
    if (store.railCapRemaining.axis < 1) continue
    const plan = store.arrivalPlan
    if (plan === null) continue
    for (let index = 0; index < plan.units.length; index += 1) {
      const unit = plan.units[index]!
      if (unit.kind === 'sp' || unit.kind === 'unclassified') continue
      const placement = store.arrivalPlacements[index]
      if (placement === undefined || !('hex' in placement) || placement.hex == null) continue
      if (AXIS_RAIL_ENTRY.has(label(placement.hex))) return { index, hex: placement.hex }
    }
  }
  return null
}

function railArrived() {
  const store = useWorkbenchStore()
  const hit = seekRailArrival(store)
  expect(hit, '应能找到一个铁路可抵达的增援条目').not.toBeNull()
  store.applyArrivalRemovalsNow()
  expect(store.beginArrivalRailPickNow(hit!.index)).toBe(true)
  const view = store.hexPickView
  const target = view === null || view.candidates === 'any' ? null : view.candidates[0]
  expect(target).toBeTruthy()
  expect(store.pickHexFor(target!)).toBe(true)
  expect(store.arrivalRailUndo).not.toBeNull()
  return { store, index: hit!.index }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B2：铁路撤回条生命周期', () => {
  it('离开增援段即收起；切回增援段也不再出现', () => {
    const { store } = railArrived()
    store.setPhase('movement')
    expect(store.arrivalRailUndo).toBeNull()
    store.setPhase('reinforcement')
    expect(store.arrivalRailUndo).toBeNull()
  })

  it('换方即收起；切回原方也不再出现', () => {
    const { store } = railArrived()
    store.setActiveSide('soviet')
    expect(store.arrivalRailUndo).toBeNull()
    store.setActiveSide('axis')
    expect(store.arrivalRailUndo).toBeNull()
  })

  it('撤回把运力退给记录下来的那一方', () => {
    const { store, index } = railArrived()
    const axisBefore = store.railCapRemaining.axis
    const sovietBefore = store.railCapRemaining.soviet
    const cost = store.arrivalRailUndo?.cost ?? 0
    expect(cost).toBeGreaterThan(0)

    expect(store.withdrawArrivalNow(index, 'axis')).toBe(true)
    expect(store.railCapRemaining.axis).toBe(axisBefore + cost)
    expect(store.railCapRemaining.soviet).toBe(sovietBefore)
    expect(store.arrivalRailUndo).toBeNull()
  })

  it('撤回条还在但账本没了：失败给原因，不静默', () => {
    const { store, index } = railArrived()
    // 先正常撤回一次（账本随之清空），再把撤回条人为挂回，模拟"条指向已消失的记录"
    expect(store.withdrawArrivalNow(index, 'axis')).toBe(true)
    store.arrivalRailUndo = { index, label: 'stale', cost: 1, side: 'axis' }
    expect(store.undoArrivalRailNow()).toBe(false)
    expect(store.arrivalRailUndo).toBeNull()
    expect(store.reinforcementError?.reason).toContain('arrivalWithdraw')
  })
})
