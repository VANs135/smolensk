import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * 第六批批 P0 切片 3（条 20）的**界面侧**：候选里标出"够不着"的炮
 *
 * 与 `tests/engine/barrage-range-10-1a.test.ts` 是同一条 10.1a 的两半：
 *   · 引擎那一半**裁决**（够不着即拒，给 10.1a）；
 *   · 本文件这一半**说清楚**（候选里给出"射程 N 格，目标在 M 格外"），玩家不必先点再被拒。
 * ★ 界面不做裁决（CODE_SPEC §3.1：规则结算只在引擎）——这里只断言文案与"标/不标"。
 *
 * ## 测法边界
 *   · 用真实地图与真实单位库；射程取自**朝向那一面**的印刷值（`unit.raw.range`，5.4a）；
 *   · 射程**交集高亮**（哪些格可被这一组炮打得到）属批 U，本切片不做。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 目标格：六邻皆图内 */
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

/** 炮位：目标格的图内邻格（格距 1） */
const NEAR_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(TARGET_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)) continue
    return candidate
  }
  throw new Error('目标格没有图内邻格')
})()

/** 远处炮位：与目标格**格距 5**（库里最大射程是 3 ⇒ 一定够不着） */
const FAR_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return hexDistance(ref, TARGET_HEX) === 5
  })
  if (found === undefined) throw new Error('地图上找不到与目标格相距 5 格的格')
  return { col: found.col, row: found.row }
})()

function artilleryRecord(): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('axis').find(
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
  )
  if (found === undefined) throw new Error('轴心国单位库中没有带轰炸值的火炮')
  return found
}

describe('第六批 P0-3：10.1a 射程在候选里的标注（条 20）', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  it('数据自检：库里**每一门**带轰炸值的炮都有印刷射程（否则射程判据会一律拒）', () => {
    let checked = 0
    for (const side of ['axis', 'soviet'] as const) {
      for (const record of unitChoices(side)) {
        for (const face of ['combat', 'move'] as const) {
          const set = record.factors?.[face]
          if ((set?.barrage ?? 0) <= 0) continue
          checked += 1
          expect(set?.range ?? null).not.toBeNull()
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('★ 射程内的炮**不标**；射程外的炮标出 10.1a 与具体格距', () => {
    store.setPhase('combat')
    // 目标格：`barragePickHex` 未对外暴露（环节点格走 `clickHex`）⇒ 用兼容层的 `battleTarget`
    store.battleTarget = { hex: TARGET_HEX, defenderIds: [] }
    expect(store.barrageTargetHex).toEqual(TARGET_HEX)
    const near = toConsoleUnit({
      record: artilleryRecord(),
      instanceId: 'gun-near',
      hex: NEAR_HEX,
      side: 'axis',
    })
    const far = toConsoleUnit({
      record: artilleryRecord(),
      instanceId: 'gun-far',
      hex: FAR_HEX,
      side: 'axis',
    })
    store.units.push(near, far)

    const reasonOf = (id: string): string | null =>
      store.barrageUnitChoices.find((item) => item.unit.instanceId === id)?.disabledReason ?? null

    expect(reasonOf('gun-near')).toBeNull()
    const farReason = reasonOf('gun-far')
    expect(farReason).not.toBeNull()
    expect(farReason).toContain('10.1a')
    expect(farReason).toContain('5')
  })

  it('★ 目标格未选 ⇒ 无从判距离，**一律不标**（不臆造）', () => {
    store.setPhase('combat')
    const far = toConsoleUnit({
      record: artilleryRecord(),
      instanceId: 'gun-far',
      hex: FAR_HEX,
      side: 'axis',
    })
    store.units.push(far)
    expect(store.barrageTargetHex).toBeNull()
    expect(
      store.barrageUnitChoices.find((item) => item.unit.instanceId === 'gun-far')?.disabledReason,
    ).toBeNull()
  })
})
