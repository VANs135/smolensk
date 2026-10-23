import { describe, expect, it } from 'vitest'

import {
  advance,
  createRngState,
  DIE_FACES,
  nextFloat,
  nextUint32,
  pickIndex,
  replayFrom,
  RNG_ALGORITHM,
  roll1d6,
  roll2d6,
  rollDice,
  rollDie,
  verifyRngState,
} from '@/engine/rng'
import type { DiceRoll, RngState } from '@/engine/state-types'

/**
 * 随机数与种子管理（B2）测试
 *
 * 核心性质：同种子必得同序列（可复算）、骰面恒在 1..6、状态可从头重推。
 * 分布检查用固定种子，结果确定，不会出现偶发红灯。
 */

/** 连续掷 N 次单骰，返回骰面序列 */
function rollSequence(seed: number, times: number): number[] {
  let rng = createRngState(seed)
  const faces: number[] = []
  for (let index = 0; index < times; index += 1) {
    const draw = rollDie(rng)
    rng = draw.rng
    faces.push(draw.value)
  }
  return faces
}

/** 连续掷 N 次 2d6，返回合计序列 */
function roll2d6Totals(seed: number, times: number): number[] {
  let rng = createRngState(seed)
  const totals: number[] = []
  for (let index = 0; index < times; index += 1) {
    const draw = roll2d6(rng)
    rng = draw.rng
    totals.push(draw.value.total)
  }
  return totals
}

describe('RNG 常量与状态创建', () => {
  it('算法标识与骰面数', () => {
    expect(RNG_ALGORITHM).toBe('mulberry32')
    expect(DIE_FACES).toBe(6)
  })

  it('createRngState：seed 与 state 同为规范化值，drawCount 归零', () => {
    expect(createRngState(19410708)).toEqual({
      seed: 19410708,
      state: 19410708,
      drawCount: 0,
    })
  })

  it('createRngState：负数 / 小数 / 非有限值都收敛为 32 位无符号整数', () => {
    for (const raw of [-1, 1.9, -1.9, Number.NaN, Number.POSITIVE_INFINITY]) {
      const rng = createRngState(raw)
      expect(Number.isInteger(rng.seed)).toBe(true)
      expect(rng.seed).toBeGreaterThanOrEqual(0)
      expect(rng.seed).toBeLessThan(2 ** 32)
    }
    // 2^32 取模回绕
    expect(createRngState(2 ** 32 + 7).seed).toBe(7)
  })
})

describe('可复算性（任一结算可复算）', () => {
  it('同种子必得同序列', () => {
    expect(rollSequence(19410708, 30)).toEqual(rollSequence(19410708, 30))
  })

  it('不同种子给出不同序列', () => {
    expect(rollSequence(1, 30)).not.toEqual(rollSequence(2, 30))
  })

  it('纯函数：同一状态反复使用，取值相同（消费后须用返回的新状态）', () => {
    const rng = createRngState(42)
    const first = rollDie(rng)
    const second = rollDie(rng)
    expect(first.value).toBe(second.value)
    expect(first.rng).toEqual(second.rng)
  })

  it('掷骰序列可由种子重放：整局复算一致', () => {
    const seed = 19410708
    // 首局：混合掷 1d6 / 2d6 若干次
    let rng = createRngState(seed)
    const firstRun: DiceRoll[] = []
    for (let index = 0; index < 12; index += 1) {
      const draw = index % 2 === 0 ? roll1d6(rng) : roll2d6(rng)
      rng = draw.rng
      firstRun.push(draw.value)
    }
    const draws = rng.drawCount
    const finalState = rng.state

    // 复算：仅凭 seed + drawCount 重推最终状态，再重放同一序列
    expect(replayFrom(seed, draws).state).toBe(finalState)
    let replay = replayFrom(seed, 0)
    const secondRun: DiceRoll[] = []
    for (let index = 0; index < 12; index += 1) {
      const draw = index % 2 === 0 ? roll1d6(replay) : roll2d6(replay)
      replay = draw.rng
      secondRun.push(draw.value)
    }
    expect(secondRun).toEqual(firstRun)
  })

  it('verifyRngState：合法存档通过，篡改/越界不通过', () => {
    let rng = createRngState(19410708)
    for (let index = 0; index < 5; index += 1) rng = rollDie(rng).rng

    expect(verifyRngState(rng)).toBe(true)
    expect(verifyRngState(createRngState(1))).toBe(true)

    // 内部状态被改 → 与 seed + drawCount 不一致
    expect(verifyRngState({ ...rng, state: rng.state + 1 })).toBe(false)
    // 游标被改
    expect(verifyRngState({ ...rng, drawCount: rng.drawCount + 1 })).toBe(false)
    // 种子被改
    expect(verifyRngState({ ...rng, seed: rng.seed + 1 })).toBe(false)
    // 非法数值
    expect(verifyRngState({ seed: 1.5, state: 1, drawCount: 0 })).toBe(false)
    expect(verifyRngState({ seed: -1, state: 0, drawCount: 0 })).toBe(false)
  })
})

