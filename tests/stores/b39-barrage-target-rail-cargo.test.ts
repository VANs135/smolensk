import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * B39 / A-1：**宣布轰炸前按盘面校验"整体目标"**（10.0c / 10.0d）
 *
 * 原文已核：
 *   · **10.0c**「玩家必须**预先指定**他的具体目标：空军基地或港口（或作为空军任务执行的运输破坏）」；
 *   · **10.0d**「……必须宣布一个**整体的目标**（如"战斗单位"或"港口"），并轰炸点数**只能用于该目标**」。
 * 引擎的 `barrageEligibility` 只判"声明与参炸单位的类型匹配"，**它不持盘面** ⇒ 盘面这一层由 store 给。
 *
 * ★ 一条**测法边界（如实）**：
 *   ① **港口一项目前拦不了** —— `src/data/map-layers.json` 的格字段只有
 *      `col/row/terrain/terrainsPresent/movementTerrain/city`（见 `map-layers.schema.ts`），**没有港口字段**；
 *      故"空格宣布港口"在本作**判不出来**，已在代码注释与回执里如实登记，不假装覆盖。
 *   ② 轰炸**结算**（表、成本、战果）不在本文件：那是 `tests/engine/barrage*.test.ts` 的地盘。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 一枚本方炮兵（有轰炸值即可宣布） */
const artilleryRecord = () =>
  unitChoices('axis').find((record) => (record.factors?.combat?.barrage ?? 0) > 0)!

/** 有空军基地算子的格（印刷基地在初设时以算子落盘，故夹具照做） */
const CORE_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => hex.col > 6 && hex.row > 6)
  if (found === undefined) throw new Error('地图上找不到可用格')
  return { col: found.col, row: found.row }
})()

describe('B39 / A-1：轰炸目标类别按盘面校验', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('★ 宣布"空军基地"但该格没有基地 ⇒ 拒（10.0c），且给规则号', () => {
    const store = newStore()
    store.setPhase('movement')
    const unit = toConsoleUnit({
      record: artilleryRecord(),
      instanceId: 'art-1',
      hex: CORE_HEX,
      side: 'axis',
    })
    store.units.push(unit)
    store.battleTarget = { hex: CORE_HEX, defenderIds: [] }

    // 盘面事实：该格没有空军基地 ⇒ 判据给出问题
    store.barrageTargetKind = 'airBase'
    expect(store.barrageTargetKindIssue).toMatchObject({ rule: '10.0c' })

    /*
     * ★ 次序（第六批 P0-1 后成为硬约束）：**先进入轰炸环节，再宣布整体目标**。
     *   进入轰炸环节会由 `isBarrageSegment` 的 watcher 自动 `setBarrageActive(true)`，
     *   而 `setBarrageActive` → `clearBarrage()` 会把 10.0d/10.0e-F 的**本场声明**
     *   （`barrageKind` / `barrageTargetKind`）一并归位——声明属于"这一场"，不属于"这一环节"。
     *   真实界面也是这个次序（面板只在轰炸环节可用），故这里照界面来。
     */
    store.setSegmentStepIndex(
      store.playerSegmentSteps.findIndex((s) => s.id === 'movement.barrage'),
    )
    store.barrageTargetKind = 'airBase'
    expect(store.beginBarrageNow()).toBe(false)
    expect(store.barrageError?.rule).toBe('10.0c')
    expect(store.log.some((entry) => entry.text.includes('没有空军基地'))).toBe(true)
  })

  it('★ 宣布"战斗单位"不受此限（任何格都能宣布）；"运输破坏"要求该格有铁路', () => {
    const store = newStore()
    store.setPhase('movement')
    store.units.push(
      toConsoleUnit({
        record: artilleryRecord(),
        instanceId: 'art-1',
        hex: CORE_HEX,
        side: 'axis',
      }),
    )
    store.battleTarget = { hex: CORE_HEX, defenderIds: [] }

    store.barrageTargetKind = 'combatUnits'
    expect(store.barrageTargetKindIssue).toBeNull()

    // 运输破坏：只有**铁路格**才放得下（14.8c）；该格有无铁路直接决定判据
    store.barrageTargetKind = 'trainbusting'
    const railHexes = mapLayers.edges.filter((edge) => edge.rail === true).map((edge) => edge.a)
    const railHex = railHexes.find((hex) => hex !== undefined && hex.col > 6 && hex.row > 6)
    if (railHex !== undefined) {
      store.battleTarget = { hex: { col: railHex.col, row: railHex.row }, defenderIds: [] }
      expect(store.barrageTargetKindIssue).toBeNull()
    }
    store.battleTarget = { hex: CORE_HEX, defenderIds: [] }
    // 非铁路格：若 CORE_HEX 恰好是铁路格则跳过这条（如实：夹具不保证）
    const coreIsRail = railHexes.some(
      (hex) => hex?.col === CORE_HEX.col && hex.row === CORE_HEX.row,
    )
    if (!coreIsRail) {
      expect(store.barrageTargetKindIssue).toMatchObject({ rule: '14.8c' })
    }
  })
})

