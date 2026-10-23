import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { aircraft, mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  aircraftChoices,
  toAirBarrageUnitRequest,
  toAirMissionAircraftView,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
} from '@/stores'

/**
 * 第五批 C1（docs/第五批修改方案.md 族 C1）：减损飞机的**背面印值**（轰炸值/空战值）
 *
 * 原文 14.1b：「每个飞机算子都有两点军力。**使用算子的反面 (减损面)来表示军力损失**」；
 * 14.4f：「移除被摧毁的飞机；剩下一 点军力的飞机将**使用其减少后的数值**来完成任务。」
 * ⇒ 减损机（steps < 印值军力）在轰炸聚值（10.0a）、14.4f 任务损失表选机（W/S 按轰炸值）、
 *   空战（14.3e 的 ACV）里都必须用**背面值**。
 *
 * 病灶：产品 `src/data/aircraft.json` 只有正面单值（权威库 `printed_values.back` 无对应字段）；
 * 运行期 `barrageStrength`/`airCombatRating` 是静态正面值，减损后照用 ⇒ 与原文不符。
 * （2026-09-30 review 复核：权威库 Ju.87b 正面 12/1、背面 6/0。）
 *
 * ★ 测法边界（如实）：① 14.4f 的 W/S 列只在「**4 aircraft**」行（`flak-mission-loss` 表），
 *   故选机用例必须凑 4 架任务机、损失骰 5（W 列）；② 13.9-4 用 IL.2（单军力机）作对象——
 *   它是"未减损却被旧判据 `steps<2` 误判为已减损"的可复现场景（正面/背面值在本作数据里对
 *   同型机恒相同，造不出"同型不同值"的差异，故该处的值同源化靠代码评审而非红检）；
 *   ③ 数据面断言只钉 Ju.87b 与 IL.2 两条代表（全表 20 条由生成脚本照权威库产出）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 六邻皆图内的格（基地与飞机都摆这里） */
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

const recordOf = (id: string): ReturnType<typeof aircraftChoices>[number] => {
  const found = aircraftChoices('axis')
    .concat(aircraftChoices('soviet'))
    .find((item) => item.aircraftId === id)
  if (found === undefined) throw new Error(`飞机库没有 ${id}`)
  return found
}

function placeAir(
  store: ReturnType<typeof newStore>,
  aircraftId: string,
  instanceId: string,
  side: 'axis' | 'soviet',
) {
  store.airUnits.push(
    toConsoleAirUnit({
      aircraft: recordOf(aircraftId),
      instanceId,
      hex: CORE_HEX,
      side,
      airStatus: 'active',
    }),
  )
  const air = store.airUnits.find((item) => item.instanceId === instanceId)
  if (air === undefined) throw new Error(`飞机 ${instanceId} 不在盘面上`)
  return air
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('第五批 C1：减损飞机的背面印值', () => {
  it('数据面：Ju.87b 带背面值（轰炸 6 / 空战 0）；IL.2 单军力无背面值', () => {
    const ju87 = aircraft.aircraft.find((item) => item.aircraftId === 'ax-aircraft-ge-ju-87b')
    const il2 = aircraft.aircraft.find((item) => item.aircraftId === 'su-aircraft-ru-il-2')
    if (ju87 === undefined || il2 === undefined) throw new Error('飞机库里缺 Ju.87b / IL.2')
    expect(ju87.barrageStrength).toBe(12)
    expect(ju87.barrageStrengthBack).toBe(6)
    expect(ju87.airCombatRatingBack).toBe(0)
    expect(il2.steps).toBe(1)
    expect(il2.barrageStrengthBack ?? null).toBeNull() // 单军力机：一损即毁，无减损面
  })

  it('10.0a 轰炸聚值：减损的 Ju.87b 按背面值 6 参炸（修前照用正面 12）', () => {
    const store = newStore()
    const ju87 = placeAir(store, 'ax-aircraft-ge-ju-87b', 'j1', 'axis')
    expect(toAirBarrageUnitRequest(ju87, CORE_HEX).printedValue).toBe(12) // 未减损：正面
    ju87.steps = 1 // 14.1b：损失 1 点 ⇒ 翻到减损面
    expect(toAirBarrageUnitRequest(ju87, CORE_HEX).printedValue).toBe(6)
  })

  it('14.3e 空战：减损的 Bf-109f 按背面 ACV 3（修前照用正面 4）', () => {
    const store = newStore()
    const bf109 = placeAir(store, 'ax-aircraft-ge-bf-109f', 'f1', 'axis')
    expect(toAirMissionAircraftView(bf109).airCombatRating).toBe(4)
    bf109.steps = 1
    expect(toAirMissionAircraftView(bf109).airCombatRating).toBe(3)
  })

  it('14.4f 任务损失表 W 列（4 机、损失骰 5）按**当前面**轰炸值选最弱：选中减损机', () => {
    const store = newStore()
    store.setAirActive(true)
    store.units.push(
      toConsoleUnit({
        record: unitChoices('axis').find((item) => item.noncombatKind === 'air_base')!,
        instanceId: 'base-ax',
        hex: CORE_HEX,
        side: 'axis',
      }),
    )
    // 4 架同型（正面全 12）：j3 减损（背面 6）⇒ W 列应选它（修前平局取先者 j1）
    for (const id of ['j1', 'j2', 'j3', 'j4'] as const)
      placeAir(store, 'ax-aircraft-ge-ju-87b', id, 'axis')
    const j3 = store.airUnits.find((item) => item.instanceId === 'j3')!
    j3.steps = 1

    store.setAirTargetFromText(label(CORE_HEX))
    for (const id of ['j1', 'j2', 'j3', 'j4'] as const) store.toggleAirMissionUnit(id)
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.declareInterceptionNow()).toBe(true)
    // 14.4e：2 骰 12（4 机任务再 +1）⇒ 必命中；14.4f：损失骰 5 ⇒「4 aircraft」行的 W 列
    store.airInputs.flakDie = 12
    store.airInputs.lossDie = 5
    expect(store.resolveFlakNow()).toBe(true)
    expect(store.airState?.flak).toMatchObject({ hit: true, lossAircraftId: 'j3' })
  })

  it('13.9-4：两枚**未减损**的 IL.2（单军力机）不得合并（修前被 steps<2 误判为已减损）', () => {
    const store = newStore()
    store.setActiveSide('soviet')
    placeAir(store, 'su-aircraft-ru-il-2', 'il2-1', 'soviet')
    placeAir(store, 'su-aircraft-ru-il-2', 'il2-2', 'soviet')
    expect(store.consolidateAircraftNow('il2-1', 'il2-2')).toBe(false)
    expect(store.airUnits.filter((item) => item.aircraftId === 'su-aircraft-ru-il-2')).toHaveLength(
      2,
    )
  })

  it('10.2c 参炸候选：减损的 Bf-109f（正面 1 / 背面 0 轰炸值）不再可选（修前仍在）', () => {
    const store = newStore()
    store.setBarrageKind('air')
    placeAir(store, 'ax-aircraft-ge-bf-109f', 'f-ok', 'axis')
    const reduced = placeAir(store, 'ax-aircraft-ge-bf-109f', 'f-hurt', 'axis')
    reduced.steps = 1
    expect(store.barrageAirCandidates.map((item) => item.instanceId)).toEqual(['f-ok'])
  })
})
