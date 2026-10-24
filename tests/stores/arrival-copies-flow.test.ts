import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { arrivalCopiesOf } from '@/engine/rules'
import type { ArrivalUnitDemand } from '@/engine/rules'
import { actionGateOf, useWorkbenchStore } from '@/stores'
import type { ActionKey, ConsolePhase } from '@/stores'

import { CORE_HEX, airBaseRecord, placeGround } from '../flows/sop-harness'

/**
 * 13.6：到达条目的**投放枚数**（`2x ...` 应当真的到场两枚）
 *
 * 修前 `count` 只进文案、投放恒落一枚，且随即被「已投放」账本挡住 ⇒ `2x 26-2-2 Arty Grp` 之类
 * 永远只有一半在场。同时**飞机到达**修前共用陆战单位库解析（飞机不在那张表里）⇒ 一律 `arrivalUnitNotResolved`；
 * 本组用例把这两件事一起钉住。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

/** 在若干回合里找第一条 `raw` 前缀匹配的到达需求（真实到达表，不造数） */
function findDemand(
  store: ReturnType<typeof newStore>,
  prefix: string,
): { turn: number; index: number; demand: ArrivalUnitDemand } {
  for (let turn = 1; turn <= 40; turn += 1) {
    store.setTurn(turn)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan
    if (plan === null) continue
    const index = plan.units.findIndex(
      (item) => item.raw.startsWith(prefix) || (item.name ?? '').startsWith(prefix),
    )
    if (index < 0) continue
    return { turn, index, demand: plan.units[index]! }
  }
  throw new Error(`到达表里没有「${prefix}」`)
}

describe('13.6：枚数判据（arrivalCopiesOf）', () => {
  it('`Nx` 同型 ⇒ N 枚；逐枚点名的括号、运输点数运力都不算枚数', () => {
    // 每个断言都用**新店**：`setTurn` 不允许回头，同一店内连扫两次会拿不到早期回合
    const axis = newStore()
    axis.setActiveSide('axis')
    expect(arrivalCopiesOf(findDemand(axis, '2x 26-2-2 Arty Grp').demand)).toBe(2)

    // `2x Corps HQ (9, 12)`：第 9 与第 12 军部是两枚**不同**算子 ⇒ 不复制
    const hq = newStore()
    hq.setActiveSide('axis')
    expect(arrivalCopiesOf(findDemand(hq, '2x Corps HQ').demand)).toBe(1)

    // `2 Truck Points` 的 2 是运力点数（13.6c），仍是一枚算子
    const trucks = newStore()
    trucks.setActiveSide('soviet')
    expect(arrivalCopiesOf(findDemand(trucks, '2 Truck Points').demand)).toBe(1)

    const alarm = newStore()
    alarm.setActiveSide('soviet')
    expect(arrivalCopiesOf(findDemand(alarm, '2x 2-1-3 Alarm Tk Bn').demand)).toBe(2)
  })

  it('普通条目恒 1 枚', () => {
    const store = newStore()
    store.setActiveSide('axis')
    expect(arrivalCopiesOf(findDemand(store, '5 Inf Div').demand)).toBe(1)
  })
})

describe('13.6：投放真的落下两枚（并记账一次）', () => {
  it('苏联 `2x 2-1-3 Alarm Tk Bn` ⇒ 盘面 +2 枚，且再投被拒', () => {
    const store = newStore()
    store.setActiveSide('soviet')
    const { turn, index } = findDemand(store, '2x 2-1-3 Alarm Tk Bn')
    store.setTurn(turn)
    store.setPhase('reinforcement')
    goToActionStep(store, 'rein.arrival')
    const before = store.units.length
    expect(store.placeArrivalNow(index)).toBe(true)
    expect(store.units.length).toBe(before + 2)
    // 13.6：整条到达已投放完毕 ⇒ 不能再来一次
    expect(store.placeArrivalNow(index)).toBe(false)
  })

  it('轴心 `2x Corps HQ (9, 12)` 只放一枚（两枚不同军部由裁判各投一次……本条只投一枚）', () => {
    const store = newStore()
    store.setActiveSide('axis')
    const { turn, index, demand } = findDemand(store, '2x Corps HQ')
    store.setTurn(turn)
    store.setPhase('reinforcement')
    goToActionStep(store, 'rein.arrival')
    // 指定其中一枚（9th Corps HQ），本条只应落一枚
    const before = store.units.length
    expect(store.placeArrivalNow(index, 'ax-hq-ge-hq-9th-corps')).toBe(true)
    expect(store.units.length).toBe(before + 1)
    expect(demand.count).toBe(2)
  })
})

describe('13.6：飞机到达（修前共用陆战库解析 ⇒ 一律投放失败）', () => {
  it('有友方空军基地时 `2x He.111` 投放为 2 架飞机（且不混进地面算子）', () => {
    const store = newStore()
    store.setActiveSide('axis')
    placeGround(store, airBaseRecord(2), CORE_HEX, 'axis', 'base-1')
    const { turn, index, demand } = findDemand(store, '2x He.111')
    expect(demand.kind).toBe('aircraft')
    store.setTurn(turn)
    store.setPhase('reinforcement')
    goToActionStep(store, 'rein.arrival')

    const groundBefore = store.units.length
    const airBefore = store.airUnits.length
    expect(store.placeArrivalNow(index)).toBe(true)
    expect(store.airUnits.length).toBe(airBefore + 2)
    // 飞机不进地面算子表（修前那条分支会先 push 一枚"地面单位"再 push 飞机）
    expect(store.units.length).toBe(groundBefore)
    expect(store.airUnits.at(-1)?.airStatus).toBe('active')
    expect(store.reinforcementError).toBeNull()
  })
})
