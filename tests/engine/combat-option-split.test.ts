import { describe, expect, it } from 'vitest'

import {
  chooseOptionSplit,
  planOptionSplits,
  type OptionLadderStep,
  type OptionLanding,
} from '@/engine/rules/combat-option-split'

/**
 * 9.10a / 9.12：选项切分的候选顺序
 *
 * 规则前提：`retreatHexes + lossPoints` 必须等于选项总数；损失点不得超过该方可用军力（9.11）；
 * 撤退格数受「可撤退性」限制（9.12 末段括注）。本模块只排顺序，不判合法性。
 */

function step(distance: number, landings: readonly OptionLanding[]): OptionLadderStep {
  const units = landings.map((landing, index) => ({ unitId: `u${String(index + 1)}`, landing }))
  return {
    distance,
    units,
    allSafe: units.every((unit) => unit.landing === 'safe'),
    allHaveLanding: units.every((unit) => unit.landing !== 'none'),
  }
}

describe('planOptionSplits：优先退、其次吃', () => {
  it('全员安全 ⇒ 退满，不损失', () => {
    const splits = planOptionSplits({
      options: 2,
      capacity: 4,
      ladder: [step(1, ['safe']), step(2, ['safe'])],
    })
    expect(splits[0]).toEqual({ retreatHexes: 2, lossPoints: 0 })
  })

  it('退满不安全但退 1 格安全 ⇒ 退 1 + 吃 1', () => {
    const splits = planOptionSplits({
      options: 2,
      capacity: 4,
      ladder: [step(1, ['safe']), step(2, ['doomed'])],
    })
    expect(splits[0]).toEqual({ retreatHexes: 1, lossPoints: 1 })
  })

  it('可用军力不足时，「全吃」不入候选，但「退满」仍在（损失 0）', () => {
    const splits = planOptionSplits({
      options: 2,
      capacity: 1,
      ladder: [step(1, ['safe']), step(2, ['safe'])],
    })
    // 退满最省，且 0 损失 ≤ 可用军力 ⇒ 首选仍是退满
    expect(splits[0]).toEqual({ retreatHexes: 2, lossPoints: 0 })
    // 全吃要求 2 点损失 > 1 点军力 ⇒ 不在候选里
    expect(splits.some((split) => split.lossPoints === 2)).toBe(false)
  })

  it('只有必死落点 ⇒ 先吃损失，必死撤退排最后（不白送单位）', () => {
    const splits = planOptionSplits({
      options: 1,
      capacity: 1,
      ladder: [step(1, ['doomed'])],
    })
    expect(splits[0]).toEqual({ retreatHexes: 0, lossPoints: 1 })
    expect(splits[splits.length - 1]).toEqual({ retreatHexes: 1, lossPoints: 0 })
  })

  it('损失吃不动时，必死撤退才上桌（9.12 兜底，且排在安全档之后）', () => {
    const splits = planOptionSplits({
      options: 2,
      capacity: 1,
      ladder: [step(1, ['safe']), step(2, ['doomed'])],
    })
    // 退 1 + 吃 1 是首选；退满（必死）只因损失吃不动才保留，且排在后面
    expect(splits[0]).toEqual({ retreatHexes: 1, lossPoints: 1 })
    if (splits.length > 1) expect(splits[1]).toEqual({ retreatHexes: 2, lossPoints: 0 })
  })

  it('无选项 ⇒ 唯一解 (0,0)；同一撤退格数不重复', () => {
    expect(planOptionSplits({ options: 0, capacity: 3, ladder: [] })).toEqual([
      { retreatHexes: 0, lossPoints: 0 },
    ])
    const splits = planOptionSplits({
      options: 2,
      capacity: 3,
      ladder: [step(1, ['safe']), step(2, ['safe'])],
    })
    expect(new Set(splits.map((split) => split.retreatHexes)).size).toBe(splits.length)
  })

  it('每条候选都满足 9.10a（和＝选项数）且损失不超可用军力（9.11）', () => {
    const splits = planOptionSplits({
      options: 3,
      capacity: 1,
      ladder: [step(1, ['safe']), step(2, ['none']), step(3, ['doomed'])],
    })
    expect(splits.length).toBeGreaterThan(0)
    for (const split of splits) {
      expect(split.retreatHexes + split.lossPoints).toBe(3)
      expect(split.lossPoints).toBeLessThanOrEqual(1)
      expect(split.retreatHexes).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('chooseOptionSplit：没有候选时退回全吃，由引擎给真实拒绝原因', () => {
  it('有候选 ⇒ 取第一条', () => {
    expect(chooseOptionSplit({ options: 1, capacity: 2, ladder: [step(1, ['safe'])] })).toEqual({
      retreatHexes: 1,
      lossPoints: 0,
    })
  })

  it('无候选 ⇒ (0, 选项数)，不编造撤退格数', () => {
    expect(chooseOptionSplit({ options: 3, capacity: 0, ladder: [] })).toEqual({
      retreatHexes: 0,
      lossPoints: 3,
    })
  })
})
