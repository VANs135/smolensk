import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { SP_TO_T } from '@/engine/rules'
import { hexLabel, toConsoleUnit, unitChoices, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * 同格「地面补给站 + 编内卡车载荷」并存时的来源选择（用户 2026-11-16 报告 #1）
 *
 * 原文：
 *   · **12.1b**「任何含有 SP 的位置，无论是地面上未装载的补给，**还是装载在运输点数上的补给**，
 *     都被称为补给站。**SP 使用前并不需要被卸载**。」
 *   · **13.2g-B**「只允许**同一多单位编队内的单位**拖取它们的 SP」；
 *     末段「玩家可以使用指挥部，将装载于编内卡车的补给，投递给**同一多单位编队内**的单位。」
 *   · **13.2h** 只规定满载符号（`F` 面）的记法，不涉及取用次序。
 *
 * 结论：原文**没有**规定"先吃自带、后吃 dump"之类的优先级 —— 同格两处来源都合法，
 * 由玩家**明确选一处**。本文件钉四件事：
 *   ① 来源清单按**每一份持仓**展开（地面账本一条、每辆装载车一条），不是"一格一条"；
 *   ② 拖着来源的编队资格（13.2g-B）**逐份**复核，不能只看同格第一条；
 *   ③ 付款扣的是**选中的那一份**（选卡车 ⇒ 扣 `loadedSpT`，不动地面账本）；
 *   ④ 同格有多份来源时，地图点格**不默认取第一条**，而是要求玩家在清单里选。
 */
const HEX: HexRef = (() => {
  const found = mapLayers.hexes.find(
    (hex) => hex.col > 8 && hex.row > 8 && hex.col < 54 && hex.row < 28,
  )
  if (found === undefined) throw new Error('地图上找不到内圈格')
  return { col: found.col, row: found.row }
})()

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const TANK_RECORD = unitChoices('axis').find(
  (record) =>
    record.isCombat === true &&
    record.attackCapable === true &&
    (record.classes?.movementClass === 'tracked' || record.classes?.movementClass === 'truck') &&
    (record.formation ?? null) === null &&
    (record.steps?.total ?? 1) <= 1,
)!

const TRUCK_RECORD = unitChoices('axis').find(
  (record) => record.noncombatKind === 'organic_truck' && typeof record.formation === 'string',
)!

/** 与编内卡车**同编队**的轴方战斗单位 */
const FORMATION_TANK = unitChoices('axis').find(
  (record) =>
    record.formation === TRUCK_RECORD.formation &&
    record.isCombat === true &&
    record.attackCapable === true &&
    record.id !== TRUCK_RECORD.id,
)!

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 同格：地面补给站 1 SP + 编内卡车 1 SP（满载） */
function sameHexStores() {
  const store = newStore()
  store.setPhase('supply')
  store.setSupplyActive(true)
  store.spDumps.push({ id: 'ground', hex: { ...HEX }, side: 'axis', sp: 1, t: 0 })
  const truck = toConsoleUnit({
    record: TRUCK_RECORD,
    instanceId: 'tr-1',
    hex: HEX,
    side: 'axis',
  })
  truck.loadedSpT = SP_TO_T
  store.units.push(truck)
  // 12.6a①：同格声明补给源 ⇒ 该堆叠有追溯补给，才有"来源清单"这一段
  store.supplySourceDraft = { hexText: hexLabel(HEX), kind: 'supplySourceHex' }
  expect(store.addSupplySource()).toBe(true)
  return { store, truck }
}

describe('12.1b / 13.2g-B：同格地面补给站与编内卡车载荷并存', () => {
  it('★ 来源清单按每一份持仓展开（地面一条 + 编内卡车一条），且可分辨是哪一处', () => {
    const { store } = sameHexStores()
    const mate = toConsoleUnit({
      record: FORMATION_TANK,
      instanceId: 'mate-1',
      hex: HEX,
      side: 'axis',
    })
    store.units.push(mate)

    expect(store.beginSupplyCheckNow('mate-1')).toBe(true)
    const dumps = store.supplySources.filter((source) => source.kind === 'dump')
    // 修前：一格一条（引擎按格给）⇒ 卡车那一条根本不存在
    // 地面那条不写 `stockId`（12.1b 同格仍是一个补给站，3.4b 的集群拆分另行处理）
    expect(dumps.map((source) => source.stockId)).toEqual([undefined, 'unit:tr-1'])
    const labels = dumps.map((source) => store.supplySourceLabel(source)).join('｜')
    expect(labels).toContain('地面补给站')
    expect(labels).toContain('编内卡车')
    expect(labels).toContain('13.2g-B')
  })

  it('★ 选编内卡车付款 ⇒ 扣 `loadedSpT`，地面账本不动（12.1a / 13.2f）', () => {
    const { store, truck } = sameHexStores()
    const mate = toConsoleUnit({
      record: FORMATION_TANK,
      instanceId: 'mate-1',
      hex: HEX,
      side: 'axis',
    })
    store.units.push(mate)
    expect(store.beginSupplyCheckNow('mate-1')).toBe(true)

    const index = store.supplySources.findIndex((source) => source.stockId === 'unit:tr-1')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(store.chooseSupplySourceNow(index)).toBe(true)

    store.supplyInputs.amountT = 1
    store.supplyInputs.purpose = 'fuel'
    expect(store.confirmSupplyPickupNow()).toBe(true)
    expect(truck.loadedSpT).toBe(SP_TO_T - 1)
    expect(store.spDumps.find((dump) => dump.id === 'ground')).toMatchObject({ sp: 1, t: 0 })
  })

  it('★ 13.2g-B 逐份复核：异编队单位只能看到地面补给站，编内卡车那条被标不可用', () => {
    const { store } = sameHexStores()
    const stranger = toConsoleUnit({
      record: TANK_RECORD,
      instanceId: 'str-1',
      hex: HEX,
      side: 'axis',
    })
    store.units.push(stranger)

    expect(store.beginSupplyCheckNow('str-1')).toBe(true)
    const truckSource = store.supplySources.find((source) => source.stockId === 'unit:tr-1')
    expect(truckSource).toBeDefined()
    expect(truckSource!.ok).toBe(false)
    expect(truckSource!.rule).toBe('13.2g-B')
    const ground = store.supplySources.find(
      (source) => source.kind === 'dump' && source.stockId === undefined,
    )
    expect(ground?.ok).toBe(true)
  })

  it('★ 地图点格不默认取第一条：同格两份来源时停在「选来源」并给出选项', () => {
    const { store } = sameHexStores()
    const mate = toConsoleUnit({
      record: FORMATION_TANK,
      instanceId: 'mate-1',
      hex: HEX,
      side: 'axis',
    })
    store.units.push(mate)
    expect(store.beginSupplyCheckNow('mate-1')).toBe(true)

    expect(store.pickSupplySourceAtHexNow(HEX)).toBe(true)
    expect(store.supplyState?.chosenSource).toBeUndefined()
    expect(store.supplyState?.step).toBe('selectSource')
  })
})

describe('统一「可选补给源」高亮（用户 2026-11-16 报告 #2）', () => {
  it('★ 补给检查的候选进同一套 supplyPay 通道，且不再用 mapHighlightHexes 叠一层', () => {
    setActivePinia(createPinia())
    const store = useWorkbenchStore()
    const mapView = useMapViewStore()
    store.setPhase('supply')
    store.setSupplyActive(true)
    store.spDumps.push({ id: 'ground', hex: { ...HEX }, side: 'axis', sp: 1, t: 0 })
    const truck = toConsoleUnit({
      record: TRUCK_RECORD,
      instanceId: 'tr-1',
      hex: HEX,
      side: 'axis',
    })
    truck.loadedSpT = SP_TO_T
    const mate = toConsoleUnit({
      record: FORMATION_TANK,
      instanceId: 'mate-1',
      hex: HEX,
      side: 'axis',
    })
    store.units.push(truck, mate)
    store.supplySourceDraft = { hexText: hexLabel(HEX), kind: 'supplySourceHex' }
    expect(store.addSupplySource()).toBe(true)
    expect(store.beginSupplyCheckNow('mate-1')).toBe(true)

    const hints = mapView.overlay.supplyPay ?? []
    // 同格两份来源 ⇒ 地图上仍只画**一格一条**（同屏只保留一套视觉）
    const atHex = hints.filter((hint) => hint.hex.col === HEX.col && hint.hex.row === HEX.row)
    expect(atHex.length).toBe(1)
    expect(typeof atHex[0]!.affordable).toBe('boolean')
    // 修前：这一格由 `mapHighlightHexes` 另外描一圈 ⇒ 两套视觉叠加
    expect(
      mapView.mapHighlightHexes.some((hex) => hex.col === HEX.col && hex.row === HEX.row),
    ).toBe(false)
  })
})
