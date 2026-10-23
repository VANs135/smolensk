import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { canFlyMission } from '@/engine/rules'
import {
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
} from '@/stores'

/**
 * H⑤（用户 2026-09-18 的 8 条报告之第 8 条）：**可执行空军任务的环节里，未激活的飞机不可选中**
 *
 * 用户原话：「8.可执行空军任务的环节时**点击机场**，**未激活的飞机应该不可选中**」。
 *
 * 原文
 *   · **14.1a**：「飞机有两种模式：激活或非激活……整体来说，**激活的飞机可以执行任务，而非激活飞机不能**。」
 *   · **14.1d**：「**非激活飞机需要通过整备来变为激活**。整备是飞机唯一需要或消耗补给的情况。」（15.1，A 段）
 *   · **14.1c**：执行完任务 / 从空战返航 ⇒ 返回基地并**变为非激活**（例外：成功拦截的战机、正常距离内基地转移）。
 *
 * 病灶：**引擎**早就按 14.1a 把关（`beginAirInteraction` 里 `aircraftNotActive:<id>`，
 * 且 `tests/engine/air-interaction.test.ts` 已有断言）——**漏的是"选择"这一步**：
 *   · `toggleAirMissionUnit`（store）只查 14.2f / 14.2a / 14.2e ⇒ 非激活飞机**点得进**；
 *   · `airMissionJoinChoices`（候选阵列）也不给 14.1a 的原因 ⇒ 面板与地图小窗的阵列里它看着可选；
 *   · 地图小窗（点机场）那颗「选入任务」按钮同理。
 * 于是玩家点机场、选了一枚非激活飞机，直到「宣布任务」才吃到 14.1a 的拒绝 —— 这正是用户报的观感。
 *
 * 本文件钉四件事：① 选择闸被 14.1a 挡住（且**账本一字未动**）；② 候选阵列给出 14.1a 的原因；
 * ③ 14.1d 的整备转激活后即可选（状态是唯一门槛）；④ 引擎判据只有一处（`canFlyMission`，真值表）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 六邻皆图内的格（摆基地与飞机都在这里，避免航程断言受地图形状影响） */
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

function airBaseRecord(): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('axis').find((record) => record.noncombatKind === 'air_base')
  if (found === undefined) throw new Error('单位库中没有空军基地算子')
  return found
}

function fighterRecord(side: Side): ReturnType<typeof aircraftChoices>[number] {
  const found = aircraftChoices(side).find((record) => record.aircraftType === 'F')
  if (found === undefined) throw new Error(`${side} 飞机库中没有战斗机`)
  return found
}

/** 摆一个本方基地 + 两架战机：`air-1` 激活、`air-2` 非激活（14.1a） */
function setupBaseAndPlanes(store: ReturnType<typeof newStore>) {
  store.units.push(
    toConsoleUnit({
      record: airBaseRecord(),
      instanceId: 'base-1',
      hex: CORE_HEX,
      side: 'axis',
    }),
  )
  const active = toConsoleAirUnit({
    aircraft: fighterRecord('axis'),
    instanceId: 'air-1',
    hex: CORE_HEX,
    side: 'axis',
    airStatus: 'active',
  })
  const inactive = toConsoleAirUnit({
    aircraft: fighterRecord('axis'),
    instanceId: 'air-2',
    hex: CORE_HEX,
    side: 'axis',
    airStatus: 'inactive',
  })
  store.airUnits.push(active, inactive)
  return { active, inactive }
}

describe('H⑤（14.1a）：空军任务里只可选**激活**的飞机', () => {
  it('★ 点机场选一枚**非激活**飞机 ⇒ 被 14.1a 拒（参战名单与气闸都不动）', () => {
    const store = newStore()
    store.setAirActive(true)
    const { active, inactive } = setupBaseAndPlanes(store)
    expect(inactive.airStatus).toBe('inactive')

    store.toggleAirMissionUnit(inactive.instanceId)
    expect(store.airMissionAirIds).toEqual([]) // 没被选进去
    expect(store.airError?.rule).toBe('14.1a')
    expect(store.airError?.reason).toBe(`aircraftNotActive:${inactive.instanceId}`)

    // 反空转（对照组）：激活的那枚**选得进去** ⇒ 上面那条不是因为"谁都选不进"
    store.toggleAirMissionUnit(active.instanceId)
    expect(store.airMissionAirIds).toEqual([active.instanceId])
    expect(store.airError).toBeNull()
  })

  it('★ 候选阵列逐机给原因：非激活 ⇒ 含 14.1a（并指向 14.1d 整备）；激活 ⇒ 无原因', () => {
    const store = newStore()
    store.setAirActive(true)
    const { active, inactive } = setupBaseAndPlanes(store)

    const choices = store.airMissionJoinChoices
    // 两枚都在阵列里（"不可选"≠"看不见"：玩家要知道它存在、以及为什么不能飞）
    expect(choices.map((item) => item.air.instanceId).sort()).toEqual(['air-1', 'air-2'])
    const inactiveChoice = choices.find((item) => item.air.instanceId === inactive.instanceId)
    const activeChoice = choices.find((item) => item.air.instanceId === active.instanceId)
    expect(inactiveChoice?.disabledReason ?? '').toContain('14.1a')
    expect(inactiveChoice?.disabledReason ?? '').toContain('14.1d') // 指路：得先整备（15.1）
    expect(activeChoice?.disabledReason).toBeNull()
  })

  it('★ 14.1d：整备转激活之后，同一枚即可选（状态是唯一门槛）', () => {
    const store = newStore()
    store.setAirActive(true)
    const { inactive } = setupBaseAndPlanes(store)

    store.toggleAirMissionUnit(inactive.instanceId)
    expect(store.airMissionAirIds).toEqual([])

    // 规则上的转换由整备（15.1，A 段）驱动；这里直接按 14.1a 的写盘入口改状态
    expect(store.toggleAirUnitStatus(inactive.instanceId)).toBe(true)
    expect(inactive.airStatus).toBe('active')
    expect(
      store.airMissionJoinChoices.find((item) => item.air.instanceId === inactive.instanceId)
        ?.disabledReason,
    ).toBeNull()

    store.toggleAirMissionUnit(inactive.instanceId)
    expect(store.airMissionAirIds).toEqual([inactive.instanceId])
    expect(store.airError).toBeNull()
  })

  it('★ 判据只有一处：`canFlyMission` 的真值表（14.1a）', () => {
    expect(canFlyMission('active')).toBe(true)
    expect(canFlyMission('inactive')).toBe(false)
  })

  it('★ 源码守卫：面板与小窗的阵列都读 store 的结论（不在组件里自己比状态）', () => {
    const panel = readFileSync('src/components/air/AirPanel.vue', 'utf8')
    // 参战机阵列的可选性与原因**必须**来自 store 的投影
    expect(panel).toContain('workbench.airMissionJoinChoices')
    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    // 地图小窗（点机场）那一颗「选入任务」按钮同样按 store 的结论禁用
    expect(popover).toContain('missionJoinReasonOf')
  })
})
