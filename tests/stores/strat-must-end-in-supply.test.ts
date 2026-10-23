import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createTraceSupplyAt, mustEndMoveInSupply } from '@/engine/rules'
import { buildMoveContext, toConsoleUnit, unitChoices } from '@/stores'
import { CORE_HEX, NEAR_HEX, newConsole } from '../flows/sop-harness'

/**
 * 5.8b：**战略模式单位必须停在有追溯补给的格**
 *
 * 条文：「战略模式下的单位……**必须在当前拥有追溯补给的格内结束它的移动**。」（5.8b）
 *
 * ★ 修前：判据写在 `move.ts`，但写成
 *   `if (mustEndMoveInSupply(state) && context.traceSupplyAt !== undefined)`
 *   而 `buildMoveContext` **不注入** `traceSupplyAt`、全仓也没有第二处构造 `MoveContext`
 *   ⇒ 那个分支**永远进不去** ⇒ 战略模式单位可以随便停在断补格（规则空转，判据恒假）。
 *
 * 本文件钉三件事：① 引擎的合同（战略 ⇒ 须在有补给处结束）；② 注入确实接上了
 * （与 12.6 同源）；③ 源码守门 —— 把注入删掉即变红。
 */

const readSource = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('5.8b：引擎合同（唯一判据来源）', () => {
  it('战略模式 ⇒ 须在有追溯补给处结束移动；战斗 / 移动模式 ⇒ 不看这一条', () => {
    const base = { orientation: 'move' as const, dg: false, exploit: false }
    expect(mustEndMoveInSupply({ ...base, mode: 'strat' })).toBe(true)
    expect(mustEndMoveInSupply({ ...base, mode: 'move' })).toBe(false)
    expect(mustEndMoveInSupply({ ...base, mode: 'combat' })).toBe(false)
    expect(mustEndMoveInSupply({ ...base, mode: 'reserve' })).toBe(false)
  })
})

describe('5.8b：移动上下文必须注入 traceSupplyAt（与 12.6 同源）', () => {
  it('store 构造的上下文带 traceSupplyAt，且与 12.6 的逐格判定同源', () => {
    const store = newConsole()
    const context = store.moveContext
    expect(typeof context.traceSupplyAt).toBe('function')
    const sameSource = createTraceSupplyAt(store.supplyFacts)
    for (const hex of [CORE_HEX, NEAR_HEX])
      expect(context.traceSupplyAt?.(hex, 'axis')).toBe(sameSource(hex, 'axis'))
  })

  it('对照：不注入时字段不在场 —— 引擎的 `!== undefined` 守卫会整条跳过', () => {
    const unit = toConsoleUnit({
      record: unitChoices('axis')[0]!,
      instanceId: 'u1',
      hex: CORE_HEX,
      side: 'axis',
      face: 'move',
    })
    const bare = buildMoveContext({ units: [unit], activeSide: 'axis', phase: 'movement' })
    expect(bare.traceSupplyAt).toBeUndefined()
    const injected = buildMoveContext({
      units: [unit],
      activeSide: 'axis',
      phase: 'movement',
      traceSupplyAt: () => false,
    })
    expect(typeof injected.traceSupplyAt).toBe('function')
  })

  it('源码守门：`buildMoveContext` 透传该字段，操作台也确实注入（删掉即红）', () => {
    const model = stripComments(readSource('src/stores/workbench-model.ts'))
    expect(model).toContain('traceSupplyAt?: (hex: HexRef, side: Side) => boolean')
    expect(model).toMatch(/traceSupplyAt:\s*input\.traceSupplyAt/)

    const store = stripComments(readSource('src/stores/workbench.ts'))
    expect(store).toMatch(/traceSupplyAt:\s*\(hex, side\)\s*=>/)
    // 注入的事实必须来自 12.6 的同一份（`createTraceSupplyAt(supplyFacts)`）
    expect(store).toContain('createTraceSupplyAt(supplyFacts.value)')
  })
})
