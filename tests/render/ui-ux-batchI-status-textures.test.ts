import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { HEX_RADIUS_PX, hexCanvasPoint } from '@/render/map-layout'
import {
  FACILITY_CORNER,
  FACILITY_TOKEN_SIZE_RATIO,
  HQ_BADGE_CORNER,
  HQ_BADGE_RATIO,
  TOKEN_SIZE_PX,
  statusTextureSlots,
} from '@/render/token-layer'

/**
 * 批 I（用户 2026-11-16）：**单位状态改贴图**
 *
 * 口径：
 *   · 扣兵力（3.6e）与混乱 DG（5.10）各一枚贴图，替掉原来的 `(-N)` 与 `DG` 文字；
 *   · 去掉右上角的「战斗 / 移动」字母；
 *   · 贴图只占**左右侧边中段**：不压名称（上沿）与战斗/移动印值（下沿）；
 *   · 与格子标记层冲突时**让位**：格内有 HQ（左中）⇒ 两枚都移到右侧上下；
 *   · 没有状态就不占位。
 */

const HEX: HexRef = { col: 36, row: 17 }

interface Rect {
  left: number
  right: number
  top: number
  bottom: number
}

function rectOfSlot(slot: { centerX: number; centerY: number; size: number }): Rect {
  return {
    left: slot.centerX - slot.size / 2,
    right: slot.centerX + slot.size / 2,
    top: slot.centerY - slot.size / 2,
    bottom: slot.centerY + slot.size / 2,
  }
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

function slots(over: { dg?: boolean; stepsLost?: number; hqInHex?: boolean } = {}) {
  const center = hexCanvasPoint(HEX)
  return statusTextureSlots({
    centerX: center.x,
    centerY: center.y,
    size: TOKEN_SIZE_PX,
    dg: over.dg ?? false,
    stepsLost: over.stepsLost ?? 0,
    hqInHex: over.hqInHex ?? false,
  })
}

describe('批 I：状态贴图的落位', () => {
  it('★ 无状态不占位；DG / 扣兵力各一枚，一边一个', () => {
    expect(slots()).toEqual([])
    const dgOnly = slots({ dg: true })
    expect(dgOnly.map((slot) => slot.kind)).toEqual(['dg'])
    const lossOnly = slots({ stepsLost: 2 })
    expect(lossOnly.map((slot) => slot.kind)).toEqual(['stepsLost'])
    const both = slots({ dg: true, stepsLost: 2 })
    expect(both.map((slot) => slot.kind).sort()).toEqual(['dg', 'stepsLost'])
    const center = hexCanvasPoint(HEX)
    const loss = both.find((slot) => slot.kind === 'stepsLost')!
    const dg = both.find((slot) => slot.kind === 'dg')!
    expect(loss.centerX).toBeLessThan(center.x)
    expect(dg.centerX).toBeGreaterThan(center.x)
  })

  it('★ 默认不与占领（左上）/ 设施（左下）/ 堆叠角标（右上）压盖', () => {
    const center = hexCanvasPoint(HEX)
    const both = slots({ dg: true, stepsLost: 1 })
    const control = rectOf(
      { x: center.x - HEX_RADIUS_PX * 0.42, y: center.y - HEX_RADIUS_PX * 0.42 },
      HEX_RADIUS_PX * 0.6,
    )
    const facility = rectOf(
      {
        x: center.x + HEX_RADIUS_PX * FACILITY_CORNER.x,
        y: center.y + HEX_RADIUS_PX * FACILITY_CORNER.y,
      },
      HEX_RADIUS_PX * FACILITY_TOKEN_SIZE_RATIO,
    )
    const badge = rectOf(
      { x: center.x + HEX_RADIUS_PX * 0.51, y: center.y - HEX_RADIUS_PX * 0.51 },
      18,
    )
    for (const slot of both) {
      const rect = rectOfSlot(slot)
      expect(overlaps(rect, control)).toBe(false)
      expect(overlaps(rect, facility)).toBe(false)
      expect(overlaps(rect, badge)).toBe(false)
      // 不压名称（上沿）/ 印值（下沿）：仍落在算子中段
      expect(rect.top).toBeGreaterThanOrEqual(center.y - TOKEN_SIZE_PX * 0.3)
      expect(rect.bottom).toBeLessThanOrEqual(center.y + TOKEN_SIZE_PX * 0.3)
    }
  })

  it('★ 让位规则：格内有 HQ ⇒ 两枚都到右侧上下，不再占左中，也不互相压盖', () => {
    const center = hexCanvasPoint(HEX)
    const both = slots({ dg: true, stepsLost: 1, hqInHex: true })
    expect(both).toHaveLength(2)
    const hq = rectOf(
      {
        x: center.x + HEX_RADIUS_PX * HQ_BADGE_CORNER.x,
        y: center.y + HEX_RADIUS_PX * HQ_BADGE_CORNER.y,
      },
      HEX_RADIUS_PX * HQ_BADGE_RATIO,
    )
    const [a, b] = both.map(rectOfSlot)
    expect(overlaps(a!, hq)).toBe(false)
    expect(overlaps(b!, hq)).toBe(false)
    expect(overlaps(a!, b!)).toBe(false)
    for (const slot of both) expect(slot.centerX).toBeGreaterThan(center.x)
    expect(both.find((slot) => slot.kind === 'stepsLost')!.centerY).toBeLessThan(
      both.find((slot) => slot.kind === 'dg')!.centerY,
    )
  })

  it('★ 源码守卫：DG 用官方贴图；右上角模式字母与 DG / (-N) 文字已删', () => {
    const layer = readFileSync('src/render/token-layer.ts', 'utf8')
    expect(layer).toContain('export function statusTextureSlots')
    expect(layer).toContain('MARKER_TEXTURES.dg')
    expect(layer).not.toContain('ctx.fillText(token.modeLetter')
    expect(layer).not.toContain("fillText('DG'")
    expect(layer).not.toContain('`(-${stepsLost})`')
    const images = readFileSync('src/render/token-images.ts', 'utf8')
    expect(images).toContain("dg: 'Neutral_DG.png'")
  })
})
