import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
} from '@/stores'

import { placeGround } from '../flows/sop-harness'

/**
 * 第五批 C2（docs/第五批修改方案.md 族 C2＋C3＋C4）：空运的 14.9c / 14.9d（store 链）
 *
 * 原文：
 *   · 14.9c「补给点数可以被空运，**处于移动模式**的战斗单位也可以空运，前提是其 MA 为
 *     **10 或以下的步行 MP**」；
 *   · 14.9d「战斗单位被空运的阶段中，**最多可移动其 MA 的 1/2**……这可以在空运任务之前或之后
 *     进行（或二者皆有），但消耗的 MA 不能超过 1/2」。
 *
 * 病灶（2026-09-30 review）：14.9c 全仓 0 命中（候选给全部地面战斗单位、引擎不查模式）；
 * 空运落地把单位直接置 `movementEnded`（比 14.9d 更严——原文允许任务前后合计移 MA/2）。
 *
 * ★ 测法边界（如实）：① "步行 MP≤10" 半条在本作数据下恒真（战斗单位战斗面 MA 最大 10），
 *   其判据层真值表由引擎用例覆盖；本文件只钉**模式**半条与额度联动。② 14.9d 的"反应/进击阶段
 *   1/4 MA、须被释放预备"等阶段分支**未实现**（主规则＝移动阶段；其余如实登记）。
 *   ③ 空运也走 14.10d 检定（既有实现口径），故链上给 `cargoDice = 12` 必成功。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 六邻皆图内的格（起点：基地 + 运输机） */
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

/** 目的地：与起点相邻的一格（14.9e：空运可飞往任何友方空军基地） */
const DEST_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(CORE_HEX, direction)
    if (
      isOnMap(candidate) &&
      mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)
    )
      return candidate
  }
  throw new Error('起点旁找不到图内格')
})()

function airBaseRecord() {
  const found = unitChoices('axis').find((record) => record.noncombatKind === 'air_base')
  if (found === undefined) throw new Error('单位库中没有空军基地算子')
  return found
}

function transportRecord(side: Side) {
  const found = aircraftChoices(side).find((record) => record.aircraftType === 'T')
  if (found === undefined) throw new Error(`${side} 飞机库中没有运输机`)
  return found
}

/** 摩托化步兵团（战斗面 MA 3＝步行 MP；移动面 MA 16＝轮式） */
function motInfRecord() {
  const found = unitChoices('axis').find((record) => record.id === 'ax-armor_pz-ge-3-pz-3-mot-inf')
  if (found === undefined) throw new Error('单位库中没有 3 Pz 3 Mot Inf')
  return found
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 摆好「起点基地 + 目的地基地 + 一架运输机（容量 4）」并返回该单位（移动模式的摩托化团） */
function setup(store: ReturnType<typeof newStore>) {
  store.setAirActive(true)
  store.units.push(
    toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
    toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-2', hex: DEST_HEX, side: 'axis' }),
  )
  const transport = toConsoleAirUnit({
    aircraft: transportRecord('axis'),
    instanceId: 'tpt-1',
    hex: CORE_HEX,
    side: 'axis',
    airStatus: 'active',
  })
  transport.transportCapacity = 4
  store.airUnits.push(transport)
  placeGround(store, motInfRecord(), CORE_HEX, 'axis', 'u1')
  const unit = store.units.find((item) => item.instanceId === 'u1')
  if (unit === undefined) throw new Error('单位 u1 不在盘面上')
  return unit
}

/** 走完 14.2f 的 A→F：宣布（带单位货物）→ 空战 → 拦截 → 防空 → cargo 检定 */
function runUnitMission(store: ReturnType<typeof newStore>): boolean {
  store.setAirMissionKind('air_transport')
  store.setAirTargetFromText(label(DEST_HEX))
  store.toggleAirMissionUnit('tpt-1')
  store.toggleAirCargoUnit('u1')
  if (!store.beginAirMissionNow()) return false
  if (!store.confirmAirCombatNow()) return false
  if (!store.declareInterceptionNow()) return false
  store.airInputs.flakDie = 2 // E 防空：2 骰 2 ⇒ 不命中
  if (!store.resolveFlakNow()) return false
  store.airInputs.cargoDice = 12 // 表 17-4：2 骰 12 必成功
  return store.resolveAirCargoNow()
}

describe('第五批 C2：空运的 14.9c / 14.9d（store 链）', () => {
  it('14.9c：战斗模式的单位不进货物候选、装入即被拒；切移动模式后两处都放行', () => {
    const store = newStore()
    const unit = setup(store)
    expect(unit.mode.mode).toBe('combat')
    // ① 候选：战斗模式**不列**（修前全列 ⇒ 红）
    expect(store.airCargoUnitChoices.map((item) => item.instanceId)).not.toContain('u1')
    // ② 端到端：装入 ⇒ 宣布被拒（引 14.9c）
    store.setAirMissionKind('air_transport')
    store.setAirTargetFromText(label(DEST_HEX))
    store.toggleAirMissionUnit('tpt-1')
    store.toggleAirCargoUnit('u1')
    expect(store.beginAirMissionNow()).toBe(false)
    expect(store.airError).toMatchObject({ rule: '14.9c' })
    // ③ 对照：切到移动模式 ⇒ 候选含它、宣布放行
    unit.mode.mode = 'move'
    expect(store.airCargoUnitChoices.map((item) => item.instanceId)).toContain('u1')
    expect(store.beginAirMissionNow()).toBe(true)
  })

  it('14.9d：空运落地后本阶段额度只剩移动面 MA 的一半；且**不**置 movementEnded', () => {
    const store = newStore()
    const unit = setup(store)
    unit.mode.mode = 'move'
    expect(unit.mpSpent).toBe(0)
    expect(runUnitMission(store)).toBe(true)
    // 14.9d：任务前未动 ⇒ 任务后合计仍可移 MA/2 ⇒ 预扣另一半
    expect(unit.hex).toEqual(DEST_HEX)
    expect(unit.mpSpent).toBe(unit.faces.move.ma / 2) // 16/2 = 8（修前 0 ⇒ 红）
    // 14.9d 允许"任务前或后"移动 ⇒ 不整段封死（修前 movementEnded=true ⇒ 红）
    expect(unit.movementEnded).toBe(false)
  })

  it('14.9d：任务前已花 2 MP ⇒ 落地后剩余额度只剩 MA/2 − 2（合计不超一半）', () => {
    const store = newStore()
    const unit = setup(store)
    unit.mode.mode = 'move'
    unit.mpSpent = 2
    expect(runUnitMission(store)).toBe(true)
    // 16 MA：上限 8，已花 2 ⇒ 之后只能再花 6 ⇒ mpSpent 预提到 10
    expect(unit.mpSpent).toBe(unit.faces.move.ma / 2 + 2) // = 10（修前 2 ⇒ 红）
  })
})
