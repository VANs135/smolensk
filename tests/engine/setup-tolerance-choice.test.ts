import { describe, expect, it } from 'vitest'

import {
  STACKING_RULE,
  WITHIN_RULE,
  planAutoSetup,
  planSetupPlacement,
  setupEntryViews,
} from '@/engine/rules'

/**
 * † 容差条目（`can setup within 1 hex of the listed location`）＝**整堆先落原文格**
 *
 * 原文（`Smolensk_Rules_v1.1.txt` 剧本 3/5/7）：
 *   `Axis divisions marked with a cross (†) can setup within 1 hex of the listed location.`
 *
 * 玩家口径（2026-11-17）：
 *   ① 初设开始时，原文写在该格的全部单位/编队**叠在原文格**（即使超过 10 RE）；
 *   ② 玩家在 ±1 内把它们散开，越界仍按 IV-A 硬拒；
 *   ③ 落到原文格时不再由引擎挑邻格，也不再把 † 当成初设栏自由项。
 * 本文件钉引擎侧：锚格落位、±1 候选、单枚散开时按**该枚当前 RE**核 10 RE。
 */
describe('† 初设：整堆落锚格、±1 内散开', () => {
  it.each(['3', '5', '7'] as const)('剧本 %s：† 全部落所列锚格，且不再进 choices', (scenarioId) => {
    const tolerant = setupEntryViews(scenarioId, 'axis').filter(
      (entry) => entry.placement === 'fixedTolerant',
    )
    expect(tolerant.length).toBeGreaterThan(0)
    const plan = planAutoSetup({ scenarioId })
    if (!plan.ok) throw new Error(plan.reason)
    const indexes = new Set(tolerant.map((entry) => entry.index))
    expect(plan.data.choices.some((choice) => indexes.has(choice.entryIndex))).toBe(false)
    for (const entry of tolerant) {
      const anchor = entry.anchors[0]
      if (anchor === undefined) throw new Error(`${entry.raw}: 应有锚格`)
      const pieces = plan.data.pieces.filter((piece) => piece.entryIndex === entry.index)
      expect(pieces.length, entry.raw).toBeGreaterThan(0)
      for (const piece of pieces) {
        expect(piece.hex, `${entry.raw} / ${piece.name}`).toEqual(anchor)
      }
    }
  })

  it('剧本 3 的 34.17：17 Pz / 29 Mtr 全部叠在 34.17（允许超 10 RE）', () => {
    const targets = setupEntryViews('3', 'axis').filter(
      (entry) =>
        entry.placement === 'fixedTolerant' &&
        entry.anchors[0]?.col === 34 &&
        entry.anchors[0]?.row === 17,
    )
    expect(targets.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['17 Pz Div', '29 Mtr Div']),
    )
    const plan = planAutoSetup({ scenarioId: '3' })
    if (!plan.ok) throw new Error(plan.reason)
    for (const entry of targets) {
      expect(entry.automatic).toBe(true)
      const pieces = plan.data.pieces.filter((piece) => piece.entryIndex === entry.index)
      expect(pieces.length).toBeGreaterThan(0)
      expect(pieces.every((piece) => piece.hex?.col === 34 && piece.hex?.row === 17)).toBe(true)
    }
  })

  it('散开仍在 ±1 内：范围外拒绝时给出锚格与半径', () => {
    const entry = setupEntryViews('3', 'axis').find(
      (row) => row.placement === 'fixedTolerant' && /29\s*Mtr/i.test(row.raw),
    )!
    const rejected = planSetupPlacement({ entry, targetHex: { col: 62, row: 34 } })
    expect(rejected).toMatchObject({ ok: false, rule: WITHIN_RULE })
    if (!rejected.ok) {
      expect(rejected.reason).toContain('锚格 34.17')
      expect(rejected.reason).toContain('半径 1 格')
    }
  })

  it('单枚散开按该枚当前 RE 核 10 RE（不是整条编队的 RE）', () => {
    const entry = setupEntryViews('3', 'axis').find(
      (row) => row.placement === 'fixedTolerant' && /29\s*Mtr/i.test(row.raw),
    )!
    const target = entry.anchors[0]!
    // 整条编队 RE 远大于 0.5：若仍按 `reOfEntry` 计，9.4 也会被拒
    const pieceRe = 0.5
    const roomy = planSetupPlacement({
      entry,
      targetHex: target,
      re: pieceRe,
      facts: { existingRe: () => 9.4 },
    })
    expect(roomy.ok).toBe(true)
    const stacked = planSetupPlacement({
      entry,
      targetHex: target,
      re: pieceRe,
      facts: { existingRe: () => 9.6 },
    })
    expect(stacked).toMatchObject({ ok: false, rule: STACKING_RULE })
  })
})
