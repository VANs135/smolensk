import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { aircraftChoices, toConsoleAirUnit, useWorkbenchStore } from '@/stores'

/**
 * 专规 3.6：随机事件的**机型结果**必须让该型飞机立即全部非激活
 *
 * ## 原文
 *   - 3.6：「19 July 至 15 August（含）每个 Axis Reinforcement Phase 掷一次。」
 *   - 表 3-3：`2-3 Bf.110` / `4 He.111` / `5-9 Supply Train` / `10 Ju.52` / `11-12 Ju.88`
 *   - 事件页注：「all air units of the listed type immediately become Inactive
 *     (assigned off-map missions this turn)」
 *
 * ## 病灶（修前）
 *   引擎 `planRandomEvent` 返回的 `aircraftType` 是**表 3-3 的机型名**（`Bf.110`），
 *   而接线处拿它去比 `ConsoleAirUnit.aircraftType`——后者是 14.1 的**机型代号**
 *   （`F` / `T` / `comb` / `Tpt`）⇒ 永远不相等，掷出机型事件后**没有任何飞机转非激活**。
 *   引擎用例只断言了「结果对象里写着 Bf.110」，故漏掉了这一层。
 *
 * ## 测法边界
 *   - 摆真机（`aircraft.json` 的 `Ge Bf.110` / `Ge Bf.109e` / `Ge He.111`），钉住"按机型名命中"；
 *   - 只测 store 落账与日志，不测界面（仓库无组件渲染测试）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const AT: HexRef = { col: 1, row: 1 }

function placeActive(
  store: ReturnType<typeof newStore>,
  model: string,
  instanceId: string,
): string {
  const record = aircraftChoices('axis').find((item) => item.name === model)
  if (record === undefined) throw new Error(`轴方飞机库里没有 ${model}`)
  store.airUnits.push(
    toConsoleAirUnit({
      aircraft: record,
      instanceId,
      hex: AT,
      side: 'axis',
      airStatus: 'active',
    }),
  )
  return instanceId
}

function statusOf(store: ReturnType<typeof newStore>, instanceId: string): string | undefined {
  return store.airUnits.find((air) => air.instanceId === instanceId)?.airStatus
}

/** 进到 19 Jul（turn 4）并按给定 2d6 掷可变增援（其余骰面固定，不影响机型事件） */
function rollAt19Jul(store: ReturnType<typeof newStore>, eventDice: number): void {
  store.setScenarioId('1')
  store.setActiveSide('axis')
  store.setTurn(4)
  expect(store.date).toBe('1941-07-19')
  store.variableReplInputs.autoRoll = false
  store.variableReplInputs.supplyDice = 8
  store.variableReplInputs.replDice = 7
  store.variableReplInputs.specialDie = 1
  store.variableReplInputs.randomEventDice = eventDice
  expect(store.rollVariableReplNow()).toBe(true)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('专规 3.6：机型结果 ⇒ 该型飞机全部非激活', () => {
  it('★ 2-3 ⇒ Bf.110：同型两架转非激活，其它机型不受影响', () => {
    const store = newStore()
    placeActive(store, 'Ge Bf.110', 'bf110-a')
    placeActive(store, 'Ge Bf.110', 'bf110-b')
    placeActive(store, 'Ge Bf.109e', 'bf109')

    rollAt19Jul(store, 2)

    expect(store.lastVariableRepl?.randomEvent).toMatchObject({
      kind: 'aircraft',
      aircraftType: 'Bf.110',
    })
    expect(statusOf(store, 'bf110-a')).toBe('inactive')
    expect(statusOf(store, 'bf110-b')).toBe('inactive')
    expect(statusOf(store, 'bf109')).toBe('active')
    expect(store.log.some((entry) => (entry.text ?? '').includes('Bf.110 ×2 立即转非激活'))).toBe(
      true,
    )
  })

  it('★ 4 ⇒ He.111：只动 He.111，Ju.52 与 Bf.109 保持激活', () => {
    const store = newStore()
    placeActive(store, 'Ge He.111', 'he111')
    placeActive(store, 'Ge Ju.52', 'ju52')
    placeActive(store, 'Ge Bf.109f', 'bf109f')

    rollAt19Jul(store, 4)

    expect(store.lastVariableRepl?.randomEvent).toMatchObject({
      kind: 'aircraft',
      aircraftType: 'He.111',
    })
    expect(statusOf(store, 'he111')).toBe('inactive')
    expect(statusOf(store, 'ju52')).toBe('active')
    expect(statusOf(store, 'bf109f')).toBe('active')
  })

  it('5-9 ⇒ Supply Train：不是机型事件，任何飞机状态不变', () => {
    const store = newStore()
    placeActive(store, 'Ge Bf.110', 'bf110')
    placeActive(store, 'Ge He.111', 'he111')

    rollAt19Jul(store, 7)

    expect(store.lastVariableRepl?.randomEvent?.kind).toBe('supplyTrain')
    expect(statusOf(store, 'bf110')).toBe('active')
    expect(statusOf(store, 'he111')).toBe('active')
  })

  it('事件期外（15 Jul）不掷、不改飞机状态', () => {
    const store = newStore()
    placeActive(store, 'Ge Bf.110', 'bf110')
    store.setScenarioId('1')
    store.setActiveSide('axis')
    store.setTurn(3)
    expect(store.date).toBe('1941-07-15')
    store.variableReplInputs.autoRoll = false
    store.variableReplInputs.supplyDice = 8
    store.variableReplInputs.replDice = 7
    store.variableReplInputs.specialDie = 1
    store.variableReplInputs.randomEventDice = 2
    expect(store.rollVariableReplNow()).toBe(true)

    expect(store.lastVariableRepl?.randomEvent).toBe(null)
    expect(statusOf(store, 'bf110')).toBe('active')
  })
})
