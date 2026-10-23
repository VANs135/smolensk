import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { markersAfterDg } from '@/engine/rules'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

/**
 * 5.10 / 5.10c：**被动模式替代当前模式**（走真实轰炸流程落盘）
 *
 * 条文：「可用 DG 标记来标记混乱模式，并**保持单位当前移动或战斗面的朝向**。
 *   **从该堆叠中移除其他所有模式标记**。」5.10c：运输点数不受 DG 影响。
 *
 * ★ 修前：两处 DG 落盘点（战斗补丁 / 轰炸补丁）都只做 `unit.mode.dg = true`，**不清**
 *   预备 / 战略 / 进击标记 ⇒ DG 与它们叠加，B1 修好的模式折算会错上加错
 *   （战略模式战斗值应为 0，却按 DG ×½ 或预备 ×½ 算）。
 *
 * 本文件用**真实地图 + 真实单位库 + 真实轰炸流程**（骰面 12 必出 `DG` 结果），
 * 断言"守方被 DG 之后只剩 DG"；5.10c 的判据在引擎侧另测（`markersAfterDg`）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const TARGET_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到六邻皆图内的格')
  return { col: found.col, row: found.row }
})()

const FIRING_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(TARGET_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row))
      continue
    return candidate
  }
  throw new Error('目标格没有可进入的图内邻格')
})()

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side, face: 'combat' })
  store.units.push(unit)
  return unit
}

const artilleryRecord = (): ReturnType<typeof unitChoices>[number] => {
  const found = unitChoices('axis').find(
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
  )
  if (found === undefined) throw new Error('轴心国单位库中没有带轰炸值的火炮')
  return found
}

const defenderRecord = (): ReturnType<typeof unitChoices>[number] => {
  const found = unitChoices('soviet').find((record) => record.isCombat === true)
  if (found === undefined) throw new Error('苏联单位库中没有战斗单位')
  return found
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/**
 * 走完一次 10.0 轰炸，返回**必定被 DG** 的守方
 *
 * 骰面取 12：`1/2` / `DG` 档必出，且 DG 的判据由引擎给（`barrageState.outcome.value.dg`）。
 */
function barrageUntilDg(defenderMode: 'reserve' | 'strat' | 'combat', exploit = false) {
  const store = newStore()
  store.setPhase('combat')
  const artillery = place(store, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
  const defender = place(store, defenderRecord(), TARGET_HEX, 'soviet', 'def-1')
  // 把守方设成待测的模式（朝向：战略必须移动面 5.8；预备可任选 5.7a）
  defender.mode = {
    mode: defenderMode,
    orientation: defenderMode === 'strat' ? 'move' : 'combat',
    dg: false,
    exploit,
  }
  store.battleTarget = { hex: TARGET_HEX, defenderIds: [defender.instanceId] }
  store.setBarrageActive(true)
  store.toggleBarrageUnit(artillery.instanceId)

  expect(store.beginBarrageNow()).toBe(true)
  // 10.1b / 12.3a：火炮补给必须落到一座声明的补给站上（账本真扣）
  const dumpId = `dg-${store.spDumps.length}`
  store.spDumps.push({ id: dumpId, hex: FIRING_HEX, side: 'axis', sp: 0, t: 20 })
  expect(store.pickBarrageSupplyDump(dumpId)).toBe(true)
  // 3.4b：受益编队若属某装甲集群，这座站须声明同一归属
  const group = store.groupOfUnit(artillery)
  if (group !== null) store.setDumpPanzerGroupNow(dumpId, group)
  expect(store.confirmBarrageSupplyStep()).toBe(true)
  expect(store.confirmBarrageShiftsStep()).toBe(true)
  store.barrageInputs.die = 12 // 轰炸骰＝2d6 之和（10.0：12 必出结果，DG 在多列上出现）
  store.barrageInputs.halfDie = 4
  expect(store.rollBarrageDiceStep()).toBe(true)
  const required = store.barrageSummary?.unitOutcome?.stepLosses ?? 0
  if (required > 0) store.barrageInputs.losses = { [defender.instanceId]: required }
  expect(store.confirmBarrageOutcomeStep()).toBe(true)

  const outcome = store.barrageState?.outcome
  return { store, defender, outcome }
}

describe('5.10：DG 替代当前模式（真实轰炸流程落盘）', () => {
  it('前置：本次轰炸确实产出了 DG 结果（否则下面几条测不到东西）', () => {
    const { outcome } = barrageUntilDg('combat')
    expect(outcome?.table).toBe('barrage')
    // 结果是被判联合（普通轰炸 / 对设施），取普通轰炸那一支的 `dg`
    expect(outcome?.table === 'barrage' ? outcome.value.dg : false).toBe(true)
  })

  it('预备单位被 DG ⇒ 只剩 DG（预备标记被移除，不再按预备折算）', () => {
    const { defender } = barrageUntilDg('reserve')
    expect(defender.mode.dg).toBe(true)
    expect(defender.mode.mode).not.toBe('reserve')
    expect(defender.mode.mode).toBe('combat') // 回朝向那一面
  })

  it('战略单位被 DG ⇒ 不再是战略（5.8 的「战斗值 0」随之失效，改按 DG 规则）', () => {
    const { defender } = barrageUntilDg('strat')
    expect(defender.mode.dg).toBe(true)
    expect(defender.mode.mode).not.toBe('strat')
    expect(defender.mode.mode).toBe('move') // 5.8 要求战略朝移动面
  })

  it('进击单位被 DG ⇒ 进击标记一并移除（5.10「其他所有模式标记」）', () => {
    const { defender } = barrageUntilDg('combat', true)
    expect(defender.mode.dg).toBe(true)
    expect(defender.mode.exploit).toBe(false)
  })

  it('朝向保持不变（5.10「保持单位当前移动或战斗面的朝向」）', () => {
    const { defender } = barrageUntilDg('reserve')
    expect(defender.mode.orientation).toBe('combat')
    expect(defender.mode.mode).toBe('combat')
  })
})

describe('5.10c：运输点数不受 DG 影响（引擎判据）', () => {
  it('一般单位 ⇒ dgOnly；运输点数 ⇒ loseReserveMarkerOnly', () => {
    const state = {
      mode: 'reserve' as const,
      orientation: 'move' as const,
      dg: false,
      exploit: false,
    }
    expect(markersAfterDg({ unitClass: 'combat', state })).toBe('dgOnly')
    expect(markersAfterDg({ unitClass: 'transportPoint', state })).toBe('loseReserveMarkerOnly')
  })
})
