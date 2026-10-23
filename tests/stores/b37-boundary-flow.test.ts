import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { mapConfig } from '@/data'
import { hexCanvasPoint } from '@/render/map-layout'
import { boundaryLinePoints } from '@/render/map-render'
import { toConsoleUnit, unitChoices, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * B37 切片 2：**装甲集群分界线**（用户口径 #14「画装甲集群分界线」）
 *
 * 原文（3.4）：分界线为 **19.19 → 62.23** 的多轨铁路线；3.4a 的 DG 条件是
 * 「与另一集群同堆叠/相邻」与「错误一侧且 Orsha 以东」，**相位末**结算。
 * 数据：`map-config.json` 的 `panzerGroupBoundary`；结论：引擎 `panzerGroupObligations`（含日期闸门）。
 *
 * ★ 一条**测法边界（如实）**：本仓库**不挂组件渲染测试**，也**不用假 ctx** ⇒
 *   "线真的画在画布上"由**几何纯函数（`boundaryLinePoints`）+ 源码守卫**钉住；
 *   像素结果靠人眼。分界线的"哪一侧"不做几何断言 —— 那是引擎 `boundarySideOf` 的用例地盘。
 */
const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

describe('B37：分界线的数据与几何', () => {
  it('★ 线两端＝产品数据的 19.19 → 62.23（不手填坐标）', () => {
    const pair = mapConfig.panzerGroupBoundary?.[0]
    expect(pair).toBeDefined()
    const [west, east] = pair!
    expect(west).toEqual({ col: 19, row: 19 })
    expect(east).toEqual({ col: 62, row: 23 })

    const { workbench } = newStores()
    expect(workbench.boundaryView).toMatchObject({ from: west, to: east })
  })

  it('★ 画布端点＝两端**格心**（渲染与测试共用同一份换算）', () => {
    const line = { from: { col: 19, row: 19 }, to: { col: 62, row: 23 } }
    const [start, end] = boundaryLinePoints(line)
    expect(start).toEqual(hexCanvasPoint(line.from))
    expect(end).toEqual(hexCanvasPoint(line.to))
    expect(start).not.toEqual(end)
  })

  it('★ 站错一侧的格由**引擎的义务清单**给出（本处只搬运；没有义务时为空）', () => {
    const { workbench } = newStores()
    // 空盘面 ⇒ 没有义务 ⇒ 提示格为空（不是"随便给几格"）
    expect(workbench.panzerWrongSideHexes).toEqual([])
    expect(workbench.boundaryView?.wrongSideHexes).toEqual([])

    // 摆一枚**轴方**单位在分界线以西（19.xx 以西不受约束）⇒ 仍为空
    const record = unitChoices('axis')[0]!
    workbench.units.push(
      toConsoleUnit({ record, instanceId: 'a1', hex: { col: 10, row: 10 }, side: 'axis' }),
    )
    expect(workbench.panzerWrongSideHexes).toEqual([])
  })
})

describe('B37：接线（源码守卫）', () => {
  it('★ 渲染层画分界线（地图事实层，与 controlMarkers 同族）', () => {
    const render = readFileSync('src/render/map-render.ts', 'utf8')
    expect(render).toContain('boundary?: BoundaryLine | null')
    expect(render).toContain('export function boundaryLinePoints(')
    expect(render).toContain('BOUNDARY_LINE_SCREEN_PX')
    expect(render).toContain('BOUNDARY_DASH_SCREEN_PX')
    expect(render).toContain('MAP_PALETTE.boundary')
    expect(render).toContain('options.boundary.wrongSideHexes')
    // 状态层 → 画布：只转交，不在渲染层读 store
    const canvas = readFileSync('src/components/map/MapCanvas.vue', 'utf8')
    expect(canvas).toContain('boundary?: BoundaryLine | null')
    expect(canvas).toContain('boundary: props.boundary')
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(game).toContain(':boundary="mapView.boundary"')
    const mapView = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(mapView).toContain('workbench.boundaryView')
  })

  it('★ 专规会话"自动出现"（对局台不再有常驻按钮）', () => {
    const mapView = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(mapView).toContain('workbench.exclusiveActionsInStep.length > 0')
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(game).not.toContain('mapView.setExclusiveOpen(')
    expect(game).toContain("session.kind === 'exclusive'")
  })
})

/**
 * B37 余项：**专规面板的分节置顶**（哪一节本环节该做）
 *
 * 方案 §3 B37 步骤 2 前半：「`ExclusiveRulesPanel` 按当前环节可做的专规**置顶**、其余折叠
 * （判据走 `allowedActionsOf`）」。判据集中在 store 的 `exclusiveSectionPins`，面板只读结果
 * （`<details :open>` ＋ CSS `order`）。
 *
 * ★ 一条**测法边界（如实）**：本仓库不挂渲染测试 ⇒ 置顶真的生效由**源码守卫**
 * （6 节各带 `pins.X` 与 order）＋**判据本身的真值**（随环节变化）钉住；视觉结果靠人眼。
 */
describe('B37：专规面板按本环节置顶', () => {
  it('★ 判据随环节变化：C 段移动环节 ⇒ 工事/建造标记可做；D 段 ⇒ 补给缓存可做；段末 ⇒ 3.4a', () => {
    const { workbench } = newStores()
    workbench.setPhase('movement')
    const steps = workbench.playerSegmentSteps
    expect(workbench.setSegmentStepIndex(0)).toBe(true)
    const mid = workbench.exclusiveSectionPins
    // C 段的移动环节：16.0b/c 与专规 3.5 的闸门都在这儿 ⇒ 那两节置顶
    expect(mid.hedgehog).toBe(true)
    expect(mid.constructionMarker).toBe(true)
    // 1.7 只在 D 段；3.4a 只在段末；1.2 只读 ⇒ 恒不置顶
    expect(mid.supplyCache).toBe(false)
    expect(mid.airRestriction).toBe(false)
    if (steps.length > 1) expect(mid.panzer).toBe(false)

    // 段末：3.4a 的分界线义务可结算 ⇒ 那一节置顶
    expect(workbench.setSegmentStepIndex(steps.length - 1)).toBe(true)
    expect(workbench.exclusiveSectionPins.panzer).toBe(true)

    // D 段：1.7 可做
    workbench.setPhase('supply')
    const supplySteps = workbench.playerSegmentSteps
    expect(workbench.setSegmentStepIndex(0)).toBe(true)
    expect(workbench.exclusiveSectionPins.supplyCache).toBe(true)
    expect(workbench.exclusiveSectionPins.hedgehog).toBe(false)
    expect(supplySteps.length).toBeGreaterThan(0)
  })

  it('★ 面板：六节都是 `<details>`，`open` 与 `order` 都取自 `pins`（折叠不删信息）', () => {
    const panel = readFileSync('src/components/exclusive/ExclusiveRulesPanel.vue', 'utf8')
    expect((panel.match(/<details/gu) ?? []).length).toBeGreaterThanOrEqual(6)
    expect((panel.match(/<\/details>/gu) ?? []).length).toBe(6)
    expect(panel).toContain('const pins = computed(() => workbench.exclusiveSectionPins)')
    for (const key of [
      'panzer',
      'security',
      'hedgehog',
      'constructionMarker',
      'supplyCache',
      'airRestriction',
    ]) {
      // 后缀匹配（不写引号，免得转义层数一多就失真）：`:open="pins.<key>"` / `order: pins.<key>`
      expect(panel, `这一节没接置顶判据：${key}`).toContain(`pins.${key}"`)
      expect(panel, `这一节没按判据排序：${key}`).toContain(`order: pins.${key}`)
    }
  })
})

describe('B37：专规会话按闸门自动出现', () => {
  it('★ D 补给段（1.7 可做）⇒ 自动出现；C 段**段中**无可做专规 ⇒ 不出现；C 段**段末**出现（3.4a）', () => {
    const { workbench, mapView } = newStores()

    workbench.setPhase('supply')
    const supplyIndex = workbench.playerSegmentSteps.findIndex((step) =>
      step.id.startsWith('supply.'),
    )
    if (supplyIndex < 0) throw new Error('D 段没有玩家环节？')
    expect(workbench.setSegmentStepIndex(supplyIndex)).toBe(true)
    expect(workbench.exclusiveActionsInStep.map((item) => item.key)).toEqual(['exclusive.forage'])
    expect(mapView.session).toMatchObject({ kind: 'exclusive' })
    expect(mapView.session?.title).toContain('专规动作：')

    // 收起后本环节不再重现（与增援/盒内动作同一套纪律）
    expect(mapView.cancelSession()).toBe(true)
    expect(mapView.session).toBeNull()

    /*
     * C 段：**段中**没有任何可做的专规动作 ⇒ 不自动出现；
     * 走到**本段最后一个玩家环节**（段末）⇒ 3.4a 的分界线义务可用 ⇒ 出现
     * （这正是 B37 切片 1 的 `at: 'end'` 在界面上的样子）。
     */
    workbench.setPhase('movement')
    const steps = workbench.playerSegmentSteps
    for (const [index, step] of steps.entries()) {
      expect(workbench.setSegmentStepIndex(index)).toBe(true)
      const atEnd = index === steps.length - 1
      const keys = workbench.exclusiveActionsInStep.map((item) => item.key)
      if (atEnd) expect(keys).toEqual(['exclusive.panzerObligation'])
      else expect(keys, `段中（${step.id}）不该有可做的专规动作`).toEqual([])
    }
  })
})
