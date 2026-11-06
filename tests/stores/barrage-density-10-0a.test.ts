import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { barrageDensityReIn, toConsoleUnit, unitChoices } from '@/stores'

/**
 * A4-01 / 10.0a：目标格内**单个师/编队**计入密度时封顶 3 RE
 *
 * 原文：「单独一个师（即使是**多单位编队**）在计算单位密度的横移时，永远不会算作超过 3RE。
 * 如果少于 3RE，则使用实际数量即可」。
 *
 * 本作的多单位编队（如 3PZ）在单位库里表现为**多个单步算子共享同一个 `formation`**；
 * 独立师（单算子 4 步）则没有 `formation`。前者必须先按 `formation` 合并再封顶，
 * 否则会把同一师按算子分别计入（偏高）。此文件钉 store 侧 `barrageDensityReIn` 的分组口径。
 */

const HEX: HexRef = { col: 36, row: 13 }

function place(id: string) {
  const record = unitChoices('axis').find((unit) => unit.id === id)
  if (record === undefined) throw new Error(`单位库里找不到 ${id}`)
  return toConsoleUnit({ record, instanceId: id, hex: HEX, side: 'axis' })
}

/** 3PZ 编队内的 5 个战斗算子：0.5×3 + 1 + 1 = 3.5 RE */
const PZ3_UNITS = [
  'ax-armor_pz-ge-3-pz-i-6-pz',
  'ax-armor_pz-ge-3-pz-ii-6-pz',
  'ax-armor_pz-ge-3-pz-iii-6-pz',
  'ax-armor_pz-ge-3-pz-3-mot-inf',
  'ax-armor_pz-ge-3-pz-75-arty',
]

describe('10.0a：store 侧密度按 formation 分组后封顶', () => {
  it('同一编队（3PZ）合计 3.5 RE ⇒ 只计 3 RE', () => {
    const units = PZ3_UNITS.map(place)
    expect(barrageDensityReIn(units, HEX, 'axis')).toBe(3)
  })

  it('编队外的单算子按各自一组封顶：4 步独立师只计 3 RE', () => {
    const division = place('ax-infantry-ge-5-inf-div')
    expect(division.formation).toBeNull()
    expect(barrageDensityReIn([division], HEX, 'axis')).toBe(3)
  })

  it('不同组各自封顶后相加：编队 1.5 RE + 独立师 3 RE ⇒ 4.5', () => {
    const group = PZ3_UNITS.slice(0, 3).map(place)
    const division = place('ax-infantry-ge-5-inf-div')
    expect(barrageDensityReIn([...group, division], HEX, 'axis')).toBe(4.5)
  })
})
