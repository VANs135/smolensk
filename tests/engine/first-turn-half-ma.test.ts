import { describe, expect, it } from 'vitest'

import { availableMa, FIRST_TURN_HALF_MA_MULT } from '@/engine/rules'
import type { MoveUnitView } from '@/engine/rules'

/**
 * 专规 1.5 / 剧本 1–2：
 *   「The Soviets are in disarray, so all of their ground units move at 1/2 MA on the first
 *     turn. This can be further adjusted by mode effects (e.g., DG).」
 *
 * ⇒ 首回合苏军地面单位 MA **再乘 0.5**，与模式折算**相乘**；6.1h 减少后的 MA 永不取整。
 * 引擎只认调用方注入的 `scenarioMaFactor`（不读剧本数据），故这里直接验证折算链。
 */

function unit(over: Partial<MoveUnitView> = {}): MoveUnitView {
  return {
    id: 'u1',
    side: 'soviet',
    isCombat: true,
    attackCapable: true,
    hasTraceSupply: true,
    hex: { col: 36, row: 13 },
    mobility: 'leg',
    ma: 5,
    re: 2,
    mode: 'combat',
    orientation: 'combat',
    dg: false,
    exploit: false,
    releasedFromReserve: false,
    fuelled: false,
    mpLockedThisPhase: false,
    ...over,
  }
}

describe('专规 1.5：首回合 1/2 MA（scenarioMaFactor × 0.5）', () => {
  it('缺省不注入 ⇒ 视为 1（不影响其它剧本/回合）', () => {
    expect(availableMa(unit({ ma: 5 }), 'movement')).toBe(5)
  })

  it('注入 0.5 ⇒ 战斗模式 5 → 2.5（6.1h 不取整）', () => {
    expect(
      availableMa(unit({ ma: 5, scenarioMaFactor: FIRST_TURN_HALF_MA_MULT }), 'movement'),
    ).toBe(2.5)
  })

  it('与模式折算相乘：战略 ×2 后再 ×1/2', () => {
    expect(
      availableMa(
        unit({
          ma: 5,
          mode: 'strat',
          orientation: 'move',
          scenarioMaFactor: FIRST_TURN_HALF_MA_MULT,
        }),
        'movement',
      ),
    ).toBe(5)
  })

  it('与模式折算相乘：预备移动段 ×1/4 后再 ×1/2（5.7 + 1.5）', () => {
    expect(
      availableMa(
        unit({ ma: 5, mode: 'reserve', scenarioMaFactor: FIRST_TURN_HALF_MA_MULT }),
        'movement',
      ),
    ).toBe(0.625)
  })

  it('与模式折算相乘：混乱 ×1/2 后再 ×1/2（原文 "further adjusted by mode effects"）', () => {
    expect(
      availableMa(unit({ ma: 5, dg: true, scenarioMaFactor: FIRST_TURN_HALF_MA_MULT }), 'movement'),
    ).toBe(1.25)
  })

  it('预备在反应/进击阶段仍按 5.7 的 0 额度（剧本系数不复活移动力）', () => {
    expect(
      availableMa(
        unit({ ma: 5, mode: 'reserve', scenarioMaFactor: FIRST_TURN_HALF_MA_MULT }),
        'reaction',
      ),
    ).toBe(0)
    expect(
      availableMa(
        unit({ ma: 5, mode: 'reserve', scenarioMaFactor: FIRST_TURN_HALF_MA_MULT }),
        'exploitation',
      ),
    ).toBe(0)
  })
})
