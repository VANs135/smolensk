import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { createMultiTrackRailFacts, boundarySideOf, panzerGroupBoundaryPath } from '@/engine/rules'
import { boundaryLinePoints } from '@/render/map-render'
import { useWorkbenchStore } from '@/stores'

/**
 * 批 F 切片 1（用户口径 第四批⑥）：**装甲集群分界线沿多轨铁路折线**
 *
 * 原文（`rules.json → guderian_hoth.boundary`）：「分界线为 **19.19 → 62.23** 的**多轨铁路线**」。
 * 修前两端点是对的，但：**渲染**画的是两端格心之间的一条**直线**（`boundaryLinePoints`），
 * **判据**按**列线性插值行号**（`boundarySideOf`）—— 而铁路线在 ±1 行内左右摆动 ⇒ 线与判据都偏。
 *
 * 本切片：路径**从数据推**（`map-layers.json` 的多轨铁路格边，BFS），**渲染与判据共用同一条**。
 *
 * ## 测法边界（如实交代）
 *   · 路径**不写死**在代码里 ⇒ 本文件把它与「§17.87 手工打出的 45 格」逐格对照（数据改了会立刻红）；
 *   · **不覆盖**画布像素（仓库不挂渲染测试）⇒ "线真的沿铁路画出来"由 `boundaryLinePoints` 的折点数
 *     与源码守卫承担，观感靠人眼；
 *   · 折线判据的"极角/跨列"等边角情形：路径是链状的（度数以 2 为主，仅 3 处度数 3），
 *     且判据只按**列的行区间**取值 ⇒ 不存在"同一格两可"的情形（区间外只有 north/south 两支）。
 */

/** §17.87 手工打出的那条 45 格路径（作为**独立证据**：数据推出的必须与它逐格一致） */
const DOCUMENTED_PATH: readonly string[] =
  `19.19 20.19 21.20 22.19 23.20 24.19 25.20 26.19 27.20 28.19 29.19
30.18 31.19 32.19 33.19 34.18 35.19 36.18 37.18 38.18 38.19 39.20
40.20 41.21 42.20 43.21 44.20 45.21 46.20 47.21 48.20 49.20 50.20
51.20 52.20 53.20 54.19 55.20 56.20 57.21 58.21 59.22 60.22 61.23 62.23`
    .split(/\s+/)
    .filter((item) => item !== '')

const path = () =>
  panzerGroupBoundaryPath({
    from: { col: 19, row: 19 },
    to: { col: 62, row: 23 },
    facts: createMultiTrackRailFacts(),
  })

describe('批 F 切片 1：分界线沿多轨铁路折线', () => {
  it('★ 路径**从数据推出**且与 §17.87 手工打出的 45 格逐格一致', () => {
    const rail = path()
    expect(rail).not.toBeNull()
    expect(rail!.map((hex) => `${hex.col}.${hex.row}`)).toEqual(DOCUMENTED_PATH)
    // 两端就是数据给的两个端点（19.19 / 62.23）
    expect(rail![0]).toEqual({ col: 19, row: 19 })
    expect(rail!.at(-1)).toEqual({ col: 62, row: 23 })
    // 是一条**向东走**的链（列单调不减 —— 铁路不会往回折）
    for (let index = 1; index < rail!.length; index += 1) {
      expect(rail![index]!.col).toBeGreaterThanOrEqual(rail![index - 1]!.col)
    }
  })

  it('★ 判据改按折线：**路径上的格**判 onLine（直线口径会把它判成两侧）', () => {
    const rail = path()!
    const boundary = { west: { col: 19, row: 19 }, east: { col: 62, row: 23 }, path: rail }

    // 路径经过的每一格都算"在线上"（3.4a 允许 Guderian「上或南」、Hoth「上或北」）
    for (const hex of rail) expect(boundarySideOf(hex, boundary)).toBe('onLine')

    /*
     * 取一处"直线与折线不同"的格：30.18 在**路径**上（折线判 onLine），
     * 而**直线插值**在该列给出约 19.9 ⇒ 30.18 会被判成 south（差 2 行）。
     * ★ 坐标约定（`map-layout` 的标定注释）：**行号越大越靠北** ⇒ row 18 < 19.9 落在"南侧"。
     * ⇒ 这一格正说明"照原文沿折线判"与旧口径的分野：**直线口径会多判出一批站错一侧的格**。
     */
    const straightOnly = boundarySideOf(
      { col: 30, row: 18 },
      { west: boundary.west, east: boundary.east },
    )
    expect(straightOnly).toBe('south')
    expect(boundarySideOf({ col: 30, row: 18 }, boundary)).toBe('onLine')

    // 区间之外：北（行号更大）/ 南（行号更小）各一侧
    expect(boundarySideOf({ col: 30, row: 22 }, boundary)).toBe('north')
    expect(boundarySideOf({ col: 30, row: 16 }, boundary)).toBe('south')
  })

  it('★ 折线判据在"同一列上下摆"处取行区间（38.18 → 38.19 两格都算线上）', () => {
    const rail = path()!
    const boundary = { west: { col: 19, row: 19 }, east: { col: 62, row: 23 }, path: rail }
    expect(
      rail
        .filter((hex) => hex.col === 38)
        .map((hex) => hex.row)
        .sort(),
    ).toEqual([18, 19])
    expect(boundarySideOf({ col: 38, row: 18 }, boundary)).toBe('onLine')
    expect(boundarySideOf({ col: 38, row: 19 }, boundary)).toBe('onLine')
    // 行号更大 ＝ 更靠北；更小 ＝ 更靠南
    expect(boundarySideOf({ col: 38, row: 20 }, boundary)).toBe('north')
    expect(boundarySideOf({ col: 38, row: 17 }, boundary)).toBe('south')
  })

  it('★ 不连通时如实返回 null（不臆造一条线）', () => {
    const none = panzerGroupBoundaryPath({
      from: { col: 19, row: 19 },
      to: { col: 62, row: 23 },
      facts: { isMultiTrackRail: () => false },
    })
    expect(none).toBeNull()
  })

  it('★ 渲染折点＝路径格心（折线）；没有路径时退回两端点连线', () => {
    const rail = path()!
    const withPath = boundaryLinePoints({
      from: { col: 19, row: 19 },
      to: { col: 62, row: 23 },
      path: rail,
    })
    expect(withPath).toHaveLength(rail.length)
    const straight = boundaryLinePoints({ from: { col: 19, row: 19 }, to: { col: 62, row: 23 } })
    expect(straight).toHaveLength(2)
  })

  it('★ 投影层：`panzerGroupBoundaryWithPath` / `boundaryView` 都带路径；初设默认归属读同一份', () => {
    setActivePinia(createPinia())
    const workbench = useWorkbenchStore()
    expect(workbench.panzerBoundaryPath).toHaveLength(DOCUMENTED_PATH.length)
    expect(workbench.panzerGroupBoundaryWithPath?.path).toHaveLength(DOCUMENTED_PATH.length)
    expect(workbench.boundaryView?.path).toHaveLength(DOCUMENTED_PATH.length)

    /*
     * 源码守卫（口径只有一处）：`setup.ts` 不再自持一份**直线版**分界线，
     * 而是读 `workbench.panzerGroupBoundaryWithPath` —— 否则"默认归属"与"义务判定"会拿两条线去判。
     */
    const setup = readFileSync('src/stores/setup.ts', 'utf8')
    expect(setup).toContain('workbench.panzerGroupBoundaryWithPath')
    expect(setup).not.toContain('mapConfig.panzerGroupBoundary')
  })
})
