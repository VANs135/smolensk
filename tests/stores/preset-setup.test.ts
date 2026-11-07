import { describe, it, expect } from 'vitest'

import { fresh, fillSetup } from '../flows/flow-harness'

/** 一键预设初设：每个剧本一条独立用例（不参数化巨型用例） */
function presetOf(id: string) {
  const ctx = fresh()
  expect(ctx.setup.enterSetup(id)).toBe(true)
  return { ctx, result: ctx.setup.presetSelfSetupNow() }
}

describe('一键预设初设（B2）', () => {
  it('剧本 1：预设后无失败、无剩余', () => {
    const { result } = presetOf('1')
    expect(result.failures, JSON.stringify(result.failures)).toEqual([])
    expect(result.remaining).toBe(0)
  })

  it('剧本 2：预设后无失败、无剩余', () => {
    const { result } = presetOf('2')
    expect(result.failures, JSON.stringify(result.failures)).toEqual([])
    expect(result.remaining).toBe(0)
  })

  it('剧本 3：预设后无失败、无剩余', () => {
    const { result } = presetOf('3')
    expect(result.failures, JSON.stringify(result.failures)).toEqual([])
    expect(result.remaining).toBe(0)
  })

  it('剧本 4：预设后无失败、无剩余', () => {
    const { result } = presetOf('4')
    expect(result.failures, JSON.stringify(result.failures)).toEqual([])
    expect(result.remaining).toBe(0)
  })

  it('剧本 5：预设后无失败、无剩余', () => {
    const { result } = presetOf('5')
    expect(result.failures, JSON.stringify(result.failures)).toEqual([])
    expect(result.remaining).toBe(0)
  })

  it('剧本 6：预设后无失败、无剩余', () => {
    const { result } = presetOf('6')
    expect(result.failures, JSON.stringify(result.failures)).toEqual([])
    expect(result.remaining).toBe(0)
  })

  it('剧本 7：预设后无失败、无剩余', () => {
    const { result } = presetOf('7')
    expect(result.failures, JSON.stringify(result.failures)).toEqual([])
    expect(result.remaining).toBe(0)
  })

  it('预设后可以完成初设并开始游戏（不自动点开始）', () => {
    const ctx = fresh()
    expect(ctx.setup.enterSetup('1')).toBe(true)
    ctx.setup.presetSelfSetupNow()
    expect(ctx.setup.finished).toBe(false)
    expect(ctx.setup.canFinishSetup()).toBe(true)
    expect(ctx.setup.startGameNow()).toBe(true)
  })

  it('幂等：连调两次不重复落位', () => {
    const ctx = fresh()
    expect(ctx.setup.enterSetup('1')).toBe(true)
    const first = ctx.setup.presetSelfSetupNow()
    const unitsAfterFirst = ctx.w.units.length
    const airAfterFirst = ctx.w.airUnits.length
    const second = ctx.setup.presetSelfSetupNow()
    expect(second.placed).toBe(0)
    expect(second.remaining).toBe(0)
    expect(second.failures).toEqual([])
    expect(ctx.w.units.length).toBe(unitsAfterFirst)
    expect(ctx.w.airUnits.length).toBe(airAfterFirst)
    expect(first.placed).toBeGreaterThan(0)
  })

  it('手动初设路径未变：不调预设时仍可逐项落位', () => {
    const ctx = fresh()
    expect(ctx.setup.enterSetup('1')).toBe(true)
    fillSetup(ctx)
    expect(ctx.setup.pendingPlacement.filter((item) => item.remaining > 0)).toHaveLength(0)
    expect(ctx.setup.initialPlacementsComplete).toBe(true)
  })

  it('确定性：同剧本两次新实例的落位集合与格号一致', () => {
    const snapshot = () => {
      const ctx = fresh()
      expect(ctx.setup.enterSetup('1')).toBe(true)
      ctx.setup.presetSelfSetupNow()
      return [
        ...ctx.w.units.map((unit) => `${unit.unitId}@${unit.hex.col}.${unit.hex.row}`),
        ...ctx.w.airUnits.map((air) => `${air.aircraftId}@${air.hex.col}.${air.hex.row}`),
      ].sort()
    }
    expect(snapshot()).toEqual(snapshot())
  })
})
