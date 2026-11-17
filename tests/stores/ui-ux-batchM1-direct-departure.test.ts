import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * 批 M1：**勾选后点目标格即开拔**（用户 2026-11-16）
 *
 * 口径：删掉「开始移动」确认这一步 —— 取子清单存在时，地图上已高亮可达格；
 * 点高亮格＝同一击完成「开拔 + 落子」，撤销（U/Backspace 走的 `undoLastStep`）仍可用；
 * 点不可达格必须说明原因，不许静默。
 */

const START: HexRef = { col: 36, row: 13 }

type Store = ReturnType<typeof useWorkbenchStore>

function combatRecord() {
  const found = unitChoices('axis').find(
    (record) =>
      record.isCombat === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )
  if (found === undefined) throw new Error('轴心单位库中没有徒步战斗单位')
  return found
}

function newStore(): Store {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

function place(store: Store, instanceId = 'a1', hex: HexRef = START) {
  const unit = toConsoleUnit({ record: combatRecord(), instanceId, hex, side: 'axis' })
  store.units.push(unit)
  return unit
}

function pickOneStep(store: Store) {
  const node = store.groupReachable.hexes.find((item) => item.path.length === 2)
  if (node === undefined) throw new Error('可到达范围里没有一步可达的格')
  return node
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('M1：勾选后点高亮格直接开拔', () => {
  it('取子清单存在时先铺可落点高亮（不必先点开始移动）', () => {
    const store = newStore()
    store.setActiveSide('axis')
    store.setPhase('movement')
    const unit = place(store)
    store.clickHex(START)
    expect(store.movePick?.ids).toEqual([unit.instanceId])
    expect(store.moveInteraction).toBeNull()
    expect(store.groupReachable.hexes.length).toBeGreaterThan(0)
  })

  it('点高亮格：同一击开拔并落子，且能一步撤回', () => {
    const store = newStore()
    store.setActiveSide('axis')
    store.setPhase('movement')
    const unit = place(store)
    store.clickHex(START)
    const target = pickOneStep(store)

    store.clickHex(target.hex)

    expect(store.moveInteraction).not.toBeNull()
    expect(store.moveInteraction!.unitIds).toEqual([unit.instanceId])
    expect(store.movePick).toBeNull()
    expect(unit.hex).toEqual(target.hex)
    expect(store.moveInteraction!.steps).toHaveLength(1)

    // 撤销（U / Backspace = undoLastStep）：落子仍能一步撤回
    store.undoLastStep()
    expect(unit.hex).toEqual(START)
    expect(store.moveInteraction!.steps).toHaveLength(0)
  })

  it('点不可达格：不开拔，并给出原因（不静默）', () => {
    const store = newStore()
    store.setActiveSide('axis')
    store.setPhase('movement')
    const unit = place(store)
    store.clickHex(START)
    expect(store.movePick).not.toBeNull()

    store.clickHex({ col: 1, row: 1 })

    expect(store.moveInteraction).toBeNull()
    expect(store.movePick).not.toBeNull()
    expect(unit.hex).toEqual(START)
    expect(store.moveBlocked).not.toBeNull()
  })

  it('点可进入的己方占位格：优先按落点处理（2026-11-18 口径，不再换选）', () => {
    const store = newStore()
    store.setActiveSide('axis')
    store.setPhase('movement')
    const mover = place(store, 'a1')
    const resident = place(store, 'a2', { col: 37, row: 13 })
    store.clickHex(START)

    store.clickHex({ col: 37, row: 13 })

    expect(mover.hex).toEqual({ col: 37, row: 13 })
    expect(store.moveInteraction?.steps).toHaveLength(1)
    expect(store.movePick).toBeNull()
    expect(resident.hex).toEqual({ col: 37, row: 13 })
  })

  it('点不可达的己方堆叠：照旧换选，不吞掉这一击', () => {
    const store = newStore()
    store.setActiveSide('axis')
    store.setPhase('movement')
    place(store, 'a1')
    const other = place(store, 'a2', { col: 20, row: 20 })

    store.clickHex(START)
    store.clickHex({ col: 20, row: 20 })

    expect(store.moveInteraction).toBeNull()
    expect(store.movePick?.hex).toEqual({ col: 20, row: 20 })
    expect(store.movePick?.ids).toEqual([other.instanceId])
  })
})

describe('M1 接线：面板不再有「开始移动」确认', () => {
  it('移动准备窗删掉确认按钮，改为点地图高亮格', () => {
    const panel = readFileSync(
      new URL('../../src/components/move/MovePanel.vue', import.meta.url),
      'utf8',
    )
    expect(panel).not.toContain('confirmMovePick()')
    expect(panel).toContain('点地图高亮格')
  })
})
