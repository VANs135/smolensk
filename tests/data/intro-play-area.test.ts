import { describe, expect, it } from 'vitest'

import { mapLayers, scenarios } from '@/data'

/**
 * Intro: Vitebsk 的活动区（剧本字段 `playArea`）
 *
 * 用户 2026-11-15 口径：地图活动范围限定在截图内可见的六角格，范围外任何单位不得进入。
 * 口径＝**截图内可见即算**（含四条边的裁切格），取自截图逐格读数：
 *
 *   row 23–30：col 1–24
 *   row 31    ：col 1,3,5,7,9 + 11–24（偶数列被地图标题图压掉，图上无格）
 *   row 32–35：col 11–24（左侧同被标题图压掉）
 *
 * 合计 267 格，全部是 map-layers 里真实存在的格；范围外的地图数据不动（照旧渲染）。
 */

const intro = scenarios.scenarios.find((scenario) => scenario.id === 'Intro')!

const parse = (text: string): { col: number; row: number } => {
  const [col, row] = text.split('.')
  return { col: Number(col), row: Number(row) }
}

/** 逐行应有的列（与截图读数一一对应） */
function expectedColumns(row: number): number[] {
  if (row >= 23 && row <= 30) return Array.from({ length: 24 }, (_, i) => i + 1)
  if (row === 31) return [...[1, 3, 5, 7, 9], ...Array.from({ length: 14 }, (_, i) => i + 11)]
  if (row >= 32 && row <= 35) return Array.from({ length: 14 }, (_, i) => i + 11)
  return []
}

describe('Intro 活动区：截图逐格取定的 267 格', () => {
  it('剧本带活动区字段：rule 非空、267 格、无重复', () => {
    expect(intro.playArea).toBeDefined()
    expect(intro.playArea!.rule.length).toBeGreaterThan(0)
    const hexes = intro.playArea!.hexes
    expect(hexes).toHaveLength(267)
    expect(new Set(hexes).size).toBe(267)
  })

  it('每一格都是地图库里真实存在的格（不造格、不删格）', () => {
    const onMap = new Set(mapLayers.hexes.map((hex) => `${hex.col}.${hex.row}`))
    for (const text of intro.playArea!.hexes) expect(onMap.has(text)).toBe(true)
  })

  it('逐行区间与截图读数一致（上 35 / 下 23 / 左 1 / 右 24）', () => {
    const actual = new Map<number, number[]>()
    for (const text of intro.playArea!.hexes) {
      const hex = parse(text)
      const list = actual.get(hex.row) ?? []
      list.push(hex.col)
      actual.set(hex.row, list)
    }
    expect([...actual.keys()].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 13 }, (_, i) => i + 23),
    )
    for (const [row, cols] of actual) {
      expect([...cols].sort((a, b) => a - b)).toEqual(expectedColumns(row))
    }
  })

  it('四条边按截图裁切口径：含 1.23 / 24.35 / 9.31 / 11.32，不含范围外', () => {
    const hexes = new Set(intro.playArea!.hexes)
    for (const text of ['1.23', '24.23', '1.31', '9.31', '11.32', '24.35', '13.27']) {
      expect(hexes.has(text)).toBe(true)
    }
    // 行 31 偶数列被标题图压掉、行 32 起的列 1–10 同理 ⇒ 不在活动区
    for (const text of ['2.31', '10.31', '1.32', '10.35', '1.22', '25.23', '24.36', '1.36']) {
      expect(hexes.has(text)).toBe(false)
    }
  })

  it('其余剧本不设活动区（缺省＝全图不限）', () => {
    for (const scenario of scenarios.scenarios.filter((item) => item.id !== 'Intro'))
      expect(scenario.playArea).toBeUndefined()
  })
})
