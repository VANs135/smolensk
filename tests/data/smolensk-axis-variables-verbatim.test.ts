import { describe, expect, it } from 'vitest'

import { arrivalsAxis, rulesConstants } from '@/data'

/**
 * `Smolensk Axis Variables.png` = **印卡逐行核对**（2026-11-01）
 *
 * 卡面两张表：
 *   · **Variable Exit (3.3c)**：`1 → remove SS Reich (all)`；`2-5 → roll again next turn`；
 *     `6 → remove 14 Mtr (all)`；「Starting 19 August, roll on this table in Axis Reinforcement Phase.
 *     Check every turn until a division is removed… Stop rolling after one is withdrawn.」
 *   · **Random Events (3.6)**：`2-3 Bf.110` / `4 He.111` / `5-9 Supply Train` / `10 Ju.52` / `11-12 Ju.88`；
 *     「Roll from 19 July to 15 August (inclusive) in the Axis Reinforcement Phase.」
 *     Supply Train = 「2 SP of extra supply at any one detrainable hex (No Rail Cap is used)」。
 */
describe('Variable Exit（3.3c）', () => {
  it('骰面映射与起始日（19 Aug）照卡面', () => {
    expect(rulesConstants.smolensk.variableExitTable).toEqual({
      '1': 'remove SS Reich (all)',
      '2-5': 'roll again next turn',
      '6': 'remove 14 Mtr (all)',
    })
    expect(rulesConstants.smolensk.variableExitStart).toBe('1941-08-19')
  })
})

const randomEvents = arrivalsAxis.randomEvents!

describe('Random Events（3.6）', () => {
  it('区间与骰面映射照卡面', () => {
    expect(randomEvents.period).toContain('19 July')
    expect(randomEvents.period).toContain('15 August')
    expect(randomEvents.table).toEqual({
      '2-3': 'Bf.110',
      '4': 'He.111',
      '5-9': 'Supply Train',
      '10': 'Ju.52',
      '11-12': 'Ju.88',
    })
  })

  it('飞机事件 = 该型全部转非激活；Supply Train = 任一可卸货格 +2 SP、不用 Rail Cap', () => {
    expect(randomEvents.airResult).toContain('immediately become Inactive')
    expect(randomEvents.supplyTrain).toContain('2 SP')
    expect(randomEvents.supplyTrain).toContain('no Rail Cap')
  })

  it('可选 4.1b：Supply Train 改为 8 Jul / 12 Jul 自动发生', () => {
    expect(randomEvents.option4_1b).toContain('8 July')
    expect(randomEvents.option4_1b).toContain('12 July')
  })
})
