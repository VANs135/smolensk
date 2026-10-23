import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { transportEquivalentOf, zocEntryEffect } from '@/engine/rules'
import { useWorkbenchStore } from '@/stores'
import { effectiveMobilityOf, needsFuelOf, toMoveUnitView } from '@/stores/workbench-model'

import { groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 通规 3.1a **逐面机动类型**（store + 引擎的联动）
 *
 * 条文：「颜色表示地面单位的移动类型……**算子一面和另一面的颜色可能不同**」。
 * 机动类型决定：**6.2** 地形取费列 / **4.5a-A** 轮式进 EZOC 必停 / **12.5a** 是否须付燃料 /
 * **4.7b** 铁路运输当量（「移动模式下印刷 MA 为 1–6 的**步行** MP」才减半）。
 *
 * ★ 修前产物只导出**记录级**一条 `classes.movementClass`（＝战斗面的值），故对以下 72 条
 *   两面不同的记录，「移动模式下的机动类型」全判错：
 *   · 39 条轴 + 33 条苏（两面都有值且不同：leg→truck 48 / truck→leg 24）；
 *   · 记录级＝战斗面的 63 条、＝移动面的 9 条 ⇒ 影响面就是**这些单位的移动面**。
 *   本组用真实单位库记录钉住改正后的行为（两侧各取一条，方向相反）。
 *
 * ★★ 2026-09-17 二轮裁定后的现状（本组据此改夹具，见 `truckToLegRecord`）：
 *   · 全库**只剩 `leg→truck` 一个方向**：轴 57 条、苏 11 条（`tests/data/units.test.ts` 同口径钉住）；
 *   · 原先 `truck→leg` 的 14 条已被用户裁定推翻（骑兵全徒步 / 筑垒全徒步 / 摩托化＝战斗面徒步·
 *     移动面轮式 —— 见回执 §17.67）⇒ 库里这一向**现在 0 条**，
 *     所以反向样本只能构造（复用真实记录数值、把两面值对调），只钉「引擎按朝向面判」这件事，
 *     不钉任何一条真实记录的取值。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 轴 4.Pz 12 摩托化步兵团：记录级 leg ｜ 战斗面 leg(MA 3) → 移动面 **truck**(MA 6)，RE 1 */
const LEG_TO_TRUCK = 'ax-armor_pz-ge-4-pz-12-mot-inf'

type GroundRecord = Parameters<typeof placeGround>[1]

/**
 * 反方向样本（战斗面 **truck** → 移动面 **leg**）：把上述**真实**记录的记录级值与两面**对调**
 *
 * 测法边界：库里这一向的 14 条已被 2026-09-17 的裁定全部推翻（见文件头 ★★），**现存 0 条**，
 * 拿任何一条都不合适。故此处只复用真实记录的数值（兵种/RE/背面 A-AR），把 `mobilityByFace` 与
 * `classes.movementClass` 对调成「战斗面轮式、移动面徒步」，只钉「引擎按朝向面判」这一件事。
 * 移动面 MA 另行压到 **4**：真实轴记录移动面印的是 16，不落在 4.7b 的「徒步 1–6 才减半」那一档，
 * 不压就测不出「按移动面判」与「按记录级判」的差别（两档都得全价 1）。复核结论落库后，
 * 这里应换回真实记录并在注释里写明是哪一条。
 */
function truckToLegRecord(): GroundRecord {
  const record = groundRecord('axis', (item) => item.id === LEG_TO_TRUCK)
  return {
    ...record,
    id: 'constructed-truck-combat-leg-move',
    classes: { ...record.classes, movementClass: 'truck' },
    mobilityByFace: { combat: 'truck', move: 'leg' },
    factors: { ...record.factors, move: { ...record.factors?.move, ma: 4 } },
  }
}

/** 铁路用例的样本：同上，但**归属改成苏方** —— 13.3h 沿线各格由苏军控住、专规 1.2 走宽轨 */
function truckToLegSovietRecord(): GroundRecord {
  return { ...truckToLegRecord(), side: 'soviet' }
}

/** 摆一个算子（真实记录或构造记录都可；按给定面朝向） */
function placeByFace(
  store: Workbench,
  record: GroundRecord,
  face: 'combat' | 'move',
  hex?: HexRef,
) {
  const at: HexRef = hex ?? { col: 15, row: 10 }
  const side: 'axis' | 'soviet' = record.side === 'axis' ? 'axis' : 'soviet'
  const unit = placeGround(store, record, at, side, 'u1', face)
  unit.raw = unit.faces[face]
  return unit
}

describe('3.1a：真实记录的逐面机动类型', () => {
  it('两条样本记录的两面值确实不同（数据契约的前置）', () => {
    // 记录级（＝战斗面的值）与移动面相反 —— 这正是「只看记录级就会判反」的由来
    const legToTruck = groundRecord('axis', (item) => item.id === LEG_TO_TRUCK)
    expect(legToTruck.classes?.movementClass).toBe('leg')
    expect(placeByFace(newStore(), legToTruck, 'combat').raw.mobility).toBe('leg')
    expect(placeByFace(newStore(), legToTruck, 'move').raw.mobility).toBe('truck')

    const truckToLeg = truckToLegRecord()
    expect(truckToLeg.classes?.movementClass).toBe('truck')
    expect(placeByFace(newStore(), truckToLeg, 'combat').raw.mobility).toBe('truck')
    expect(placeByFace(newStore(), truckToLeg, 'move').raw.mobility).toBe('leg')
  })

  it('12.5a：是否须付燃料按**朝向面**判（只看记录级就会判反）', () => {
    // 构造样本：记录级 truck ⇒ 只看记录级会恒判「须付燃料」；移动面是 leg ⇒ 实际不须
    const truckToLeg = placeByFace(newStore(), truckToLegRecord(), 'move')
    expect(effectiveMobilityOf(truckToLeg)).toBe('leg')
    expect(needsFuelOf(truckToLeg)).toBe(false)
    // 其战斗面确是 truck（该面朝向时须付燃料）
    expect(needsFuelOf(placeByFace(newStore(), truckToLegRecord(), 'combat'))).toBe(true)

    // 轴摩托化步兵团：记录级 leg ⇒ 只看记录级会恒判「不须燃料」；移动面是 truck ⇒ 实际须
    const legToTruck = groundRecord('axis', (item) => item.id === LEG_TO_TRUCK)
    const legToTruckMove = placeByFace(newStore(), legToTruck, 'move')
    expect(effectiveMobilityOf(legToTruckMove)).toBe('truck')
    expect(needsFuelOf(legToTruckMove)).toBe(true)
    expect(needsFuelOf(placeByFace(newStore(), legToTruck, 'combat'))).toBe(false)
  })

  it('4.5a-A：进敌方 ZOC 是否必停按移动面判（轮式须停、徒步不受影响）', () => {
    const truckToLeg = placeByFace(newStore(), truckToLegRecord(), 'move')
    expect(zocEntryEffect(toMoveUnitView(truckToLeg).mobility)).toBe('unaffected')
    const legToTruck = placeByFace(
      newStore(),
      groundRecord('axis', (item) => item.id === LEG_TO_TRUCK),
      'move',
    )
    expect(zocEntryEffect(toMoveUnitView(legToTruck).mobility)).toBe('mustStopOrOverrun')
  })

  it('4.7b：铁路当量按**移动面**的机动类型与 MA 判（leg 1–6 才减半）', () => {
    // 构造样本：移动面 leg MA 4 ⇒ 1RE 减半 = 0.5（只看记录级按 truck ⇒ 1）
    const truckToLeg = placeByFace(newStore(), truckToLegRecord(), 'move')
    expect(
      transportEquivalentOf({
        kind: 'unit',
        re: truckToLeg.re,
        mobility: truckToLeg.faces.move.mobility,
        moveMa: truckToLeg.faces.move.ma,
      }),
    ).toBe(0.5)
    // 轴摩托化步兵团：移动面 truck MA 6 ⇒ 全价 1（只看记录级按 leg 6 ⇒ 误减半成 0.5）
    const legToTruck = placeByFace(
      newStore(),
      groundRecord('axis', (item) => item.id === LEG_TO_TRUCK),
      'move',
    )
    expect(
      transportEquivalentOf({
        kind: 'unit',
        re: legToTruck.re,
        mobility: legToTruck.faces.move.mobility,
        moveMa: legToTruck.faces.move.ma,
      }),
    ).toBe(1)
  })

  it('5.4a：模式切换后机动类型随朝向刷新（与 `raw` 同一行口径）', () => {
    const store = newStore()
    const unit = placeByFace(store, truckToLegRecord(), 'combat')
    store.clickHex({ col: 15, row: 10 })
    expect(effectiveMobilityOf(unit)).toBe('truck')

    store.switchUnitMode('move')
    expect(unit.mode.orientation).toBe('move')
    expect(effectiveMobilityOf(unit)).toBe('leg')
    expect(needsFuelOf(unit)).toBe(false)

    store.switchUnitMode('combat')
    expect(effectiveMobilityOf(unit)).toBe('truck')
  })
})

/** Mogilev（15.10）→ Orsha（18.18）：整段是多轨干线（13.3a），两端都是聚落 */
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

describe('4.7b：铁路当量真的按**移动面**算（走一遍 store 的铁路运货）', () => {
  it('移动面 leg MA 4 的 1RE 单位 ⇒ 当量 0.5，再加 13.3a 全程多轨减半 ⇒ 0.25 点', () => {
    const store = newStore()
    store.switchSide() // 苏方（专规 1.2 用宽轨；铁路容量 7/19 之后为 3）
    store.setPhase('movement')
    store.setTurn(5)
    // 沿线各格放苏军单位控住（13.3h），并把起点声明为补给源（13.3c 的可火车卸货格）
    for (const hex of RAIL_RUN) {
      const guard = groundRecord('soviet', (item) => item.isCombat === true)
      placeGround(store, guard, hex, 'soviet', `ctl-${label(hex)}`)
    }
    store.supplySourceDraft = { hexText: label(RAIL_RUN[0]!), kind: 'supplySourceHex' }
    expect(store.addSupplySource()).toBe(true)

    const unit = placeByFace(store, truckToLegSovietRecord(), 'move', RAIL_RUN[0])
    expect(unit.faces.move).toMatchObject({ ma: 4, mobility: 'leg' })
    store.selectedId = unit.instanceId
    store.railMoveInputs = {
      toHexText: label(RAIL_RUN[RAIL_RUN.length - 1]!),
      spAmount: 1,
      fromDumpId: null,
    }

    expect(store.railMoveNow('unit'), JSON.stringify(store.railMoveError)).toBe(true)
    // 当量 1RE × 0.5（4.7b 步行 1–6 MA）× 0.5（13.3a 全程多轨）= 0.25
    expect(store.lastRailMove!.cost).toBe(0.25)
    expect(store.lastRailMove!.detail).toContain('全程多轨')
  })
})
