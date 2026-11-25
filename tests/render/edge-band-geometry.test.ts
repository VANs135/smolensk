import { describe, expect, it } from 'vitest'

import { HEX_INRADIUS_PX, HEX_RADIUS_PX, hexCanvasPoint } from '@/render/map-layout'
import { EDGE_BAND_THICKNESS_PX, edgeBandRect, type EdgeBandPiece } from '@/render/map-render'

/**
 * 专规 1.4b 入盒带：**纯几何**（不碰 store / 不碰画布）
 *
 * 段贴在格的**外侧**：北段骑在格的上边线之上、南段贴下边线之下、东段贴格的右顶点之外，
 * 宽/厚取 §4.1b 口径（宽≈56＝六角外接半径、厚 18），随缩放等比（由调用方乘 `scale`）。
 */

const hex = { col: 20, row: 35 } as const
const center = hexCanvasPoint(hex)

function piece(side: EdgeBandPiece['side']): EdgeBandPiece {
  return { box: side === 'north' ? 'northeast' : 'southeast', hex, side, occupied: false }
}

describe('edgeBandRect', () => {
  it('带厚＝18（画布像素），与设计口径一致', () => {
    expect(EDGE_BAND_THICKNESS_PX).toBe(18)
  })

  it('北段：底边压在格的上边线上（不侵入格内）', () => {
    const rect = edgeBandRect(piece('north'))
    expect(rect.h).toBe(EDGE_BAND_THICKNESS_PX)
    expect(rect.w).toBeCloseTo(HEX_RADIUS_PX, 5)
    expect(rect.x + rect.w / 2).toBeCloseTo(center.x, 5)
    expect(rect.y + rect.h).toBeCloseTo(center.y - HEX_INRADIUS_PX, 5)
  })

  it('南段：顶边压在格的下边线上（不侵入格内）', () => {
    const rect = edgeBandRect(piece('south'))
    expect(rect.h).toBe(EDGE_BAND_THICKNESS_PX)
    expect(rect.w).toBeCloseTo(HEX_RADIUS_PX, 5)
    expect(rect.x + rect.w / 2).toBeCloseTo(center.x, 5)
    expect(rect.y).toBeCloseTo(center.y + HEX_INRADIUS_PX, 5)
  })

  it('东段：贴格的右顶点外侧，18×18 方块、竖直居中', () => {
    const rect = edgeBandRect(piece('east'))
    expect(rect.w).toBe(EDGE_BAND_THICKNESS_PX)
    expect(rect.h).toBe(EDGE_BAND_THICKNESS_PX)
    expect(rect.x).toBeCloseTo(center.x + HEX_RADIUS_PX, 5)
    expect(rect.y + rect.h / 2).toBeCloseTo(center.y, 5)
  })
})
