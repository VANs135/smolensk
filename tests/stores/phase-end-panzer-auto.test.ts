import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useGameSessionStore, useWorkbenchStore } from '@/stores'

import { CORE_HEX, NEAR_HEX, combatRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 阶段末**装甲集群**判定：有选择才弹窗，能判的直接判
 *
 * 病灶：段末闸门 `exclusive.panzerObligation` 在**每个玩家相位末**都放行，
 *   而会话窗的自动出现只看这条闸门、不看是否真有义务 ⇒ 每次换段都弹一个
 *   「当前没有分界线义务」的长面板（用户报「太长、字太多」）。
 *
 * 口径：
 *   · 3.4a 命中**单枚**单位 ⇒ 引擎可直接判定（原文「place a DG on a unit … if it is …」），
 *     段末自动投 DG + 一行日志，不开窗；
 *   · 命中**多枚**才是玩家选择（选哪一枚投 DG）⇒ 才开窗，且推进被拦到选完为止；
 *   · 3.4b 的 SP 归属是**可选专规**：未采纳时整块不生效，也不能把段末窗口撑出来。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { session: useGameSessionStore(), workbench: useWorkbenchStore() }
}

/** 把 store 放到「本段最后一个玩家环节」＝段末（3.4a 的判定时机） */
function toPhaseEnd(workbench: Workbench): void {
  workbench.setPhase('movement')
  const steps = workbench.playerSegmentSteps
  if (steps.length === 0) throw new Error('C 段没有玩家环节？')
  workbench.setSegmentStepIndex(steps.length - 1)
}

/** 摆一枚轴方多单位编队单位并声明集群 */
function panzerUnit(
  workbench: Workbench,
  hex: { col: number; row: number },
  id: string,
  group: 'guderian' | 'hoth',
) {
  const unit = placeGround(workbench, combatRecord('axis'), hex, 'axis', id)
  workbench.setMultiUnitFormationNow(id, true)
  workbench.setPanzerGroupNow(id, group)
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('阶段末装甲集群：无义务不弹窗', () => {
  it('段末闸门放行 ≠ 该开窗：没有义务时会话不自动出现（3.4a）', () => {
    const { session, workbench } = newStores()
    session.startGame()
    session.patchRecords({ activeSide: 'axis' })
    toPhaseEnd(workbench)

    // 闸门仍然表达"此刻是结算时机"，但它不再单独决定是否弹窗
    expect(workbench.panzerObligationActive).toBe(true)
    expect(workbench.exclusiveActionsInStep).toHaveLength(1)
    expect(workbench.panzerDgChoiceObligations).toEqual([])
    expect(workbench.exclusiveAutoOpen).toBe(false)
    expect(workbench.exclusiveSectionPins.panzer).toBe(false)
  })

  it('3.4b 未采纳：未归属 SP 也不撑出段末窗口（可选专规不出现）', () => {
    const { session, workbench } = newStores()
    session.startGame()
    session.patchRecords({ activeSide: 'axis' })
    toPhaseEnd(workbench)
    workbench.spDumps.push({ id: 'sd-x', hex: { ...CORE_HEX }, side: 'axis', sp: 2, t: 0 })

    expect(workbench.panzerGroupRulesOn).toBe(false)
    expect(workbench.panzerGroupUnassignedDumps).toEqual([])
    expect(workbench.exclusiveSectionPins.panzer).toBe(false)
    expect(workbench.exclusiveAutoOpen).toBe(false)
  })
})

describe('阶段末装甲集群：单候选自动判定', () => {
  it('命中单枚 ⇒ 段末自动投 DG、落一行 3.4a 日志，且不开窗', () => {
    const { session, workbench } = newStores()
    session.startGame()
    session.patchRecords({ activeSide: 'axis' })
    const guderian = panzerUnit(workbench, CORE_HEX, 'g1', 'guderian')
    const hoth = panzerUnit(workbench, NEAR_HEX, 'h1', 'hoth')
    toPhaseEnd(workbench)

    // 两集群各命中一枚 ⇒ 没有可选空间
    expect(workbench.panzerGroupObligations).toHaveLength(2)
    expect(workbench.panzerDgChoiceObligations).toEqual([])
    expect(workbench.exclusiveAutoOpen).toBe(false)

    workbench.advanceSegmentNow()

    expect(guderian.mode.dg).toBe(true)
    expect(hoth.mode.dg).toBe(true)
    expect(
      workbench.log.some((entry) => entry.rule === '3.4a' && entry.text.includes('自动投 DG')),
    ).toBe(true)
  })
})

describe('阶段末装甲集群：多候选才弹窗', () => {
  it('同一编队命中两枚 ⇒ 窗口出现、推进被拦；选一枚后窗口收起（3.4a）', () => {
    const { session, workbench } = newStores()
    session.startGame()
    session.patchRecords({ activeSide: 'axis' })
    const g1 = panzerUnit(workbench, CORE_HEX, 'g1', 'guderian')
    const g2 = panzerUnit(workbench, CORE_HEX, 'g2', 'guderian')
    const hoth = panzerUnit(workbench, NEAR_HEX, 'h1', 'hoth')
    toPhaseEnd(workbench)

    expect(workbench.panzerDgChoiceObligations).toHaveLength(1)
    expect(workbench.exclusiveSectionPins.panzer).toBe(true)
    expect(workbench.exclusiveAutoOpen).toBe(true)
    expect(workbench.currentAdvanceBlock).toMatchObject({ rule: '3.4a' })
    expect(workbench.advanceSegmentNow()).toBeNull()

    // 有选择就不自动替玩家投
    expect(g1.mode.dg).toBe(false)
    expect(g2.mode.dg).toBe(false)
    expect(hoth.mode.dg).toBe(false)

    expect(workbench.applyPanzerGroupDgNow('g1')).toBe(true)
    expect(g1.mode.dg).toBe(true)
    // 投过一枚 ⇒ 该编队义务已结清，窗口收起（另一枚不必再投）
    expect(workbench.panzerDgChoiceObligations).toHaveLength(0)
    expect(workbench.exclusiveAutoOpen).toBe(false)
  })
})
