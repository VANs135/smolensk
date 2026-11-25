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

  /**
   * 2026-11-26（用户裁定）：一键自动放置时**飞机一律先进地图外空军盒**，不许把每一枚
   * 钉进"候选排序里的第一个基地格"（那样既占了基地，玩家事后也只能逐枚撤回）。
   */
  it('★ 预设后飞机全在地图外空军盒里（不占基地格）', () => {
    const ctx = fresh()
    expect(ctx.setup.enterSetup('Intro')).toBe(true)
    expect(ctx.setup.presetSelfSetupNow().failures).toEqual([])
    const ids = ctx.w.airUnits.map((air) => air.instanceId)
    expect(ids.length).toBe(7)
    expect(ids.every((id) => ctx.w.airBoxMembers.includes(id))).toBe(true)
    // 没有一枚落在图上基地格（盒内飞机不占格）
    expect(ctx.w.onMapAirUnits).toHaveLength(0)
  })
})
