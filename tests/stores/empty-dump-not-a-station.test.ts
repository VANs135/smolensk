import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * B1（用户 2026-11-24 裁定）：**补给站用完后不能算站点**（12.1b ＋ 12.1c）
 *
 * 原文：
 *   · **12.1b**「Any location containing Supply Points ... is called a dump」
 *   · **12.1c**「如果该补给站被清空，请移除**此标记**」
 *
 * 现状口径：0 SP + 0 T 的**账本条目**保留（退款/撤销/界面显示"已用尽"仍要靠它），
 * 但它**不再是站**：不进 `supplyFacts` 的 dumps（⇒ 不给覆盖集、不给直拖/投递）、
 * 不进付款/装载/卸载候选（13.2f 的「同格有补给站」也不再由空条目满足）。
 *
 * 本文件钉三件事：
 *   ① 空条目不在 `supplyFacts.dumpsFor` 与燃料候选里，但仍在 `allSpDumps`（账本不删）；
 *   ② 补回 1 T 后**立刻**重新成为站（防误杀：判据是持仓，不是"曾经清空过"）；
 *   ③ 13.2f 的卸载前提「已经有已卸载的补给站」不由空条目满足。
 */

/** 内圈的一格（角落格在补给路径上走不通，见 B32 步骤 2 的教训） */
const HEX: HexRef = (() => {
  const found = mapLayers.hexes.find(
    (hex) => hex.col > 8 && hex.row > 8 && hex.col < 54 && hex.row < 28,
  )
  if (found === undefined) throw new Error('地图上找不到内圈格')
  return { col: found.col, row: found.row }
})()

/** 需要燃料的轮式战斗单位（12.5a：按**移动面**取轮式；见 supply-reachability-flow 的注释） */
const TANK_RECORD = unitChoices('axis').find(
  (record) =>
    record.mobilityByFace?.move === 'truck' &&
    record.isCombat === true &&
    (record.noncombatKind ?? null) === null,
)!

/** 运输点数（13.2f：装载/卸载的承运算子） */
const CARRIER_RECORD = unitChoices('axis').find(
  (record) => record.noncombatKind === 'transport_point',
)!

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B1 12.1b / 12.1c：清空的补给站不再是站', () => {
  it('★ 0 SP + 0 T：不进事实与燃料候选，但账本条目保留', () => {
    const store = newStore()
    store.setPhase('movement')
    const tank = toConsoleUnit({ record: TANK_RECORD, instanceId: 'tk-1', hex: HEX, side: 'axis' })
    store.units.push(tank)
    store.spDumps.push({ id: 'd-1', hex: { ...HEX }, side: 'axis', sp: 0, t: 0 })
    store.selectedId = 'tk-1'
    store.fuelMethod = 'singleUnit'

    // ① 账本条目**保留**（12.1c 的"移除标记"在数据上由持仓表达，不删条目）
    expect(store.allSpDumps.map((dump) => dump.id)).toContain('d-1')
    // ② 但它不是站：12.3a 的 dumps 事实里没有这一格
    expect(store.supplyFacts.dumpsFor('axis')).toEqual([])
    // ③ 付款候选里也没有它
    expect(store.fuelDumpChoices.map((dump) => dump.id)).not.toContain('d-1')
  })

  it('★ 补回 1 T 后立刻重新成为站（判据是持仓，不是"曾经清空过"）', () => {
    const store = newStore()
    store.setPhase('movement')
    const tank = toConsoleUnit({ record: TANK_RECORD, instanceId: 'tk-1', hex: HEX, side: 'axis' })
    store.units.push(tank)
    store.spDumps.push({ id: 'd-1', hex: { ...HEX }, side: 'axis', sp: 0, t: 0 })
    store.selectedId = 'tk-1'
    store.fuelMethod = 'singleUnit'

    store.setSpDumpHoldings('d-1', { sp: 0, t: 1 })
    expect(store.supplyFacts.dumpsFor('axis')).toEqual([HEX])
    expect(store.fuelDumpChoices.map((dump) => dump.id)).toContain('d-1')

    // 再用空 ⇒ 又立刻退出（同一局内来回切换，不依赖任何"已撤站"记忆）
    store.setSpDumpHoldings('d-1', { sp: 0, t: 0 })
    expect(store.supplyFacts.dumpsFor('axis')).toEqual([])
    expect(store.fuelDumpChoices.map((dump) => dump.id)).not.toContain('d-1')
  })

  it('★ 13.2f：空条目不能充当「同格已有已卸载的补给站」的卸载前提', () => {
    const store = newStore()
    store.setPhase('movement')
    const carrier = toConsoleUnit({
      record: CARRIER_RECORD,
      instanceId: 'tr-1',
      hex: HEX,
      side: 'axis',
    })
    carrier.loadedSpT = 1
    store.units.push(carrier)
    store.spDumps.push({ id: 'd-1', hex: { ...HEX }, side: 'axis', sp: 0, t: 0 })

    // 同格只有**空**条目 ⇒ 卸载入口不出现
    expect(store.transportUnloadReadyAt('tr-1')).toBe(false)

    // 补 1 T 后才能卸载（13.2f「已经有已卸载的补给站」）
    store.setSpDumpHoldings('d-1', { sp: 0, t: 1 })
    expect(store.transportUnloadReadyAt('tr-1')).toBe(true)
  })
})
