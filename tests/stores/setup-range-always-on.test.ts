import { describe, expect, it } from 'vitest'

import { hexDistance } from '@/engine/hex-geometry'
import { useMapViewStore } from '@/stores'
import { fresh } from '../flows/flow-harness'

/**
 * 初设 † 范围**常亮**与免选中拖动（用户 2026-11-18）
 *
 * 原文：`Axis divisions marked with a cross (†) can setup within 1 hex of the listed location`
 * ⇒ 轮到该方初设时，† 条目的 ±N 格一直铺在地图上；不得只有"点中某一枚"才亮，
 *   也不得把范围外的点击吞成"散开这一枚"（那样就没法先去布别的单位）。
 * 范围判定仍由 `planSetupPlacement` / `moveStackUnits` 给出，本文件只钉交互口径。
 */

const tolerantOf = (setup: ReturnType<typeof fresh>['setup'], pattern: RegExp) =>
  setup.entries.find((entry) => entry.placement === 'fixedTolerant' && pattern.test(entry.raw))!

const unitsAt = (ctx: ReturnType<typeof fresh>, hex: { col: number; row: number }) =>
  ctx.w.units.filter((unit) => unit.hex.col === hex.col && unit.hex.row === hex.row)

function tolerantUnit(ctx: ReturnType<typeof fresh>) {
  const entry = tolerantOf(ctx.setup, /29\s*Mtr/i)
  return unitsAt(ctx, { col: 34, row: 17 }).find((unit) =>
    entry.pieces.some((piece) => piece.unitId === unit.unitId),
  )!
}

describe('初设 † 范围常亮', () => {
  it('★ 未选中任何单位时，当前布设方的 † 范围仍铺在地图上', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('3')
    const mapView = useMapViewStore()
    mapView.stackSelection = []
    ctx.setup.cancelStackDisperse()

    const range = ctx.setup.rangeCandidatesOfSetupSide
    expect(range.length).toBeGreaterThan(0)
    expect(mapView.overlay.setupCandidates?.length).toBe(range.length)

    const side = ctx.setup.setupSideCursor
    expect(side).not.toBeNull()
    const anchors = ctx.setup.entries
      .filter((entry) => entry.side === side && entry.placement === 'fixedTolerant')
      .flatMap((entry) => entry.anchors)
    for (const hex of range) {
      expect(
        anchors.some((anchor) => hexDistance(anchor, hex) <= 1),
        `${String(hex.col)}.${String(hex.row)} 不在任何 † 锚格 ±1 内`,
      ).toBe(true)
    }
  })

  it('★ 不选中也能直接拖 † 算子，落点仍按该条目的 ±1 校验', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('3')
    const mapView = useMapViewStore()
    mapView.stackSelection = []

    const unit = tolerantUnit(ctx)
    expect(ctx.setup.beginStackDisperse(unit.instanceId)).toBe(true)
    const target = (ctx.setup.stackDisperse?.candidates ?? []).find(
      (hex) => hex.col !== unit.hex.col || hex.row !== unit.hex.row,
    )!
    expect(mapView.dropMovingCounterAt(unit.instanceId, target)).toBe(true)
    expect(unit.hex).toEqual(target)
  })

  it('★ 选中 † 算子后，范围外的格不被散开点击吞掉', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('3')
    const unit = tolerantUnit(ctx)
    expect(ctx.setup.beginStackDisperse(unit.instanceId)).toBe(true)
    const before = { ...unit.hex }

    expect(ctx.setup.moveStackUnitAtHex({ col: 1, row: 1 })).toBe(false)
    expect(unit.hex).toEqual(before)

    const inRange = (ctx.setup.stackDisperse?.candidates ?? []).find(
      (hex) => hex.col !== before.col || hex.row !== before.row,
    )!
    expect(ctx.setup.moveStackUnitAtHex(inRange)).toBe(true)
  })

  it('★ 开始放置别的初设项时收起上一枚的 ±1 选中态', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('3')
    const unit = tolerantUnit(ctx)
    expect(ctx.setup.beginStackDisperse(unit.instanceId)).toBe(true)
    expect(ctx.setup.stackDisperse).not.toBeNull()

    const choice = ctx.setup.selfChoiceEntries.find(
      (entry) => entry.side === ctx.setup.setupSideCursor && entry.placement === 'radius',
    )!
    expect(choice, '剧本 3 轴心应有 w/i 条件放置项').toBeDefined()
    expect(ctx.setup.beginSelfPlacement(choice.index)).toBe(true)
    expect(ctx.setup.stackDisperse).toBeNull()
  })
})
