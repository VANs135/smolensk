import { describe, expect, it } from 'vitest'

import { fresh } from '../flows/flow-harness'

/**
 * 一键预设初设必须把**飞机**也落完（人机对打自对打的前置）
 *
 * 缺陷现象（2026-11-15 首跑）：Intro 预设后仍有 7 枚德军飞机未落位
 * （Bf.110 ×2 / Do.17z / Ju.88 / Ju.87b ×3），失败理由「双方布设均已确认」——
 * 预设先把两方地面布设都确认了，此后再摆飞机时 `setupSideCursor` 已是 null，
 * 而 `canEditAirSetup` 要求游标停在该方 ⇒ 全部被拒，开局却照常成功（状态不一致）。
 */
describe('一键预设初设：飞机随本方布设一并落位', () => {
  it('Intro 预设后 failures 为空、remaining 为 0、7 枚飞机全部落位', () => {
    const ctx = fresh()
    expect(ctx.setup.enterSetup('Intro')).toBe(true)
    const preset = ctx.setup.presetSelfSetupNow()
    expect(preset.failures).toEqual([])
    expect(preset.remaining).toBe(0)
    expect(preset.airPlaced).toBe(7)
  })

  it('预设完可直接开局，盘面上确有这 7 枚飞机', () => {
    const ctx = fresh()
    expect(ctx.setup.enterSetup('Intro')).toBe(true)
    expect(ctx.setup.presetSelfSetupNow().remaining).toBe(0)
    expect(ctx.setup.startGameNow()).toBe(true)
    expect(ctx.w.airUnits).toHaveLength(7)
  })
})
