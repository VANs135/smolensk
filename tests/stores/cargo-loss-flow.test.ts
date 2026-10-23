import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import { mapLayers } from '@/data'
import { hexDistance, HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
} from '@/stores'

/**
 * 批 F 切片 6（B49 收尾之②）：**14.4g 货物损失**的端到端（store 级）
 *
 * ## 原文（先读再动）
 *   · **14.4f**：「如果防空造成损失，则其中一个执行任务的飞机会在执行任务之前承受损失。……**剩下一 点军力的
 *     飞机将使用其减少后的数值来完成任务。**」
 *   · **14.4g**：「如果运输任务的货物容量因防空而发生变化，则**重新计算可用的装载量**（注意 14.9e 的距离效果），
 *     并根据新的容量，**摧毁超出部分**的货物（由玩家自主选择）。取整时，按**有利于货物存留**的方式取整。」
 *   · **14.9b**：「1/2T 的容量……也**不能取整为 1T**。（**例外：货物损失，14.4g**）」
 *
 * ## 修前的病灶
 *   `resolveFlakNow` 只把被命中的飞机扣 1 点军力（`applyAirStepLoss`），**完全不碰货物** ——
 *   容量变小之后，载货清单原样进入 14.10d 的检定（本该被摧毁的货物照样运到）。
 *
 * ## 测法边界（如实交代）
 *   · 用真实地图格与真实运输机库记录（Ju.52：正面 1T / 减损面 1/2T，取自工程库）；两架飞机的**正面容量**在
 *     夹具里手设为 2T（真实 Ju.52 只有 1T ⇒ 差值不足 1 整 T，14.4g 的"有利取整"会把超出部分抹掉，见引擎用例）；
 *   · 起点与目的地**刻意拉开到航程一半以上**（14.9e-B 档），使容量不翻倍 ⇒ 数字可逐项断言；
 *   · **载货 T 的口径只数 SP**（与装载时的 14.9a 校验同一口径；单位货物的 RE 当量未纳入，已登记边界）；
 *   · **不覆盖界面**（仓库无组件渲染测试）：面板只是把 `airCargoLossPending` 画出来。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 六邻皆图内的格（起点基地） */
