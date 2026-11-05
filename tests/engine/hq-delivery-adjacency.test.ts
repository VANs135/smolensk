import { describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import type { TraceSupplyFacts } from '@/engine/rules'
import {
  canThrowViaHQ,
  countSupplyDistanceToAny,
  countSupplyDistanceToUnitViaTable,
} from '@/engine/rules'
import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'

/**
 * R2（12.3c 读法 A）：**指挥部投递**的终点可为「单位格或其任一相邻格」
 *
 * ## 原文
 *   **12.3c**：无论地形如何（即使是禁入地形），只要补给能到达**单位的相邻格**，那么单位就可以获得补给。
 *   这适用于所有使用直接拖取或**指挥部投递**的补给机制。
 *
 * ## 判据（用户裁定的读法 A，务必精确）
 *   · 投递范围从 HQ 沿路径按 MP 累计（本夹具的轮式 10 MP 道路为 0.5 MP/格 ⇒ **第 20 格为最远格**）；
 *   · 待判单位**所在格**不在范围内时，看其**任一相邻格**是否在范围内；
 *   · **不是**"把范围整体扩一格"（第 22 格必须仍不可得）；
 *   · 单位格本身不可进入（禁入地形）时，仍可由相邻格获得。
 */

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`
const START: HexRef = { col: 20, row: 10 }
/** 一条直线道路的方向（取六邻方向之一，逐格 neighbor 即一条连续直线） */
const DIRECTION = HEX_DIRECTIONS[0]!

/** 从 HQ 格起、沿同一方向连续的第 0..n-1 格 */
function corridor(length: number): HexRef[] {
  const hexes: HexRef[] = [START]
  for (let index = 1; index < length; index += 1) {
    hexes.push(neighbor(hexes[index - 1]!, DIRECTION))
  }
  return hexes
}

const LINE = corridor(40)
const ON_LINE = new Set(LINE.map(label))

/**
 * 只由这条「走廊」组成的合成盘面：走廊外的格不在图上；
 * `costPerStep` 即每格消耗（道路 0.5 / 非道路 1）；`blocked` 中的格**不可进入**（禁入地形）。
 */
function makeFacts(costPerStep: number, blocked: readonly HexRef[] = []): TraceSupplyFacts {
  const blockedKeys = new Set(blocked.map(label))
  return {
    onMap: (hex) => ON_LINE.has(label(hex)),
    sourcesFor: () => [],
    extendersFor: () => [],
    throwHqsFor: () => [],
    dumpsFor: () => [],
    hasEnemyCombatUnit: () => false,
    inEnemyZoc: () => false,
    stepCost: (from, to) =>
      ON_LINE.has(label(from)) && ON_LINE.has(label(to)) && !blockedKeys.has(label(to))
        ? costPerStep
        : null,
  }
}

const HQ = LINE[0]!
const side: Side = 'axis'

/** 与 `hqDeliveryDumpKeys` 同口径：12.3c 邻接目标 + 12.3b 投递距离裁决 */
function canDeliver(unitHex: HexRef, maxMp: number, facts = makeFacts(0.5)): boolean {
  const reach = countSupplyDistanceToUnitViaTable(facts, {
    from: HQ,
    unitHex,
    side,
    mobility: 'truck',
    maxMp,
  })
  return canThrowViaHQ({
    hqMode: 'move',
    distanceMp: reach.ok ? reach.mp : Number.POSITIVE_INFINITY,
    throwRangeMp: maxMp,
  }).ok
}

describe('12.3c：10 MP 摩托化投递 + 20 格连续道路（0.5 MP/格）', () => {
  it('★ 第 20 格（消耗恰 10.0 MP）⇒ 可获得', () => {
    expect(canDeliver(LINE[20]!, 10)).toBe(true)
  })

  it('★ 第 21 格（自身在外、邻格=第 20 格）⇒ 可获得（读法 A）', () => {
    expect(canDeliver(LINE[21]!, 10)).toBe(true)
    // 读法 A 的**精确性**：第 21 格自身的距离确实是 10.5 MP（并非把范围整体扩到 21 格）
    const own = countSupplyDistanceToAny(makeFacts(0.5), {
      from: HQ,
      targets: [LINE[21]!],
      side,
      mobility: 'truck',
      maxMp: 10,
    })
    expect(own.ok).toBe(false)
  })

  it('★ 第 22 格（自身与全部相邻格都在范围外）⇒ 不可获得', () => {
    // 走廊只有前后两邻在图上：第 21 格 = 10.5 MP、第 23 格 = 11.5 MP ⇒ 均 > 10
    expect(canDeliver(LINE[22]!, 10)).toBe(false)
  })

  it('★ 单位格不可进入（禁入地形），邻格在范围内 ⇒ 可获得', () => {
    const facts = makeFacts(0.5, [LINE[21]!])
    const reach = countSupplyDistanceToUnitViaTable(facts, {
      from: HQ,
      unitHex: LINE[21]!,
      side,
      mobility: 'truck',
      maxMp: 10,
    })
    expect(reach).toEqual({ ok: true, mp: 10 })
    expect(canDeliver(LINE[21]!, 10, facts)).toBe(true)
    // 与 `canEatOffTheMap` 同口径：单位格本身不可达，但邻格可达即成立
  })

  it('★ 非道路地形（1 MP/格）：第 10 格可得、第 11 格经邻格可得、第 12 格不可得', () => {
    const facts = makeFacts(1)
    expect(canDeliver(LINE[10]!, 10, facts)).toBe(true)
    expect(canDeliver(LINE[11]!, 10, facts)).toBe(true)
    expect(canDeliver(LINE[12]!, 10, facts)).toBe(false)
  })

  it('★ 8 MP 投递（苏军印值）：道路第 16 格可得、第 17 格经邻格可得、第 18 格不可', () => {
    const facts = makeFacts(0.5)
    expect(canDeliver(LINE[16]!, 8, facts)).toBe(true)
    expect(canDeliver(LINE[17]!, 8, facts)).toBe(true)
    expect(canDeliver(LINE[18]!, 8, facts)).toBe(false)
  })
})

describe('读表版与逐目标版同值（改造不改变最小距离口径）', () => {
  it('对同一组目标，`countSupplyDistanceToUnitViaTable` 与 `countSupplyDistanceToAny` 的 min 值一致', () => {
    const facts = makeFacts(0.5)
    for (const index of [0, 5, 19, 20, 21, 22, 30]) {
      const viaTable = countSupplyDistanceToUnitViaTable(facts, {
        from: HQ,
        unitHex: LINE[index]!,
        side,
        mobility: 'truck',
        maxMp: 10,
      })
      const any = countSupplyDistanceToAny(facts, {
        from: HQ,
        targets: [LINE[index]!, ...HEX_DIRECTIONS.map((d) => neighbor(LINE[index]!, d))],
        side,
        mobility: 'truck',
        maxMp: 10,
      })
      expect(viaTable).toEqual(any)
    }
  })
})
