import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { EXTENDER_REQUIRED_POINTS, isConvertibleTransportPoint } from '@/engine/rules'
import { isExtenderUnit, toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

import { CORE_HEX, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 13.2c 运输点数的**合并 / 拆分** + 12.7 延补队的**双向转换**
 *
 * 条文：
 *   · 13.2c「合并与拆分**不消耗 MP**，但只能在**友方移动阶段**中进行，且所有涉及的运输点数必须在
 *     **同一格**内……**不同类型的运输点数永远不能合并为同一个算子**，这一限制也包括编内卡车」；
 *   · 12.7a「将合计至少 **5 点**运输点数移动到同一格后，即可将这些运输点数转换为延补队。
 *     此操作消耗 **1/2 的 MA**」（余数留在原格）；
 *   · 12.7d 主动翻面回 5 点运输点数：**移动环节内** + 消耗自身一半 MA。
 *
 * ★ 修前：`mergeTransportPoints` / `splitTransportPoint` / `planConvertTransportToExtender` /
 *   `planFlipExtenderToTransport` 在 `src/` 内**全部零消费** ⇒ 13.2c 与 12.7 两条规则都没有入口。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 摆一枚运输点数算子（按型号与规模取真实记录） */
function placeTransportPoint(
  store: Workbench,
  kind: 'truck' | 'wagon',
  size: number,
  hex: HexRef = CORE_HEX,
  id?: string,
) {
  const record = unitChoices('axis').find(
    (item) =>
      item.noncombatDetails?.transport === size &&
      (item.noncombatDetails?.transportKind ?? null) === kind,
  )
  if (record === undefined) throw new Error(`单位库没有 ${kind} ${size} 运输点数算子`)
  return placeGround(store, record, hex, 'axis', id ?? `${kind}-${size}`)
}

/**
 * 声明一个基础补给源（12.6a①）
 *
 * ★ 第五批批 B 切片 2 起的**契约更新**（收紧，不是放宽）：12.7d 的「生成时须与补给来源相连」
 * 接通后，转换现场必须有可达来源 —— 既有用例补这一句才继续成立（修前缺该判据）。
 */
function declareSource(store: Workbench, hex: HexRef): void {
  store.supplySourceDraft = { hexText: `${hex.col}.${hex.row}`, kind: 'supplySourceHex' }
  expect(store.addSupplySource()).toBe(true)
}

describe('13.2c：合并运输点数（同格、同类型、移动阶段、不耗 MP）', () => {
  it('同格同类型的两枚 ⇒ 合并为该规模的单枚（换成对应面额的算子）', () => {
    const store = newStore()
    store.setPhase('movement')
    const a = placeTransportPoint(store, 'truck', 2)
    const b = placeTransportPoint(store, 'truck', 3)
    store.transportPointInputs = {
      ...store.transportPointInputs,
      mergeIds: [a.instanceId, b.instanceId],
    }
    expect(store.mergeTransportPointsNow()).toBe(true)
    const merged = store.transportPointsOfSide
    expect(merged).toHaveLength(1)
    expect(merged[0]!.noncombatTransport).toBe(5)
    expect(merged[0]!.hex).toEqual(CORE_HEX)
  })

  it('不同类型不得合并（13.2c：这一限制也包括编内卡车）', () => {
    const store = newStore()
    store.setPhase('movement')
    const truck = placeTransportPoint(store, 'truck', 3)
    const wagon = placeTransportPoint(store, 'wagon', 3)
    store.transportPointInputs = {
      ...store.transportPointInputs,
      mergeIds: [truck.instanceId, wagon.instanceId],
    }
    expect(store.mergeTransportPointsNow()).toBe(false)
    expect(store.transportPointsOfSide).toHaveLength(2) // 账本不动
  })

  it('不同格不得合并', () => {
    const store = newStore()
    store.setPhase('movement')
    const here = placeTransportPoint(store, 'truck', 2)
    const there = placeTransportPoint(store, 'truck', 3, {
      col: CORE_HEX.col + 1,
      row: CORE_HEX.row,
    })
    store.transportPointInputs = {
      ...store.transportPointInputs,
      mergeIds: [here.instanceId, there.instanceId],
    }
    expect(store.mergeTransportPointsNow()).toBe(false)
  })

  it('非移动阶段不得合并（13.2c 只在友方移动阶段）', () => {
    const store = newStore()
    store.setPhase('supply')
    const a = placeTransportPoint(store, 'truck', 2)
    const b = placeTransportPoint(store, 'truck', 3)
    store.transportPointInputs = {
      ...store.transportPointInputs,
      mergeIds: [a.instanceId, b.instanceId],
    }
    expect(store.mergeTransportPointsNow()).toBe(false)
  })

  it('算子库没有该规模 ⇒ 整笔拒绝且原算子不动（13.2c 的算子数量限制是规则原文）', () => {
    const store = newStore()
    store.setPhase('movement')
    const a = placeTransportPoint(store, 'truck', 5)
    const b = placeTransportPoint(store, 'truck', 5) // 10 点：库里只有 1–5 面额
    store.transportPointInputs = {
      ...store.transportPointInputs,
      mergeIds: [a.instanceId, b.instanceId],
    }
    expect(store.mergeTransportPointsNow()).toBe(false)
    expect(store.transportPointsOfSide).toHaveLength(2)
  })
})

describe('13.2c：拆分运输点数（各份为正且合计等于原规模）', () => {
  it('5 点拆成 2 + 3 ⇒ 两枚新算子，原枚消失', () => {
    const store = newStore()
    store.setPhase('movement')
    const point = placeTransportPoint(store, 'truck', 5)
    store.transportPointInputs = {
      ...store.transportPointInputs,
      splitId: point.instanceId,
      splitSizesText: '2 3',
    }
    expect(store.splitTransportPointNow()).toBe(true)
    const sizes = store.transportPointsOfSide.map((unit) => unit.noncombatTransport).sort()
    expect(sizes).toEqual([2, 3])
  })

  it('合计不等于原规模 ⇒ 拒（13.2c）', () => {
    const store = newStore()
    store.setPhase('movement')
    const point = placeTransportPoint(store, 'truck', 5)
    store.transportPointInputs = {
      ...store.transportPointInputs,
      splitId: point.instanceId,
      splitSizesText: '2 2',
    }
    expect(store.splitTransportPointNow()).toBe(false)
    expect(store.transportPointsOfSide).toHaveLength(1)
  })

  it('少于两份 ⇒ 拒（拆分的本意）', () => {
    const store = newStore()
    store.setPhase('movement')
    const point = placeTransportPoint(store, 'truck', 5)
    store.transportPointInputs = {
      ...store.transportPointInputs,
      splitId: point.instanceId,
      splitSizesText: '5',
    }
    expect(store.splitTransportPointNow()).toBe(false)
  })
})

describe('12.7a：运输点数 → 延补队（满 5 点、消耗 ½ MA、余数留原格）', () => {
  it('5 点 ⇒ 变成一枚延补队，且本阶段只剩一半 MA', () => {
    const store = newStore()
    store.setPhase('movement')
    declareSource(store, CORE_HEX)
    placeTransportPoint(store, 'truck', 5)
    expect(store.convertTransportToExtenderNow(`${CORE_HEX.col}.${CORE_HEX.row}`, 'truck')).toBe(
      true,
    )
    const extenders = store.units.filter(isExtenderUnit)
    expect(extenders).toHaveLength(1)
    // 12.7a：消耗 1/2 的 MA（12.7b：延补队的印值 MA 在**战斗面**）
    expect(extenders[0]!.mpSpent).toBe(extenders[0]!.faces.combat.ma / 2)
    // 5 点被全部消耗 ⇒ 不留余量，且延补队**不算**运输点数（它是同一枚算子的另一面）
    expect(store.transportPointsOfSide).toHaveLength(0)
  })

  it('8 点（5 + 3）⇒ 消耗 5 点、余 3 点留在原格（12.7a：点数可任意拆分）', () => {
    const store = newStore()
    store.setPhase('movement')
    declareSource(store, CORE_HEX)
    placeTransportPoint(store, 'truck', 5)
    placeTransportPoint(store, 'truck', 3)
    expect(store.convertTransportToExtenderNow(`${CORE_HEX.col}.${CORE_HEX.row}`, 'truck')).toBe(
      true,
    )
    expect(store.units.filter(isExtenderUnit)).toHaveLength(1)
    const leftovers = store.transportPointsOfSide.map((unit) => unit.noncombatTransport)
    expect(leftovers).toEqual([3])
  })

  it('不足 5 点 ⇒ 拒（12.7a 的阈值）', () => {
    const store = newStore()
    store.setPhase('movement')
    declareSource(store, CORE_HEX)
    placeTransportPoint(store, 'truck', 4)
    expect(store.convertTransportToExtenderNow(`${CORE_HEX.col}.${CORE_HEX.row}`, 'truck')).toBe(
      false,
    )
    expect(store.units.filter(isExtenderUnit)).toHaveLength(0)
  })

  it('非移动阶段不得转换（12.7a：只能在移动阶段；第五批批 B 切片 2 补闸）', () => {
    const store = newStore()
    store.setPhase('supply')
    declareSource(store, CORE_HEX)
    placeTransportPoint(store, 'truck', 5)
    expect(store.convertTransportToExtenderNow(`${CORE_HEX.col}.${CORE_HEX.row}`, 'truck')).toBe(
      false,
    )
    // 被**统一闸门**拦下（与"段内只在对应环节放行"同一处口径），原算子一字未动
    expect(store.actionRefusal).toMatchObject({ key: 'move.extenderConvert' })
    expect(store.units.filter(isExtenderUnit)).toHaveLength(0)
    expect(store.transportPointsOfSide).toHaveLength(1)
  })

  it('生成格连不到补给来源 ⇒ 拒（12.7d：不能在该格生成延补队）', () => {
    const store = newStore()
    store.setPhase('movement')
    // ★ 不声明任何来源 —— 12.7d 的"生成时须与追溯补给的补给来源格相连"不成立
    placeTransportPoint(store, 'truck', 5)
    expect(store.convertTransportToExtenderNow(`${CORE_HEX.col}.${CORE_HEX.row}`, 'truck')).toBe(
      false,
    )
    expect(store.units.filter(isExtenderUnit)).toHaveLength(0)
    expect(store.transportPointsOfSide).toHaveLength(1) // 账本一字未动
    expect(store.log.some((entry) => (entry.text ?? '').includes('12.7d'))).toBe(true)
  })

  it('10 点 + 明确要求 2 队 ⇒ 落 2 枚延补队、各记 ½ MA（第五批：修前只落 1 枚却按 2 队扣点）', () => {
    const store = newStore()
    store.setPhase('movement')
    declareSource(store, CORE_HEX)
    placeTransportPoint(store, 'truck', 5, CORE_HEX, 'tp-a')
    placeTransportPoint(store, 'truck', 5, CORE_HEX, 'tp-b')
    expect(store.convertTransportToExtenderNow(`${CORE_HEX.col}.${CORE_HEX.row}`, 'truck', 2)).toBe(
      true,
    )
    const extenders = store.units.filter(isExtenderUnit)
    expect(extenders).toHaveLength(2)
    for (const extender of extenders) {
      expect(extender.mpSpent).toBe(extender.faces.combat.ma / 2)
    }
    // 两枚 5 点全被消耗
    expect(store.transportPointsOfSide).toHaveLength(0)
  })

  it('编内卡车不参与转换（12.7a/5.7f：通用运输点数才算）', () => {
    // 数据层判据：`isConvertibleTransportPoint` 只看 noncombatKind
    expect(
      isConvertibleTransportPoint({ noncombatKind: 'organic_truck', transportKind: 'truck' }),
    ).toBe(false)
    expect(
      isConvertibleTransportPoint({ noncombatKind: 'transport_point', transportKind: 'truck' }),
    ).toBe(true)
  })
})

describe('12.7d：延补队 → 5 点运输点数（主动翻面，移动环节 + ½ MA）', () => {
  it('翻面后回到 5 点运输点数', () => {
    const store = newStore()
    store.setPhase('movement')
    declareSource(store, CORE_HEX)
    placeTransportPoint(store, 'truck', 5)
    store.convertTransportToExtenderNow(`${CORE_HEX.col}.${CORE_HEX.row}`, 'truck')
    const extender = store.units.find(isExtenderUnit)!
    expect(store.flipExtenderToTransport(extender.instanceId)).toBe(true)
    expect(store.units.filter(isExtenderUnit)).toHaveLength(0)
    expect(store.transportPointsOfSide.map((unit) => unit.noncombatTransport)).toEqual([
      EXTENDER_REQUIRED_POINTS,
    ])
  })

  it('非移动环节不得主动翻面（12.7d）', () => {
    const store = newStore()
    store.setPhase('movement')
    declareSource(store, CORE_HEX)
    placeTransportPoint(store, 'truck', 5)
    store.convertTransportToExtenderNow(`${CORE_HEX.col}.${CORE_HEX.row}`, 'truck')
    const extender = store.units.find(isExtenderUnit)!
    store.setPhase('supply')
    expect(store.flipExtenderToTransport(extender.instanceId)).toBe(false)
    expect(store.units.filter(isExtenderUnit)).toHaveLength(1)
  })
})

/** 让未用到的导入显式落地（命名与真实单位库一致） */
export const __fixture = { toConsoleUnit }
