import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { unitsAxis } from '@/data'
import { VARIABLE_EXIT_START } from '@/engine/rules'
import {
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'
import { createMemoryStorage } from '@/shared'
import { CORE_HEX, NEAR_HEX, placeGround } from '../flows/sop-harness'

/**
 * 专规 3.3c 可变撤离的 **store 端到端**（真实 Table + 真实单位库）
 *
 * 用户 2026-11-05 裁定⑦「按原文来」，实现依据 1.6a：
 * - 目标编队**在场**（盘面或死亡堆）⇒ 直接整队移出游戏（1.6a：「even if in the dead pile」）；
 * - 盘面与死亡堆**都没有**该编队算子 ⇒ 玩家从**同印值**（战斗面 attack/AR/MA）算子中挑一枚顶替；
 * - `2–5` 是"下回合再掷"，**不是**已了结（修前错置 `resolved`，与「until … is Removed」相反）；
 * - 待选状态从 `session.log` 反推 ⇒ 存档往返后选择态不丢（不新增存档字段）。
 */

function newStore() {
  setActivePinia(createPinia())
  const workbench = useWorkbenchStore()
  const game = useGameSessionStore()
  game.setSaveStorage(createMemoryStorage())
  if (!game.startGame()) throw new Error('开局被拒')
  workbench.setActiveSide('axis')
  workbench.setPhase('reinforcement')
  rollToLateTurn(workbench)
  return { workbench, game }
}

/** 推进到 3.3c 窗口已开的回合（19 Aug 及以后） */
function rollToLateTurn(store: ReturnType<typeof useWorkbenchStore>): void {
  for (let turn = 1; turn <= 19; turn += 1) {
    store.setTurn(turn)
    if (store.date >= VARIABLE_EXIT_START) return
  }
  throw new Error('回合轨里没有 19 Aug 之后的回合')
}

/** 掷一次可变增援，把可变撤离骰面钉成 `die` */
function rollVariableExit(store: ReturnType<typeof useWorkbenchStore>, die: number): void {
  store.variableReplInputs.autoRoll = false
  store.variableReplInputs.variableExitDie = die
  expect(store.rollVariableReplNow()).toBe(true)
}

function axisRecord(formation: string) {
  const record = unitChoices('axis').find((item) => item.formation === formation)
  if (record === undefined) throw new Error(`轴方单位库缺少编队 ${formation}`)
  return record
}

function combatKeyOf(record: ReturnType<typeof axisRecord>): string {
  const view = toConsoleUnit({
    record,
    instanceId: 'probe:factors',
    hex: CORE_HEX,
    side: 'axis',
  })
  return `${view.faces.combat.attack}|${view.faces.combat.ar}|${view.faces.combat.ma}`
}

/** 与 SS Reich 同印值的盘面候选（测试自选，保证候选集非空） */
function sameFactorsAxisRecord() {
  const reference = new Set(
    unitsAxis.units
      .filter((record) => record.formation === 'SS-R')
      .map((record) => combatKeyOf(record)),
  )
  const found = unitChoices('axis').find(
    (record) => record.formation !== 'SS-R' && reference.has(combatKeyOf(record)),
  )
  if (found === undefined) throw new Error('轴方单位库里没有与 SS Reich 同印值的算子')
  return found
}

/** 与 SS Reich 印值**不同**的盘面算子（用来证明"同格只列可选"） */
function differentFactorsAxisRecord() {
  const reference = new Set(
    unitsAxis.units
      .filter((record) => record.formation === 'SS-R')
      .map((record) => combatKeyOf(record)),
  )
  const found = unitChoices('axis').find(
    (record) => record.formation !== 'SS-R' && !reference.has(combatKeyOf(record)),
  )
  if (found === undefined) throw new Error('轴方单位库里找不到与 SS Reich 印值不同的算子')
  return found
}

describe('专规 3.3c：撤离真正落盘（不是"只标记"）', () => {
  it('编队在盘面 ⇒ 掷 1 直接整队移出游戏（1.6a）', () => {
    const { workbench, game } = newStore()
    placeGround(workbench, axisRecord('SS-R'), CORE_HEX, 'axis', 'ss-1')
    placeGround(workbench, axisRecord('SS-R'), NEAR_HEX, 'axis', 'ss-2')
    expect(workbench.units).toHaveLength(2)

    rollVariableExit(workbench, 1)

    expect(workbench.units).toHaveLength(0)
    expect(workbench.units.some((unit) => unit.formation === 'SS-R')).toBe(false)
    expect(workbench.variableExitResolved).toBe(true)
    expect(workbench.variableExitSelectionOpen).toBe(false)
    expect(game.log.some((entry) => entry.outcome.rule === '3.3c')).toBe(true)
  })

  it('编队只剩死亡堆 ⇒ 仍按 1.6a 直接移除（even if in the dead pile）', () => {
    const { workbench } = newStore()
    const dead: ConsoleUnit = toConsoleUnit({
      record: axisRecord('14MTR'),
      instanceId: 'mtr-dead',
      hex: CORE_HEX,
      side: 'axis',
    })
    workbench.deadPile.push(dead)
    expect(workbench.deadPile.some((unit) => unit.instanceId === 'mtr-dead')).toBe(true)

    rollVariableExit(workbench, 6)

    expect(workbench.deadPile.some((unit) => unit.instanceId === 'mtr-dead')).toBe(false)
    expect(workbench.variableExitResolved).toBe(true)
    expect(workbench.variableExitSelectionOpen).toBe(false)
  })

  it('盘面与死亡堆都没有 ⇒ 进入选择态，只列同印值可选算子', () => {
    const { workbench } = newStore()
    const eligible = sameFactorsAxisRecord()
    const other = differentFactorsAxisRecord()
    const eligibleUnit = placeGround(workbench, eligible, CORE_HEX, 'axis', 'sub-ok')
    placeGround(workbench, other, CORE_HEX, 'axis', 'sub-no')

    rollVariableExit(workbench, 1)

    expect(workbench.variableExitResolved).toBe(true)
    expect(workbench.variableExitSelectionOpen).toBe(true)
    const ids = workbench.variableExitPickItems.map((item) => item.id)
    expect(ids).toEqual([eligibleUnit.instanceId])
    expect(workbench.variableExitPickHexes).toEqual([{ col: CORE_HEX.col, row: CORE_HEX.row }])
    // 堆叠里不可选的那枚**根本不出现**（不是灰显）
    expect(ids).not.toContain('sub-no')
  })

  it('确认替补 ⇒ 该算子移出游戏、选择态结束、日志留 1.6a', () => {
    const { workbench, game } = newStore()
    const record = sameFactorsAxisRecord()
    placeGround(workbench, record, CORE_HEX, 'axis', 'sub-ok')
    rollVariableExit(workbench, 1)
    expect(workbench.confirmVariableExitSubstitute('sub-ok')).toBe(true)

    expect(workbench.units.some((unit) => unit.instanceId === 'sub-ok')).toBe(false)
    expect(workbench.variableExitSelectionOpen).toBe(false)
    expect(game.log.some((entry) => entry.outcome.rule === '1.6a')).toBe(true)
  })

  it('不在可选清单里的算子会被拒绝（1.6a 只允许同印值）', () => {
    const { workbench } = newStore()
    placeGround(workbench, sameFactorsAxisRecord(), CORE_HEX, 'axis', 'sub-ok')
    placeGround(workbench, differentFactorsAxisRecord(), CORE_HEX, 'axis', 'sub-no')
    rollVariableExit(workbench, 1)

    expect(workbench.confirmVariableExitSubstitute('sub-no')).toBe(false)
    expect(workbench.units.some((unit) => unit.instanceId === 'sub-no')).toBe(true)
    expect(workbench.variableExitSelectionOpen).toBe(true)
  })
})

describe('专规 3.3c：2–5 是"下回合再掷"，不是已了结', () => {
  it('掷 2 ⇒ resolved 保持 false，且下一回合仍能掷出并落盘', () => {
    const { workbench } = newStore()
    placeGround(workbench, axisRecord('SS-R'), CORE_HEX, 'axis', 'ss-1')
    const turn = workbench.turn

    rollVariableExit(workbench, 2)
    expect(workbench.variableExitResolved).toBe(false)
    expect(workbench.units).toHaveLength(1)

    workbench.setTurn(turn + 1)
    rollVariableExit(workbench, 1)
    expect(workbench.variableExitResolved).toBe(true)
    expect(workbench.units).toHaveLength(0)
  })
})

describe('专规 3.3c：待选态随存档往返（从 session.log 反推）', () => {
  it('存档 → 读档后选择态与可选清单都不丢', () => {
    const { workbench, game } = newStore()
    const record = sameFactorsAxisRecord()
    placeGround(workbench, record, CORE_HEX, 'axis', 'sub-ok')
    rollVariableExit(workbench, 1)
    const before = workbench.variableExitPickItems.map((item) => item.id)
    expect(before).toEqual(['sub-ok'])

    expect(game.saveNow()).toBe(true)
    expect(game.loadNow()).toBe(true)

    expect(workbench.variableExitSelectionOpen).toBe(true)
    expect(workbench.variableExitPickItems.map((item) => item.id)).toEqual(before)
  })
})
