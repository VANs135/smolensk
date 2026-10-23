import { afterEach, describe, expect, it, vi } from 'vitest'

import { mapLayers } from '@/data'
import { MAP_LAYER_ORDER, drawMap, visiblePrintedHedgehogs } from '@/render/map-render'
import { hexCanvasPoint } from '@/render/map-layout'
import {
  MARKER_TEXTURES,
  counterImages,
  hedgehogTextureUrl,
  markerTextureUrl,
} from '@/render/token-images'
import { drawMovementOverlay, type UnitToken } from '@/render/token-layer'
import type { Size, ViewportTransform } from '@/render/viewport'

/**
 * **绘制层次断言**（B1，用户 2026-09-16 #2）
 *
 * 两层要求：① 工事贴图要在**堆叠最上层**；② 单位状态贴图要压在该**单位自己的图**之上。
 * 这类错误肉眼一时看不出（图叠错层仍然"有东西在"），故用**记录调用序**的假 ctx 断言：
 *   · 把 `counterImages.get` 打桩成返回**可辨识的假图**（`{ url }`），这样 `drawImage` 分支真的会走；
 *   · 假 ctx 记录 `[op, 参数]` 序列，按 URL 找位置，断言先后顺序。
 */
interface DrawCall {
  op: string
  url?: string
}

/** 记录调用序的假 ctx：只实现本测试会走到的绘制方法 */
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
    fillText: noop,
    fillRect: (): void => void calls.push({ op: 'fillRect' }),
    drawImage: (image: unknown): void => {
      const url = (image as { url?: string } | null)?.url
      calls.push({ op: 'drawImage', ...(url === undefined ? {} : { url }) })
    },
    // 样式属性可写即可
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

