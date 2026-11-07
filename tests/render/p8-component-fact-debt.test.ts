import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { segmentLabelsOfAction } from '@/stores'

const source = (path: string) => readFileSync(path, 'utf8')

/**
 * P8「还债」：组件内另算逐点收口（源码守卫 + 投影行为）
 *
 * 只钉「组件不得另立判据」：规则结论一律取自引擎/store 的既有事实或只读投影。
 */
describe('P8：组件内另算还债（源码守卫）', () => {
  it('#2 MovePanel 环节名取 ACTION_GATES 投影', () => {
    expect(segmentLabelsOfAction('move.order')).toEqual([
      'C 移动·模式与移动',
      'E 反应·反应移动',
      'G 进击·进击移动',
    ])
    const move = source('src/components/move/MovePanel.vue')
    expect(move).toContain('segmentLabelsOfAction')
    expect(move).not.toContain('模式与移动」「E 反应')
  })

  it('#3 SupplyPanel 已并 SP 判定取引擎谓词', () => {
    const supply = source('src/components/supply/SupplyPanel.vue')
    expect(supply).toContain('isNormalizedHoldings')
    expect(supply).not.toContain('function isNormalized')
  })

  it('#4 SupplyPanel 铁路抢修候选取 store 谓词', () => {
    const supply = source('src/components/supply/SupplyPanel.vue')
    expect(supply).toContain('isRailRepairUnit')
    expect(supply).not.toContain("specialized.includes('rail_repair')")
  })

  it('#5 SupplyPanel 损耗分摊显隐取 store 投影', () => {
    const supply = source('src/components/supply/SupplyPanel.vue')
    expect(supply).toContain('workbench.attritionNeedsAllocation')
    expect(supply).not.toContain("losses.kind === 'allSteps'")
  })

  it('#6 SupplyPhasePanel 喂食候选取 store 投影', () => {
    const panel = source('src/components/supply/SupplyPhasePanel.vue')
    expect(panel).toContain('supplyFeedingCandidates')
    expect(panel).not.toContain('hasTraceSupply')
  })

  it('#7 MapActionPopover 轰炸资格取 store 谓词', () => {
    const popover = source('src/components/game/MapActionPopover.vue')
    expect(popover).toContain('isBarrageCapableUnit')
    expect(popover).not.toContain('raw.barrage')
  })
})
