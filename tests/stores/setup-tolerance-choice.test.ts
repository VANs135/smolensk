import { describe, expect, it } from 'vitest'

import { hexDistance } from '@/engine/hex-geometry'
import { hexCanvasPoint } from '@/render/map-layout'
import { currentReOf, useMapViewStore } from '@/stores'
import { fresh } from '../flows/flow-harness'

/**
 * 剧本 3 的 34.17：† 编队初设时**整堆叠在原文格**，由玩家在 ±1 内散开
 *
 * 原文：`34.17: … 17 Pz Div (…) † / 29 Mtr Div (…) †`，
 * 注 `Axis divisions marked with a cross (†) can setup within 1 hex of the listed location.`
 * ⇒ 默认留在 34.17（可超 10 RE）；超限时必须散开，散开仍按 IV-A / 10 RE / 9.11d 校验。
 */
describe('† 初设：整堆落原文格、盘面散开（剧本 3 的 34.17）', () => {
  const tolerantOf = (setup: ReturnType<typeof fresh>['setup'], pattern: RegExp) =>
    setup.entries.find((entry) => entry.placement === 'fixedTolerant' && pattern.test(entry.raw))!

  const unitsAt = (ctx: ReturnType<typeof fresh>, hex: { col: number; row: number }) =>
    ctx.w.units.filter((unit) => unit.hex.col === hex.col && unit.hex.row === hex.row)

  it('runAutoSetup 后 17 Pz / 29 Mtr 全部在 34.17，且不再列进初设栏', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('3')
    for (const pattern of [/17\s*Pz/i, /29\s*Mtr/i]) {
      const entry = tolerantOf(ctx.setup, pattern)
      expect(ctx.setup.selfChoiceEntries.some((row) => row.index === entry.index)).toBe(false)
      expect(ctx.setup.pendingPlacement.some((row) => row.entryIndex === entry.index)).toBe(false)
      const unitIds = new Set(entry.pieces.map((piece) => piece.unitId))
      const placed = unitsAt(ctx, { col: 34, row: 17 }).filter((unit) => unitIds.has(unit.unitId))
      expect(placed.length, entry.raw).toBeGreaterThan(0)
    }
    // 整堆默认超 10 RE，且列在「必做散开」里
    const over = ctx.setup.overStackedHexes.find((row) => row.hex.col === 34 && row.hex.row === 17)
    expect(over, '34.17 应超 10 RE').toBeDefined()
    expect(over!.re).toBeGreaterThan(10)
    expect(over!.movableIds.length).toBeGreaterThan(0)
    // 超限格不散开 ⇒ 不能收束/开局（4.8 / IV-F）
    expect(ctx.setup.canFinishSetup()).toBe(false)
    expect(ctx.setup.lastAction?.rule).toBe('IV-F')
    expect(ctx.setup.lastAction?.detail).toContain('34.17')
  })

  it('地图拖动原语：† 算子可拖、落到 ±1 内即散开（复用普通落位判据）', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('3')
    const mapView = useMapViewStore()
    const entry = tolerantOf(ctx.setup, /29\s*Mtr/i)
    const unit = unitsAt(ctx, { col: 34, row: 17 }).find((row) =>
      entry.pieces.some((piece) => piece.unitId === row.unitId),
    )!
    // 拖动源：34.17 是多枚堆叠，中心不一定压中某一枚 ⇒ 在格内取一个命中点
    const center = hexCanvasPoint({ col: 34, row: 17 })
    let drag: { id: string; label: string } | null = null
    for (const dx of [-20, -10, 0, 10, 20]) {
      for (const dy of [-20, -10, 0, 10, 20]) {
        drag = mapView.counterForMoveDragAt(
          { col: 34, row: 17 },
          { x: center.x + dx, y: center.y + dy },
          1,
        )
        if (drag !== null) break
      }
      if (drag !== null) break
    }
    expect(drag).not.toBeNull()
    expect(ctx.setup.isStackDisperseUnit(drag!.id)).toBe(true)

    // 落点：走 MapCanvas 实际使用的 drop 入口，单位落到合法邻格
    ctx.setup.beginStackDisperse(unit.instanceId)
    const target = (ctx.setup.stackDisperse?.candidates ?? []).find(
      (hex) => hex.col !== 34 || hex.row !== 17,
    )!
    expect(mapView.dropMovingCounterAt(unit.instanceId, target, { x: 0, y: 0 })).toBe(true)
    expect(unit.hex).toEqual(target)
  })

  it('选中 † 算子后高亮 ±1 候选；范围外被拒并给出锚格与半径', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('3')
    const entry = tolerantOf(ctx.setup, /29\s*Mtr/i)
    const unit = unitsAt(ctx, { col: 34, row: 17 }).find((row) =>
      entry.pieces.some((piece) => piece.unitId === row.unitId),
    )!
    expect(ctx.setup.isStackDisperseUnit(unit.instanceId)).toBe(true)
    expect(ctx.setup.beginStackDisperse(unit.instanceId)).toBe(true)
    expect(ctx.setup.stackDisperse?.instanceId).toBe(unit.instanceId)
    const candidates = ctx.setup.stackDisperse?.candidates ?? []
    expect(candidates.length).toBeGreaterThan(1)
    for (const hex of candidates) {
      expect(hexDistance({ col: 34, row: 17 }, hex)).toBeLessThanOrEqual(1)
    }

    expect(ctx.setup.moveStackUnit(unit.instanceId, { col: 62, row: 34 })).toBe(false)
    expect(ctx.setup.lastAction?.detail).toContain('锚格 34.17')
    expect(ctx.setup.lastAction?.detail).toContain('半径 1 格')
  })

  it('散开一枚后源格 RE 下降；目标格超 10 RE 则拒（IV-F）', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('3')
    const entry = tolerantOf(ctx.setup, /29\s*Mtr/i)
    const unit = unitsAt(ctx, { col: 34, row: 17 }).find((row) =>
      entry.pieces.some((piece) => piece.unitId === row.unitId),
    )!
    const before = unitsAt(ctx, { col: 34, row: 17 }).reduce(
      (sum, item) => sum + currentReOf(item),
      0,
    )
    ctx.setup.beginStackDisperse(unit.instanceId)
    const target = (ctx.setup.stackDisperse?.candidates ?? []).find(
      (hex) => hex.col !== 34 || hex.row !== 17,
    )!
    expect(ctx.setup.moveStackUnit(unit.instanceId, target)).toBe(true)
    expect(unit.hex).toEqual(target)
    const after = unitsAt(ctx, { col: 34, row: 17 }).reduce(
      (sum, item) => sum + currentReOf(item),
      0,
    )
    expect(after).toBeLessThan(before)

    // 再往一个已经 9.6 RE 的邻格塞同一枚 ⇒ 10 RE 上限拒绝
    const crowded = (ctx.setup.stackDisperse?.candidates ?? []).find(
      (hex) => hex.col !== target.col || hex.row !== target.row,
    )!
    const crowd = unitsAt(ctx, crowded)[0]
    if (crowd !== undefined) crowd.re = 9.6
    const rejected = ctx.setup.moveStackUnit(unit.instanceId, crowded)
    if (crowd !== undefined) {
      expect(rejected).toBe(false)
      expect(ctx.setup.lastAction?.rule).toBe('IV-F')
    }
  })

  it('散开不改实例 id：卡车满载标记与 loadedSpT 原样保留', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('3')
    const truck = ctx.setup.setupTrucks.find((row) => {
      const unit = ctx.w.units.find((item) => item.instanceId === row.instanceId)
      return unit?.hex.col === 34 && unit.hex.row === 17
    })!
    ctx.setup.toggleTruckFull(truck.instanceId, true)
    const unit = ctx.w.units.find((item) => item.instanceId === truck.instanceId)!
    unit.loadedSpT = 1
    ctx.setup.beginStackDisperse(truck.instanceId)
    const target = (ctx.setup.stackDisperse?.candidates ?? []).find(
      (hex) => hex !== undefined && (hex.col !== 34 || hex.row !== 17),
    )!
    expect(ctx.setup.moveStackUnit(truck.instanceId, target)).toBe(true)
    expect(truck.instanceId).toBe(unit.instanceId)
    expect(unit.loadedSpT).toBe(1)
    expect(ctx.setup.truckFullIds).toContain(truck.instanceId)
  })

  it('超堆叠散开后，4.8 / IV-F 的义务消失', () => {
    const ctx = fresh()
    ctx.setup.enterSetup('3')
    // 反复把超堆叠格里的 † 算子挪到合法邻格，直到所有格 ≤10 RE
    for (let n = 0; n < 200 && ctx.setup.overStackedHexes.length > 0; n += 1) {
      const over = ctx.setup.overStackedHexes[0]!
      const id = over.movableIds[0]
      expect(id, over.label).toBeDefined()
      expect(ctx.setup.beginStackDisperse(id!)).toBe(true)
      const candidates = ctx.setup.stackDisperse?.candidates ?? []
      let moved = false
      for (const hex of candidates) {
        if (ctx.setup.moveStackUnit(id!, hex)) {
          moved = true
          break
        }
      }
      expect(moved, `${over.label} 的 ${id} 无处可散`).toBe(true)
    }
    expect(ctx.setup.overStackedHexes).toEqual([])
  })
})
