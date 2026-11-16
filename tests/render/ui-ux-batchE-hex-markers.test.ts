import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { HEX_RADIUS_PX, hexCanvasPoint } from '@/render/map-layout'
import {
  FACILITY_CORNER,
  FACILITY_SLOT_STEP,
  FACILITY_TOKEN_SIZE_RATIO,
  HQ_BADGE_CORNER,
  HQ_BADGE_RATIO,
  facilityTokenViews,
  hqBadgeView,
  type UnitToken,
} from '@/render/token-layer'

/**
 * 批 E：**格子标记层重排**（用户 2026-11-16）
 *
 * 口径：设施放格子最上层**左下角**、缩小**常显**；**左上角**是占领标记；**左中**是 HQ。
 * 三处不得互相压盖，也不与堆叠数量角标（右上）冲突；常显＝不再依赖点开小窗。
 *
 * 本组钉住三件事：
 *   ① 设施有**固定角位**（与格内堆叠枚数无关，也不参与扇面分页）；
 *   ② 设施/占领/HQ/堆叠角标四者的矩形互不相交（纯几何，可在 Node 里断言）；
 *   ③ 源码守卫：绘制入口真的把设施从扇面里拆出来、且 HQ 标记真的画。
 */

const HEX: HexRef = { col: 36, row: 17 }

function token(over: Partial<UnitToken> & { id: string }): UnitToken {
  return {
    hex: HEX,
    side: 'soviet',
    label: 'x',
    selected: false,
    ended: false,
    modeLetter: 'M',
    dg: false,
    awaitingFuel: false,
    fuelled: false,
    ...over,
  }
}

interface Rect {
  left: number
  right: number
  top: number
  bottom: number
}

function rectOf(center: { x: number; y: number }, side: number): Rect {
  return {
    left: center.x - side / 2,
    right: center.x + side / 2,
    top: center.y - side / 2,
    bottom: center.y + side / 2,
  }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

describe('批 E：设施固定左下角、常显', () => {
  it('★ 设施角位与格内枚数无关：三枚依次沿左下角向右排，边长＝0.28R（比算子小）', () => {
    const base = token({ id: 'base', noncombatKind: 'air_base' })
    const sp = token({ id: 'sp', noncombatKind: 'sp', spPoints: 3 })
    const hog = token({ id: 'hog', noncombatKind: 'hedgehog' })
    const views = facilityTokenViews(HEX, [base, sp, hog])
    const center = hexCanvasPoint(HEX)
    expect(views).toHaveLength(3)
    expect(views[0]!.centerX).toBeCloseTo(center.x + HEX_RADIUS_PX * FACILITY_CORNER.x, 6)
    expect(views[0]!.centerY).toBeCloseTo(center.y + HEX_RADIUS_PX * FACILITY_CORNER.y, 6)
    expect(views[1]!.centerX).toBeCloseTo(
      center.x + HEX_RADIUS_PX * (FACILITY_CORNER.x + FACILITY_SLOT_STEP),
      6,
    )
    expect(views[2]!.centerX).toBeCloseTo(
      center.x + HEX_RADIUS_PX * (FACILITY_CORNER.x + FACILITY_SLOT_STEP * 2),
      6,
    )
    // 左下：x 偏左、y 偏下
    expect(views[0]!.centerX).toBeLessThan(center.x)
    expect(views[0]!.centerY).toBeGreaterThan(center.y)
    // 缩小：边长＝0.28R，明显小于算子边长
    expect(views[0]!.size).toBeCloseTo(HEX_RADIUS_PX * FACILITY_TOKEN_SIZE_RATIO, 6)
  })

  it('★ 空设施不占位（没有状态就不显示）', () => {
    expect(facilityTokenViews(HEX, [])).toEqual([])
  })

  it('★ 四角互不压盖：设施（左下）/ 占领标记（左上）/ HQ（左中）/ 堆叠枚数角标（右上）', () => {
    const center = hexCanvasPoint(HEX)
    const facilityView = facilityTokenViews(HEX, [
      token({ id: 'base', noncombatKind: 'air_base' }),
    ])[0]!
    const facility = rectOf(
      { x: facilityView.centerX, y: facilityView.centerY },
      HEX_RADIUS_PX * FACILITY_TOKEN_SIZE_RATIO,
    )
    // 占领标记：与 map-render 的 CONTROL_MARKER_RATIO / HEDGEHOG_CORNER_OFFSET 同口径（0.6R、左上 0.42R）
    const control = rectOf(
      { x: center.x - HEX_RADIUS_PX * 0.42, y: center.y - HEX_RADIUS_PX * 0.42 },
      HEX_RADIUS_PX * 0.6,
    )
    const hqView = hqBadgeView(HEX)
    const hq = rectOf({ x: hqView.centerX, y: hqView.centerY }, HEX_RADIUS_PX * HQ_BADGE_RATIO)
    // 堆叠角标：右上角（取半径 9px 的圆的外接方框，scale=1）
    const badgeRadius = 9
    const badge = rectOf(
      {
        x: center.x + HEX_RADIUS_PX * 0.51,
        y: center.y - HEX_RADIUS_PX * 0.51,
      },
      badgeRadius * 2,
    )
    expect(overlaps(facility, control)).toBe(false)
    expect(overlaps(facility, hq)).toBe(false)
    expect(overlaps(facility, badge)).toBe(false)
    expect(overlaps(control, hq)).toBe(false)
    expect(overlaps(control, badge)).toBe(false)
    expect(overlaps(hq, badge)).toBe(false)
    // HQ 真的在「左中」：x 偏左、y 与格心齐平
    expect(hqBadgeView(HEX).centerX).toBeCloseTo(center.x + HEX_RADIUS_PX * HQ_BADGE_CORNER.x, 6)
    expect(hqBadgeView(HEX).centerY).toBeCloseTo(center.y, 6)
  })

  it('★ 源码守卫：扇面只排非设施，设施单独常显一层；HQ 标记与 hq 投影都在', () => {
    const layer = readFileSync('src/render/token-layer.ts', 'utf8')
    expect(layer).toContain('export function facilityTokenViews')
    expect(layer).toContain('group.filter((token) => !isFacilityToken(token))')
    expect(layer).toContain('drawHqBadge')
    expect(layer).toContain("ctx.fillText('HQ'")
    expect(layer).toContain('hq?: boolean')
    const view = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(view).toContain('hq: unit.side === hotseat.viewerSide && isHqUnit(unit)')
  })
})
