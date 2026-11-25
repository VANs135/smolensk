import { describe, expect, it } from 'vitest'

import { unitChoices } from '@/stores'

import { CORE_HEX, newConsole, placeGround } from '../flows/sop-harness'

/**
 * 5.8b：`moveContext` 只在盘上真有战略模式单位时才注入 `traceSupplyAt`。
 *
 * 这是一条性能契约：`traceSupplyAtForMove.value` 会立即构建 `supplyFacts`
 * （全军追溯补给 + 两侧铁路 BFS）。没有战略单位时引擎不会调用这个函数，
 * 但无条件注入仍会让每次换格白付一份补给事实 ⇒ 单步多出数十毫秒。
 *
 * 同时钉住规则面：一旦有战略单位，注入必须恢复，5.8b「战略模式须停在有补给格」不能失效。
 */
const RECORD = unitChoices('axis').find((record) => record.isCombat === true)!

describe('5.8b：moveContext 的 traceSupplyAt 注入条件', () => {
  it('无战略单位 ⇒ 不注入（普通移动不白算 supplyFacts）', () => {
    const store = newConsole()
    placeGround(store, RECORD, CORE_HEX, 'axis', 'm-1')
    store.setPhase('movement')
    expect(store.moveContext.traceSupplyAt).toBeUndefined()
  })

  it('有战略单位 ⇒ 仍注入（5.8b 判据不丢）', () => {
    const store = newConsole()
    placeGround(store, RECORD, CORE_HEX, 'axis', 'm-1')
    store.setPhase('movement')
    const live = store.units.find((unit) => unit.instanceId === 'm-1')!
    live.mode.mode = 'strat'
    expect(store.moveContext.traceSupplyAt).toBeTypeOf('function')
  })
})
