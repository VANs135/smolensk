import { describe, expect, it } from 'vitest'

import { SOVIET_STRAT_MODE_FROM, canSetModeAtSetup } from '@/engine/rules'
import type { SetupModeRequest } from '@/engine/rules'

/**
 * IV-B：初设阶段设定模式（combat / move / reserve / strat）
 *
 * 原文（通规 IV-B 初设）：
 *   「Ground units can be set up in any desired mode. (Exception: ground units adjacent to
 *     enemy Attack-Capable units cannot be set up in Reserve or Strat Mode.)」
 * ⇒ 地面单位初设可选四种主动模式；与敌方**攻击力单位**相邻者不得设预备/战略。
 *
 * 复用 `canSwitchMode` 的通用闸门，故 5.1 / 5.5 / 5.5c / 5.6 / 5.7f / 5.8 / 5.8c / 专规 2.3e
 * 在初设同样生效；预备另受 5.4a 的**按格额度**与剧本明禁（剧本 3「No units can setup in
 * Reserve Mode.」）约束。
 */

const BASE: Omit<SetupModeRequest, 'to' | 'orientation'> = {
  unitClass: 'combat',
  side: 'axis',
  hex: '10.10',
  adjacentEnemyAttackCapable: false,
  reserveCap: 4,
  reserveOccupiedHexes: [],
}

describe('IV-B：初设可选四种主动模式', () => {
  it('战斗 / 移动 / 预备 / 战略均可设定（地面战斗单位）', () => {
    const cases = [
      { to: 'combat', orientation: 'combat' },
      { to: 'move', orientation: 'move' },
      { to: 'reserve', orientation: 'combat' },
      { to: 'strat', orientation: 'move' },
    ] as const
    for (const item of cases) {
      const result = canSetModeAtSetup({ ...BASE, to: item.to, orientation: item.orientation })
      expect(result.ok).toBe(true)
    }
  })

  it('朝向仍受 5.5 / 5.6 / 5.8 约束（战略必须移动面）', () => {
    expect(canSetModeAtSetup({ ...BASE, to: 'combat', orientation: 'move' }).ok).toBe(false)
    expect(canSetModeAtSetup({ ...BASE, to: 'move', orientation: 'combat' }).ok).toBe(false)
    const strat = canSetModeAtSetup({ ...BASE, to: 'strat', orientation: 'combat' })
    expect(strat.ok).toBe(false)
    if (!strat.ok) expect(strat.rule).toBe('5.8')
  })
})

