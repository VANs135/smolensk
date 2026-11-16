import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 13.3f：Railhead 端头 = 换轨账本 + 铁路连通的**推导结果**（不是手摆实例）
 *
 * 原文只写「Players keep track of the current extent of each rail gauge using Railhead markers」，
 * 取法未写；本组钉的是 store 接线：账本一变，`railheadMarkers` 立即跟着前移/后撤，
 * 没有任何「设置端头位置」的入口。推导本身（推进/后撤/分叉/不重复）见 `tests/engine/rail.test.ts`。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

type Workbench = ReturnType<typeof useWorkbenchStore>

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 13.3f-B：换轨须是"移动进入"的副产品 ⇒ 先让单位真的走一格 */
function walkInto(store: Workbench, unitId: string, from: HexRef, to: HexRef): void {
  const active = store.moveInteraction?.unitIds.includes(unitId) === true
  if (!active || store.moveInteraction?.finished === true) {
    store.clickHex(from)
    if (store.movePickHex !== null) {
      store.setMovePickOnly(unitId)
      expect(store.confirmMovePick()).toBe(true)
    }
  }
  store.clickHex(to)
  expect(store.units.find((unit) => unit.instanceId === unitId)?.hex).toEqual(to)
}
const heads = (store: Workbench): string[] =>
  store.railheadMarkers.map((marker) => label(marker.hex!))

