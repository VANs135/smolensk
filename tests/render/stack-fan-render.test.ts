import { afterEach, describe, expect, it, vi } from 'vitest'

import { HEX_RADIUS_PX, hexCanvasPoint } from '@/render/map-layout'
import { stackFanLayout } from '@/render/stack-fan'
import { counterImages } from '@/render/token-images'
import { drawMovementOverlay, type UnitToken } from '@/render/token-layer'

/**
 * B2：**就地展开的渲染**（用户 2026-09-16 #1「点格即在该格内摊开每一枚」）
 *
 * 与纯函数测试分开：这里用记录调用序的假 ctx 断言"真的逐枚画了"，而不是只画顶牌。
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
    arc: (): void => void calls.push({ op: 'arc' }),
    fill: noop,
    stroke: noop,
    setLineDash: noop,
    strokeRect: noop,
    strokeText: noop,
    fillText: (text: string, x: number, y: number): void =>
      void calls.push({ op: 'fillText', args: [text, x, y] }),
    fillRect: (): void => void calls.push({ op: 'fillRect' }),
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

const SCALE = 1

function token(
  id: string,
  hex: { col: number; row: number },
  extra: Partial<UnitToken> = {},
): UnitToken {
  return {
    id,
    hex,
    side: 'soviet',
    unitId: 'su-infantry-ru-6-rifle-div',
    face: 'combat',
    images: { front: 'Ru_6_Inf_Div_F.png', back: 'Ru_6_Inf_Div_B.png' },
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

const HEX = { col: 15, row: 10 }

describe('B2 就地展开：渲染（用户 2026-11-10：**常态摊开**，不点也摊）', () => {
  it('不点也摊开：格内三枚**逐枚画出**（数量可数，不再是顶牌一枚）', () => {
    const calls: DrawCall[] = []
    stubImages()
    const group = [token('u1', HEX), token('u2', HEX), token('u3', HEX)]
    drawMovementOverlay(
      recordingCtx(calls),
      { tokens: group, reachable: [], path: [], startHex: null, selectedIds: [] },
      SCALE,
    )
    const counterDraws = calls.filter((call) => call.url?.includes('Ru_6_Inf_Div_F.png') === true)
    expect(counterDraws, '常态摊开：三枚都要画出来').toHaveLength(3)

    // 各自缩到槽位尺寸（"更紧密错位"），且中心互不相同（真的是摊开，不是叠在一起）
    const layout = stackFanLayout({ hex: HEX, total: 3 })
    for (const call of counterDraws)
      expect(call.args?.[2] as number).toBeCloseTo(layout.slots[0]!.size, 6)
    const centers = counterDraws.map(
      (call) => `${String(call.args?.[0])},${String(call.args?.[1])}`,
    )
    expect(new Set(centers).size).toBe(3)
  })

  it('单枚格：仍只画这一枚（没有可摊的东西）', () => {
    const calls: DrawCall[] = []
    stubImages()
    drawMovementOverlay(
      recordingCtx(calls),
      {
        tokens: [token('u1', HEX)],
        reachable: [],
        path: [],
        startHex: null,
        selectedIds: [],
      },
      SCALE,
    )
    const counterDraws = calls.filter((call) => call.url?.includes('Ru_6_Inf_Div_F.png') === true)
    expect(counterDraws).toHaveLength(1)
  })

  it('展开：本页每一枚都画出来（4 枚 ⇒ 4 次贴图，且各自缩到槽位尺寸）', () => {
    const calls: DrawCall[] = []
    stubImages()
    const group = [token('u1', HEX), token('u2', HEX), token('u3', HEX), token('u4', HEX)]
    drawMovementOverlay(
      recordingCtx(calls),
      {
        tokens: group,
        reachable: [],
        path: [],
        startHex: null,
        selectedIds: ['u2'],
        expandedStack: { hex: HEX, page: 0 },
      },
      SCALE,
    )
    const counterDraws = calls.filter((call) => call.url?.includes('Ru_6_Inf_Div_F.png') === true)
    expect(counterDraws, '展开后应逐枚画出').toHaveLength(4)

    // 每枚的边长＝槽位尺寸（比未展开的定尺小）
    const layout = stackFanLayout({ hex: HEX, total: 4 })
    const sizes = counterDraws.map((call) => call.args?.[2] as number)
    for (const size of sizes) expect(size).toBeCloseTo(layout.slots[0]!.size, 6)
  })

  it('展开：状态贴图逐枚贴在**各自**那一枚上（只贴有标记的那枚）', () => {
    const calls: DrawCall[] = []
    stubImages()
    const group = [
      token('u1', HEX),
      token('u2', HEX, { strat: true }),
      token('u3', HEX),
      token('u4', HEX),
    ]
    drawMovementOverlay(
      recordingCtx(calls),
      {
        tokens: group,
        reachable: [],
        path: [],
        startHex: null,
        selectedIds: [],
        expandedStack: { hex: HEX, page: 0 },
      },
      SCALE,
    )
    const statusDraws = calls.filter(
      (call) => call.op === 'drawImage' && !call.url?.includes('Inf_Div'),
    )
    expect(statusDraws, '只有带战略标记的那一枚产生贴图').toHaveLength(1)
  })

  it('展开：超过六枚时，角标显示本页以外的枚数', () => {
    const calls: DrawCall[] = []
    stubImages()
    const group = Array.from({ length: 7 }, (_, index) => token(`u${index}`, HEX))
    drawMovementOverlay(
      recordingCtx(calls),
      {
        tokens: group,
        reachable: [],
        path: [],
        startHex: null,
        selectedIds: [],
        expandedStack: { hex: HEX, page: 0 },
      },
      SCALE,
    )
    const texts = calls
      .filter((call) => call.op === 'fillText')
      .map((call) => String(call.args?.[0]))
    expect(texts).toContain('+1')
  })

  it('展开第 2 页：画出前一页未容纳的算子', () => {
    const calls: DrawCall[] = []
    stubImages()
    const group = Array.from({ length: 8 }, (_, index) => token(`u${index}`, HEX))
    drawMovementOverlay(
      recordingCtx(calls),
      {
        tokens: group,
        reachable: [],
        path: [],
        startHex: null,
        selectedIds: [],
        expandedStack: { hex: HEX, page: 1 },
      },
      SCALE,
    )
    const counterDraws = calls.filter((call) => call.url?.includes('Ru_6_Inf_Div_F.png') === true)
    expect(counterDraws).toHaveLength(2)
    const texts = calls
      .filter((call) => call.op === 'fillText')
      .map((call) => String(call.args?.[0]))
    expect(texts).toContain('+6')
  })

  it('别格翻页时，本格仍按**第 0 页摊开**（页号只作用于那一格）', () => {
    const calls: DrawCall[] = []
    stubImages()
    const other = { col: 16, row: 10 }
    const group = [token('u1', HEX), token('u2', HEX)]
    drawMovementOverlay(
      recordingCtx(calls),
      {
        tokens: group,
        reachable: [],
        path: [],
        startHex: null,
        selectedIds: [],
        expandedStack: { hex: other, page: 0 },
      },
      SCALE,
    )
    const counterDraws = calls.filter((call) => call.url?.includes('Ru_6_Inf_Div_F.png') === true)
    expect(counterDraws).toHaveLength(2)
  })

  it('展开格的四枚各自落在格内（中心到格心 < R，不会压到相邻格）', () => {
    const layout = stackFanLayout({ hex: HEX, total: 4 })
    const center = hexCanvasPoint(HEX)
    const centers = layout.slots.map((slot) => ({
      x: slot.x + slot.size / 2,
      y: slot.y + slot.size / 2,
    }))
    for (const point of centers) {
      expect(Math.hypot(point.x - center.x, point.y - center.y)).toBeLessThan(HEX_RADIUS_PX)
    }
    // 四枚中心互不相同（真的是摊开，不是叠在一起）
    const keys = new Set(centers.map((point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`))
    expect(keys.size).toBe(4)
  })
})