describe('掷骰取值域', () => {
  it('rollDie 恒在 1..6', () => {
    for (const face of rollSequence(7, 2000)) {
      expect(face).toBeGreaterThanOrEqual(1)
      expect(face).toBeLessThanOrEqual(6)
    }
  })

  it('roll1d6 返回 count=1、faces 长度 1、total 与骰面一致', () => {
    const { value } = roll1d6(createRngState(3))
    expect(value.count).toBe(1)
    expect(value.faces).toHaveLength(1)
    expect(value.total).toBe(value.faces[0])
  })

  it('roll2d6 恒在 2..12 且 total 为两骰之和', () => {
    let rng = createRngState(11)
    for (let index = 0; index < 1000; index += 1) {
      const draw = roll2d6(rng)
      rng = draw.rng
      expect(draw.value.count).toBe(2)
      expect(draw.value.faces).toHaveLength(2)
      expect(draw.value.total).toBe((draw.value.faces[0] ?? 0) + (draw.value.faces[1] ?? 0))
      expect(draw.value.total).toBeGreaterThanOrEqual(2)
      expect(draw.value.total).toBeLessThanOrEqual(12)
    }
  })

  it('rollDice 骰数非法即抛错', () => {
    const rng = createRngState(1)
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => rollDice(rng, bad)).toThrow(RangeError)
    }
  })

  it('六面分布均匀（固定种子，60000 次；各面在 9500–10500 之间）', () => {
    const counts = new Map<number, number>()
    for (const face of rollSequence(19410708, 60000)) {
      counts.set(face, (counts.get(face) ?? 0) + 1)
    }
    expect([...counts.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6])
    for (const face of [1, 2, 3, 4, 5, 6]) {
      const count = counts.get(face) ?? 0
      expect(count).toBeGreaterThan(9500)
      expect(count).toBeLessThan(10500)
    }
  })

  it('2d6 合计呈钟形：7 出现最多，2 与 12 最少', () => {
    const totals = roll2d6Totals(19410708, 60000)
    const countOf = (target: number) => totals.filter((t) => t === target).length
    expect(countOf(7)).toBeGreaterThan(countOf(6))
    expect(countOf(7)).toBeGreaterThan(countOf(8))
    expect(countOf(2)).toBeLessThan(countOf(3))
    expect(countOf(12)).toBeLessThan(countOf(11))
  })
})

describe('状态推进与游标', () => {
  it('每次抽取 drawCount +1，seed 保持不变', () => {
    const start = createRngState(5)
    const after1 = nextUint32(start)
    expect(start.drawCount).toBe(0)
    expect(after1.rng.drawCount).toBe(1)
    expect(after1.rng.seed).toBe(5)

    const after2 = nextUint32(after1.rng)
    expect(after2.rng.drawCount).toBe(2)
  })

  it('nextFloat 落在 [0,1)', () => {
    let rng = createRngState(9)
    for (let index = 0; index < 500; index += 1) {
      const draw = nextFloat(rng)
      rng = draw.rng
      expect(draw.value).toBeGreaterThanOrEqual(0)
      expect(draw.value).toBeLessThan(1)
    }
  })

  it('advance 与逐个抽取等价', () => {
    const start = createRngState(77)
    let stepped = start
    for (let index = 0; index < 10; index += 1) stepped = nextUint32(stepped).rng
    expect(advance(start, 10)).toEqual(stepped)
    expect(advance(start, 0)).toEqual(start)
  })

  it('pickIndex 抽取盒用：下标恒在 [0,size)、同种子同序列、size=1 恒 0', () => {
    // 取值域
    let rng = createRngState(1941)
    for (let index = 0; index < 500; index += 1) {
      const draw = pickIndex(rng, 7)
      rng = draw.rng
      expect(draw.value).toBeGreaterThanOrEqual(0)
      expect(draw.value).toBeLessThan(7)
    }
    // 可复算：同种子同序列（抽取盒的抽签必须能重放）
    const first: number[] = []
    let a = createRngState(2024)
    for (let index = 0; index < 20; index += 1) {
      const draw = pickIndex(a, 12)
      a = draw.rng
      first.push(draw.value)
    }
    const second: number[] = []
    let b = createRngState(2024)
    for (let index = 0; index < 20; index += 1) {
      const draw = pickIndex(b, 12)
      b = draw.rng
      second.push(draw.value)
    }
    expect(second).toEqual(first)
    // 单候选不消耗随机数
    const single = pickIndex(createRngState(5), 1)
    expect(single.value).toBe(0)
    expect(single.rng.drawCount).toBe(0)
    // 非法候选个数
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => pickIndex(createRngState(1), bad)).toThrow(RangeError)
    }
  })

  it('advance 步数非法即抛错', () => {
    const rng = createRngState(1)
    for (const bad of [-1, 2.5, Number.NaN]) {
      expect(() => advance(rng, bad)).toThrow(RangeError)
    }
    expect(() => replayFrom(1, -1)).toThrow(RangeError)
  })

  it('replayFrom(seed, 0) 等于新建状态', () => {
    const rng: RngState = replayFrom(123, 0)
    expect(rng).toEqual(createRngState(123))
  })
})
