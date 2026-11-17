import { describe, expect, it } from 'vitest'

import { hexDistance } from '@/engine/hex-geometry'
import { currentReOf } from '@/stores/workbench-model'
import { fresh } from '../flows/flow-harness'

/**
 * 剧本 3 的 34.17：† 许可式条目必须出现在「玩家自定义初设」里
 *
 * 原文：`34.17: … 17 Pz Div (…) † / 29 Mtr Div (…) †`，
 * 注 `Axis divisions marked with a cross (†) can setup within 1 hex of the listed location.`
 * ⇒ 玩家在 34.17 ±1 内自选，不是引擎替他定死。
 */
describe('† 初设：面板可自选（剧本 3 的 34.17）', () => {
  const tolerantOf = (setup: ReturnType<typeof fresh>['setup'], pattern: RegExp) =>
    setup.entries.find((entry) => entry.placement === 'fixedTolerant' && pattern.test(entry.raw))!

  it('runAutoSetup 只把 † 预置成可改的一格，清单仍待玩家定夺', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('3')
    for (const pattern of [/17\s*Pz/i, /29\s*Mtr/i]) {
      const entry = tolerantOf(ctx.setup, pattern)
      expect(ctx.setup.selfChoiceEntries.some((row) => row.index === entry.index)).toBe(true)
      const item = ctx.setup.pendingPlacement.find((row) => row.entryIndex === entry.index)
      expect(item, entry.raw).toBeDefined()
      expect(item!.remaining).toBe(1)
      expect(item!.candidates.length).toBeGreaterThan(0)
      const provisional = item!.provisionalHex
      expect(provisional, entry.raw).not.toBeUndefined()
      const [col, row] = provisional!.split('.').map(Number)
      expect(hexDistance({ col: 34, row: 17 }, { col: col!, row: row! })).toBeLessThanOrEqual(1)
      // 预置不是记账：进度仍是 0，面板不把它算作已完成
      expect(ctx.setup.completed[`self:${entry.index}`]).not.toBe(true)
    }
    // 17 Pz 与 29 Mtr 不能都被硬塞进 34.17：各自预置格的 RE 必须 ≤10
    const hexes = [/17\s*Pz/i, /29\s*Mtr/i].map((pattern) => {
      const entry = tolerantOf(ctx.setup, pattern)
      return ctx.setup.pendingPlacement.find((row) => row.entryIndex === entry.index)!
        .provisionalHex!
    })
    for (const label of hexes) {
      const [col, row] = label.split('.').map(Number)
      const re = ctx.w.units
        .filter((unit) => unit.hex.col === col && unit.hex.row === row)
        .reduce((sum, unit) => sum + currentReOf(unit), 0)
      expect(re, label).toBeLessThanOrEqual(10)
    }
  })

  it('玩家可点 34.17 邻格；点范围外被拒并给出锚格与半径', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('3')
    const entry = tolerantOf(ctx.setup, /29\s*Mtr/i)

    ctx.setup.setSelfChoice(entry.index, '62.34')
    expect(ctx.setup.placeSelfEntry(entry.index)).toBe(false)
    expect(ctx.setup.lastAction?.detail).toContain('锚格 34.17')
    expect(ctx.setup.lastAction?.detail).toContain('半径 1 格')

    const candidates = ctx.setup.candidatesOf(entry.index)
    let placed = false
    for (const hex of candidates) {
      ctx.setup.setSelfChoice(entry.index, `${hex.col}.${hex.row}`)
      if (ctx.setup.placeSelfEntry(entry.index)) {
        placed = true
        break
      }
    }
    expect(placed).toBe(true)
    expect(ctx.setup.completed[`self:${entry.index}`]).toBe(true)
  })

  it('一键预设仍把 † 落进可改的合法格（不是留空，也不是硬塞超堆叠）', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('3')
    const preset = ctx.setup.presetSelfSetupNow()
    expect(preset.failures).toEqual([])
    for (const pattern of [/17\s*Pz/i, /29\s*Mtr/i]) {
      const entry = tolerantOf(ctx.setup, pattern)
      expect(ctx.setup.placedSelfInstances[entry.index]).toBe(1)
      expect(ctx.setup.completed[`self:${entry.index}`]).toBe(true)
    }
  })
})
