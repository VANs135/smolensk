import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  actionGateOf,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'
import type { ActionKey, ConsolePhase } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 13.9 整编：**唯一入口＝盘面左键多选 ≥2 枚 → 右键**（v7.1 §4.3）
 *
 * 修前是"恰一枚伙伴 ⇒ 一键并 / 多枚 ⇒ 开整编大窗"；用户 2026-11-11 改为：
 *   · 不再开大窗；
 *   · 多选里至少有一对合法才出「整编（13.9）」，条件不满足 ⇒ 菜单项**不出现**；
 *   · 点它自动合并（不替玩家挑保留枚之外的任何东西）。
 */

const HEX: HexRef = { col: 36, row: 13 }
const OTHER: HexRef = { col: 37, row: 13 }

function stores(side: 'axis' | 'soviet' = 'soviet') {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide(side)
  // 2026-11-11：观察方手动选（不再随行动方自动切），测试里与行动方对齐
  useHotseatStore().setViewerSide(side)
  return { workbench, mapView: useMapViewStore() }
}

function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  expect(store.setSegmentStepIndex(index)).toBe(true)
}

/** 13.9-1：多军力师（两面印值相同 ⇒ 同一记录放一起即可合并） */
function multiStepRecord() {
  return groundRecord('soviet', (record) => /Tk Div|Rifle Div/i.test(record.vassalName ?? ''))
}

describe('13.9 整编：盘面多选 → 右键 → 自动合并（不再开大窗）', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
    s.workbench.setPhase('reinforcement')
    goToActionStep(s.workbench, 'rein.rebuild')
  })

  it('★ 三枚同格可并 ⇒ 多选判据成立，点「整编」自动合并一对', () => {
    const record = multiStepRecord()
    for (const id of ['a', 'b', 'c']) placeGround(s.workbench, record, HEX, 'soviet', id)

    expect(s.workbench.canConsolidateSelectionNow(['a', 'b', 'c'])).toBe(true)
    expect(s.workbench.consolidateSelectionNow(['a', 'b', 'c'])).toBe(true)
    // 自动合并：至少少了一枚，且留下的是预演通过的那一对
    expect(s.workbench.units.length).toBeLessThan(3)
    expect(s.workbench.lastConsolidation).not.toBe(null)
    // 不再有"打开整编会话"这条路径
    expect(s.workbench.consolidationPick).toBe(null)
  })

  it('★ 恰两枚同格 ⇒ 多选判据成立，且菜单入口挂在多选分支上', () => {
    const record = multiStepRecord()
    const keep = placeGround(s.workbench, record, HEX, 'soviet', 'k1')
    const remove = placeGround(s.workbench, record, HEX, 'soviet', 'r1')
    keep.steps = 2
    remove.steps = 1

    expect(s.workbench.canConsolidateSelectionNow(['k1', 'r1'])).toBe(true)
    // 菜单项只挂在"多选"分支（单枚菜单不出现整编）
    const source = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(source).toContain('canConsolidateSelectionNow(targets)')
    expect(source).toContain("key: 'rein.consolidate.selection'")
  })

  it('★ 重建段盘面右键：逐枚没有动作项时，「整编（13.9）」仍必须在菜单里', () => {
    /*
     * 实走（2026-11-17）：B 段「重建与整编」环节，逐枚单位没有可执行动作
     * （模式/加油/铁路等都按环节闸门不出），`showCounterContext` 把菜单目标全滤掉，
     * 于是多选右键**连菜单都开不出来**，13.9 整编没有任何入口。
     */
    const record = multiStepRecord()
    placeGround(s.workbench, record, HEX, 'soviet', 'k1')
    placeGround(s.workbench, record, HEX, 'soviet', 'r1')
    // 先证明确实是"逐枚无动作"的盘面：单枚右键不应开出自己的菜单
    expect(s.mapView.openUnitContext(HEX, 'k1', { x: 0, y: 0 })).toBe(false)

    // 右键该格（点在格内空白：world 给到格外的远处，避免命中算子图）
    s.mapView.onHexContext(HEX, { x: 99999, y: 99999 }, { x: 10, y: 10 }, 1)
    const keys = s.mapView.contextOptions.flatMap((option) =>
      option.actions.map((action) => action.key),
    )
    expect(keys).toContain('rein.consolidate.selection')
  })

  it('★ 单枚选择 / 跨格 / 缺一枚 ⇒ 判据不成立（菜单项不出现）', () => {
    const record = multiStepRecord()
    placeGround(s.workbench, record, HEX, 'soviet', 'k1')
    placeGround(s.workbench, record, HEX, 'soviet', 'r1')
    placeGround(s.workbench, record, OTHER, 'soviet', 'far1')

    expect(s.workbench.canConsolidateSelectionNow(['k1'])).toBe(false)
    expect(s.workbench.canConsolidateSelectionNow(['k1', 'far1'])).toBe(false)
    expect(s.workbench.canConsolidateSelectionNow(['k1', 'r1'])).toBe(true)
  })
})
