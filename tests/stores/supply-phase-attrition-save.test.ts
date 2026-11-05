import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { holdingsToT, resolveAttrition } from '@/engine/rules'
import { useGameSessionStore, useWorkbenchStore } from '@/stores'
import { createMemoryStorage } from '@/shared'

import { CORE_HEX, combatRecord, placeGround } from '../flows/sop-harness'

/**
 * 交接文档 §6：D 段「供养后进入实际损耗名单、掷骰后等待玩家分摊」的合法保存点验证
 *
 * 当前策略是**允许**在此状态保存（不属 `assertCompleteSettlement` 的未完交互），
 * 因此冷读档必须把骰面、分摊草稿、损耗义务、结算标记与付款账本一起还原：
 * 不重掷、不重复付款、不丢待办。本用例从真实工作台入口走完付款与掷骰，
 * 再清空内存盘面后读档核对，不靠修改库存数字代替付款。
 */
describe('12.8b：待决损耗的合法保存点，冷读档后账本完整', () => {
  it('已付款 + 已掷骰 + 已填分摊草稿但未提交 ⇒ 读档后义务仍在，骰面与账本不变', () => {
    setActivePinia(createPinia())
    const w = useWorkbenchStore()
    const game = useGameSessionStore()
    game.setSaveStorage(createMemoryStorage())
    game.startGame()
    w.setPhase('supply')

    const ids = ['fed', 'oos1', 'oos2']
    for (const id of ids) {
      placeGround(w, combatRecord('axis'), CORE_HEX, 'axis', id)
      const unit = w.units.find((item) => item.instanceId === id)!
      unit.re = 1
      unit.steps = 1
      unit.hasTraceSupply = false
    }
    w.spDumps.push({ id: 'near', hex: { ...CORE_HEX }, side: 'axis', sp: 0, t: 1 })
    w.supplyPhaseInputs = { availableT: 0, eatOffTheMap: { fed: true } }

    expect(w.planSupplyPhaseNow()).toBe(true)
    expect(w.applySupplyPhaseRecoveryNow()).toBe(true)
    expect(w.applySupplyPhaseFeedingNow()).toBe(true)
    // 12.6c：吃图上补给不构成追溯补给（用户 2026-11-06 裁定）⇒ 只记续命，不写 hasTraceSupply
    expect(holdingsToT(w.spDumps[0]!)).toBe(0)
    expect(w.units.find((unit) => unit.instanceId === 'fed')!.hasTraceSupply).toBe(false)
    expect(w.units.find((unit) => unit.instanceId === 'fed')!.sustainedBySpecialSupplyTurn).toBe(
      w.turn,
    )

    const index = w.playerSegmentSteps.findIndex((step) => step.id === 'supply.check')
    if (index < 0) throw new Error('D 段没有「补给检定」环节')
    expect(w.setSegmentStepIndex(index)).toBe(true)
    const key = `${CORE_HEX.col}.${CORE_HEX.row}`
    const duty = w.supplyPhasePlan!.attritionDuty.find(
      (item) => `${item.hex.col}.${item.hex.row}` === key,
    )!
    expect(duty.unitIds).toEqual(['oos1', 'oos2'])
    // 选一个确实产生「部分损失」的骰面 ⇒ 分摊有选择余地，属真正待决
    const die = Array.from({ length: 11 }, (_, value) => value + 2).find((value) => {
      const loss = resolveAttrition({
        die: value,
        bestAr: duty.bestAr,
        oosSteps: duty.oosSteps,
      }).losses
      return loss.kind === 'steps' && loss.steps > 0 && loss.steps < duty.oosSteps
    })
    if (die === undefined) throw new Error('找不到产生部分损失的骰面')
    expect(w.rollAttritionNow(key, die)).toBe(true)
    w.setAttritionAllocation(key, 'oos1', 1) // 草稿，尚未提交
    expect(w.attritionAppliedHexes).toEqual([])
    const drawsBefore = w.drawCount

    expect(game.saveNow()).toBe(true)

    // 清空内存账本后冷读档：所有待决事实必须只从存档里回来
    w.attritionResults = {}
    w.attritionInputs = {}
    w.supplyPhasePlan = null
    w.spDumps = []
    expect(game.loadNow()).toBe(true)
    // 重新取一次 store：清空内存盘面后，读档回来的事实只从存档里来
    const restored = useWorkbenchStore()

    expect(restored.attritionResults[key]?.die).toBe(die)
    expect(w.attritionInputs[key]?.allocation).toEqual({ oos1: 1 })
    expect(w.attritionAppliedHexes).toEqual([])
    expect(
      restored.supplyPhasePlan?.attritionDuty.find(
        (item) => `${item.hex.col}.${item.hex.row}` === key,
      )?.unitIds,
    ).toEqual(['oos1', 'oos2'])
    expect(w.supplyFeedingSettled).toBe(true)
    expect(w.supplyRecoverySettled).toBe(true)
    // 付款账本：读档后仍是已扣完的 1T，不重置、不重复扣
    expect(holdingsToT(w.spDumps.find((dump) => dump.id === 'near')!)).toBe(0)
    expect(w.drawCount).toBe(drawsBefore)

    // 重复操作不重掷、不重复付款，义务仍要求玩家分摊
    expect(w.rollAttritionNow(key, 12)).toBe(true)
    expect(w.attritionResults[key]?.die).toBe(die)
    expect(w.applySupplyPhaseFeedingNow()).toBe(true)
    expect(holdingsToT(w.spDumps.find((dump) => dump.id === 'near')!)).toBe(0)
    expect(w.drawCount).toBe(drawsBefore)
    // 正式推进入口仍被未分摊的义务挡住，且停在同一环（不是被别的闸门拦下）
    const stepBefore = w.segmentStepIndex
    expect(w.advanceSegmentNow()).toBeNull()
    expect(w.log.some((entry) => (entry.text ?? '').includes('损耗尚未分配'))).toBe(true)
    expect(w.segmentStepIndex).toBe(stepBefore)
    expect(w.attritionAppliedHexes).toEqual([])

    // 读档后可以按保存下来的骰面继续完成这一格的结算
    expect(w.applyAttritionNow(key)).toBe(true)
    expect(w.attritionAppliedHexes).toEqual([key])
  })
})
