import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { emptyReplHoldings } from '@/engine/rules'
import { isReplUnit, replRecordOf } from '@/stores'
import { useWorkbenchStore } from '@/stores'
import { actionGateOf, type ActionKey, type ConsolePhase } from '@/stores'

import { CORE_HEX, groundRecord, newConsole, placeGround } from '../flows/sop-harness'

/**
 * §5-D（用户 2026-10-25 十条裁定）：**补员算子盘面化**
 *
 * 裁定逐条落到代码：
 * ① 每 1 点 = 1 枚（`Pax Repl` / `EQ Repl`，规则字面）；
 * ② 归属＝掷骰获得方（轴/苏各两条记录，`replRecordOf` 按方取）；
 * ③ 正常移动（与普通算子同链，耗 MP/燃料）；
 * ④ 被歼灭/轰炸摧毁 ⇒ **直接消灭移除，不进死亡堆**；
 * ⑤ 断补/缺油的补员仍可用于重建（重建判据只看格/HQ 范围/ZOC，不看补员自身补给燃料）；
 * ⑥ Ftr / Tac 按专规 1.6 走账本（只补 1 step、不可保存、不做盘面算子）；
 * ⑦ 掷出后按 SOP「放置在地图上」——落点由裁判选格（无入场格规定）；
 * ⑧ 恒为移动模式（13.5「补员永远无法进入战斗模式」）；
 * ⑨ 盘面为唯一事实（`replHoldings` 是投影；存档见 `save-slot`）；
 * ⑩ 补员给单位补员后即被移除；都在一个格子 ⇒ 被补员单位须与补员堆叠在一起（13.5a）。
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

/** 本组用例的补员/重建落点（harness 的 CORE_HEX 即"六邻皆图内"的格） */
const REPL_HEX = CORE_HEX

/** 轴心步兵师记录（重建表 `Infantry Div step` = 2x Pax） */
const infDivRecord = () =>
  groundRecord('axis', (item) => item.branch === 'infantry' && item.echelon === 'div')

describe('§5-D：补员算子的数据与创建', () => {
  it('每方各有一条 Pax / EQ 记录；每 1 点摆 1 枚', () => {
    for (const side of ['axis', 'soviet'] as const) {
      expect(replRecordOf(side, 'pax')?.vassalName).toBe(
        `${side === 'axis' ? 'Ge' : 'Ru'} Pax Repl`,
      )
      expect(replRecordOf(side, 'eq')?.vassalName).toBe(`${side === 'axis' ? 'Ge' : 'Ru'} EQ Repl`)
    }
    const store = newStore()
    store.setActiveSide('axis')
    store.setReplHoldingsNow({ ...emptyReplHoldings(), pax: 5, eq: 2 }, CORE_HEX)
    const repls = store.units.filter((unit) => isReplUnit(unit))
    expect(repls).toHaveLength(7)
    expect(repls.filter((unit) => unit.replKind === 'pax')).toHaveLength(5)
    expect(repls.filter((unit) => unit.replKind === 'eq')).toHaveLength(2)
    // ⑧ 恒为移动模式（13.5）
    expect(repls.every((unit) => unit.mode.mode === 'move')).toBe(true)
    // 归属＝当前方（②）
    expect(repls.every((unit) => unit.side === 'axis')).toBe(true)
    // 都在同一格（⑩ 的结构保证）
    expect(
      repls.every((unit) => unit.hex.col === CORE_HEX.col && unit.hex.row === CORE_HEX.row),
    ).toBe(true)
  })

  it('`replHoldings` 是投影：盘面加一枚，投影立即 +1', () => {
    const store = newStore()
    store.setActiveSide('axis')
    expect(store.replHoldings).toMatchObject({ pax: 0, eq: 0 })
    store.setReplHoldingsNow({ ...emptyReplHoldings(), pax: 3 }, CORE_HEX)
    expect(store.replHoldings.pax).toBe(3)
  })
})