const CORE_HEX: HexRef = (() => {
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

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

function airBaseRecord() {
  const found = unitChoices('axis').find((record) => record.noncombatKind === 'air_base')
  if (found === undefined) throw new Error('单位库中没有空军基地算子')
  return found
}

function transportRecord(side: Side) {
  const found = aircraftChoices(side).find((record) => record.aircraftType === 'Tpt')
  if (found === undefined) throw new Error(`${side} 飞机库中没有运输机`)
  return found
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('批 F 切片 6：14.4g 防空致容量变化后的货物损失（玩家选择摧毁）', () => {
  it('★ 一架被防空打损 ⇒ 容量下降 ⇒ 落待决；选摧毁哪件后任务继续（14.4g）', () => {
    const store = newStore()
    const range = transportRecord('axis').rangeHexes ?? 0
    if (range <= 0) throw new Error('运输机没有航程印值')
    // 目的地：与起点直线距离 > 航程的一半（避开 14.9e-C 的容量翻倍），且在图内
    const target = mapLayers.hexes
      .map((hex) => ({ col: hex.col, row: hex.row }))
      .filter(
        (hex) => hexDistance(CORE_HEX, hex) > range / 2 && hexDistance(CORE_HEX, hex) <= range,
      )
      .sort((a, b) => hexDistance(CORE_HEX, a) - hexDistance(CORE_HEX, b))[0]
    if (target === undefined) throw new Error('地图上找不到「航程一半以外、航程以内」的目的地格')

    store.setAirActive(true)
    store.setAirMissionKind('air_transport')
    store.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-2', hex: target, side: 'axis' }),
    )
    // 两架运输机：正面容量手设 2T（减损面仍取数据里的 Ju.52 值 1/2T）
    const transportA = toConsoleAirUnit({
      aircraft: transportRecord('axis'),
      instanceId: 'tpt-1',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'active',
    })
    const transportB = toConsoleAirUnit({
      aircraft: transportRecord('axis'),
      instanceId: 'tpt-2',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'active',
    })
    transportA.transportCapacity = 2
    transportB.transportCapacity = 2
    store.airUnits.push(transportA, transportB)

    expect(store.setAirTargetFromText(label(target))).toBe(true)
    store.toggleAirMissionUnit('tpt-1')
    store.toggleAirMissionUnit('tpt-2')
    store.airInputs.cargoSpT = 4 // 满载：2 + 2
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.airState?.assignment.cargoCapacity).toBe(4)
    /*
     * 14.4a + 14.4c：空运/空投**只在敌方巡逻区内**才受防空影响，而巡逻区由「**拥有激活战斗机的空军基地**」
     * 创建（半径 10 格）⇒ 在任务格旁边摆一座苏军基地 + 一架激活战斗机，把任务格罩进巡逻区。
     */
    const enemyFighter = aircraftChoices('soviet').find((record) => record.aircraftType === 'F')
    if (enemyFighter === undefined) throw new Error('苏方飞机库里没有战斗机')
    const pzHex = HEX_DIRECTIONS.map((direction) => neighbor(target, direction)).find(
      (hex) =>
        isOnMap(hex) &&
        mapLayers.hexes.some((item) => item.col === hex.col && item.row === hex.row),
    )
    if (pzHex === undefined) throw new Error('任务格旁边没有图内格可放苏军基地')
    store.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'su-base', hex: pzHex, side: 'soviet' }),
    )
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: enemyFighter,
        instanceId: 'su-f1',
        hex: pzHex,
        side: 'soviet',
        airStatus: 'active',
      }),
    )

    // 14.2f 逐步：空战（无对手）→ 拦截（放弃）→ 防空（命中）
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.declareInterceptionNow()).toBe(true)
    store.airInputs.flakDie = 12 // 14.4e：修正后 ≥ 11 ⇒ 命中
    store.airInputs.lossDie = 1 // 14.4f 的任务损失表：由哪一架承受
    expect(store.resolveFlakNow()).toBe(true)

    // 14.4f：被命中的那架掉 1 点军力 ⇒ 它的容量改用**减损面**（Ju.52 = 1/2T）
    expect(store.airState?.flak).toMatchObject({ applies: true, hit: true })
    const damaged = store.airUnits.find((air) => air.side === 'axis' && air.steps < 2)
    expect(damaged).toBeDefined()
    expect(store.airMissionCargoCapacityNow).toBe(2.5) // 2（完好）＋ 0.5（减损面）
    // 14.4g：可用装载量按**有利取整** = ceil(2.5) = 3 ⇒ 载 4T 时超出 1T
    expect(store.airCargoLossPending).toMatchObject({ allowedT: 3, excessT: 1 })
    // 待决未处理之前，货物检定不许进行
    store.airInputs.cargoDice = 12
    expect(store.resolveAirCargoNow()).toBe(false)

    // 玩家选一件 1T 的 SP 摧毁 ⇒ 达标
    const firstCargo = store.airState?.assignment.cargo[0]
    expect(firstCargo).toBeDefined()
    store.toggleAirCargoLossPick(firstCargo!.id)
    expect(store.confirmAirCargoLossNow()).toBe(true)
    expect(store.airCargoLossPending).toBe(null)
    expect(store.airState?.assignment.cargo.length).toBe(3)

    // 处理完之后，货物检定照常进行（14.10d）
    expect(store.resolveAirCargoNow()).toBe(true)
  })

  it('★ 摧毁量不足 ⇒ 拒（14.4g）；容量够装 ⇒ 不落待决', () => {
    const store = newStore()
    const range = transportRecord('axis').rangeHexes ?? 0 // 上面已判过非空，这里只是让 TS 收窄
    const target = mapLayers.hexes
      .map((hex) => ({ col: hex.col, row: hex.row }))
      .filter(
        (hex) => hexDistance(CORE_HEX, hex) > range / 2 && hexDistance(CORE_HEX, hex) <= range,
      )
      .sort((a, b) => hexDistance(CORE_HEX, a) - hexDistance(CORE_HEX, b))[0]!
    store.setAirActive(true)
    store.setAirMissionKind('air_transport')
    store.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-2', hex: target, side: 'axis' }),
    )
    const transport = toConsoleAirUnit({
      aircraft: transportRecord('axis'),
      instanceId: 'tpt-1',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'active',
    })
    transport.transportCapacity = 1
    store.airUnits.push(transport)
    expect(store.setAirTargetFromText(label(target))).toBe(true)
    store.toggleAirMissionUnit('tpt-1')
    store.airInputs.cargoSpT = 1
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.declareInterceptionNow()).toBe(true)
    store.airInputs.flakDie = 12
    store.airInputs.lossDie = 1
    expect(store.resolveFlakNow()).toBe(true)

    // 14.9b 的例外：容量 1T ⇒ 减损面 1/2T，但按**有利取整** ceil(0.5) = 1 ⇒ 1T 货物**存留**（14.4g 的例子）
    expect(store.airCargoLossPending).toBe(null)
    store.airInputs.cargoDice = 12
    expect(store.resolveAirCargoNow()).toBe(true)
  })
})
