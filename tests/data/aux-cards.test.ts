import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { auxCards, mapConfig, mapLayers } from '@/data'

/**
 * A10：辅助卡分区（用户 2026-09-16 交付标定）
 *
 * 两条都钉住：① 卡与分区的清单、坐标在图内、类型齐全；
 * ② **主图几何与主图标定一致**（同一批标定的另一半，user 2026-09-16 一并交付）。
 */
describe('A10：辅助卡分区（aux-cards.json）', () => {
  /**
   * 卡面图所在目录（**允许分散在子目录**）
   *
   * 用户 2026-09-16 把素材整理进了 `地图及辅助卡\要放进游戏的\{需要的表格,需要的盒}\`
   * 与 `增援\`，故这里按"候选目录"逐个找，而不是写死一个目录 ——
   * 否则素材一搬家，门禁就会红成"缺图"，看不出是"图没了"还是"目录变了"。
   */
  const CARDS_DIRS = [
    'D:\\OCS\\OCS斯摩棱斯克素材\\图片素材库\\地图及辅助卡',
    'D:\\OCS\\OCS斯摩棱斯克素材\\图片素材库\\地图及辅助卡\\要放进游戏的\\需要的盒',
    'D:\\OCS\\OCS斯摩棱斯克素材\\图片素材库\\地图及辅助卡\\要放进游戏的\\需要的表格',
    'D:\\OCS\\OCS斯摩棱斯克素材\\图片素材库\\地图及辅助卡\\增援',
  ]

  /** 在候选目录里找这张图（找不到返回 null） */
  const findCardImage = (image: string): string | null => {
    for (const dir of CARDS_DIRS) {
      const file = path.join(dir, image)
      if (fs.existsSync(file)) return file
    }
    return null
  }

  it('7 张卡 / 29 个分区，两侧都齐（死人堆 · 标记 · 拆分 · 空军激活与未激活）＋ 1 张双方共用的运力记录轨', () => {
    expect(auxCards.cards).toHaveLength(7)
    const kinds = auxCards.cards.flatMap((card) => card.regions.map((r) => r.boxKind))
    // B31c：运力记录轨（Rail-Sea-Cap）14 格 + 原有 15 个盒分区
    expect(kinds).toHaveLength(29)
    expect(kinds.filter((kind) => kind === 'capacity_track')).toHaveLength(14)
    for (const kind of [
      'dead_pile',
      'markers',
      'breakdown_pool',
      'air_box_active',
      'air_box_inactive',
    ])
      expect(kinds.filter((k) => k === kind).length, `${kind} 应两侧各一份`).toBe(2)
    // 苏联专有的两项（1.6c 特补师池、2.3a 警戒池）与地图外入口盒只有苏方卡面有
    expect(kinds.filter((k) => k === 'special_repl_division_pool')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'alarm_pool')).toHaveLength(1)
    expect(
      kinds.filter((k) => k === 'edge_box_northeast' || k === 'edge_box_southeast'),
    ).toHaveLength(2)
    // 编队标记抽取盒只有轴方卡面有
    expect(kinds.filter((k) => k === 'formation_draw')).toHaveLength(1)
  })

  it('每个分区矩形都落在卡面之内（越界即错的兜底断言）', () => {
    for (const card of auxCards.cards) {
      for (const region of card.regions) {
        const { x, y, w, h } = region.rect
        expect(x + w, `${card.id}/${region.id} 右边界`).toBeLessThanOrEqual(card.imageSize.w)
        expect(y + h, `${card.id}/${region.id} 下边界`).toBeLessThanOrEqual(card.imageSize.h)
      }
    }
  })

  it('卡面图文件存在（资产门禁：卡面缺图即红）', () => {
    for (const card of auxCards.cards) {
      const file = findCardImage(card.image)
      expect(file, `缺少卡面 ${card.image}`).not.toBeNull()
      // PNG 头里的尺寸必须与声明一致（防止标定与图错配）
      const buf = fs.readFileSync(file!)
      const w = buf.readUInt32BE(16)
      const h = buf.readUInt32BE(20)
      expect({ w, h }, `${card.image} 尺寸`).toEqual(card.imageSize)
    }
  })

  it('卡 id 与 side 一一对应（每方 3 张：死人堆 / 地图外盒 / 空军盒）', () => {
    for (const side of ['axis', 'soviet'] as const) {
      const mine = auxCards.cards.filter((card) => card.side === side)
      expect(mine.map((card) => card.boxKind).sort()).toEqual(['air_box', 'dead_pile', 'offboard'])
    }
  })
})

/**
 * 主图标定（同批交付）：`D:\OCS\六角格标定测试\map.json`
 *
 * 标定值：orient=flat、protrudeTB=up、size(R)=63.27、tx=112.5、ty=3947.5、rows=36、cols=62、
 * 覆盖 off=76 / top=31 / bottom=31 ⇒ 62×36−76 = **2156** 格。
 * 我们的产物独立导出自源库 `map_hexes.json`，此处断言两者**逐项一致**：
 * 格数与格集合一致（见 map-layers.test.ts 的逐格契约）、几何常数由 R 推出后与产物相同。
 */
describe('主图标定一致性（map.json ↔ map-config/map-layers）', () => {
  const R = 63.27 // 标定的六角格外接圆半径（flat-top）

  it('几何常数一致：列间距 1.5R、行间距 √3R、原点 (112.5, 3947.5)', () => {
    // R 由标定给到 2 位小数（63.27），故容差取 0.01px：
    // 实测列间距＝1.5R 精确成立（94.905），行间距 109.584 与 √3R＝109.5869 差 0.003px（产物侧的舍入）
    expect(mapConfig.geometry.hexWidthPx).toBeCloseTo(1.5 * R, 3)
    expect(Math.abs(mapConfig.geometry.hexHeightPx - Math.sqrt(3) * R)).toBeLessThan(0.01)
    expect(mapConfig.geometry.originX).toBeCloseTo(112.5, 6)
    expect(mapConfig.geometry.originY).toBeCloseTo(3947.5, 6)
  })

  it('格数与行列范围一致：62 列 × 36 行、图内 2156 格', () => {
    expect(mapLayers.hexes).toHaveLength(2156)
    const cols = mapLayers.hexes.map((h) => h.col)
    const rows = mapLayers.hexes.map((h) => h.row)
    expect(Math.min(...cols)).toBe(1)
    expect(Math.max(...cols)).toBe(62)
    expect(Math.min(...rows)).toBe(0)
    expect(Math.max(...rows)).toBe(35)
  })
})