describe('§5-D：重建吃"同一格内"的补员，吃完即移除', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /** 建一盘：HQ + 带损步兵师 + 4 Pax 补员，全在 DEFENDER_HEX */
  function setup(store: ReturnType<typeof newStore>, pax = 4) {
    store.setTurn(2)
    store.setPhase('reinforcement')
    goToActionStep(store, 'rein.rebuild')
    placeGround(
      store,
      groundRecord('axis', (item) => item.specialized?.includes('hq') === true),
      REPL_HEX,
      'axis',
      'hq-1',
    )
    const unit = placeGround(store, infDivRecord(), REPL_HEX, 'axis', 'u1')
    unit.steps = unit.printedSteps - 1
    store.setReplHoldingsNow({ ...emptyReplHoldings(), pax }, REPL_HEX)
    return unit
  }

  it('13.5a：2 Pax 补满一枚步兵师，且这 2 枚补员被移除', () => {
    const store = newStore()
    store.setActiveSide('axis')
    const unit = setup(store, 4)
    const before = store.units.filter((item) => isReplUnit(item)).length

    expect(
      store.rebuildUnitNow({
        unitId: 'u1',
        rebuildType: 'Infantry Div step',
        replHexText: `${REPL_HEX.col}.${REPL_HEX.row}`,
      }),
    ).toBe(true)
    expect(unit.steps).toBe(unit.printedSteps)
    // ⑩：被消耗的 2 枚 Pax 离开盘面
    expect(store.units.filter((item) => isReplUnit(item)).length).toBe(before - 2)
    expect(store.replHoldings.pax).toBe(2)
  })

  it('13.5a：补员不够 ⇒ 拒（按**这一格**的枚数判，不是全盘合计）', () => {
    const store = newStore()
    store.setActiveSide('axis')
    setup(store, 1)
    expect(
      store.rebuildUnitNow({
        unitId: 'u1',
        rebuildType: 'Infantry Div step',
        replHexText: `${REPL_HEX.col}.${REPL_HEX.row}`,
      }),
    ).toBe(false)
    expect(store.reinforcementError).toMatchObject({ rule: '13.5' })
    // 被拒 ⇒ 一枚都没少
    expect(store.replHoldings.pax).toBe(1)
  })

  it('13.5a：补员在**别的格** ⇒ 判不出"都在一个格中"⇒ 拒', () => {
    const store = newStore()
    store.setActiveSide('axis')
    const unit = setup(store, 4)
    // 把 4 枚 Pax 挪到另一格（模拟"分开放在两地"）
    const other = { col: REPL_HEX.col + 3, row: REPL_HEX.row }
    for (const item of store.units.filter((one) => isReplUnit(one))) item.hex = { ...other }
    expect(
      store.rebuildUnitNow({
        unitId: 'u1',
        rebuildType: 'Infantry Div step',
        replHexText: `${REPL_HEX.col}.${REPL_HEX.row}`,
      }),
    ).toBe(false)
    expect(store.reinforcementError).toMatchObject({ rule: '13.5' })
    expect(unit.steps).toBe(unit.printedSteps - 1)
  })

  it('13.5a：被补员单位不与补员同格 ⇒ 拒（堆叠判据）', () => {
    const store = newStore()
    store.setActiveSide('axis')
    setup(store, 4)
    const apart = { col: REPL_HEX.col + 1, row: REPL_HEX.row + 1 }
    const unit = store.units.find((item) => item.instanceId === 'u1')!
    unit.hex = { ...apart }
    expect(
      store.rebuildUnitNow({
        unitId: 'u1',
        rebuildType: 'Infantry Div step',
        replHexText: `${REPL_HEX.col}.${REPL_HEX.row}`,
      }),
    ).toBe(false)
    expect(store.reinforcementError).toMatchObject({ rule: '13.5a' })
  })

  it('⑤：补员自身断补/缺油，**仍可用于重建**（判据只看格/HQ 范围/ZOC）', () => {
    const store = newStore()
    store.setActiveSide('axis')
    const unit = setup(store, 4)
    for (const item of store.units.filter((one) => isReplUnit(one))) {
      item.hasTraceSupply = false
      item.fuelled = false
    }
    expect(
      store.rebuildUnitNow({
        unitId: 'u1',
        rebuildType: 'Infantry Div step',
        replHexText: `${REPL_HEX.col}.${REPL_HEX.row}`,
      }),
    ).toBe(true)
    expect(unit.steps).toBe(unit.printedSteps)
  })
})

describe('§5-D：消灭、模式与移动', () => {
  it('④：补员算子被摧毁 ⇒ 直接消灭移除，**不进死亡堆**', () => {
    const store = newStore()
    store.setActiveSide('axis')
    store.setReplHoldingsNow({ ...emptyReplHoldings(), pax: 2 }, CORE_HEX)
    const repl = store.units.find((item) => isReplUnit(item))!
    store.eliminateEntry(repl, '9.11', `${repl.name} 被歼灭`)
    expect(store.units.some((item) => item.instanceId === repl.instanceId)).toBe(false)
    expect(store.deadPile.some((item) => item.instanceId === repl.instanceId)).toBe(false)
    expect(store.replHoldings.pax).toBe(1)
  })

  it('⑧：补员不能切到战斗模式；可以切回移动模式', () => {
    const store = newConsole()
    store.setActiveSide('axis')
    store.setReplHoldingsNow({ ...emptyReplHoldings(), pax: 1 }, CORE_HEX)
    const repl = store.units.find((item) => isReplUnit(item))!
    store.selectedId = repl.instanceId
    store.switchUnitMode('combat')
    expect(store.units.find((item) => item.instanceId === repl.instanceId)!.mode.mode).toBe('move')
    store.switchUnitMode('move')
    expect(store.units.find((item) => item.instanceId === repl.instanceId)!.mode.mode).toBe('move')
  })

  it('③：补员算子走正常移动链（与普通算子同一套开拔/耗 MP）', () => {
    const store = newConsole()
    store.setActiveSide('axis')
    store.setReplHoldingsNow({ ...emptyReplHoldings(), pax: 1 }, CORE_HEX)
    const repl = store.units.find((item) => isReplUnit(item))!
    store.selectedId = repl.instanceId
    // 补员是普通地面算子 ⇒ 能进移动交互（不被 participatesIn 之类滤掉）
    expect(store.beginMoveFor([repl.instanceId])).toBe(true)
    expect(store.moveInteraction).not.toBeNull()
  })
})
