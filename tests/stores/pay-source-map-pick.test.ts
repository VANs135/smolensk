import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useWorkbenchStore } from '@/stores'

import { CORE_HEX, groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 用户 2026-11-12：建造 / 工事 / 加油的付款站改为**地图点选**（与炮击同一套）
 *
 * 本用例只钉 store 的"进入选站模式 → 点中候选 → 写入 payDumpId 并退出"这一层；
 * 地图高亮/格上 SP 文本由 `map-view` 的 `constructionPayHints` / `hedgehogPayHints` /
 * `fuelPayHints` 派生，判据只有 store 这一处。
 */
const newStore = (): Workbench => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

function placeEngineer(store: Workbench, instanceId = 'e1') {
  const record = groundRecord('axis', (item) => (item.specialized ?? []).includes('hq'))
  const unit = placeGround(store, record, CORE_HEX, 'axis', instanceId)
  unit.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
  unit.mpSpent = 0
  unit.movementEnded = false
  return unit
}

function withDump(store: Workbench, hex = CORE_HEX, sp = 4): string {
  store.spDumps.push({ id: 'd1', hex: { ...hex }, side: 'axis', sp, t: 0 })
  return 'd1'
}

describe('15.3 / 15.2A：建造付款站的地图点选', () => {
  it('工程兵在补给站同格 ⇒ 候选含该站；点中后写入 payDumpId 并退出选站模式', () => {
    const store = newStore()
    const engineer = placeEngineer(store)
    const dumpId = withDump(store)
    store.constructionInputs = {
      hexText: `${CORE_HEX.col}.${CORE_HEX.row}`,
      engineerId: engineer.instanceId,
      payDumpId: null,
    }

    expect(store.toggleConstructionPayPick()).toBe(true)
    expect(store.constructionPayPick).toBe(true)
    expect(store.constructionPayDumps.map((dump) => dump.id)).toEqual([dumpId])

    expect(store.pickConstructionPayDumpNow(dumpId)).toBe(true)
    expect(store.constructionInputs.payDumpId).toBe(dumpId)
    expect(store.constructionPayPick).toBe(false)
  })

  it('未指定施工者 ⇒ 不开选站模式（不铺无主候选）', () => {
    const store = newStore()
    withDump(store)
    expect(store.toggleConstructionPayPick()).toBe(false)
    expect(store.constructionPayPick).toBe(false)
  })

  it('远处补给站不进候选（12.3a：施工者拖不到）', () => {
    const store = newStore()
    const engineer = placeEngineer(store)
    store.spDumps.push({
      id: 'far',
      hex: { col: CORE_HEX.col + 20, row: CORE_HEX.row },
      side: 'axis',
      sp: 4,
      t: 0,
    })
    store.constructionInputs = {
      hexText: `${CORE_HEX.col}.${CORE_HEX.row}`,
      engineerId: engineer.instanceId,
      payDumpId: null,
    }
    expect(store.constructionPayDumps).toEqual([])
  })
})

describe('16.0b：环形工事付款站的地图点选', () => {
  it('目标格内的施工小队可达该站 ⇒ 点中后写入 payDumpId', () => {
    const store = newStore()
    const worker = placeEngineer(store, 'w1')
    const dumpId = withDump(store)
    store.hedgehogExecutorMode = 'inPlace'
    store.hedgehogInputs = {
      hexText: `${CORE_HEX.col}.${CORE_HEX.row}`,
      workerIds: [worker.instanceId],
      payDumpId: null,
    }

    expect(store.toggleHedgehogPayPick()).toBe(true)
    expect(store.hedgehogPayDumps.map((dump) => dump.id)).toEqual([dumpId])
    expect(store.pickHedgehogPayDumpNow(dumpId)).toBe(true)
    expect(store.hedgehogInputs.payDumpId).toBe(dumpId)
    expect(store.hedgehogPayPick).toBe(false)
  })

  it('未勾选施工小队 ⇒ 不开选站模式', () => {
    const store = newStore()
    withDump(store)
    store.hedgehogInputs = {
      hexText: `${CORE_HEX.col}.${CORE_HEX.row}`,
      workerIds: [],
      payDumpId: null,
    }
    expect(store.toggleHedgehogPayPick()).toBe(false)
  })
})
