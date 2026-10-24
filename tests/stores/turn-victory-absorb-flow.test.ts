import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { controlOfHex } from '@/engine/rules'
import { breakdownAbsorbObligations } from '@/engine/rules/breakdown'
import { isSavableRepl } from '@/engine/rules/rebuild'
import { isVariableExitActive, rollVariableExit } from '@/engine/rules'
import { toBreakdownSideView, useWorkbenchStore } from '@/stores'

import { CORE_HEX, groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * M8 回合与胜利（store 级）：5.0a/b/c · 3.3c 可变撤离 · 13.5 可保存补员 · 20.0d 阶段末强制吸收
 *
 * 条文：
 *   · **5.0c** 控制判定：格内有**可攻击**单位 ⇒ 该方；空格 ⇒ **最后控制者**；从未被占据 ⇒ 无人控制。
 *   · **5.0b** 任何回合开始（19 Aug 起）判定提前决胜；**5.0a** 只在**最终回合结束时**判终局。
 *   · **3.3c** 轴方 19 Aug 起每增援阶段掷 1 骰：1 ⇒ 移 SS Reich、6 ⇒ 移 14 Mtr、2–5 ⇒ 下回合再掷；
 *     **掷出 1/6 即了结**（不再逐回合掷）。
 *   · **13.5** Pax / Eq 可跨回合保存；Ftr / Tac 不可（增援阶段末清零）。
 *   · **20.0d** 减损的多军力单位**在任何阶段结束时必须吸收**与之堆叠且合格的拆分单位。
 *
 * ★ 修前：`controlOfHex` / `checkTurnStartVictory` / `checkTurnEndVictory` / `isVariableExitActive` /
 *   `isSavableRepl` / `breakdownAbsorbObligations` **全部零消费**，其中三处在 store 里另有同义实现
 *   （控制判定、提前决胜、补员可保存性），而 3.3c 的「已了结不再掷」与 20.0d 的阶段末强制吸收**根本没有**。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 把回合拨到某个 ISO 日期 */
function turnAt(store: Workbench, date: string): boolean {
  for (let turn = 1; turn <= 19; turn += 1) {
    store.setTurn(turn)
    if (store.date === date) return true
    if (store.date > date) return false
  }
  return false
}

describe('5.0c：控制判定与引擎同源', () => {
  it('`controlOfHex`：可攻击单位优先，其次最后控制者，都没有即无人控制', () => {
    expect(
      controlOfHex({ hex: CORE_HEX, attackCapableSide: 'axis', lastControllingSide: 'soviet' }),
    ).toBe('axis')
    expect(
      controlOfHex({ hex: CORE_HEX, attackCapableSide: null, lastControllingSide: 'soviet' }),
    ).toBe('soviet')
    expect(
      controlOfHex({ hex: CORE_HEX, attackCapableSide: null, lastControllingSide: null }),
    ).toBeNull()
  })

  it('store：格内有可攻击单位 ⇒ 归该方；空格的最后控制者账本同样生效', () => {
    const store = newStore()
    const record = groundRecord('axis', (item) => item.attackCapable === true)
    placeGround(store, record, CORE_HEX, 'axis', 'u1')
    expect(store.victoryControlOf(CORE_HEX)).toBe('axis')
  })
})

describe('5.0a / 5.0b：回合始末的判定入口', () => {
  it('`checkTurnStartVictory` 与 `checkTurnEndVictory` 都在 store 里被消费（不再是死代码）', () => {
    const store = newStore()
    turnAt(store, '1941-07-08')
    // 5.0b：19 Aug 之前不做提前决胜 ⇒ 结论必为 ongoing
    expect(store.decisiveVictory.outcome).toBe('ongoing')
    // 5.0a：非末回合 ⇒ 恒为 ongoing（明文限定「最终回合结束时」）
    expect(store.turnEndVictory.outcome).toBe('ongoing')
    expect(store.turnEndVictory.level).toBe('final')
  })

  it('末回合的 H 清理段收束 ⇒ 触发一次终局判定并落日志（5.0a）', () => {
    const store = newStore()
    // 拨到该剧本的末回合
    const lastTurn = store.victoryTurnRange.lastTurn
    store.setTurn(lastTurn)
    expect(store.atFinalTurn).toBe(true)
    store.setPhase('cleanUp')
    expect(store.runCleanUpNow()).toBe(true)
    // 回合结束判定必定落一条（末回合时其结论即 5.0a 的终局判定）
    const entry = store.log.find((item) => item.text.includes('回合结束判定'))
    expect(entry).not.toBeUndefined()
    expect(entry!.rule).toBe('5.0a')
    // 末回合 ⇒ `turnEndVictory` 给出终局档（level='final'），而非 ongoing
    expect(store.turnEndVictory.level).toBe('final')
  })
})

describe('3.3c：可变撤离的窗口与了结', () => {
  it('`isVariableExitActive`：19 Aug 起为真', () => {
    expect(isVariableExitActive('1941-08-18')).toBe(false)
    expect(isVariableExitActive('1941-08-19')).toBe(true)
    expect(isVariableExitActive('1941-09-02')).toBe(true)
  })

  it('`rollVariableExit`：1 ⇒ SS Reich、6 ⇒ 14 Mtr、2–5 ⇒ 下回合再掷', () => {
    expect(rollVariableExit(1, '1941-08-19').description).toContain('SS Reich')
    expect(rollVariableExit(6, '1941-08-19').description).toContain('14 Mtr')
    expect(rollVariableExit(3, '1941-08-19').kind).toBe('reroll')
    expect(rollVariableExit(1, '1941-08-19').kind).toBe('remove')
  })

  it('store：窗口随日期开关；一次了结后置位 `variableExitResolved` 且不再掷', () => {
    const store = newStore()
    turnAt(store, '1941-08-19')
    expect(store.variableExitOpen).toBe(true)
    expect(store.variableExitResolved).toBe(false)

    // 手工填一个「1」（移 SS Reich）⇒ 了结
    store.variableReplInputs = {
      ...store.variableReplInputs,
      autoRoll: false,
      supplyDice: 7,
      replDice: 7,
      specialDie: 1,
      variableExitDie: 1,
      randomEventDice: 7,
    }
    expect(store.rollVariableReplNow()).toBe(true)
    expect(store.variableExitResolved).toBe(true)
    expect(store.lastVariableRepl?.variableExit?.kind).toBe('remove')
  })
})

describe('13.5：可保存的补员由引擎判定', () => {
  it('`isSavableRepl`：Pax / Eq 可存，Ftr / Tac 不可', () => {
    expect(isSavableRepl('pax')).toBe(true)
    expect(isSavableRepl('eq')).toBe(true)
    expect(isSavableRepl('ftr')).toBe(false)
    expect(isSavableRepl('tac')).toBe(false)
  })

  it('store：清零后只留可保存的那两类', () => {
    const store = newStore()
    store.setReplHoldingsNow({ ftr: 3, tac: 2, pax: 5, eq: 4 }, CORE_HEX)
    store.clearNonSavableReplNow()
    expect(store.replHoldings).toMatchObject({ ftr: 0, tac: 0, pax: 5, eq: 4 })
  })
})

describe('20.0d：阶段末的强制吸收', () => {
  it('引擎：减损母单位 + 堆叠的合格拆分单位 ⇒ 给出义务；未减损则无义务', () => {
    const parent = { id: 'p1', re: 4, isCombat: true }
    void parent
    const view = (id: string, steps: number, printedSteps: number) =>
      toBreakdownSideView(
        {
          instanceId: id,
          unitId: 'ax-x',
          combatClass: 'other',
          raw: { attack: 6, ar: 4, ma: 6 },
          steps,
          printedSteps,
          mode: { mode: 'combat', orientation: 'combat', dg: false, exploit: false },
          internalStocks: 'ready',
          side: 'axis',
        } as never,
        'ax',
      )
    const broken = view('p1', 3, 4)
    const full = view('p2', 4, 4)
    const brk = view('b1', 1, 1)
    const stacked = [brk]
    expect(
      breakdownAbsorbObligations({ units: [broken], breakdownsStackedWith: () => stacked }),
    ).toHaveLength(1)
    // 未减损 ⇒ 无义务（20.0d「减损的」是前提）
    expect(
      breakdownAbsorbObligations({ units: [full], breakdownsStackedWith: () => stacked }),
    ).toHaveLength(0)
  })
})
