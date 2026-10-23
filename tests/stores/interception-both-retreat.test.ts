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

/**
 * 第五批 A2（docs/第五批修改方案.md 族 A2）：14.5 拦截「**双方返航**」时两机都要掉步
 *
 * 病灶：引擎 `resolveInterception` 对 `abortSide='both'` 给出**含双方**的 `stepLossIds`
 * （`air-interaction.ts:852-858`），store 却按三元式 `abortSide === 'attacker' ? interceptor : defender`
 * 只给一边掉步（`workbench.ts:13067-13070`）⇒ 修正骰落在「双方返航」带（14.3e 空战表：修正后 7）
 * 且损失骰 5–6 时，拦截机不掉步＝算错军力。
 * 规则原文：14.3e-C「掷第三枚骰子，即"损失"骰，以确定**返航的单位或单位们**是否还必须承受军力损失」
 * （`_ocs_v43_clean.txt:2761-2763`；例：修正后 7 ⇒「双方均返航」，txt:2778-2783）。
 *
 * ★ 测法边界（如实）：本用例只钉**拦截**这一条路径（`resolveInterceptionCombatNow`）；
 *   逐轮空战（`resolveAirCombatRounds`，同一 14.3e 表）的掉步在引擎内另行组装、已有用例覆盖，
 *   `air.ts:993-1001` 的实现本来就把 both 展开成双方 ⇒ 不在本用例重复。
 *   骰面经 `airInputs.interceptDie/interceptLossDie` 注入 ⇒ 确定性；"恰好落在 7"由
 *   `interceptDie = 7 − (拦截机 ACV − 迎战机 ACV)` 反推（若库里的 ACV 差使骰面越出 2–12，夹具会当场抛错）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 六邻皆图内的格 */
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

/** CORE_HEX 的图内邻格（苏方拦截机基地 ⇒ 巡逻区覆盖 CORE_HEX，14.4c） */
const NEAR_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(CORE_HEX, direction)
    if (
      isOnMap(candidate) &&
      mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)
    ) {
      return candidate
    }
  }
  throw new Error('CORE_HEX 没有图内邻格')
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

function bomberRecord(side: Side): ReturnType<typeof aircraftChoices>[number] {
  const found = aircraftChoices(side).find(
    (record) => record.aircraftType === 'T' && (record.barrageStrength ?? 0) > 0,
  )
  if (found === undefined) throw new Error(`${side} 飞机库中没有轰炸机`)
  return found
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('第五批 A2：14.5 拦截「双方返航」两机各掉 1 步（14.3e-C）', () => {
  it('修正骰落在双退带（7）＋损失骰 5 ⇒ 拦截机与任务机都损失 1 点军力', () => {
    const store = newStore()
    store.setAirActive(true)
    // 轴方：基地 + 轰炸机（任务方）
    store.units.push(
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-ax',
        hex: CORE_HEX,
        side: 'axis',
      }),
    )
    const bomber = toConsoleAirUnit({
      aircraft: bomberRecord('axis'),
      instanceId: 'bomber-1',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'active',
    })
    store.airUnits.push(bomber)
    // 苏方：基地 + 激活战斗机（拦截机）
    store.units.push(
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-su',
        hex: NEAR_HEX,
        side: 'soviet',
      }),
    )
    const interceptor = toConsoleAirUnit({
      aircraft: fighterRecord('soviet'),
      instanceId: 'fighter-su',
      hex: NEAR_HEX,
      side: 'soviet',
      airStatus: 'active',
    })
    store.airUnits.push(interceptor)

    store.setAirTargetFromText(label(CORE_HEX))
    store.toggleAirMissionUnit(bomber.instanceId)
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.airInterceptionResponse).toMatchObject({ eligible: true })

    store.airInputs.interceptDeclared = true
    store.airInputs.interceptorId = 'fighter-su'
    expect(store.declareInterceptionNow()).toBe(true)

    // 反推骰面：修正后恰好 7（空战表「双方均返航」带；≤6 拦截机退、≥8 任务机退）
    const diff = interceptor.airCombatRating - bomber.airCombatRating
    const die = 7 - diff
    expect(die).toBeGreaterThanOrEqual(2)
    expect(die).toBeLessThanOrEqual(12)
    store.airInputs.interceptDie = die
    store.airInputs.interceptLossDie = 5

    const interceptorStepsBefore = interceptor.steps
    const bomberStepsBefore = bomber.steps
    expect(store.resolveInterceptionCombatNow()).toBe(true)
    const combat = store.airState?.interception?.combat
    expect(combat?.combat?.abortSide).toBe('both')
    // 14.3e-C：损失骰 5–6 ⇒ **返航的单位或单位们**各损 1 点 ⇒ 两机都掉（修前只有任务机掉）
    expect(interceptor.steps).toBe(interceptorStepsBefore - 1)
    expect(bomber.steps).toBe(bomberStepsBefore - 1)
    // 14.5：拦截失败 ⇒ 拦截机变非激活（引擎 `interceptorAirStatus`，store 此处落盘）；
    // ★ 任务机（防守方）的"返航 ⇒ 非激活"发生在**任务收束**（14.3d/14.2f-F），
    //   本用例停在拦截结算 ⇒ 它的 airStatus 此刻尚未翻，不断言（测法边界）。
    expect(interceptor.airStatus).toBe('inactive')
  })
})
