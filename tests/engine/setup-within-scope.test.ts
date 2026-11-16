import { describe, expect, it } from 'vitest'

import { hexDistance } from '@/engine/hex-geometry'
import {
  WITHIN_RULE,
  planAutoSetup,
  planSetupPlacement,
  setupCandidates,
  setupEntryViews,
} from '@/engine/rules'

/**
 * 初设的「指定一格内」范围校验（通规 IV-A + 专规 Setup Notes）
 *
 * 原文（`Smolensk_Rules_v1.1.txt`）：
 *   · 剧本 1 苏军：`w/i 3 hexes of 34.17 or 34.18:`（两个锚格各 3 格内，含边界）；
 *   · 剧本 3 德军：`w/i 1 hex of 31.17:`（1 格内）；
 *   · 剧本 3/5/7 德军：`Axis divisions marked with a cross (†) can setup within 1 hex of the
 *     listed location.`（每条所列格 ±1 格）；
 *   · 剧本 5.1/5.2 可选 4.3：`1.Mot Div can now setup within 1 hex of 18.17`（另有用例覆盖）；
 *   · Intro / Vitebsk 的 text notation 不含任何 `w/i` / `within X hexes`。
 *
 * 本文件只钉「引擎是否把范围当硬约束」：范围外一律 `IV-A` 拒，范围内（含边界）通过。
 */

const FAR = { col: 62, row: 34 }

describe('初设范围：w/i 3 hexes of 34.17 or 34.18（剧本 1 苏军）', () => {
  const rows = setupEntryViews('1', 'soviet').filter((entry) => entry.placement === 'radius')

  it('10 条都解析成半径 3，且保留两个锚格', () => {
    expect(rows).toHaveLength(10)
    for (const entry of rows) {
      expect(entry.radius, entry.raw).toBe(3)
      expect(entry.anchors).toEqual([
        { col: 34, row: 17 },
        { col: 34, row: 18 },
      ])
    }
  })

  it('候选范围内的格通过；两个锚格都超出 3 格的格即拒（IV-A）', () => {
    for (const entry of rows) {
      const inside = setupCandidates(entry)[0]
      if (inside === undefined) throw new Error(`${entry.raw}: 应有候选格`)
      expect(planSetupPlacement({ entry, targetHex: inside }).ok, entry.raw).toBe(true)

      const rejected = planSetupPlacement({ entry, targetHex: FAR })
      expect(rejected, entry.raw).toMatchObject({ ok: false, rule: WITHIN_RULE })
      if (!rejected.ok) expect(rejected.reason).toContain('setupHexOutOfRange')
    }
  })
})

describe('初设范围：w/i 1 hex of 31.17（剧本 3 德军）', () => {
  const rows = setupEntryViews('3', 'axis').filter(
    (entry) => entry.placement === 'radius' && entry.anchors[0]?.col === 31,
  )

  it('10 条都解析成半径 1、锚格 31.17', () => {
    expect(rows).toHaveLength(10)
    for (const entry of rows) {
      expect(entry.radius, entry.raw).toBe(1)
      expect(entry.anchors).toEqual([{ col: 31, row: 17 }])
    }
  })

  it('1 格内通过；范围外即拒（IV-A）', () => {
    for (const entry of rows) {
      const inside = setupCandidates(entry)[0]
      if (inside === undefined) throw new Error(`${entry.raw}: 应有候选格`)
      expect(planSetupPlacement({ entry, targetHex: inside }).ok, entry.raw).toBe(true)
      expect(planSetupPlacement({ entry, targetHex: FAR }), entry.raw).toMatchObject({
        ok: false,
        rule: WITHIN_RULE,
      })
    }
  })
})

describe('初设范围：† 所列位置 ±1 格（剧本 3/5/7 德军）', () => {
  it.each(['3', '5', '7'] as const)('剧本 %s：† 条目半径 1，范围外即拒', (scenarioId) => {
    const rows = setupEntryViews(scenarioId, 'axis').filter(
      (entry) => entry.placement === 'fixedTolerant',
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const entry of rows) {
      expect(entry.radius, entry.raw).toBe(1)
      const anchor = entry.anchors[0]
      if (anchor === undefined) throw new Error(`${entry.raw}: 应有锚格`)
      expect(planSetupPlacement({ entry, targetHex: anchor }).ok, entry.raw).toBe(true)
      expect(planSetupPlacement({ entry, targetHex: FAR }), entry.raw).toMatchObject({
        ok: false,
        rule: WITHIN_RULE,
      })
    }
  })

  it.each(['3', '5', '7'] as const)('剧本 %s：自动落位的 † 单位都在所列格 1 格内', (scenarioId) => {
    const plan = planAutoSetup({ scenarioId })
    if (!plan.ok) throw new Error(plan.reason)
    const tolerant = setupEntryViews(scenarioId, 'axis').filter(
      (entry) => entry.placement === 'fixedTolerant',
    )
    for (const entry of tolerant) {
      const anchor = entry.anchors[0]
      if (anchor === undefined) throw new Error(`${entry.raw}: 应有锚格`)
      const placed = plan.data.pieces.filter((piece) => piece.entryIndex === entry.index)
      expect(placed.length, entry.raw).toBeGreaterThan(0)
      for (const piece of placed) {
        if (piece.hex === null) continue // 死亡堆 / 无可落格
        expect(
          hexDistance(anchor, piece.hex),
          `${entry.raw} → ${piece.hexText}`,
        ).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('初设范围：Intro 没有 w/i / within 限定', () => {
  it('Intro 的条目全是固定格 / 基地盒 / 死亡堆，不含 radius / fixedTolerant', () => {
    const rows = setupEntryViews('Intro')
    expect(rows.filter((entry) => entry.placement === 'radius')).toEqual([])
    expect(rows.filter((entry) => entry.placement === 'fixedTolerant')).toEqual([])
  })
})
