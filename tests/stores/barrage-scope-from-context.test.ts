import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { hexDistance } from '@/engine/hex-geometry'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * 条 13（用户实机）：**炮击候选按当前选中集合/本格收窄**
 *
 * 现象：右键某一枚炮兵点「炮击」，参炸阵列铺出**全场**所有炮兵。
 * 口径：取当前选中集合（无选中时取该格炮兵），按既有射程/弹药/环节判据过滤；
 * 别格的炮兵不进列表。候选的**判据**仍只来自 `barrageUnitChoices`（引擎同源），
 * 本组用例只钉"视图收窄"这一层。
 */

/** B8：把 store 放到**本段里允许做该动作的那个环节**（与既有轰炸测试同一写法） */
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
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const MAP_HEXES: HexRef[] = mapLayers.hexes.map((hex) => ({ col: hex.col, row: hex.row }))

/** H1：本次右键的那一格 */
const H1: HexRef = MAP_HEXES[0]!
/** H2：别格（同格两枚 + 别格一枚，用来证明"别格不进列表"） */
const H2: HexRef = (() => {
  const found = MAP_HEXES.find((hex) => hexDistance(hex, H1) > 0)
  if (found === undefined) throw new Error('地图上只有一个格？')
  return found
})()

/** 有印刷轰炸值的火炮（10.0e-B：不得低于印刷值轰炸） */
function artilleryRecord(side: 'axis' | 'soviet'): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
  )
  if (found === undefined) throw new Error(`${side} 单位库中没有带轰炸值的火炮`)
  return found
}

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('条 13：炮击候选按当前选中集合收窄', () => {
  it('★ 右键单枚炮兵 ⇒ 阵列只含这一枚（同格另一枚也列），别格炮兵不进列表', () => {
    const store = newStore()
    store.setPhase('combat')
    goToActionStep(store, 'barrage.declare')
    place(store, artilleryRecord('axis'), H1, 'axis', 'art-1')
    place(store, artilleryRecord('axis'), H1, 'axis', 'art-1b')
    place(store, artilleryRecord('axis'), H2, 'axis', 'art-2')

    // 等价于右键入口：`map-view` 的「炮击」分支调 `beginBarrageAt(hex, instanceId)`
    store.beginBarrageAt(H1, 'art-1')

    expect(store.barrageUnitIds).toEqual(['art-1'])
    expect(store.barrageVisibleChoices.map((choice) => choice.unit.instanceId).sort()).toEqual([
      'art-1',
      'art-1b',
    ])
    expect(store.barrageVisibleChoices.some((choice) => choice.unit.instanceId === 'art-2')).toBe(
      false,
    )
    // 判据仍来自权威表：灰显原因与 `barrageUnitChoices` 同源
    expect(store.barrageVisibleChoices.every((choice) => choice.disabledReason === null)).toBe(true)
  })

  it('★ 工具条直接开启（无选中）⇒ 仍是全场候选', () => {
    const store = newStore()
    place(store, artilleryRecord('axis'), H1, 'axis', 'art-1')
    place(store, artilleryRecord('axis'), H1, 'axis', 'art-1b')
    place(store, artilleryRecord('axis'), H2, 'axis', 'art-2')

    store.setBarrageActive(true)

    expect(store.barrageVisibleChoices.length).toBe(store.barrageUnitChoices.length)
    expect(store.barrageVisibleChoices.length).toBe(3)
  })

  it('源码守卫：面板阵列改读 barrageVisibleChoices，右键入口走 beginBarrageAt', () => {
    const panel = readFileSync('src/components/barrage/BarragePanel.vue', 'utf8')
    expect(panel).toContain('barrageVisibleChoices')
    expect(panel).not.toContain('workbench.barrageUnitChoices.map')
    const view = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(view).toContain('beginBarrageAt(hex, instanceId)')
  })
})
