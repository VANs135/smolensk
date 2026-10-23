import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_RADIUS_PX, hexCanvasPoint, isBoardHex } from '@/render/map-layout'
import {
  CONSTRUCTION_MARKER_CORNER,
  CONSTRUCTION_MARKER_RATIO,
  DEFAULT_MAP_LAYERS,
  MAP_LAYER_ORDER,
  constructionMarkerBadges,
} from '@/render/map-render'

/**
 * 专规 3.5：**建造标记（桥 / 简易机场）在地图上看得见**（B34 余项③b 的第二小项）
 *
 * 原文：「可在**任意轴方移动阶段**、**单位移动之前**使用，把两面之一放进一个有**轴方战斗单位**的格。
 *   这是**免费**的。三枚标记是剧本 1 与 2 初设的一部分；每枚只能**使用一次**。」
 *
 * ★ 修前病灶：标记放得下去（`constructionMarkerPieces` 有状态、专规面板里也列了文字），
 *   但**地图上不画** ⇒ 玩家丢完就失去唯一空间参照（"那枚桥到底在哪一格"）。
 *   它还会改变盘面事实（13.8b 过河取费、15.2C 卸载上限），看不见等于记不住。
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

  it('★ 投影：角标落在格心**左下**内沿（与工事右上、控制标记左上错开），尺寸＝0.42R', () => {
    const [badge] = constructionMarkerBadges([{ kind: 'bridge', hex: BOARD }])
    expect(badge).toBeDefined()
    const center = hexCanvasPoint(BOARD)
    expect(badge!.center.x).toBeCloseTo(center.x + HEX_RADIUS_PX * CONSTRUCTION_MARKER_CORNER.x, 6)
    expect(badge!.center.y).toBeCloseTo(center.y + HEX_RADIUS_PX * CONSTRUCTION_MARKER_CORNER.y, 6)
    expect(badge!.side).toBeCloseTo(HEX_RADIUS_PX * CONSTRUCTION_MARKER_RATIO, 6)
    // 左下：x 偏左、y 偏下（与格心比较）
    expect(badge!.center.x).toBeLessThan(center.x)
    expect(badge!.center.y).toBeGreaterThan(center.y)
  })

  it('★ 桥与简易机场都投得出来（kind 原样带出，绘制据此选颜色与字）', () => {
    const badges = constructionMarkerBadges([
      { kind: 'bridge', hex: BOARD },
      { kind: 'airStrip', hex: BOARD },
    ])
    expect(badges.map((badge) => badge.kind)).toEqual(['bridge', 'airStrip'])
  })

  it('★ 不在图上的格不画（与工事/控制标记同一纪律）', () => {
    expect(constructionMarkerBadges([{ kind: 'bridge', hex: { col: -5, row: -5 } }])).toEqual([])
    // 空数组也不炸
    expect(constructionMarkerBadges([])).toEqual([])
  })

  it('★ 源码守卫：图层真的挂在 `drawMap` 上，且上层把 store 的标记传进了画布', () => {
    const render = readFileSync('src/render/map-render.ts', 'utf8')
    expect(render).toContain('constructionMarkers?: readonly ConstructionMarkerPiece[] | null')
    expect(render).toContain('if (layers.constructionMarkers)')
    expect(render).toContain('export function constructionMarkerBadges')
    // 画布只画被给的东西（不读 store）：props → drawMap 的 options
    const canvas = readFileSync('src/components/map/MapCanvas.vue', 'utf8')
    expect(canvas).toContain('constructionMarkers: props.constructionMarkers')
    // 对局台把 workbench 的标记列表传给画布
    const view = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(view).toContain(':construction-markers="workbench.constructionMarkerPieces"')
  })
})