/**
 * B39 / B-3：**以运输点数作为铁路货物**（13.3a「每个铁路运量点数可以运输一个 SP **或 RE**」）
 *
 * ★ 一条**测法边界（如实）**：本文件只钉 **store 的入口与拒绝**（选中哪一枚、是不是本方、
 *   运力 > 0）；"沿铁路走通并扣容量"依赖一条真实铁路路径与当日容量额度 —— 那一段
 *   由 `tests/stores/rail-cargo-flow.test.ts` 与 `tests/engine/rail.test.ts` 覆盖（同一条链）。
 */
describe('B39 / B-3：运输点数作铁路货物', () => {
  beforeEach(() => setActivePinia(createPinia()))

  /**
   * 一枚**运输点数**（`noncombatKind === 'transport_point'`）
   *
   * 运力字段只存在于**控制台视图**（`ConsoleUnit.noncombatTransport`，由记录的
   * `noncombatDetails.transport` 映射而来）⇒ 记录侧只按种类挑，运力在落盘后读。
   */
  const transportPoint = () => {
    const found = unitChoices('axis').find((record) => record.noncombatKind === 'transport_point')
    if (found === undefined) throw new Error('轴方算子库里没有运输点数条目？')
    return found
  }

  it('★ 选中本方运输点数 ⇒ 入口成立（缺卸货格时给的是"要卸货格"而不是"没选单位"）', () => {
    const store = newStore()
    store.setPhase('movement')
    const point = toConsoleUnit({
      record: transportPoint(),
      instanceId: 'tp-1',
      hex: CORE_HEX,
      side: 'axis',
    })
    store.units.push(point)
    store.selectedId = 'tp-1'
    store.railMoveInputs = { toHexText: '', spAmount: 1, fromDumpId: null }
    store.setSegmentStepIndex(
      store.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement'),
    )

    // 未给卸货格 ⇒ 先报"要卸货格"（说明已经走到"运输点数这条路"上）
    expect(store.railMoveNow('transportPoint')).toBe(false)
    expect(store.railMoveError?.reason).toBe('railMoveNeedsDestination')
  })

  it('★ 没选中任何算子 ⇒ 报"请先选中那枚运输点数"；选中**非**运输点数 ⇒ 报"不是本方的运输点数"', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setSegmentStepIndex(
      store.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement'),
    )
    store.railMoveInputs = {
      toHexText: `${String(CORE_HEX.col)}.${String(CORE_HEX.row)}`,
      spAmount: 1,
      fromDumpId: null,
    }

    expect(store.railMoveNow('transportPoint')).toBe(false)
    expect(store.railMoveError?.reason).toBe('railMoveNeedsSelectedTransportPoint')

    // 摆一枚**普通战斗单位**并选中 ⇒ 不是运输点数
    const combat = toConsoleUnit({
      record: unitChoices('axis').find((record) => record.isCombat === true)!,
      instanceId: 'c-1',
      hex: CORE_HEX,
      side: 'axis',
    })
    store.units.push(combat)
    store.selectedId = 'c-1'
    expect(store.railMoveNow('transportPoint')).toBe(false)
    expect(store.railMoveError?.reason).toBe('railMoveNeedsOwnTransportPoint')
  })

  it('★ 源码守卫：三种货物共用同一条链（面板有第三个按钮）', () => {
    const wb = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(wb).toContain("kind: 'unit' | 'sp' | 'transportPoint'")
    expect(wb).toContain("cargo.kind === 'unit' || cargo.kind === 'transportPoint'")
    expect(wb).toContain(
      "{ kind: 'transportPoint', id: unit.instanceId, side, size: unit.noncombatTransport }",
    )
    const panel = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')
    expect(panel).toContain("workbench.railMoveNow('transportPoint')")
  })
})
