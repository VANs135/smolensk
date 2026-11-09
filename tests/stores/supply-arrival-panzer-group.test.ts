import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { PANZER_GROUP_OPTION_ITEM } from '@/engine/rules'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 3.4b：德军到货 SP「未选归属不得落账」
 *
 * 原文：「All new Axis SP must immediately be assigned to a panzer group.」
 * 本批口径：初设与「补给表/免费铁运/补给列车」到货两处，德军 SP 必须先由玩家选 Guderian/Hoth；
 * 未选时 `applySupplyArrivalsNow()` 整笔拒绝，账本不新增。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const adoptPanzerGroupOption = (): void => {
  const session = useGameSessionStore()
  const index = session.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM)
  if (index < 0) throw new Error('开场共识清单里没有 3.4b 这一条')
  session.setAgreedCheck(index, true)
}

const hex = (col: number, row: number): HexRef => ({ col, row })
const CITY_HEX = hex(2, 2)
const AXIS_SOURCES = ['1.03', '1.04', '1.07', '1.12', '1.19', '1.26', '4.00', '8.00']

function armAxisRail(store: ReturnType<typeof newStore>): void {
  store.setScenarioId('1')
  store.seedConvertedRailsNow()
  for (const text of AXIS_SOURCES) {
    const [col, row] = text.split('.').map(Number)
    store.supplySourceDecls.push({
      id: `src-${text}`,
      hex: hex(col!, row!),
      side: 'axis',
      kind: 'edgeRail',
    })
  }
  const record = unitChoices('axis').find(
    (item) => item.isCombat === true && item.attackCapable === true,
  )
  if (record === undefined) throw new Error('轴方单位库里没有战斗单位')
  store.units.push(
    toConsoleUnit({ record, instanceId: 'u-axis', hex: { ...CITY_HEX }, side: 'axis' }),
  )
}

function enterArrivalStep(store: ReturnType<typeof newStore>): void {
  store.setPhase('reinforcement')
  const allowed = actionGateOf('rein.supplyArrival')
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error('B 段没有允许 rein.supplyArrival 的环节')
  expect(store.setSegmentStepIndex(index)).toBe(true)
}

function planArrival(store: ReturnType<typeof newStore>): void {
  store.supplyArrivalSp = 7
  store.toggleFreeRailPick(CITY_HEX)
  store.pickFreeRailEdgeHex(hex(1, 3))
  expect(store.freeRailError).toBe(null)
}

/**
 * 3.4b 均分：2 SP ⇒ Guderian 1 / Hoth 1（可拆成两格各 1，能精确满足；奇数点归 Guderian
 * 的 7 ⇒ 4/3 由 `tests/engine/panzer-groups.test.ts` 的 `splitSupplyTableSp(7)` 断言）。
 *
 * 均分只判 **Supply Table 到货**；补给列车（3.6）不属 Supply Table，不在均分对象里。
 */
function planTwoSplit(store: ReturnType<typeof newStore>): void {
  store.supplyArrivalSp = 2
  store.toggleFreeRailPick(CITY_HEX)
  store.pickFreeRailEdgeHex(hex(1, 3))
  expect(store.freeRailError).toBe(null)
  expect(store.arrivalSpGroupTargets).toHaveLength(2)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('3.4b：到货 SP 必须选归属', () => {
  it('开启 + 轴方 + 未选 ⇒ 整笔拒绝，账本不变', () => {
    const store = newStore()
    adoptPanzerGroupOption()
    armAxisRail(store)
    enterArrivalStep(store)
    planArrival(store)
    expect(store.panzerGroupRulesOn).toBe(true)

    expect(store.applySupplyArrivalsNow()).toBe(false)
    expect(store.spDumps).toEqual([])
    expect(store.log.some((entry) => (entry.text ?? '').includes('未选择归属'))).toBe(true)
  })

  it('开启 + 轴方 + 按 Supply Table 均分（2 SP ⇒ G 1 / H 1）⇒ 落账并立即写入归属', () => {
    const store = newStore()
    adoptPanzerGroupOption()
    armAxisRail(store)
    enterArrivalStep(store)
    planTwoSplit(store)
    const targets = store.arrivalSpGroupTargets
    store.setArrivalSpGroup(targets[0]!.hexText, 'guderian')
    store.setArrivalSpGroup(targets[1]!.hexText, 'hoth')

    expect(store.applySupplyArrivalsNow()).toBe(true)
    const groups = store.spDumps.map((dump) => store.panzerGroupOfDump(dump.id)).sort()
    expect(groups).toEqual(['guderian', 'hoth'])
    expect(store.spDumps.reduce((sum, dump) => sum + dump.sp, 0)).toBe(2)
    expect(store.pendingSpGroupAssignment).toEqual([])
    expect(store.arrivalSpGroupTargets).toEqual([])
  })

  it('开启 + 轴方 + 未按 Supply Table 均分 ⇒ 整笔拒绝，账本不变（3.4b）', () => {
    const store = newStore()
    adoptPanzerGroupOption()
    armAxisRail(store)
    enterArrivalStep(store)
    planTwoSplit(store)
    // 2 SP 全给 Hoth ⇒ 违反「2 ⇒ G 1 / H 1」
    for (const target of store.arrivalSpGroupTargets)
      store.setArrivalSpGroup(target.hexText, 'hoth')

    expect(store.applySupplyArrivalsNow()).toBe(false)
    expect(store.spDumps).toEqual([])
    expect(store.log.some((entry) => (entry.text ?? '').includes('均分'))).toBe(true)
  })

  it('关闭 ⇒ 不选也落账（与现状一致）', () => {
    const store = newStore()
    armAxisRail(store)
    enterArrivalStep(store)
    planArrival(store)
    expect(store.panzerGroupRulesOn).toBe(false)
    expect(store.applySupplyArrivalsNow()).toBe(true)
    expect(store.spDumps.reduce((sum, dump) => sum + dump.sp, 0)).toBe(7)
    expect(store.panzerGroupOfDump(store.spDumps[0]!.id)).toBe(null)
  })

  it('19 Aug（已勾选）⇒ 不再要求归属，也不写新归属', () => {
    const store = newStore()
    adoptPanzerGroupOption()
    store.setTurn(13)
    expect(store.date).toBe('1941-08-19')
    armAxisRail(store)
    enterArrivalStep(store)
    planArrival(store)
    expect(store.panzerGroupRulesOn).toBe(false)
    expect(store.applySupplyArrivalsNow()).toBe(true)
    expect(store.spDumps.every((dump) => store.panzerGroupOfDump(dump.id) === null)).toBe(true)
  })
})
