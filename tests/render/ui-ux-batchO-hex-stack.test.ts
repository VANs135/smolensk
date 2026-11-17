import { afterEach, describe, expect, it, vi } from 'vitest'

import { HEX_RADIUS_PX, hexCanvasPoint } from '@/render/map-layout'
import { TOKEN_SIZE_PX } from '@/render/stack-fan'
import { counterImages } from '@/render/token-images'
import { drawMovementOverlay, hqBadgeView, hitHexToken, type UnitToken } from '@/render/token-layer'

/**
 * 堆叠与格内显示（用户 2026-11-18）——渲染侧
 *
 * ② HQ 不再是「HQ」文字块，改画**真实算子贴图**，占位在左中；
 * ③ 飞机不进地面堆叠（停在基地的不画；执行任务的单独画）；
 * ④ 常态只画数量合适的地面单位（≤4 枚不重叠，>4 枚画 4 枚 + 角标）。
 */

interface DrawCall {
  op: string
  url?: string
  args?: readonly unknown[]
}

function recordingCtx(calls: DrawCall[]): CanvasRenderingContext2D {
  const noop = (): void => undefined
  const ctx = {
    canvas: { width: 0, height: 0 },
    save: noop,
    restore: noop,
    setTransform: noop,
    clearRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    setLineDash: noop,
    strokeRect: noop,
    strokeText: noop,
    fillText: (text: string, x: number, y: number): void =>
      void calls.push({ op: 'fillText', args: [text, x, y] }),
    fillRect: noop,
    drawImage: (image: unknown, x?: number, y?: number, w?: number, h?: number): void => {
      const url = (image as { url?: string } | null)?.url
      calls.push({ op: 'drawImage', ...(url === undefined ? {} : { url }), args: [x, y, w, h] })
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
  }
  return ctx as unknown as CanvasRenderingContext2D
}

const HEX = { col: 15, row: 10 }

function token(id: string, extra: Partial<UnitToken> = {}): UnitToken {
  return {
    id,
    hex: HEX,
    side: 'axis',
    unitId: `unit-${id}`,
    face: 'combat',
    images: { front: `${id}.png`, back: `${id}_B.png` },
    label: '12-2-2',
    selected: false,
    ended: false,
    modeLetter: 'C',
    dg: false,
    awaitingFuel: false,
    fuelled: false,
    ...extra,
  }
}

function stubImages(): void {
  vi.spyOn(counterImages, 'get').mockImplementation(
    (url: string) => ({ url }) as unknown as CanvasImageSource,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('② HQ：真实算子贴图，占位在左中', () => {
  it('画的是 HQ 算子的贴图（不是「HQ」文字），位置＝hqBadgeView', () => {
    const calls: DrawCall[] = []
    stubImages()
    const hq = token('hq1', { hq: true })
    drawMovementOverlay(
      recordingCtx(calls),
      { tokens: [token('u1'), hq], reachable: [], path: [], startHex: null, selectedIds: [] },
      1,
    )
    const badge = hqBadgeView(HEX)
    const hqDraw = calls.find((call) => call.url?.includes('hq1.png') === true)
    expect(hqDraw).toBeDefined()
    expect(hqDraw?.args).toEqual([
      badge.centerX - badge.side / 2,
      badge.centerY - badge.side / 2,
      badge.side,
      badge.side,
    ])
    expect(calls.some((call) => String(call.args?.[0]) === 'HQ')).toBe(false)
  })

  it('HQ 不占地面扇面席位：同格另一枚仍按原尺画在格心', () => {
    const calls: DrawCall[] = []
    stubImages()
    const hq = token('hq1', { hq: true })
    drawMovementOverlay(
      recordingCtx(calls),
      { tokens: [token('u1'), hq], reachable: [], path: [], startHex: null, selectedIds: [] },
      1,
    )
    const groundDraw = calls.find((call) => call.url?.includes('u1.png') === true)
    const center = hexCanvasPoint(HEX)
    expect(groundDraw?.args).toEqual([
      center.x - TOKEN_SIZE_PX / 2,
      center.y - TOKEN_SIZE_PX / 2,
      TOKEN_SIZE_PX,
      TOKEN_SIZE_PX,
    ])
  })

  it('命中：点左中 HQ 区域选到 HQ 那一枚，点格心选到地面那一枚', () => {
    const hq = token('hq1', { hq: true })
    const group = [token('u1'), hq]
    const badge = hqBadgeView(HEX)
    expect(
      hitHexToken({
        hex: HEX,
        group,
        page: 0,
        point: { x: badge.centerX, y: badge.centerY },
        scale: 1,
      })?.id,
    ).toBe('hq1')
    expect(
      hitHexToken({ hex: HEX, group, page: 0, point: hexCanvasPoint(HEX), scale: 1 })?.id,
    ).toBe('u1')
  })
})

describe('③ 飞机不进地面堆叠', () => {
  it('停在基地的飞机不画在地面堆叠里（既不算枚数、也不占槽位）', () => {
    const calls: DrawCall[] = []
    stubImages()
    const plane = token('f1', { air: true, selected: false })
    drawMovementOverlay(
      recordingCtx(calls),
      {
        tokens: [token('u1'), token('u2'), plane],
        reachable: [],
        path: [],
        startHex: null,
        selectedIds: [],
      },
      1,
    )
    expect(calls.some((call) => call.url?.includes('f1.png') === true)).toBe(false)
    // 地面 2 枚照常摊开
    expect(
      calls.filter(
        (call) => call.url?.includes('u1.png') === true || call.url?.includes('u2.png') === true,
      ),
    ).toHaveLength(2)
  })

  it('执行任务的飞机单独画在格心（可被点中）', () => {
    const calls: DrawCall[] = []
    stubImages()
    const plane = token('f1', { air: true, selected: true })
    drawMovementOverlay(
      recordingCtx(calls),
      { tokens: [token('u1'), plane], reachable: [], path: [], startHex: null, selectedIds: [] },
      1,
    )
    const center = hexCanvasPoint(HEX)
    const planeDraw = calls.find((call) => call.url?.includes('f1.png') === true)
    expect(planeDraw).toBeDefined()
    expect(
      hitHexToken({ hex: HEX, group: [token('u1'), plane], page: 0, point: center, scale: 1 })?.id,
    ).toBe('f1')
  })

  it('4 枚地面 + 2 架停场飞机：不触发分页角标', () => {
    const calls: DrawCall[] = []
    stubImages()
    const group = [
      token('u1'),
      token('u2'),
      token('u3'),
      token('u4'),
      token('f1', { air: true }),
      token('f2', { air: true }),
    ]
    drawMovementOverlay(
      recordingCtx(calls),
      { tokens: group, reachable: [], path: [], startHex: null, selectedIds: [] },
      1,
    )
    const texts = calls
      .filter((call) => call.op === 'fillText')
      .map((call) => String(call.args?.[0]))
    expect(texts).toEqual([])
    expect(
      calls.some(
        (call) => call.url?.includes('f1.png') === true || call.url?.includes('f2.png') === true,
      ),
    ).toBe(false)
  })
})

describe('④ 常态只画「数量合适」的地面单位', () => {
  it('5 枚地面：画 4 枚 + 角标 +1（不把整格塞满）', () => {
    const calls: DrawCall[] = []
    stubImages()
    const group = Array.from({ length: 5 }, (_, index) => token(`u${index}`))
    drawMovementOverlay(
      recordingCtx(calls),
      { tokens: group, reachable: [], path: [], startHex: null, selectedIds: [] },
      1,
    )
    const draws = calls.filter((call) => call.url?.endsWith('.png') === true)
    expect(draws).toHaveLength(4)
    const texts = calls
      .filter((call) => call.op === 'fillText')
      .map((call) => String(call.args?.[0]))
    expect(texts).toContain('+1')
  })

  it('4 枚地面：全部画出且互不重叠（四角不越格）', () => {
    const calls: DrawCall[] = []
    stubImages()
    const group = Array.from({ length: 4 }, (_, index) => token(`u${index}`))
    drawMovementOverlay(
      recordingCtx(calls),
      { tokens: group, reachable: [], path: [], startHex: null, selectedIds: [] },
      1,
    )
    const rects = calls
      .filter((call) => call.url?.endsWith('.png') === true)
      .map((call) => ({
        x: call.args?.[0] as number,
        y: call.args?.[1] as number,
        w: call.args?.[2] as number,
        h: call.args?.[3] as number,
      }))
    expect(rects).toHaveLength(4)
    const center = hexCanvasPoint(HEX)
    for (const rect of rects) {
      expect(rect.w).toBeCloseTo(TOKEN_SIZE_PX * 0.52, 6)
      // 四角都在六角格内
      for (const dx of [0, rect.w]) {
        for (const dy of [0, rect.h]) {
          const x = Math.abs(rect.x + dx - center.x)
          const y = Math.abs(rect.y + dy - center.y)
          expect(x + y / Math.sqrt(3)).toBeLessThanOrEqual(HEX_RADIUS_PX + 1e-6)
        }
      }
    }
    // 两两不重叠
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i]!
        const b = rects[j]!
        const overlap =
          a.x < b.x + b.w - 1e-6 &&
          b.x < a.x + a.w - 1e-6 &&
          a.y < b.y + b.h - 1e-6 &&
          b.y < a.y + a.h - 1e-6
        expect(overlap).toBe(false)
      }
    }
  })
})
