import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useContainersStore, useWorkbenchStore } from '@/stores'
import type { VariableReinforcementPlan } from '@/engine/rules/variable-repl'

/**
 * 用户实测（2026-11-15）：轴方抽到「补给列车 2 SP」卡，点了没反应、放不到图上。
 *
 * 断点：卡片能渲染成可点（`rollHandEntries` 里 `blocked: null`），但全局闸门
 * `rollPlacementOpen` 仍为假（1.6c 还没掷）⇒ `beginRollHandEntryNow('sp:train')`
 * 走进 `beginSupplyTrainHexPickNow` 的第一个闸就 only-log 返回，地图不进选格态。
 *
 * 口径：不可用项不出现。判定没走完时，手牌 / 结束本段都不该渲染成可点；
 * 窗口只留「掷骰检定」这一个动作与一句当前挡因。
 */

/** 只造「随机事件=补给列车」这一项；其余骰面不是本用例关心的事 */
function trainPlan(): VariableReinforcementPlan {
  return {
    rule: '1.6b',
    sp: 0,
    repl: { ftr: 0, tac: 0, pax: 0, eq: 0, rowLabel: 'Early' },
    special: null,
    variableExit: null,
    randomEvent: {
      roll: 6,
      kind: 'supplyTrain',
      sp: 2,
      detail: '2 骰 6 ⇒ Supply Train（5-9）',
    },
    detail: '1.6b',
  }
}

function armedStore() {
  setActivePinia(createPinia())
  const store = useWorkbenchStore()
  store.setPhase('reinforcement')
  store.setTurn(2)
  const at = store.playerSegmentSteps.findIndex((step) => step.id === 'reinforcement.replRoll')
  expect(at).toBeGreaterThanOrEqual(0)
  expect(store.setSegmentStepIndex(at)).toBe(true)
  // 1.6b 真掷一次（把 `variableReplRolled` 的凭据落上），再把结果换成「随机事件=补给列车」
  store.variableReplInputs.autoRoll = true
  expect(store.rollVariableReplNow()).toBe(true)
  store.lastVariableRepl = trainPlan()
  return store
}

describe('补给列车卡：判定未走完时不能是「点了没反应」的假入口', () => {
  it('复现：卡片在 rollHandEntries 里可点，但全局闸门仍关着，点击只落空', () => {
    const store = armedStore()
    expect(store.supplyTrainPending).toBe(true)
    expect(store.hasSpecialReplDraw(store.activeSide, store.turn)).toBe(false)
    expect(store.rollPlacementOpen).toBe(false)
    // 不计全局闸、只看卡自身挡因 ⇒ `blocked` 为空，修前因此被渲染成可点卡
    expect(store.rollHandEntries.find((entry) => entry.id === 'sp:train')?.blocked).toBeNull()
    expect(store.beginRollHandEntryNow('sp:train')).toBe(false)
    expect(store.hexPickView).toBeNull()
  })

  it('1.6c 掷完后：同一张卡进选格、落到合法格、标记与账本对上', () => {
    const store = armedStore()
    expect(
      useContainersStore().drawSpecialRepl(store.activeSide, store.variableReplSpecialDie ?? 3),
    ).toBe(true)
    expect(store.rollPlacementOpen).toBe(true)
    expect(store.beginRollHandEntryNow('sp:train')).toBe(true)
    const candidates = store.hexPickView?.candidates
    expect(Array.isArray(candidates)).toBe(true)
    const hex = (candidates as { col: number; row: number }[])[0]!
    expect(store.supplyTrainPlacementHexes.length).toBeGreaterThan(0)
    const before = store.allSpDumps
      .filter(
        (dump) => dump.side === 'axis' && dump.hex.col === hex.col && dump.hex.row === hex.row,
      )
      .reduce((sum, dump) => sum + dump.sp, 0)
    expect(store.pickHexFor(hex)).toBe(true)
    expect(store.supplyTrainPending).toBe(false)
    const after = store.allSpDumps
      .filter(
        (dump) => dump.side === 'axis' && dump.hex.col === hex.col && dump.hex.row === hex.row,
      )
      .reduce((sum, dump) => sum + dump.sp, 0)
    expect(after - before).toBe(2)
  })
})

describe('面板：手牌与「结束本段」都在同一个全局闸门内', () => {
  const panel = readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')

  it('手牌阵列 / 结束本段受 `rollPlacementOpen` 把门，判定未完成时只留检定与挡因', () => {
    const gate = panel.indexOf('v-if="workbench.rollPlacementOpen"')
    expect(gate).toBeGreaterThan(-1)
    const cards = panel.indexOf('data-testid="roll-hand-cards"')
    const end = panel.indexOf('data-testid="roll-end-step"')
    expect(cards).toBeGreaterThan(gate)
    expect(end).toBeGreaterThan(cards)
    // 闸门之外仍有挡因行（不是静默隐藏）
    expect(panel).toContain('data-testid="roll-hand-gate"')
  })
})