describe('5.1 / 5.5c / 5.7f / 5.8c：单位类别闸门在初设同样生效', () => {
  it('设施（SP/港口/空军基地/环形工事）没有模式（6.1b）', () => {
    const result = canSetModeAtSetup({
      ...BASE,
      unitClass: 'facility',
      to: 'move',
      orientation: 'move',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rule).toBe('6.1b')
  })

  it('补员不能设战斗模式，但可设其他模式（13.5 / 5.5c）', () => {
    const combat = canSetModeAtSetup({
      ...BASE,
      unitClass: 'repl',
      to: 'combat',
      orientation: 'combat',
    })
    expect(combat.ok).toBe(false)
    if (!combat.ok) expect(combat.rule).toBe('5.5c')
    expect(
      canSetModeAtSetup({ ...BASE, unitClass: 'repl', to: 'move', orientation: 'move' }).ok,
    ).toBe(true)
  })

  it('运输点数不能设预备 / 战略，但可设移动（5.7f / 5.8c）', () => {
    const reserve = canSetModeAtSetup({
      ...BASE,
      unitClass: 'transportPoint',
      to: 'reserve',
      orientation: 'combat',
    })
    expect(reserve.ok).toBe(false)
    if (!reserve.ok) expect(reserve.rule).toBe('5.7f')

    const strat = canSetModeAtSetup({
      ...BASE,
      unitClass: 'transportPoint',
      to: 'strat',
      orientation: 'move',
    })
    expect(strat.ok).toBe(false)
    if (!strat.ok) expect(strat.rule).toBe('5.8c')

    expect(
      canSetModeAtSetup({ ...BASE, unitClass: 'transportPoint', to: 'move', orientation: 'move' })
        .ok,
    ).toBe(true)
  })
})

describe('IV-B 例外：与敌方攻击力单位相邻', () => {
  it('相邻者不得设预备或战略（即使额度充足）', () => {
    const reserve = canSetModeAtSetup({
      ...BASE,
      to: 'reserve',
      orientation: 'combat',
      adjacentEnemyAttackCapable: true,
    })
    expect(reserve.ok).toBe(false)
    if (!reserve.ok) expect(reserve.rule).toBe('IV-B')

    const strat = canSetModeAtSetup({
      ...BASE,
      to: 'strat',
      orientation: 'move',
      adjacentEnemyAttackCapable: true,
    })
    expect(strat.ok).toBe(false)
    if (!strat.ok) expect(strat.rule).toBe('IV-B')
  })

  it('相邻不限制战斗 / 移动模式', () => {
    expect(
      canSetModeAtSetup({
        ...BASE,
        to: 'combat',
        orientation: 'combat',
        adjacentEnemyAttackCapable: true,
      }).ok,
    ).toBe(true)
    expect(
      canSetModeAtSetup({
        ...BASE,
        to: 'move',
        orientation: 'move',
        adjacentEnemyAttackCapable: true,
      }).ok,
    ).toBe(true)
  })
})

describe('5.4a：初设进入预备即按格占额度', () => {
  it('额度 0 ⇒ 无预备权（剧本没给就是 0）', () => {
    const result = canSetModeAtSetup({
      ...BASE,
      to: 'reserve',
      orientation: 'combat',
      reserveCap: 0,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rule).toBe('5.4a')
  })

  it('新格已达上限 ⇒ 拒；同格已有预备 ⇒ 放行（一枚标记覆盖同格整个 portion）', () => {
    const reached = canSetModeAtSetup({
      ...BASE,
      to: 'reserve',
      orientation: 'combat',
      reserveCap: 2,
      reserveOccupiedHexes: ['10.10', '11.11'],
      hex: '12.12',
    })
    expect(reached.ok).toBe(false)
    if (!reached.ok) expect(reached.rule).toBe('5.4a')

    const sameHex = canSetModeAtSetup({
      ...BASE,
      to: 'reserve',
      orientation: 'combat',
      reserveCap: 2,
      reserveOccupiedHexes: ['10.10', '11.11'],
      hex: '10.10',
    })
    expect(sameHex.ok).toBe(true)
  })

  it('剧本明禁初设预备（剧本 3「No units can setup in Reserve Mode.」）', () => {
    const result = canSetModeAtSetup({
      ...BASE,
      to: 'reserve',
      orientation: 'combat',
      reserveSetupForbidden: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rule).toBe('ch11')
  })
})

describe('专规 2.3e：8 月 1 日回合前苏军不得进入战略模式（初设同样适用）', () => {
  it('7 月苏军设战略被拒，8 月 1 日起放行；轴方不受限', () => {
    const early = canSetModeAtSetup({
      ...BASE,
      side: 'soviet',
      to: 'strat',
      orientation: 'move',
      date: '1941-07-22',
    })
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.rule).toBe('专规 2.3e')

    expect(
      canSetModeAtSetup({
        ...BASE,
        side: 'soviet',
        to: 'strat',
        orientation: 'move',
        date: SOVIET_STRAT_MODE_FROM,
      }).ok,
    ).toBe(true)
    expect(
      canSetModeAtSetup({
        ...BASE,
        side: 'axis',
        to: 'strat',
        orientation: 'move',
        date: '1941-07-22',
      }).ok,
    ).toBe(true)
  })
})