/** 桩：任何 URL 都返回可辨识的假图（`{ url }`），并记住请求过的 URL */
function stubImages(seen: string[]): void {
  vi.spyOn(counterImages, 'get').mockImplementation((url: string) => {
    seen.push(url)
    return { url } as unknown as CanvasImageSource
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

const SCALE = 0.6
/** 让某格落在视口内：以该格心为视口中心 */
function viewportAt(hex: { col: number; row: number }, size: Size): ViewportTransform {
  const center = hexCanvasPoint(hex)
  return {
    scale: SCALE,
    offsetX: size.width / 2 - center.x * SCALE,
    offsetY: size.height / 2 - center.y * SCALE,
  }
}

const VIEW: Size = { width: 800, height: 600 }

function tokenAt(hex: { col: number; row: number }, extra: Partial<UnitToken> = {}): UnitToken {
  return {
    id: `u-${hex.col}.${hex.row}`,
    hex,
    side: 'soviet',
    unitId: 'su-infantry-ru-6-rifle-div',
    face: 'combat',
    images: { front: 'Ru_6_Inf_Div_F.png', back: 'Ru_6_Inf_Div_B.png' },
    label: '12-2-2',
    selected: true,
    ended: false,
    modeLetter: 'C',
    dg: false,
    awaitingFuel: false,
    fuelled: false,
    ...extra,
  }
}

describe('B1 绘制层次（用户 2026-09-16 #2）', () => {
  it('MAP_LAYER_ORDER：工事在算子之后、状态贴图在最后', () => {
    const order = [...MAP_LAYER_ORDER]
    expect(order.indexOf('printedHedgehogs')).toBeGreaterThan(order.indexOf('tokens'))
    expect(order.indexOf('statusTextures')).toBeGreaterThan(order.indexOf('tokens'))
  })

  it('工事贴图压在算子**之上**（同一帧里 hedgehog 的 drawImage 晚于算子图）', () => {
    const hedgehog = mapLayers.printedHedgehogs[0]!
    const calls: DrawCall[] = []
    const seen: string[] = []
    stubImages(seen)

    drawMap(recordingCtx(calls), {
      viewport: viewportAt(hedgehog, VIEW),
      viewSize: VIEW,
      image: null,
      layers: { image: false, grid: false, labels: false, edges: false, hedgehogs: true },
      overlay: {
        tokens: [tokenAt(hedgehog, { id: 'u-hedge' })],
        reachable: [],
        path: [],
        startHex: null,
        selectedIds: [],
      },
    })

    const images = calls.filter((call) => call.op === 'drawImage')
    const tokenIdx = images.findIndex((call) => call.url?.includes('Ru_6_Inf_Div_F.png') === true)
    const hedgeIdx = images.findIndex((call) => call.url === hedgehogTextureUrl(hedgehog.level))
    expect(tokenIdx).toBeGreaterThanOrEqual(0)
    expect(hedgeIdx).toBeGreaterThanOrEqual(0)
    expect(hedgeIdx, '工事必须在算子之后画').toBeGreaterThan(tokenIdx)
  })

  it('状态贴图压在该单位**自己的图**之上（模式贴图晚于本单位算子图）', () => {
    const hex = { col: 15, row: 10 }
    const calls: DrawCall[] = []
    const seen: string[] = []
    stubImages(seen)
    const token = tokenAt(hex, { strat: true, exploit: false, outOfSupply: false })

    drawMovementOverlay(
      recordingCtx(calls),
      { tokens: [token], reachable: [], path: [], startHex: null, selectedIds: [] },
      SCALE,
    )

    const images = calls.filter((call) => call.op === 'drawImage')
    const tokenIdx = images.findIndex((call) => call.url?.includes('Ru_6_Inf_Div_F.png') === true)
    const stratIdx = images.findIndex(
      (call) => call.url === markerTextureUrl(MARKER_TEXTURES.strat),
    )
    expect(tokenIdx).toBeGreaterThanOrEqual(0)
    expect(stratIdx).toBeGreaterThanOrEqual(0)
    expect(stratIdx, '状态贴图必须在算子图之后画').toBeGreaterThan(tokenIdx)
  })

  it('同格多枚时，状态贴图只贴在**实际画出的顶牌**上（不贴到看不见的牌上）', () => {
    const hex = { col: 15, row: 10 }
    const calls: DrawCall[] = []
    const seen: string[] = []
    stubImages(seen)
    /*
     * 顶牌判定见 `topTokenOf`：正在操作的那一枚（selected）> 飞机 > 最后一枚。
     * 故把「带战略标记」的那枚设为**未选中**且排在前面，顶牌就是后一枚（无标记）⇒ 不该出现战略贴图。
     */
    const hidden = tokenAt(hex, { id: 'u-hidden', selected: false, strat: true })
    const top = tokenAt(hex, { id: 'u-top', selected: true, strat: false })

    drawMovementOverlay(
      recordingCtx(calls),
      { tokens: [hidden, top], reachable: [], path: [], startHex: null, selectedIds: [] },
      SCALE,
    )

    const stratDraws = calls.filter(
      (call) => call.op === 'drawImage' && call.url === markerTextureUrl(MARKER_TEXTURES.strat),
    )
    expect(stratDraws).toHaveLength(0) // 顶牌没有战略标记 ⇒ 不画（其下那枚不参与）
  })

  it('工事角标在未就绪时走矢量回退，且仍在算子之后（arc 晚于 fillRect）', () => {
    const hedgehog = mapLayers.printedHedgehogs[0]!
    const ops: string[] = []
    const ctx = recordingCtx([])
    // 让贴图不可用 ⇒ 走「圆点 + 等级」回退；用 arc 作为工事的可辨识操作
    const spy = vi.spyOn(counterImages, 'get').mockReturnValue(null)
    const original = ctx.arc as unknown as (...args: unknown[]) => void
    // 记录 arc 位置
    let arcIndex = -1
    ;(ctx as unknown as { arc: () => void }).arc = (): void => {
      if (arcIndex < 0) arcIndex = ops.length
      ops.push('arc')
    }
    ;(ctx as unknown as { fillRect: () => void }).fillRect = (): void => {
      ops.push('fillRect')
    }
    void original

    drawMap(ctx, {
      viewport: viewportAt(hedgehog, VIEW),
      viewSize: VIEW,
      image: null,
      layers: { image: false, grid: false, labels: false, edges: false, hedgehogs: true },
      overlay: {
        tokens: [tokenAt(hedgehog, { id: 'u-hedge2' })],
        reachable: [],
        path: [],
        startHex: null,
        selectedIds: [],
      },
    })
    spy.mockRestore()

    const lastRect = ops.lastIndexOf('fillRect')
    expect(arcIndex, '工事回退角标必须在算子色块之后').toBeGreaterThan(lastRect)
  })
})

/**
 * 防"测试空转"：断言上面用的定位方式**确实**把测试格放进了视口
 * （否则 `visible*` 裁掉全部要素，绘制序断言会"因为没画所以通过"）。
 */
describe('B1 定位口径（防测试空转）', () => {
  it('viewportAt 让目标格落在可见矩形内 ⇒ 工事与算子真的会被画出来', () => {
    const hedgehog = mapLayers.printedHedgehogs[0]!
    const viewport = viewportAt(hedgehog, VIEW)
    const visible = visiblePrintedHedgehogs(viewport, VIEW)
    expect(visible.some((item) => item.col === hedgehog.col && item.row === hedgehog.row)).toBe(
      true,
    )
  })
})
