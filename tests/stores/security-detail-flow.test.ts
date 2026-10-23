import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { removalReasonOf, type SecurityCheckCityView } from '@/engine/rules'
import { useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 专规 3.3b：治安需求的**逐城明细**（＋ `removalReasonOf` 的唯一消费点）
 *
 * 条文：「轴心国控制的**城市格**应由一个**可攻击**单位占据或被**轴方 ZOC** 覆盖；否则在该格放一枚
 *   苏军 **Trainbusting** 标记（可在**任意相位**放置）；在**任意 H 清理段**，若需求满足或该城转苏控
 *   则移除。」
 *
 * ★ 修前 `securityCityViews` 导出而界面**零引用**、`removalReasonOf` **零消费**：
 *   面板只能显示「需放置 N 处 / 需移除 M 处」三个计数，玩家看不到**是哪座城**、
 *   也看不到「为什么该移除」与「为什么现在还不能移除（须等 H 段）」。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 地图上第一座城（产品数据 map-layers 的 city 字段） */
function firstCity(store: Workbench) {
  const hex = store.mapCityHexes[0]
  if (hex === undefined) throw new Error('地图上没有城市格（夹具不成立）')
  return hex
}

describe('3.3b：逐城明细的行结构', () => {
  it('每座地图城市各一行；有事可做的城排在前面', () => {
    const store = newStore()
    const rows = store.securityCityDetails
    expect(rows).toHaveLength(store.mapCityHexes.length)
    const rank = { place: 0, remove: 1, none: 2 } as const
    const ranks = rows.map((row) => rank[row.action])
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
    // 未声明轴控时：没有任何城市需要放标记（非轴控城市不在 3.3b 范围内）
    expect(rows.every((row) => row.action === 'none')).toBe(true)
    expect(rows.every((row) => row.controlledByAxis === false)).toBe(true)
  })

  it('轴控但既无可攻击单位、也无 ZOC、且无标记 ⇒ 该行 action=place', () => {
    const store = newStore()
    const hex = firstCity(store)
    store.toggleAxisCityControlNow(`${hex.col}.${hex.row}`)
    const row = store.securityCityDetails.find((item) =>
      item.label.startsWith(`${hex.col}.${hex.row}`),
    )
    expect(row).not.toBeUndefined()
    expect(row).toMatchObject({ controlledByAxis: true, action: 'place', marked: false })
    expect(row!.occupied).toBe(false)
    expect(row!.zoc).toBe(false)
  })

  it('轴控且被**可攻击单位占据** ⇒ 无需放置；已有标记则该行 action=remove 且理由是「需求已满足」', () => {
    const store = newStore()
    const hex = firstCity(store)
    store.toggleAxisCityControlNow(`${hex.col}.${hex.row}`)
    const record = groundRecord(
      'axis',
      (item) => item.isCombat === true && item.attackCapable === true,
    )
    placeGround(store, record, hex, 'axis', 'sec-1')

    let row = store.securityCityDetails.find((item) =>
      item.label.startsWith(`${hex.col}.${hex.row}`),
    )!
    expect(row).toMatchObject({ occupied: true, action: 'none' })
    // 有标记 ⇒ 该移除，理由＝治安需求已满足
    store.trainbustingMarks.push({ id: 'tb-1', hex: { ...hex }, side: 'soviet' })
    row = store.securityCityDetails.find((item) => item.label.startsWith(`${hex.col}.${hex.row}`))!
    expect(row).toMatchObject({ marked: true, action: 'remove', removalReason: 'securityNeedsMet' })
    // 3.3b：移除只在 H 清理段
    store.setPhase('movement')
    expect(
      store.securityCityDetails.find((item) => item.label.startsWith(`${hex.col}.${hex.row}`))!
        .removalAllowedNow,
    ).toBe(false)
    store.setPhase('cleanUp')
    expect(
      store.securityCityDetails.find((item) => item.label.startsWith(`${hex.col}.${hex.row}`))!
        .removalAllowedNow,
    ).toBe(true)
  })

  it('城市转苏控（撤销轴控声明）⇒ 有标记的那些行 action=remove 且理由是「已转苏控」', () => {
    const store = newStore()
    const hex = firstCity(store)
    store.trainbustingMarks.push({ id: 'tb-2', hex: { ...hex }, side: 'soviet' })
    // 未声明轴控 ⇒ 该格属「转苏控」一类
    const row = store.securityCityDetails.find((item) =>
      item.label.startsWith(`${hex.col}.${hex.row}`),
    )!
    expect(row).toMatchObject({
      controlledByAxis: false,
      action: 'remove',
      removalReason: 'citySovietControlled',
    })
  })

  it('明细的 action 与引擎 `checkSecurityNeeds` 同源（不另算一遍）', () => {
    const store = newStore()
    const hex = firstCity(store)
    store.toggleAxisCityControlNow(`${hex.col}.${hex.row}`)
    const needs = store.securityNeeds!
    const placeKeys = needs.placeAt.map((item) => `${item.col}.${item.row}`)
    for (const row of store.securityCityDetails) {
      if (row.action === 'place') expect(placeKeys).toContain(row.label.split(' ')[0])
    }
  })
})

describe('3.3b：`removalReasonOf` 与 `checkSecurityNeeds` 同源', () => {
  it('两个理由的判据与「该移除」一致（不该移除时为 null）', () => {
    const city = (over: Partial<SecurityCheckCityView>): SecurityCheckCityView => ({
      hex: { col: 1, row: 1 },
      controlledByAxis: true,
      occupiedByAttackCapable: false,
      coveredByAxisZoc: false,
      hasTrainbusting: true,
      ...over,
    })
    // 轴控且需求未满足 ⇒ 不该移除（无理由）
    expect(removalReasonOf(city({}))).toBeNull()
    // 需求满足（占据或 ZOC）⇒ 理由＝需求已满足
    expect(removalReasonOf(city({ occupiedByAttackCapable: true }))).toBe('securityNeedsMet')
    expect(removalReasonOf(city({ coveredByAxisZoc: true }))).toBe('securityNeedsMet')
    // 转苏控 ⇒ 理由＝已转苏控（即使需求"满足"也按转控算，因为它已不在轴控清单里）
    expect(removalReasonOf(city({ controlledByAxis: false, occupiedByAttackCapable: true }))).toBe(
      'citySovietControlled',
    )
  })
})
