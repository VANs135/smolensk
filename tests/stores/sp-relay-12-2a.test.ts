import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 12.2a：接力运输（store 级）
 *
 * 原文：
 *   · 12.2a「同一个 SP 在一个阶段内，只能通过一种类型的运输方式……进行移动，如果之前在同一阶段内
 *     被卸载过，则该 SP 不能再装载于其他交通方式。」
 *   · 12.2b「在地图上移动 SP 后立即使用掉 SP 的话，并不违反此处接力运输的规则。」
 *
 * 本作没有逐 SP 身份；账本按「格 + 方 + 方式 + T」记。12.2b 的边界取「同阶段该站持仓减少即释放」，
 * 原文未给的更细时点不扩展。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 与 rail-cargo-flow 同一段实测铁路线（15.10 → 18.18） */
const RAIL_RUN: HexRef[] = [
  { col: 15, row: 10 },
  { col: 15, row: 11 },
  { col: 15, row: 12 },
  { col: 15, row: 13 },
  { col: 16, row: 13 },
  { col: 16, row: 14 },
  { col: 16, row: 15 },
  { col: 17, row: 16 },
  { col: 17, row: 17 },
  { col: 18, row: 17 },
  { col: 18, row: 18 },
]
const label = (hex: HexRef): string => `${hex.col}.${hex.row}`
const FROM: HexRef = RAIL_RUN[0]!
const TO: HexRef = RAIL_RUN[RAIL_RUN.length - 1]!

function railUnit(store: Workbench, hex: HexRef, instanceId: string) {
  const record = groundRecord(
    'soviet',
    (item) =>
      item.isCombat === true &&
      item.attackCapable === true &&
      item.classes?.movementClass !== 'leg',
  )
  const unit = placeGround(store, record, hex, 'soviet', instanceId)
  unit.mode = { mode: 'move', orientation: 'move', dg: false, exploit: false }
  unit.mpSpent = 0
  unit.movementEnded = false
  return unit
}

function controlRailRun(store: Workbench): void {
  RAIL_RUN.forEach((hex) => railUnit(store, hex, `ctl-${label(hex)}`))
  store.supplySourceDraft = { hexText: label(FROM), kind: 'supplySourceHex' }
  expect(store.addSupplySource()).toBe(true)
}

function sovietStore(): Workbench {
  const store = newStore()
  store.switchSide()
  store.setPhase('movement')
  store.setTurn(5)
  return store
}

function placeTransportPoint(store: Workbench, hex: HexRef, instanceId: string) {
  const record = groundRecord(
    'soviet',
    (item) =>
      item.noncombatKind === 'transport_point' && (item.noncombatDetails?.transport ?? 0) >= 2,
  )
  return placeGround(store, record, hex, 'soviet', instanceId)
}

function pushDump(store: Workbench, hex: HexRef, sp: number, id: string) {
  store.spDumps.push({ id, hex: { ...hex }, side: 'soviet', sp, t: 0 })
}

function dumpAt(store: Workbench, hex: HexRef) {
  return store.spDumps.find(
    (item) => item.side === 'soviet' && item.hex.col === hex.col && item.hex.row === hex.row,
  )
}

