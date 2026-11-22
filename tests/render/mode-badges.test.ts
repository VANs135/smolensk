import { existsSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  counterImages,
  exploitTextureUrl,
  markerTextureUrl,
  MARKER_TEXTURES,
  reserveModeTextureUrl,
} from '@/render/token-images'

import { counterKeyOf, packedCounterUrl } from '../counter-url-helper'
import {
  MODE_BADGE_SIZE_RATIO,
  drawTokenStatusTextures,
  modeBadgeSlots,
  statusTextureSlots,
  TOKEN_SIZE_PX,
  type UnitToken,
} from '@/render/token-layer'

/**
 * 模式贴图（用户 2026-11-18）：**有官方标记的模式，把标记小尺寸画在单位上**
 *
 * 口径：
 *   · 进击 / 预备 / 战略（/ 断补）都有官方标记图，逐枚贴在该算子自己的绘制框内；
 *   · 小尺寸、成排落位：同格多枚算子各贴各的，互不压住；
 *   · 既有的扣兵力（左）与 DG（右）占算子左右侧边中段 ⇒ 模式角标不得压上去；
 *   · 只在模式成立时出现（预备＝`modeLetter === 'R'`），退出即不返回任何角标；
 *   · 只读呈现层已有的状态，不在这里判定规则。
 */

const SIZE = TOKEN_SIZE_PX

function slots(
  over: {
    modeLetter?: string
    exploit?: boolean
    strat?: boolean
    outOfSupply?: boolean
  } = {},
) {
  return modeBadgeSlots({
    centerX: 100,
    centerY: 200,
    size: SIZE,
    modeLetter: over.modeLetter ?? 'C',
    exploit: over.exploit ?? false,
    strat: over.strat ?? false,
    outOfSupply: over.outOfSupply ?? false,
  })
}

interface Rect {
  left: number
  right: number
  top: number
  bottom: number
}

function rectOf(slot: { centerX: number; centerY: number; size: number }): Rect {
  return {
    left: slot.centerX - slot.size / 2,
    right: slot.centerX + slot.size / 2,
    top: slot.centerY - slot.size / 2,
    bottom: slot.centerY + slot.size / 2,
  }
}

/** 严格相交（贴边不算压住） */
function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

describe('模式角标：哪些状态出现、退出即消失', () => {
  it('★ 无模式 ⇒ 不占位', () => {
    expect(slots({ modeLetter: 'C' })).toEqual([])
    expect(slots({ modeLetter: 'M' })).toEqual([])
  })

  it('★ 进击模式出现进击角标；预备模式（modeLetter R）出现预备角标', () => {
    expect(slots({ exploit: true }).map((slot) => slot.kind)).toEqual(['exploit'])
    expect(slots({ modeLetter: 'R' }).map((slot) => slot.kind)).toEqual(['reserve'])
  })

  it('★ 战略与断补沿用官方贴图，同样走角标', () => {
    expect(slots({ strat: true }).map((slot) => slot.kind)).toEqual(['strat'])
    expect(slots({ outOfSupply: true }).map((slot) => slot.kind)).toEqual(['outOfSupply'])
  })

  it('★ 多状态并存时逐枚列出（不互相 else）', () => {
    const kinds = slots({ exploit: true, modeLetter: 'R', strat: true }).map((slot) => slot.kind)
    expect(kinds).toEqual(['exploit', 'reserve', 'strat'])
  })
})

describe('模式角标：小尺寸、成排、互不压住', () => {
  it('★ 尺寸随算子等比缩放，且明显小于算子', () => {
    const [slot] = slots({ exploit: true })
    expect(slot!.size).toBeCloseTo(SIZE * MODE_BADGE_SIZE_RATIO, 6)
    const small = modeBadgeSlots({
      centerX: 0,
      centerY: 0,
      size: SIZE * 0.6,
      modeLetter: 'C',
      exploit: true,
    })
    expect(small[0]!.size).toBeCloseTo(SIZE * 0.6 * MODE_BADGE_SIZE_RATIO, 6)
  })

  it('★ 多枚角标在同一排里互不重叠，且全在自己的算子框内', () => {
    const list = slots({ exploit: true, modeLetter: 'R', strat: true, outOfSupply: true })
    expect(list).toHaveLength(4)
    for (const [index, slot] of list.entries()) {
      const rect = rectOf(slot)
      expect(rect.left).toBeGreaterThanOrEqual(100 - SIZE / 2 - 1e-6)
      expect(rect.right).toBeLessThanOrEqual(100 + SIZE / 2 + 1e-6)
      expect(rect.top).toBeGreaterThanOrEqual(200 - SIZE / 2 - 1e-6)
      expect(rect.bottom).toBeLessThanOrEqual(200 + SIZE / 2 + 1e-6)
      for (const other of list.slice(index + 1)) {
        expect(intersects(rect, rectOf(other))).toBe(false)
      }
    }
  })

  it('★ 不压住左右两侧的扣兵力 / DG 贴图', () => {
    const left = 100
    const top = 200
    const status = statusTextureSlots({
      centerX: left,
      centerY: top,
      size: SIZE,
      dg: true,
      stepsLost: 3,
    })
    // 前提：损失在左、DG 在右（批 I 的既有口径）
    expect(status.map((slot) => slot.kind)).toEqual(['stepsLost', 'dg'])

    for (const slot of slots({ exploit: true, modeLetter: 'R', strat: true, outOfSupply: true })) {
      for (const fixed of status) {
        expect(intersects(rectOf(slot), rectOf(fixed)), `${slot.kind} vs ${fixed.kind}`).toBe(false)
      }
    }
  })
})

