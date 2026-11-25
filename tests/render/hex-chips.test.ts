import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  HEX_CHIP_ANCHORS,
  HEX_CHIP_SIZE_RATIO,
  HEX_CHIP_SLOT_STEP,
  type HexChipKind,
} from '@/render/hex-chips'

/**
 * 2026-11-26 用户：「统一格子里 HQ、设施、占领标记等小贴图的尺寸，每个东西有固定的放置位置」
 *
 * 本组钉三件事：
 *   ① 只有**一个**尺寸常量，六类贴片全用它（不许再有 0.6R / 0.5R / 0.24R 之类的私人档）；
 *   ② 六个槽位**互不相同**，且按统一尺寸画出来的方块**两两不相交**（纯几何，Node 里可判）；
 *   ③ 源码守卫：token-layer 与 map-render 都真的从 `hex-chips` 取值，没有把旧数值写回去。
 */

const KINDS: readonly HexChipKind[] = [
  'control',
  'mapMarker',
  'printedHedgehog',
  'hq',
  'facility',
  'construction',
]

interface Rect {
  left: number
  right: number
  top: number
  bottom: number
}

function rectOf(kind: HexChipKind, slot = 0): Rect {
  const anchor = HEX_CHIP_ANCHORS[kind]
  // 单位统一取 R＝1（相对量，与像素半径无关）
  const cx =
    anchor.x + (kind === 'facility' || kind === 'construction' ? slot * HEX_CHIP_SLOT_STEP : 0)
  const cy = anchor.y
  const half = HEX_CHIP_SIZE_RATIO / 2
  return { left: cx - half, right: cx + half, top: cy - half, bottom: cy + half }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

describe('格内小贴片：统一尺 + 固定槽位', () => {
  it('★ 六类贴片共用同一个尺寸常量（表里没有第二种尺）', () => {
    expect(HEX_CHIP_SIZE_RATIO).toBeGreaterThan(0.2)
    expect(HEX_CHIP_SIZE_RATIO).toBeLessThan(0.4)
    // 步长 ≥ 边长 ⇒ 同槽位相邻两枚之间一定留缝，不会叠边
    expect(HEX_CHIP_SLOT_STEP).toBeGreaterThanOrEqual(HEX_CHIP_SIZE_RATIO)
  })

  it('★ 六个槽位各不相同：每样东西只占自己那一处', () => {
    const keys = KINDS.map((kind) => `${HEX_CHIP_ANCHORS[kind].x},${HEX_CHIP_ANCHORS[kind].y}`)
    expect(new Set(keys).size).toBe(KINDS.length)
  })

  it('★ 六类贴片两两不相交（含设施同格第 2、3 枚仍在自家左下排）', () => {
    for (let i = 0; i < KINDS.length; i += 1) {
      for (let j = i + 1; j < KINDS.length; j += 1) {
        expect(overlaps(rectOf(KINDS[i]!), rectOf(KINDS[j]!))).toBe(false)
      }
    }
    // 设施第 2、3 枚不与建造标记打架
    expect(overlaps(rectOf('facility', 1), rectOf('construction'))).toBe(false)
    expect(overlaps(rectOf('facility', 2), rectOf('construction'))).toBe(false)
    // 设施自己那排是**向右**依次排开，不叠成一坨
    expect(overlaps(rectOf('facility', 0), rectOf('facility', 1))).toBe(false)
    expect(overlaps(rectOf('facility', 1), rectOf('facility', 2))).toBe(false)
  })

  it('★ 不占格心：所有贴片中心都偏开 ±0.4R 以上', () => {
    for (const kind of KINDS) {
      const anchor = HEX_CHIP_ANCHORS[kind]
      expect(Math.hypot(anchor.x, anchor.y)).toBeGreaterThan(0.4)
    }
  })

  it('★ 源码守卫：两处渲染都从 `hex-chips` 取值，旧数值没有回流', () => {
    const layer = readFileSync('src/render/token-layer.ts', 'utf8')
    expect(layer).toContain("from './hex-chips'")
    expect(layer).toContain('HEX_CHIP_ANCHORS.facility')
    expect(layer).toContain('HEX_CHIP_ANCHORS.hq')
    expect(layer).toContain('HEX_CHIP_SIZE_RATIO')
    // 旧的私人数值不许回流
    expect(layer).not.toContain('HQ_BADGE_RATIO = 0.24')

    const render = readFileSync('src/render/map-render.ts', 'utf8')
    expect(render).toContain("from './hex-chips'")
    for (const key of ['control', 'mapMarker', 'printedHedgehog', 'construction']) {
      expect(render).toContain(`HEX_CHIP_ANCHORS.${key}`)
    }
    expect(render).not.toContain('CONTROL_MARKER_RATIO = 0.6')
    expect(render).not.toContain('MAP_MARKER_RATIO = 0.5')
    expect(render).not.toContain('HEDGEHOG_TEXTURE_RATIO = 0.7')
  })
})
