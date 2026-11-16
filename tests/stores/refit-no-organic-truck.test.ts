import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { SP_TO_T } from '@/engine/rules'
import {
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 用户裁定（2026-11-16）：**整备（15.1B）永远不吃编内卡车的补给**
 *
 * 原文：
 *   · **15.1B**「每个空军基地的整备费用为 1T（与空军基地等级或整备的飞机数量无关）」——
 *     只定费用，取得渠道回到 12.x。
 *   · **12.9c**「空军基地整备飞机需要**图上补给**（可通过**直接拖取**或**从指挥部投递**获得）」。
 *   · **13.2g-A/B**「编内卡车永远无法在地图上卸载它们的 SP」「只允许**同一多单位编队内的单位**
 *     拖取它们的 SP」；末段「玩家可以使用指挥部，将装载于编内卡车的补给，投递给**同一多单位编队内**
 *     的单位。」—— 空军基地不是多单位编队内的单位，指挥部也不能把编内卡车的 SP 投给它。
 *
 * 故整备的可付来源里**不能出现 `unit:`（编内卡车载荷）**；同格只有编内卡车时整备不可付款；
 * 地面补给站照常（12.1b：同格多份地面持仓仍是一个补给站）。
 */
const HEX: HexRef = (() => {
  const found = mapLayers.hexes.find(
    (hex) => hex.col > 8 && hex.row > 8 && hex.col < 54 && hex.row < 28,
  )
  if (found === undefined) throw new Error('地图上找不到内圈格')
  return { col: found.col, row: found.row }
})()

const AIR_BASE = unitChoices('axis').find((record) => record.noncombatKind === 'air_base')!
const ORGANIC_TRUCK = unitChoices('axis').find(
  (record) => record.noncombatKind === 'organic_truck' && typeof record.formation === 'string',
)!
const AIRCRAFT = aircraftChoices('axis')[0]!

function withBase(): ReturnType<typeof useWorkbenchStore> {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const store = useWorkbenchStore()
  store.setPhase('aircraftRefit')
  store.setAirActive(true)
  store.units.push(
    toConsoleUnit({ record: AIR_BASE, instanceId: 'base-1', hex: HEX, side: 'axis' }),
  )
  store.airUnits.push(
    toConsoleAirUnit({
      aircraft: AIRCRAFT,
      instanceId: 'air-1',
      hex: HEX,
      side: 'axis',
      airStatus: 'inactive',
    }),
  )
  return store
}

function addOrganicTruck(store: ReturnType<typeof useWorkbenchStore>) {
  const truck = toConsoleUnit({
    record: ORGANIC_TRUCK,
    instanceId: 'tr-1',
    hex: HEX,
    side: 'axis',
  })
  truck.loadedSpT = SP_TO_T
  store.units.push(truck)
  return truck
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('15.1B / 12.9c / 13.2g-B：整备的付款来源不含编内卡车', () => {
  it('★ 同格只有编内卡车 ⇒ 没有可付款来源，整备在「确认整备」处就被拒', () => {
    const store = withBase()
    const truck = addOrganicTruck(store)

    expect(store.airRefitPayDumps('base-1')).toEqual([])
    expect(store.beginRefitNow('base-1')).toBe(true)
    store.toggleRefitAircraft('air-1')
    expect(store.confirmRefitSelectionNow()).toBe(false)
    expect(store.refitPayDumps).toEqual([])
    expect(store.pickRefitPayDump('unit:tr-1')).toBe(false)
    expect(store.confirmRefitPaymentNow()).toBe(false)
    expect(truck.loadedSpT).toBe(SP_TO_T)
  })

  it('★ 地面站 + 编内卡车同格 ⇒ 只列地面站（12.1b 一个补给站），卡车那条不出现', () => {
    const store = withBase()
    addOrganicTruck(store)
    store.spDumps.push({ id: 'ground', hex: { ...HEX }, side: 'axis', sp: 1, t: 0 })

    const pays = store.airRefitPayDumps('base-1')
    expect(pays.map((dump) => dump.id)).toEqual(['ground'])
    expect(pays.some((dump) => dump.carrierIsOrganicTruck === true)).toBe(false)
  })

  it('★ 反向：只有地面补给站 ⇒ 照常可付 1T（1SP 找零为 3T）', () => {
    const store = withBase()
    store.spDumps.push({ id: 'ground', hex: { ...HEX }, side: 'axis', sp: 1, t: 0 })

    expect(store.airRefitPayDumps('base-1').map((dump) => dump.id)).toEqual(['ground'])
    expect(store.beginRefitNow('base-1')).toBe(true)
    store.toggleRefitAircraft('air-1')
    expect(store.confirmRefitSelectionNow()).toBe(true)
    expect(store.pickRefitPayDump('ground')).toBe(true)
    expect(store.confirmRefitPaymentNow()).toBe(true)
    expect(store.spDumps.find((dump) => dump.id === 'ground')).toMatchObject({ sp: 0, t: 3 })
  })
})
