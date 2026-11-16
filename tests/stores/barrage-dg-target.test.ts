import { createPinia, setActivePinia } from 'pinia'

import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  actionGateOf,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ConsolePhase,
} from '@/stores'

import { CORE_HEX, NEAR_HEX, groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 5.10 / 10.0a：**DG 不是炮击目标的排除条件**
 *
 * 原文：10.0a「使用轰炸表对敌方战斗单位进行轰炸。主要目标是将它们 DG。」
 * 5.10b 只削弱 DG 单位自己的战斗值/轰炸值/移动值，5.10d 只禁铁路/空运/海运；
 * 没有任何一条禁止「已 DG 的单位被炮击」（事实上 DG 正是炮击的主要结果）。
 *
 * 用户 2026-11-16 报告：F 段炮击环节右键**已 DG 的敌方单位**时「炮击」整项不出现。
 */

const TARGET_HEX: HexRef = NEAR_HEX

const newStores = () => {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

function enterStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: Parameters<typeof actionGateOf>[0],
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

function defenderRecord() {
  return groundRecord('soviet', (record) => record.isCombat === true)
}

function artilleryRecord() {
  return groundRecord(
    'axis',
    (record) =>
      (record.factors?.combat?.barrage ?? 0) > 0 && (record.factors?.combat?.range ?? 0) > 0,
  )
}

/** 邻格一门炮 + 目标格守军（可 DG）+ 一座够付的补给站 */
function setupBarrage(options: { dg: boolean; withDump?: boolean }) {
  const { workbench, mapView } = newStores()
  workbench.setPhase('combat')
  enterStep(workbench, 'barrage.declare')
  placeGround(workbench, artilleryRecord(), CORE_HEX, 'axis', 'art-1')
  const defender = placeGround(workbench, defenderRecord(), TARGET_HEX, 'soviet', 'def-1')
  if (options.dg) defender.mode = { ...defender.mode, dg: true }
  if (options.withDump !== false) {
    workbench.spDumps.push({ id: 'dump-1', hex: CORE_HEX, side: 'axis', sp: 0, t: 20 })
  }
  return { workbench, mapView, defender }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('DG 敌方单位仍可被炮击（10.0a / 5.10b）', () => {
  it('★ 目标已 DG ⇒ 入口与菜单项照常出现', () => {
    const { workbench, mapView } = setupBarrage({ dg: true })
    expect(workbench.barrageEntryEligible(TARGET_HEX)).toBe(true)
    expect(mapView.openUnitContext(TARGET_HEX, 'def-1', { x: 0, y: 0 })).toBe(true)
    const keys = mapView.contextOptions.flatMap((option) =>
      option.actions.map((action) => action.key),
    )
    expect(keys).toContain('ops.barrage')
  })

  it('★ 走地图右键路径（onHexContext）：DG 目标同样出「炮击」，且不留拒绝提示', () => {
    const { workbench, mapView } = setupBarrage({ dg: true })
    mapView.onHexContext(TARGET_HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
    const keys = mapView.contextOptions.flatMap((option) =>
      option.actions.map((action) => action.key),
    )
    expect(keys).toContain('ops.barrage')
    expect(workbench.mapHint).toBeNull()
  })

  it('★ 热坐战雾下（viewer=行动方）：DG 守军仍是敌方顶牌，右键出「炮击」', () => {
    const { workbench, mapView } = setupBarrage({ dg: true })
    const hotseat = useHotseatStore()
    hotseat.setMode('pvp')
    hotseat.setViewerSide('axis')
    expect(hotseat.visibleUnitIdsInHex(TARGET_HEX)).toContain('def-1')
    expect(mapView.openUnitContext(TARGET_HEX, 'def-1', { x: 0, y: 0 })).toBe(true)
    expect(
      mapView.contextOptions
        .flatMap((option) => option.actions.map((action) => action.key))
        .includes('ops.barrage'),
    ).toBe(true)
    expect(workbench.barrageEntryEligible(TARGET_HEX)).toBe(true)
  })

  it('反向：目标已 DG 但付不起 10.1b 的补给 ⇒ 炮击项**不出现**', () => {
    const { workbench, mapView } = setupBarrage({ dg: true, withDump: false })
    expect(workbench.barrageEntryEligible(TARGET_HEX)).toBe(false)
    expect(mapView.openUnitContext(TARGET_HEX, 'def-1', { x: 0, y: 0 })).toBe(false)
    expect(mapView.contextOptions).toEqual([])
  })

  it('★ 菜单整张没出来时，地图提示写明**真正**卡住的规则（10.1b，而非 DG）', () => {
    const { workbench, mapView } = setupBarrage({ dg: true, withDump: false })
    mapView.onHexContext(TARGET_HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
    expect(mapView.contextOptions).toEqual([])
    expect(workbench.mapHint?.rule).toBe('10.1b')
    expect(workbench.mapHint?.text ?? '').toContain('补给站')
  })
})