function rrUnit(
  store: Workbench,
  side: 'axis' | 'soviet',
  hex: HexRef,
  instanceId: string,
): ReturnType<typeof placeGround> {
  const record = groundRecord(side, (item) => (item.specialized ?? []).includes('rail_repair'))
  const unit = placeGround(store, record, hex, side, instanceId, 'combat')
  unit.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
  unit.raw = unit.faces.combat
  unit.mpSpent = 0
  unit.movementEnded = false
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('13.3f：Railhead 端头随换轨账本自动前移 / 后撤', () => {
  it('★ 轴方换进 ⇒ 端头前移到 3.2；苏方换回 ⇒ 端头后撤到 2.2', () => {
    const store = newStore()
    store.setPhase('movement')
    // 剧本 1 的初设换轨（01.03 → 2.02）落账后的端头是 2.2，不是西缘的 1.3
    store.convertedRailHexes = ['1.3', '2.2']
    expect(heads(store)).toEqual(['2.2'])

    const axis = rrUnit(store, 'axis', { col: 2, row: 2 }, 'rr-axis')
    // 13.3f-B：走进 3.2 才可换轨
    walkInto(store, axis.instanceId, { col: 2, row: 2 }, { col: 3, row: 2 })
    expect(store.convertRailGaugeNow(axis.instanceId, '3.2')).toBe(true)
    expect(heads(store)).toEqual(['3.2'])

    // 苏方要换回，须先进入该格（敌人走开后再进入）
    store.units.splice(store.units.indexOf(axis), 1)
    store.switchSide()
    store.setPhase('movement')
    const soviet = rrUnit(store, 'soviet', { col: 2, row: 2 }, 'rr-soviet')
    walkInto(store, soviet.instanceId, { col: 2, row: 2 }, { col: 3, row: 2 })
    expect(store.convertRailGaugeNow(soviet.instanceId, '3.2')).toBe(true)
    expect(heads(store)).toEqual(['2.2'])
  })

  /**
   * 实玩反馈：铁路工兵**沿铁路逐格前进**，每进一格换一格，端头却不延伸。
   *
   * 原文 13.3f-B：「一个铁路修理单位只需**移动进入**一个铁路格，就可转换该铁路格的轨距。
   *   轨距转换不消耗SP，也不消耗额外的移动点数。」
   * 13.3g-A：「一个铁路修理单位**可在移动阶段将铁路移动与轨距转换结合起来**。（例外：如果用于
   *   铁路移动的格刚刚在当前阶段内进行了轨距转换，则不能这样做。不能接力！）」
   * 13.3g-D：每阶段最多转换 4 格（或当前 MA 格数）。
   * ⇒ 地面连续行走时**没有「换完必须停下」**，也没有「一阶段只能换一格」；每进入一格都可换，
   *   端头应随账本逐格前移，且旧端头不留。
   */
  it('★ 沿铁路连续走 3 格、逐格换轨：每格进账本，端头逐格前移且无残留', () => {
    const store = newStore()
    store.setScenarioId('5')
    store.setTurn(10)
    store.seedConvertedRailsNow()
    store.setPhase('movement')
    expect(heads(store)).toEqual(['2.2', '24.6', '24.19'])

    const axis = rrUnit(store, 'axis', { col: 24, row: 19 }, 'rr-walk')
    const route: HexRef[] = [
      { col: 25, row: 20 },
      { col: 26, row: 19 },
      { col: 27, row: 20 },
    ]
    let from: HexRef = { col: 24, row: 19 }
    for (const to of route) {
      walkInto(store, axis.instanceId, from, to)
      expect(store.convertRailGaugeNow(axis.instanceId, label(to))).toBe(true)
      expect(store.convertedRailHexes).toContain(label(to))
      // 端头前移：新格是端头，旧格（已有后继）不再残留
      expect(heads(store)).toEqual(['2.2', '24.6', label(to)])
      from = to
    }
    expect(store.convertedRailHexes).toEqual(
      expect.arrayContaining(['24.19', '25.20', '26.19', '27.20']),
    )
  })

  /**
   * 13.3f-B 的事实是「本阶段**移动进入**过该格」，不是「移动交互还开着」。
   * 玩家换去操作别的单位（新的移动交互会替换 `moveInteraction`）后，原单位仍应能换掉
   * 它本阶段刚走进的那一格；否则实玩里「走一格 → 换一格 → 再走下一格」很容易被这一步挡住。
   */
  it('★ 边走边换：换去操作别的单位后再回来换轨，仍认「本阶段刚走进的格」', () => {
    const store = newStore()
    store.setScenarioId('5')
    store.setTurn(10)
    store.seedConvertedRailsNow()
    store.setPhase('movement')

    const axis = rrUnit(store, 'axis', { col: 24, row: 19 }, 'rr-a')
    walkInto(store, axis.instanceId, { col: 24, row: 19 }, { col: 25, row: 20 })

    // 另一枚单位开始并完成一次移动 ⇒ `moveInteraction` 被整体替换
    const other = placeGround(
      store,
      groundRecord('axis', (item) => item.isCombat === true),
      { col: 22, row: 20 },
      'axis',
      'other',
      'move',
    )
    other.mode = { mode: 'move', orientation: 'move', dg: false, exploit: false }
    other.raw = other.faces.move
    other.mpSpent = 0
    other.movementEnded = false
    // 先结束工兵的移动（6.1：另一组单位开拔前须先结束），再选中另一枚开始新移动
    store.finishMove()
    store.clickHex({ col: 22, row: 20 })
    if (store.movePickHex !== null) {
      store.setMovePickOnly(other.instanceId)
      expect(store.confirmMovePick()).toBe(true)
    }

    expect(store.moveInteraction?.unitIds).toEqual([other.instanceId])
    // 换轨仍应成立（轴方刚走进 25.20），端头随之推进
    expect(store.convertRailGaugeNow(axis.instanceId, '25.20')).toBe(true)
    expect(heads(store)).toEqual(['2.2', '24.6', '25.20'])
  })

  /** 反向：只能换**最后走进**的那一格；走过的旧格、没走进去的格一律拒。 */
  it('★ 反向：走过但当前不所在的格不能换（只认最后进入的格）', () => {
    const store = newStore()
    store.setScenarioId('5')
    store.setTurn(10)
    store.seedConvertedRailsNow()
    store.setPhase('movement')

    const axis = rrUnit(store, 'axis', { col: 24, row: 19 }, 'rr-c')
    walkInto(store, axis.instanceId, { col: 24, row: 19 }, { col: 25, row: 20 })
    expect(store.convertRailGaugeNow(axis.instanceId, '25.20')).toBe(true)
    walkInto(store, axis.instanceId, { col: 25, row: 20 }, { col: 26, row: 19 })

    // 旧格 25.20：单位已不在那里 ⇒ 拒
    expect(store.convertRailGaugeNow(axis.instanceId, '25.20')).toBe(false)
    // 当前格 26.19：刚走进 ⇒ 允许
    expect(store.convertRailGaugeNow(axis.instanceId, '26.19')).toBe(true)
    expect(heads(store)).toEqual(['2.2', '24.6', '26.19'])
  })
})
