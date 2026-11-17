import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { toConsoleUnit, useContainersStore, useWorkbenchStore } from '@/stores'
import type { VariableReinforcementPlan } from '@/engine/rules/variable-repl'
import { combatRecord } from '../flows/sop-harness'

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
    const railCapBefore = store.railCapUsedBy('axis')
    expect(store.pickHexFor(hex)).toBe(true)
    expect(store.supplyTrainPending).toBe(false)
    const after = store.allSpDumps
      .filter(
        (dump) => dump.side === 'axis' && dump.hex.col === hex.col && dump.hex.row === hex.row,
      )
      .reduce((sum, dump) => sum + dump.sp, 0)
    expect(after - before).toBe(2)
    // 3.6 原文「(no Rail Cap used)」：落 2 SP 不扣铁路运力
    expect(store.railCapUsedBy('axis')).toBe(railCapBefore)
  })
})

/**
 * 用户口径（2026-11-16）：「德军的铁路入场格可以卸车，应该能放那里」。
 *
 * 核原文（13.3c① / 3.6）后**不支持**：
 *   - 13.3c① 要求该铁路格有 `village, city (any size), port, or Engineer-Capable HQ`；
 *   - 3.6 只写 `at any one detrainable hex`，没有「入场格例外」。
 * 轴方铁路入场格（1.03 / 1.07 / 1.19 / 4.00 / 8.00）是 Woods/Swamp/Open，不是可卸车格。
 * 因此**不放宽候选**，只在候选为空时把原因写清（不摆一张点了没反应的卡）。
 */
describe('13.3c：入场格不是可卸车格；候选为空时不给可点卡', () => {
  it('入场格是铁路网的种子，但本身不进补给列车候选（缺 13.3c① 的村庄/城市）', () => {
    const store = armedStore()
    const text = (hex: { col: number; row: number }): string => `${hex.col}.${hex.row}`
    expect(store.entryRailSeedsBySide.axis.length).toBeGreaterThan(0)
    expect(store.supplyTrainPlacementHexes.length).toBeGreaterThan(0)
    const candidates = new Set(store.supplyTrainPlacementHexes.map(text))
    for (const seed of store.entryRailSeedsBySide.axis) {
      expect(candidates.has(text(seed))).toBe(false)
    }
  })

  it('唯一可卸车格被敌占 ⇒ 候选为空：卡变挡因行，点击不进选格，提示含 13.3c 依据', () => {
    const store = armedStore()
    expect(
      useContainersStore().drawSpecialRepl(store.activeSide, store.variableReplSpecialDie ?? 3),
    ).toBe(true)
    expect(store.rollPlacementOpen).toBe(true)
    const record = combatRecord('soviet')
    for (const [index, hex] of [...store.supplyTrainPlacementHexes].entries()) {
      store.units.push(
        toConsoleUnit({ record, instanceId: `block-${String(index)}`, hex, side: 'soviet' }),
      )
    }
    expect(store.supplyTrainPlacementHexes).toHaveLength(0)
    const card = store.rollHandEntries.find((entry) => entry.id === 'sp:train')
    expect(card?.blocked).not.toBeNull()
    expect(card?.blocked).toContain('13.3c')
    expect(card?.blocked).toContain('村庄/城市')
    expect(card?.blockedKind).toBe('placement')
    expect(store.beginRollHandEntryNow('sp:train')).toBe(false)
    expect(store.hexPickView).toBeNull()
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
