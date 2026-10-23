import { describe, expect, it } from 'vitest'

import { resolveAirCombat, resolveBarrage, resolveBarrageVsFacility } from '@/engine/rules'
import { resolveFlakLoss } from '@/engine/rules/air-interaction'
import {
  airCombatLookup,
  airCombatLossRoll,
  barrageCostT,
  barrageLookup,
  barrageVsFacilityLookup,
  captureLookup,
  flakKillCheck,
  flakMissionLoss,
} from '@/engine/tables'

/**
 * 判定表取表黄金样本（轰炸/对设施/夺取/防空/空战）
 */

describe('barrageLookup（10.0a）', () => {
  it('掷 2 出 "-"、掷 12 高值段出 "3"', () => {
    expect(barrageLookup(2, 1).code).toBe('-')
    expect(barrageLookup(12, 117).code).toBe('3')
  })

  it('列位值段与边界夹取', () => {
    expect(barrageLookup(10, 0).columnLabel).toBe('1 or less')
    expect(barrageLookup(10, 200).columnLabel).toBe('117+')
    expect(barrageLookup(7, 5).columnLabel).toBe('5-7')
  })

  it('成本行随列位返回（117+ → 10 T）', () => {
    expect(barrageCostT(117)).toBe(10)
    expect(barrageCostT(1)).toBe(1)
  })
})

describe('barrageVsFacilityLookup（10.0c）', () => {
  it('掷 4 高值段含 * 与飞机门槛', () => {
    const result = barrageVsFacilityLookup(4, 90)
    expect(result.code).toBe('2 * (4)')
    expect(result.columnLabel).toBe('81+')
  })

  it('低值低段无效果', () => {
    expect(barrageVsFacilityLookup(1, 1).code).toBe('-')
  })
})

describe('captureLookup（9.14b/c）', () => {
  it('各类别按骰面返回夺取百分比', () => {
    expect(captureLookup(6, 'wagons')).toBe(100)
    expect(captureLookup(6, 'dump')).toBe(75)
    expect(captureLookup(1, 'trucks')).toBe(0)
    expect(captureLookup(4, 'dump')).toBe(50)
  })
})

describe('flak（14.4e / 14.4f）', () => {
  it('修正 2d6 ≥ 11 击落一架', () => {
    expect(flakKillCheck(11)).toBe(true)
    expect(flakKillCheck(10)).toBe(false)
    expect(flakKillCheck(18)).toBe(true)
  })

  it('任务损失表：3 机掷 4 → 2 号机', () => {
    expect(flakMissionLoss(3, 4)).toBe('#2')
    expect(flakMissionLoss(4, 5)).toBe('W')
    expect(flakMissionLoss(4, 6)).toBe('S')
  })
})

describe('airCombatLookup（14.3e）', () => {
  it('修正骰 ≤6 攻方退出 / 7 双方 / ≥8 守方', () => {
    expect(airCombatLookup(6)).toBe('attacker_aborts')
    expect(airCombatLookup(7)).toBe('both_abort')
    expect(airCombatLookup(8)).toBe('defender_aborts')
    expect(airCombatLookup(2)).toBe('attacker_aborts')
  })

  it('损失骰 1–4 无损失 / 5–6 军力损失', () => {
    expect(airCombatLossRoll(4)).toBe('no_loss')
    expect(airCombatLossRoll(6)).toBe('step_loss')
  })
})

/**
 * M6⑤：三张表与 `rules/` 的**同答**（同一输入两处结论一致）
 *
 * ★ 这一组是 M0① 那条危害的回归保护：「测试测 `tables/` 那份、产品用 `rules/` 那份」⇒
 *   测试绿灯不能保证产品路径正确。故每条都**同时**问两处并断言相等，而不是各测各的常量。
 */
describe('M6⑤：表模块与 rules 同答（barrage / flak / air-combat）', () => {
  it('常规轰炸：半数值先按 4.2 取整 —— 表模块与 `resolveBarrage` 落到**同一列**', () => {
    for (const [die, value] of [
      [7, 2.5],
      [7, 1.5],
      [10, 24.5],
      [4, 3.5],
      [12, 117],
      [2, 1],
    ] as const) {
      const fromTable = barrageLookup(die, value)
      const fromRules = resolveBarrage({ die, valueRange: value })
      expect(fromTable.code, `掷 ${die}／轰炸值 ${value}`).toBe(fromRules.code)
      expect(fromTable.columnIndex).toBe(fromRules.initialColumn)
      expect(barrageCostT(value)).toBe(fromRules.costT)
    }
  })

  it('对设施轰炸：表模块与 `resolveBarrageVsFacility` 同格值（该表不取整）', () => {
    for (const [die, value] of [
      [3, 8],
      [6, 81],
      [1, 1],
      [5, 30.5],
    ] as const) {
      expect(barrageVsFacilityLookup(die, value).code).toBe(
        resolveBarrageVsFacility(die, value).code,
      )
    }
  })

  it('防空损失表：`flakMissionLoss` 与产品路径 `resolveFlakLoss` 取到同一格', () => {
    const planes = [
      { id: 'a', barrageStrength: 6 },
      { id: 'b', barrageStrength: 2 },
      { id: 'c', barrageStrength: 9 },
    ]
    for (let die = 1; die <= 6; die += 1) {
      const cell = flakMissionLoss(3, die)
      const picked = resolveFlakLoss(planes, die)
      // 位置序 '#N'：表里的编号就是候选序；W/S 则按轰炸值取最弱 / 最强
      if (/^#\d+$/.test(cell)) {
        expect(picked.aircraftId).toBe(planes[Number(cell.slice(1)) - 1]!.id)
      } else if (cell === 'W') {
        expect(picked.aircraftId).toBe('b')
      } else if (cell === 'S') {
        expect(picked.aircraftId).toBe('c')
      }
      expect(picked.code).toBe(cell)
    }
  })

  it('空战：`resolveAirCombat` 的三档与损失骰与表模块逐值一致', () => {
    for (let roll = 2; roll <= 12; roll += 1) {
      const fromTables = airCombatLookup(roll)
      const expected =
        fromTables === 'attacker_aborts'
          ? 'attacker'
          : fromTables === 'both_abort'
            ? 'both'
            : 'defender'
      expect(resolveAirCombat(roll).abortSide, `修正骰 ${roll}`).toBe(expected)
    }
    for (let die = 1; die <= 6; die += 1) {
      expect(resolveAirCombat(9, die).winnerLossRoll).toBe(airCombatLossRoll(die))
    }
    // 双方返航同样掷损失骰（返航者＝双方）
    expect(resolveAirCombat(7, 6)).toMatchObject({ abortSide: 'both', lossAppliesTo: 'both' })
  })
})
