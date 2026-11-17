import { describe, expect, it } from 'vitest'

import { hexDistance } from '@/engine/hex-geometry'
import {
  STACKING_RULE,
  WITHIN_RULE,
  planAutoSetup,
  planSetupPlacement,
  setupEntryViews,
} from '@/engine/rules'

/**
 * † 容差条目（`can setup within 1 hex of the listed location`）属**许可式**
 *
 * 原文（`Smolensk_Rules_v1.1.txt` 剧本 3/5/7）：
 *   `Axis divisions marked with a cross (†) can setup within 1 hex of the listed location.`
 *
 * 许可式 ⇒ 应交给玩家在锚格 ±1 内点格；引擎不得在 `planAutoSetup` 里替玩家定死。
 * 本文件钉三件事：
 *   ① † 不再产生自动落位棋子，而是进入 `choices`；
 *   ② 候选格全在锚格半径内（含边界）；
 *   ③ 越界拒绝时给出锚格与半径（不是只给一个模糊的 allowed 列表）。
 */
describe('† 初设：许可式范围交玩家选格', () => {
  it.each(['3', '5', '7'] as const)('剧本 %s：† 条目全部进入 choices，自动棋子为 0', (id) => {
    const tolerant = setupEntryViews(id, 'axis').filter(
      (entry) => entry.placement === 'fixedTolerant',
    )
    expect(tolerant.length).toBeGreaterThan(0)
    const plan = planAutoSetup({ scenarioId: id })
    if (!plan.ok) throw new Error(plan.reason)
    const indexes = new Set(tolerant.map((entry) => entry.index))
    expect(plan.data.pieces.some((piece) => indexes.has(piece.entryIndex))).toBe(false)
    const choices = new Map(plan.data.choices.map((choice) => [choice.entryIndex, choice]))
    for (const entry of tolerant) {
      const choice = choices.get(entry.index)
      expect(choice, entry.raw).toBeDefined()
      expect(choice!.candidates.length, entry.raw).toBeGreaterThan(0)
      const anchor = entry.anchors[0]!
      expect(choice!.candidates).toContainEqual(anchor)
      for (const hex of choice!.candidates) {
        expect(
          hexDistance(anchor, hex),
          `${entry.raw} → ${hex.col}.${hex.row}`,
        ).toBeLessThanOrEqual(entry.radius ?? 1)
      }
    }
  })

  it('剧本 3 的 34.17 两个 † 编队：17 Pz / 29 Mtr 都是玩家选格', () => {
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
      expect(plan.data.choices.some((choice) => choice.entryIndex === entry.index)).toBe(true)
    }
  })

  it('范围外拒绝时给出锚格与半径', () => {
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

  it('玩家在 † 范围内落位仍受 10 RE 上限（IV-F / 4.8）', () => {
    const entry = setupEntryViews('3', 'axis').find(
      (row) => row.placement === 'fixedTolerant' && /29\s*Mtr/i.test(row.raw),
    )!
    const stacked = planSetupPlacement({
      entry,
      targetHex: entry.anchors[0]!,
      facts: { existingRe: () => 9.5 },
    })
    expect(stacked).toMatchObject({ ok: false, rule: STACKING_RULE })
    const roomy = planSetupPlacement({
      entry,
      targetHex: entry.anchors[0]!,
      facts: { existingRe: () => 0 },
    })
    expect(roomy.ok).toBe(true)
  })
})
