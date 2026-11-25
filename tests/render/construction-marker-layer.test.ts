import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_RADIUS_PX, hexCanvasPoint, isBoardHex } from '@/render/map-layout'
import {
  CONSTRUCTION_MARKER_OCCUPIED_CORNER,
  CONSTRUCTION_MARKER_OCCUPIED_RATIO,
  CONSTRUCTION_MARKER_SIZE_RATIO,
  DEFAULT_MAP_LAYERS,
  MAP_LAYER_ORDER,
  constructionMarkerCounters,
} from '@/render/map-render'
import { TOKEN_SIZE_PX } from '@/render/stack-fan'

/**
 * 专规 3.5：**建造标记（桥 / 简易机场）在地图上按算子原尺画**
 *
 * 原文：「可在**任意轴方移动阶段**、**单位移动之前**使用，把两面之一放进一个有**轴方战斗单位**的格。
 *   这是**免费**的。三枚标记是剧本 1 与 2 初设的一部分；每枚只能**使用一次**。」
 *
 * 用户 2026-11-26：「建造标记要画对应的算子，大小和空军基地一样」。
 *   旧版是 0.42R 的左下小角标 ⇒ 24% 缩放下约 10px，等于看不见；现按 `TOKEN_SIZE_PX` 画。
 *
 * 测法边界：本组只测**投影与图层**（纯函数 + 图层顺序 + 装配守卫）；
 *   "画出来长什么样"（贴图/回退色）由人工目检 —— 与工事/控制标记那两层的测法一致。
 */
describe('专规 3.5：建造标记的地图层', () => {
  /** 图内第一格（放在图上的标记才画） */
  const BOARD: HexRef = (() => {
    const found = mapLayers.hexes.find((hex) => isBoardHex({ col: hex.col, row: hex.row }))
    if (found === undefined) throw new Error('地图上找不到图内格')
    return { col: found.col, row: found.row }
  })()

  it('★ 图层顺序：建造标记在**控制标记之后**（压在最上层），且默认开启', () => {
    const control = MAP_LAYER_ORDER.indexOf('controlMarkers')
    const construction = MAP_LAYER_ORDER.indexOf('constructionMarkers')
    expect(control).toBeGreaterThanOrEqual(0)
    expect(construction).toBeGreaterThan(control)
    expect(DEFAULT_MAP_LAYERS.constructionMarkers).toBe(true)
  })

  it('★ 空格里：算子原尺（与空军基地算子同尺寸）画在格心', () => {
    const [counter] = constructionMarkerCounters([{ kind: 'bridge', hex: BOARD }])
    expect(counter).toBeDefined()
    const center = hexCanvasPoint(BOARD)
    expect(counter!.center.x).toBeCloseTo(center.x, 6)
    expect(counter!.center.y).toBeCloseTo(center.y, 6)
    expect(counter!.side).toBeCloseTo(TOKEN_SIZE_PX * CONSTRUCTION_MARKER_SIZE_RATIO, 6)
    expect(counter!.occupied).toBe(false)
    // 原尺必须明显大于旧角标（0.42R 是"看不见"的病灶）
    expect(counter!.side).toBeGreaterThan(HEX_RADIUS_PX * 0.6)
  })

  it('★ 同格已驻算子：缩半尺并让到左下内沿（不让驻军算子被整块盖住）', () => {
    const occupied = new Set([`${BOARD.col}.${BOARD.row}`])
    const [counter] = constructionMarkerCounters([{ kind: 'airStrip', hex: BOARD }], occupied)
    const center = hexCanvasPoint(BOARD)
    expect(counter!.occupied).toBe(true)
    expect(counter!.side).toBeCloseTo(TOKEN_SIZE_PX * CONSTRUCTION_MARKER_OCCUPIED_RATIO, 6)
    expect(counter!.center.x).toBeCloseTo(
      center.x + HEX_RADIUS_PX * CONSTRUCTION_MARKER_OCCUPIED_CORNER.x,
      6,
    )
    expect(counter!.center.y).toBeCloseTo(
      center.y + HEX_RADIUS_PX * CONSTRUCTION_MARKER_OCCUPIED_CORNER.y,
      6,
    )
  })

  it('★ 桥与简易机场都投得出来（kind 原样带出，绘制据此选回退字/色）', () => {
    const counters = constructionMarkerCounters([
      { kind: 'bridge', hex: BOARD },
      { kind: 'airStrip', hex: BOARD },
    ])
    expect(counters.map((counter) => counter.kind)).toEqual(['bridge', 'airStrip'])
  })

  it('★ 不在图上的格不画（与工事/控制标记同一纪律）', () => {
    expect(constructionMarkerCounters([{ kind: 'bridge', hex: { col: -5, row: -5 } }])).toEqual([])
    // 空数组也不炸
    expect(constructionMarkerCounters([])).toEqual([])
  })

  it('★ 源码守卫：图层真的挂在 `drawMap` 上，且上层把 store 的标记传进了画布', () => {
    const render = readFileSync('src/render/map-render.ts', 'utf8')
    expect(render).toContain('constructionMarkers?: readonly ConstructionMarkerPiece[] | null')
    expect(render).toContain('if (layers.constructionMarkers)')
    expect(render).toContain('export function constructionMarkerCounters')
    // 图＝素材库正式算子面（桥/机场共用），并进了预载清单
    expect(render).toContain('constructionMarkerImageUrl')
    const images = readFileSync('src/render/token-images.ts', 'utf8')
    expect(images).toContain("CONSTRUCTION_MARKER_TEXTURE = 'Ge_Air_Strip-Bridge_F.png'")
    expect(images).toContain('constructionMarkerImageUrl(),')
    // 画布只画被给的东西（不读 store）：props → drawMap 的 options
    const canvas = readFileSync('src/components/map/MapCanvas.vue', 'utf8')
    expect(canvas).toContain('constructionMarkers: props.constructionMarkers')
    // 对局台把 workbench 的标记列表传给画布
    const view = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(view).toContain(':construction-markers="workbench.constructionMarkerPieces"')
  })
})
