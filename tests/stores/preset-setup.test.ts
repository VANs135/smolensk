import { describe, it, expect } from 'vitest'

import { fresh, fillSetup } from '../flows/flow-harness'
import { useHotseatStore } from '@/stores'

/** 一键预设初设：每个剧本一条独立用例（不参数化巨型用例） */
function presetOf(id: string) {
  const ctx = fresh()
  expect(ctx.setup.enterSetup(id)).toBe(true)
  return { ctx, result: ctx.setup.presetSelfSetupNow() }
}

describe('一键全落（2026-11-19：PVE 轴心先手不再空转）', () => {
  /**
   * 回归：修前界面只传 `onlySide: presetSide`（AI 方）。剧本 3–7 是轴心先手，
   * 游标尚在玩家方 ⇒ `presetSelfSetupNow` 直接空转（placed=0 / remaining=78）。
   * 用户裁定改为全落双方后，无参调用在轴心先手剧本同样落完。
   */
  for (const id of ['3', '4', '5', '6', '7']) {
    it(`PVE+AI苏联 · 轴心先手剧本 ${id}：一键全落不空转`, () => {
      const ctx = fresh()
      const hot = useHotseatStore()
      hot.setMode('pve')
      hot.setAiSide('soviet')
      expect(ctx.setup.enterSetup(id)).toBe(true)
      expect(ctx.setup.setupSideCursor).toBe('axis')
      // 进入初设时确有必做项（空转特征：remaining 停在 78/38/28）
      const before = ctx.setup.initialPlacementsComplete
      expect(before).toBe(false)
      // 界面现在的调用：无参全落（而非只传 AI 方）
      const result = ctx.setup.presetSelfSetupNow()
      expect(result.failures, JSON.stringify(result.failures)).toEqual([])
      expect(result.remaining).toBe(0)
      expect(ctx.setup.setupSideCursor).toBeNull()
      // 全落收束后初设完成
      expect(ctx.setup.initialPlacementsComplete).toBe(true)
    })
  }
})

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
    // ch10：初设单位摆完后执行一次编队抽取，才允许收束
    expect(ctx.setup.drawSetupEffectsNow()).toBe(true)
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

  it('手动初设路径未变：不调预设时仍可逐项落位', { timeout: 20000 }, () => {
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
