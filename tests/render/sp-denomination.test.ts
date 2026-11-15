import { describe, expect, it } from 'vitest'

import { spDumpImageUrlOf } from '@/stores/workbench-model'
import {
  nearestSpDenomination,
  spCounterImageUrl,
  spDenominationDiffers,
} from '@/render/token-images'

/**
 * 条 27 / §4-7：SP 素材只有 1/2/3/4/5/10/15 ⇒ 任意总额取「最近面额」图，实数用角标补。
 * 原实现直接拼 `Neutral_SP_${points}`，9 SP 会取到不存在的图。
 */
describe('条 27：SP 任意总额的取图规则', () => {
  it('最近面额：落在七种面额上的取自身，夹在中间的取更近者', () => {
    const expected: Record<number, number> = {
      1: 1,
      2: 2,
      3: 3,
      4: 4,
      5: 5,
      6: 5,
      7: 5,
      8: 10,
      9: 10,
      10: 10,
      11: 10,
      12: 10,
      13: 15,
      14: 15,
      15: 15,
      16: 15,
      20: 15,
    }
    for (const [points, denom] of Object.entries(expected)) {
      expect(nearestSpDenomination(Number(points)), `points=${points}`).toBe(denom)
    }
  })

  it('非正 / 非整数 ⇒ null（不拼出不存在或负数面额的图名）', () => {
    expect(nearestSpDenomination(0)).toBeNull()
    expect(nearestSpDenomination(-3)).toBeNull()
    expect(nearestSpDenomination(2.5)).toBeNull()
    expect(spCounterImageUrl(0, 'combat')).toBeNull()
    expect(spCounterImageUrl(-1, 'move')).toBeNull()
  })

  it('9 SP 取 10 面额的图（不再取不存在的 Neutral_SP_9）', () => {
    const url = spCounterImageUrl(9, 'combat')
    expect(url).not.toBeNull()
    expect(url).toContain('Neutral_SP_10')
    expect(url).not.toContain('Neutral_SP_9')
  })

  it('1/2/3 仍按正反面选图（move=B 运输面 / combat=F 补给面）', () => {
    expect(spCounterImageUrl(2, 'move')).toContain('Neutral_SP_2_B')
    expect(spCounterImageUrl(2, 'combat')).toContain('Neutral_SP_2_F')
    expect(spCounterImageUrl(3, 'move')).toContain('Neutral_SP_3_B')
  })

  it('面额与实数不一致时要求画角标', () => {
    expect(spDenominationDiffers(9)).toBe(true)
    expect(spDenominationDiffers(7)).toBe(true)
    expect(spDenominationDiffers(20)).toBe(true)
    // 正好落在面额上 ⇒ 不需要角标
    expect(spDenominationDiffers(5)).toBe(false)
    expect(spDenominationDiffers(10)).toBe(false)
    expect(spDenominationDiffers(15)).toBe(false)
  })
})

/**
 * ★ 用户 2026-11-15（实机试玩第 3 项）：**补给站数值改变后，算子贴图的面额要实时跟着变**。
 *
 * 补给站在面板里是账本条目（`SpDump`），取图必须与地图令牌同一口径：
 * 有整 SP 走补给面 F；只剩 T 走运输面 B（12.1a：1 SP = 4 T）。
 */
describe('补给站账本：面额跟随当前数值', () => {
  it('整 SP 改变 ⇒ 换成新面额（4 → 2）', () => {
    expect(spDumpImageUrlOf({ side: 'axis', sp: 4, t: 0 })).toContain('Neutral_SP_4')
    expect(spDumpImageUrlOf({ side: 'axis', sp: 2, t: 0 })).toContain('Neutral_SP_2_F')
  })

  it('只剩运输点数 ⇒ 走运输面 B，不是空白', () => {
    expect(spDumpImageUrlOf({ side: 'axis', sp: 0, t: 3 })).toContain('Neutral_SP_3_B')
  })

  it('空站 ⇒ 无图（不可用项不出现）', () => {
    expect(spDumpImageUrlOf({ side: 'axis', sp: 0, t: 0 })).toBeNull()
  })
})