describe('12.2a：已卸货的 SP 同阶段不能再换一种运输方式', () => {
  it('运输点数卸货 → 同阶段铁路从同格运走 ⇒ 拒（12.2a）', () => {
    const store = sovietStore()
    controlRailRun(store)
    pushDump(store, FROM, 2, 'src-relay')
    const point = placeTransportPoint(store, FROM, 'tp-relay-1')
    store.transportLoadInputs = { pointId: point.instanceId, amount: 2 }
    expect(store.loadTransportPointNow()).toBe(true)

    // 运到终点卸载（终点有友军战斗单位 / 可卸货）
    point.hex = { ...TO }
    point.mpSpent = 0
    store.transportLoadInputs = { pointId: point.instanceId, amount: 2 }
    expect(store.unloadTransportPointNow()).toBe(true)
    const landed = dumpAt(store, TO)!
    expect(landed.sp + landed.t / 4).toBe(2)

    store.railMoveInputs = { toHexText: label(FROM), spAmount: 2, fromDumpId: landed.id }
    expect(store.railMoveNow('sp')).toBe(false)
    expect(store.railMoveError).toMatchObject({ rule: '12.2a' })
    expect(dumpAt(store, TO)!.sp + dumpAt(store, TO)!.t / 4).toBe(2)
  })

  it('铁路运到站 → 同阶段运输点数从同格装载 ⇒ 拒（12.2a）', () => {
    const store = sovietStore()
    controlRailRun(store)
    pushDump(store, FROM, 2, 'src-rail')
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: 'src-rail' }
    expect(store.railMoveNow('sp')).toBe(true)
    const arrived = dumpAt(store, TO)!

    const point = placeTransportPoint(store, TO, 'tp-relay-2')
    store.transportLoadInputs = { pointId: point.instanceId, amount: 1 }
    expect(store.loadTransportPointNow()).toBe(false)
    expect(store.transportLoadError).toMatchObject({ rule: '12.2a' })
    expect(point.loadedSpT).toBe(0)
    expect(arrived.sp + arrived.t / 4).toBe(1)
  })
})

describe('12.2a：不误伤合法路径', () => {
  it('运输点数卸货 → 同阶段再由另一个运输点数装载 ⇒ 允许（同一种方式）', () => {
    const store = sovietStore()
    controlRailRun(store)
    pushDump(store, FROM, 2, 'src-same')
    const p1 = placeTransportPoint(store, FROM, 'tp-same-1')
    store.transportLoadInputs = { pointId: p1.instanceId, amount: 2 }
    expect(store.loadTransportPointNow()).toBe(true)
    p1.hex = { ...TO }
    p1.mpSpent = 0
    store.transportLoadInputs = { pointId: p1.instanceId, amount: 2 }
    expect(store.unloadTransportPointNow()).toBe(true)

    const p2 = placeTransportPoint(store, TO, 'tp-same-2')
    store.transportLoadInputs = { pointId: p2.instanceId, amount: 2 }
    expect(store.loadTransportPointNow()).toBe(true)
  })

  it('12.2b：卸下后立即消耗，释放接力锁定 ⇒ 同阶段铁路可运剩余', () => {
    const store = sovietStore()
    controlRailRun(store)
    pushDump(store, FROM, 2, 'src-use')
    pushDump(store, TO, 2, 'to-old')
    const point = placeTransportPoint(store, FROM, 'tp-use')
    store.transportLoadInputs = { pointId: point.instanceId, amount: 1 }
    expect(store.loadTransportPointNow()).toBe(true)
    point.hex = { ...TO }
    point.mpSpent = 0
    store.transportLoadInputs = { pointId: point.instanceId, amount: 1 }
    expect(store.unloadTransportPointNow()).toBe(true)

    const toDump = dumpAt(store, TO)!
    // 卸下 1 SP 后该格共 3 SP；立即消耗 1 SP ⇒ 12.2b 释放 4T 锁定
    store.setSpDumpHoldings(toDump.id, { sp: 2, t: 0 })
    store.railMoveInputs = { toHexText: label(FROM), spAmount: 2, fromDumpId: toDump.id }
    expect(store.railMoveNow('sp')).toBe(true)
  })

  it('下一阶段 ⇒ 接力锁定失效', () => {
    const store = sovietStore()
    controlRailRun(store)
    pushDump(store, FROM, 2, 'src-next')
    const point = placeTransportPoint(store, FROM, 'tp-next')
    store.transportLoadInputs = { pointId: point.instanceId, amount: 2 }
    expect(store.loadTransportPointNow()).toBe(true)
    point.hex = { ...TO }
    point.mpSpent = 0
    store.transportLoadInputs = { pointId: point.instanceId, amount: 2 }
    expect(store.unloadTransportPointNow()).toBe(true)

    store.setPhase('combat')
    store.setPhase('movement')
    const landed = dumpAt(store, TO)!
    store.railMoveInputs = { toHexText: label(FROM), spAmount: 2, fromDumpId: landed.id }
    expect(store.railMoveNow('sp')).toBe(true)
  })
})