describe('模式贴图：官方素材', () => {
  it('★ 预备模式按阵营取官方标记（轴心 Ge_Reserve_F / 苏联 Ru_Russian_Reserve）', () => {
    expect(reserveModeTextureUrl('axis')).toBe(packedCounterUrl('markers', 'Ge_Reserve_F.png'))
    expect(reserveModeTextureUrl('soviet')).toBe(
      packedCounterUrl('markers', 'Ru_Russian_Reserve.png'),
    )
    expect(existsSync('public/counters/markers/Ge_Reserve_F.png')).toBe(true)
    expect(existsSync('public/counters/markers/Ru_Russian_Reserve.png')).toBe(true)
  })

  it('★ 进击 / 战略 / 断补仍走既有官方贴图，不另起素材', () => {
    expect(counterKeyOf(exploitTextureUrl('u-1'))).toMatch(/^markers\/misc_Explt-[234] small\.png$/)
    expect(markerTextureUrl(MARKER_TEXTURES.strat)).toBe(
      packedCounterUrl('markers', 'misc_Strat small.png'),
    )
    expect(markerTextureUrl(MARKER_TEXTURES.outOfSupply)).toBe(
      packedCounterUrl('markers', 'misc_OoS small.png'),
    )
  })
})

describe('模式角标：真的画在算子层之上', () => {
  interface DrawCall {
    url?: string
    x: number
    y: number
    width: number
    height: number
  }

  function token(extra: Partial<UnitToken>): UnitToken {
    return {
      id: 'u-1',
      hex: { col: 3, row: 4 },
      side: 'axis',
      label: '6-3-3',
      selected: false,
      ended: false,
      modeLetter: 'C',
      dg: false,
      awaitingFuel: false,
      fuelled: false,
      ...extra,
    }
  }

  function recordingCtx(calls: DrawCall[]): CanvasRenderingContext2D {
    const ctx = {
      canvas: { width: 0, height: 0 },
      save: () => undefined,
      restore: () => undefined,
      drawImage: (image: unknown, x: number, y: number, width: number, height: number): void => {
        const url = (image as { url?: string } | null)?.url
        calls.push({ url, x, y, width, height })
      },
    }
    return ctx as unknown as CanvasRenderingContext2D
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('★ 进击单位的进击贴图以角标尺寸画在该枚算子上', () => {
    vi.spyOn(counterImages, 'get').mockImplementation(
      (url: string) => ({ url }) as unknown as CanvasImageSource,
    )
    const calls: DrawCall[] = []
    drawTokenStatusTextures(recordingCtx(calls), [
      { token: token({ exploit: true }), centerX: 100, centerY: 200, size: SIZE },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(exploitTextureUrl('u-1'))
    expect(calls[0]!.width).toBeCloseTo(SIZE * MODE_BADGE_SIZE_RATIO, 6)
  })

  it('★ 转入预备（modeLetter R）的单位画预备贴图；不是预备就不画', () => {
    vi.spyOn(counterImages, 'get').mockImplementation(
      (url: string) => ({ url }) as unknown as CanvasImageSource,
    )
    const reserveCalls: DrawCall[] = []
    drawTokenStatusTextures(recordingCtx(reserveCalls), [
      { token: token({ modeLetter: 'R' }), centerX: 100, centerY: 200, size: SIZE },
    ])
    expect(reserveCalls.map((call) => call.url)).toEqual([reserveModeTextureUrl('axis')])

    const combatCalls: DrawCall[] = []
    drawTokenStatusTextures(recordingCtx(combatCalls), [
      { token: token({ modeLetter: 'C' }), centerX: 100, centerY: 200, size: SIZE },
    ])
    expect(combatCalls).toEqual([])
  })
})
