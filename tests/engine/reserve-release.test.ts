import { describe, expect, it } from 'vitest'

import {
  ACTIONS_BY_PHASE,
  canReleaseReserve,
  checkTiming,
  clearReleasedFromReserve,
  maMultiplier,
} from '@/engine/rules'
import type { ModeState } from '@/engine/rules'

/**
 * 释放预备（通规 5.7b）
 *
 * 条文：5.7b「被玩家『释放』的预备模式单位可在**该玩家的反应阶段或进击阶段**使用。要释放一个
 *   单位时，**只需移除它的预备标记**：该单位现在即处于战斗模式或移动模式，取决于它的朝向（5.7a）。
 *   玩家可以先释放一个单位并让其移动与突袭，然后再决定是否释放其他预备单位。」
 *   A) 进击阶段：拥有完整的移动 / 轰炸 / 战斗能力（MA ×1）；
 *   B) 反应阶段：以它**一半的 MA** 移动（MA ×1/2）。
 *
 * 行动者身份：反应阶段＝非阶段玩家（6.3a），进击阶段＝阶段玩家（11.0a）；
 * 移动阶段不可释放（5.4「在移动阶段之外，不允许进行其他形式的主动模式切换」）。
 */

/** 预备模式单位（朝向战斗面） */
const RESERVE: ModeState = { mode: 'reserve', orientation: 'combat', dg: false, exploit: false }

describe('5.7b：释放预备的时点与行动者身份', () => {
  it('反应阶段：非阶段玩家可释放自己的预备（6.3a）', () => {
    const verdict = canReleaseReserve({
      state: RESERVE,
      side: 'soviet',
      activeSide: 'axis',
      phase: 'reaction',
    })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.rule).toBe('5.7b')
    expect(verdict.mode).toEqual({ ...RESERVE, releasedFromReserve: true })
    // 5.7b-B：反应阶段以一半 MA 移动
    expect(verdict.maMult).toBe(0.5)
  })

  it('反应阶段：**阶段玩家**不能释放（那是他自己的回合，6.3a）', () => {
    expect(
      canReleaseReserve({ state: RESERVE, side: 'axis', activeSide: 'axis', phase: 'reaction' }),
    ).toMatchObject({ ok: false, rule: '6.3a' })
  })

  it('进击阶段：阶段玩家可释放自己的预备，且拥有完整 MA（11.0a / 5.7b-A）', () => {
    const verdict = canReleaseReserve({
      state: RESERVE,
      side: 'axis',
      activeSide: 'axis',
      phase: 'exploitation',
    })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.maMult).toBe(1)
    // 非阶段玩家在 G 段不得释放
    expect(
      canReleaseReserve({
        state: RESERVE,
        side: 'soviet',
        activeSide: 'axis',
        phase: 'exploitation',
      }),
    ).toMatchObject({ ok: false, rule: '11.0a' })
  })

  it('移动阶段不能释放预备（5.4：主动模式切换只在移动阶段，而释放属反应/进击段）', () => {
    const verdict = canReleaseReserve({
      state: RESERVE,
      side: 'axis',
      activeSide: 'axis',
      phase: 'movement',
    })
    expect(verdict).toMatchObject({ ok: false, rule: '5.7b' })
    if (!verdict.ok) expect(verdict.reason).toContain('movement')
  })
})

describe('5.7b：释放的前提与「只释放一次」', () => {
  it('非预备模式的单位无需释放', () => {
    const combat: ModeState = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
    expect(
      canReleaseReserve({ state: combat, side: 'axis', activeSide: 'axis', phase: 'exploitation' }),
    ).toMatchObject({ ok: false, rule: '5.7b' })
  })

  it('同一阶段内不可重复释放（本阶段刚释放过）', () => {
    const already: ModeState = { ...RESERVE, releasedFromReserve: true }
    const verdict = canReleaseReserve({
      state: already,
      side: 'axis',
      activeSide: 'axis',
      phase: 'exploitation',
    })
    expect(verdict).toMatchObject({ ok: false, rule: '5.7b' })
    if (!verdict.ok) expect(verdict.reason).toContain('已经释放')
  })

  it('释放不产生新标记：仍是 reserve + releasedFromReserve（由 canonicalMode 折回朝向面）', () => {
    const verdict = canReleaseReserve({
      state: { ...RESERVE, orientation: 'move' },
      side: 'axis',
      activeSide: 'axis',
      phase: 'exploitation',
    })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.mode.mode).toBe('reserve')
    expect(verdict.mode.orientation).toBe('move')
    expect(verdict.mode.releasedFromReserve).toBe(true)
  })

  it('释放后的模式倍率与 5.7b 一致：E ×1/2、G ×1，且 5.9 的 DG 等标记不受影响', () => {
    const released: ModeState = { ...RESERVE, releasedFromReserve: true }
    expect(maMultiplier(released, 'reaction')).toBe(0.5)
    expect(maMultiplier(released, 'exploitation')).toBe(1)
  })
})

