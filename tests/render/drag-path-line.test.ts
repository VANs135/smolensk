import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { isBoardHex } from '@/render/map-layout'
import { DEFAULT_MAP_LAYERS, MAP_PALETTE, drawMap, type DragPathPreview } from '@/render/map-render'

/**
 * 用户 2026-11-18：拖动单位时的**路径线**
 *
 * 口径：
 *   · 拖动经过的格连成一条折线（含终点），让玩家看见这一次拖过了哪些格；
 *   · 路径走不通时**不画落位终点**（只留一条红色路径线）。
 *
 * 测法边界：这里测图层本身（假 ctx 记录 stroke / arc）与装配守卫；
 * 拖动起止与跟手由 MapCanvas 的指针流程负责（见 `counter-drag-ghost` 与流程用例）。
 */

/** 图内两格（画线只要求是合法格） */
const PATH: readonly HexRef[] = (() => {
  const board = mapLayers.hexes.filter((hex) => isBoardHex({ col: hex.col, row: hex.row }))
  if (board.length < 2) throw new Error('地图上找不到两个图内格')
  return [
    { col: board[0]!.col, row: board[0]!.row },
    { col: board[1]!.col, row: board[1]!.row },
  ]
})()

/** 只记 stroke 颜色与 arc 的假 ctx（其它图层全关 ⇒ 观察到的就是路径层） */
function strokeCtx() {
  const styles: string[] = []
  const arcs: { x: number; y: number; r: number }[] = []
  let style = ''
  const ctx = {
    canvas: { width: 6000, height: 4000 },
    save() {},
    restore() {},
    setTransform() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc(x: number, y: number, r: number) {
      arcs.push({ x, y, r })
    },
    rect() {},
    fill() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    setLineDash() {},
    drawImage() {},
    fillText() {},
    strokeText() {},
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    stroke() {
      styles.push(style)
    },
    get strokeStyle() {
      return style
    },
    set strokeStyle(value: string) {
      style = value
    },
    fillStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, styles, arcs }
}

/** 只留高亮/工事等全部关掉，避免其它图层写入 stroke 颜色 */
const OFF_LAYERS = {
  ...DEFAULT_MAP_LAYERS,
  image: false,
  grid: false,
  labels: false,
  edges: false,
  hedgehogs: false,
  control: false,
  constructionMarkers: false,
  mapMarkers: false,
}

function renderPath(preview: DragPathPreview | null) {
  const { ctx, styles, arcs } = strokeCtx()
  drawMap(ctx, {
    viewport: { scale: 1, offsetX: 0, offsetY: 0 },
    viewSize: { width: 6000, height: 4000 },
    layers: OFF_LAYERS,
    image: null,
    dragPath: preview,
  })
  return { styles, arcs }
}

describe('拖动路径图层', () => {
  it('★ 可达路径：画一条折线，并在终点画一枚落位圈', () => {
    const { styles, arcs } = renderPath({ path: PATH, ok: true })

    expect(styles).toContain(MAP_PALETTE.dragPath)
    expect(arcs).toHaveLength(1)
  })

  it('★ 走不通：只画红色路径线，**不画落位终点**', () => {
    const { styles, arcs } = renderPath({ path: PATH, ok: false })

    expect(styles).toContain(MAP_PALETTE.dragPathBlocked)
    expect(arcs).toHaveLength(0)
  })

  it('只有一格 / 没给预览 ⇒ 什么都不画', () => {
    expect(renderPath({ path: [PATH[0]!], ok: true })).toEqual({ styles: [], arcs: [] })
    expect(renderPath(null)).toEqual({ styles: [], arcs: [] })
  })

  it('★ 装配守卫：画布把拖动预览交给 drawMap，对局台把预览回调传给画布', () => {
    const render = readFileSync('src/render/map-render.ts', 'utf8')
    expect(render).toContain('dragPath?: DragPathPreview | null')
    expect(render).toContain('if (dragPath !== null && dragPath.path.length >= 2)')

    const canvas = readFileSync('src/components/map/MapCanvas.vue', 'utf8')
    expect(canvas).toContain('props.dragPathPreview')
    expect(canvas).toContain('dragPath: counterDragPreview')

    const view = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(view).toContain(':drag-path-preview="mapView.previewMoveDragPath"')
  })
})
