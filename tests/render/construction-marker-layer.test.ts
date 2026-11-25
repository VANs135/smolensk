import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_CHIP_ANCHORS, HEX_CHIP_SIZE_RATIO, HEX_CHIP_SLOT_STEP } from '@/render/hex-chips'
import { HEX_RADIUS_PX, hexCanvasPoint, isBoardHex } from '@/render/map-layout'
import { DEFAULT_MAP_LAYERS, MAP_LAYER_ORDER, constructionMarkerBadges } from '@/render/map-render'

/**
 * 专规 3.5：**建造标记（桥 / 简易机场）＝格内小贴片之一**（统一尺 0.28R、下中槽位）
 *
 * 原文：「可在**任意轴方移动阶段**、**单位移动之前**使用，把两面之一放进一个有**轴方战斗单位**的格。
 *   这是**免费**的。三枚标记是剧本 1 与 2 初设的一部分；每枚只能**使用一次**。」
 *
 * 用户 2026-11-26 三次口径：
 *   ① 「建造标记要画对应的算子，大小和空军基地一样」—— 先按算子原尺画；
 *   ② 「不要这么大，和设施一样小，并且放格子边缘位置」—— 改为设施贴片尺；
 *   ③ 「统一格子里 HQ、设施、占领标记等小贴图的尺寸，每个东西有固定的放置位置」——
 *      并入 `hex-chips` 的统一尺 `HEX_CHIP_SIZE_RATIO`、固定槽位 `HEX_CHIP_ANCHORS.construction`（下中），
 *      同格多枚沿 `HEX_CHIP_SLOT_STEP` 向右排开。
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

  it('★ 统一尺 + 固定槽位：0.28R、格右下内沿（与 HQ / 设施 / 占领标记同一枚尺）', () => {
    const [badge] = constructionMarkerBadges([{ kind: 'bridge', hex: BOARD }])
    expect(badge).toBeDefined()
    const center = hexCanvasPoint(BOARD)
    expect(badge!.side).toBeCloseTo(HEX_RADIUS_PX * HEX_CHIP_SIZE_RATIO, 6)
    expect(badge!.center.x).toBeCloseTo(
      center.x + HEX_RADIUS_PX * HEX_CHIP_ANCHORS.construction.x,
      6,
    )
    expect(badge!.center.y).toBeCloseTo(
      center.y + HEX_RADIUS_PX * HEX_CHIP_ANCHORS.construction.y,
      6,
    )
    // 右下：x 偏右（不占设施用的左下、不压格心）、y 偏下
    expect(badge!.center.x).toBeGreaterThan(center.x)
    expect(badge!.center.y).toBeGreaterThan(center.y)
    // 必须明显小于算子原尺（上一版按算子原尺画 ⇒ 用户退回）
    expect(badge!.side).toBeLessThan(HEX_RADIUS_PX * 0.4)
  })

  it('★ 同格多枚沿统一步长向右排开（不叠成一坨）', () => {
    const badges = constructionMarkerBadges([
      { kind: 'bridge', hex: BOARD },
      { kind: 'airStrip', hex: BOARD },
    ])
    expect(badges.map((badge) => badge.kind)).toEqual(['bridge', 'airStrip'])
    const first = badges[0]!
    const second = badges[1]!
    expect(second.center.x - first.center.x).toBeCloseTo(HEX_RADIUS_PX * HEX_CHIP_SLOT_STEP, 6)
    expect(second.center.y).toBeCloseTo(first.center.y, 6)
    // 尺寸不因枚数变化
    expect(second.side).toBeCloseTo(first.side, 6)
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
    // 统一尺与固定槽位来自 hex-chips，不另立一套数值
    expect(render).toContain('HEX_CHIP_SIZE_RATIO')
    expect(render).toContain('CONSTRUCTION_CORNER')
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