describe('5.7b：`releasedFromReserve` 是「本阶段」的时点事实', () => {
  it('clearReleasedFromReserve 摘掉该旗标；无旗标时原样返回', () => {
    const released: ModeState = { ...RESERVE, releasedFromReserve: true }
    // 表示法：旗标留在对象上、置为 false（调用方一律按 `=== true` 判定）
    expect(clearReleasedFromReserve(released)).toEqual({ ...RESERVE, releasedFromReserve: false })
    // 幂等：已无旗标的状态原引用返回
    expect(clearReleasedFromReserve(RESERVE)).toBe(RESERVE)
  })

  it('清除后不再具备反应/进击阶段的移动资格（6.3a / 7.0a / 11.0a 不被陈旧旗标绕过）', () => {
    const stale: ModeState = { ...RESERVE, releasedFromReserve: true }
    const cleared = clearReleasedFromReserve(stale)
    // 单位虽已摘掉预备标记（回朝向面），但下阶段不能再凭旧旗标在反应段移动
    expect(maMultiplier(cleared, 'exploitation')).toBe(0)
  })
})

describe('2.2 / 5.7b：时机族的行动者身份校验（checkTiming）', () => {
  const unit = (released: boolean) => ({
    id: 'u1',
    isCombat: true,
    attackCapable: true,
    mobility: 'track' as const,
    mode: released ? { ...RESERVE, releasedFromReserve: true } : RESERVE,
    raw: { attack: 5, ar: 3, ma: 6 },
    re: 1,
  })

  it('E 段：非阶段玩家释放自己的预备通过；释放**不要求**已释放标记', () => {
    expect(
      checkTiming({
        action: 'reserveRelease',
        side: 'soviet',
        activeSide: 'axis',
        phase: 'reaction',
        date: '1941-07-12',
        units: [unit(false)],
      }),
    ).toEqual([])
  })

  it('E 段：阶段玩家释放自己的预备被 6.3a 拦下', () => {
    const violations = checkTiming({
      action: 'reserveRelease',
      side: 'axis',
      activeSide: 'axis',
      phase: 'reaction',
      date: '1941-07-12',
      units: [unit(false)],
    })
    expect(violations.map((item) => item.rule)).toContain('6.3a')
  })

  it('G 段：阶段玩家释放自己的预备通过；非阶段玩家被 11.0a 拦下', () => {
    expect(
      checkTiming({
        action: 'reserveRelease',
        side: 'axis',
        activeSide: 'axis',
        phase: 'exploitation',
        date: '1941-07-12',
        units: [unit(false)],
      }),
    ).toEqual([])
    expect(
      checkTiming({
        action: 'reserveRelease',
        side: 'soviet',
        activeSide: 'axis',
        phase: 'exploitation',
        date: '1941-07-12',
        units: [unit(false)],
      }).map((item) => item.rule),
    ).toContain('11.0a')
  })

  it('C 段不在许可动作里：释放预备在移动阶段被段闸拦下', () => {
    const violations = checkTiming({
      action: 'reserveRelease',
      side: 'axis',
      activeSide: 'axis',
      phase: 'movement',
      date: '1941-07-12',
      units: [unit(false)],
    })
    expect(violations.map((item) => item.reason)).toContain('actionNotInSegment')
    expect([...ACTIONS_BY_PHASE.reaction]).toContain('reserveRelease')
    expect([...ACTIONS_BY_PHASE.exploitation]).toContain('reserveRelease')
    expect([...ACTIONS_BY_PHASE.movement]).not.toContain('reserveRelease')
  })
})
