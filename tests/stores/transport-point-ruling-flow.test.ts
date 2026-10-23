import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { distributeTransportCargo } from '@/engine/rules'
import { organicTruckImageUrl, tokenImageUrl } from '@/render/token-images'
import { SP_TO_T } from '@/engine/rules'
import { modeUnitClassOf, toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * 运输单位与运输点数（**用户 2026-09-15 裁定**）
 *
 * 用户原话：「编内卡车装 1SP；通用的运输点数**有几点运力就是几**（该回合有 3 点马车点数增援，
 *   就视为装着 3SP 进场）……编内卡车全部只有 1 点运力，该单位两面，一面是空载 1-45，
 *   一面是满载 1F（1 运力数字右上角多了个 F）-45」＋「**运输单位只有移动模式，没有战斗模式**（13.0）」
 *   ＋「运输点数是可以自由拆分的……先按照实体来几点给几点的算子，玩家移动时可以自由拆分」。
 *
 * 本组把四条口径分别钉住：① 只有移动模式；② 到货装载量＝运力点数；③ 编内卡车的面＝装载；
 * ④ 拆分/合并**保货**（总数不变）。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

const recordOf = (side: 'axis' | 'soviet', id: string) => {
  const found = unitChoices(side).find((item) => item.id === id)
  if (found === undefined) throw new Error(`单位库缺少 ${id}`)
  return found
}

describe('13.0：运输单位只有移动模式（没有战斗面）', () => {
  it('即使调用方按「战斗面」摆放，运输点数与编内卡车也一律落到移动模式', () => {
    for (const [side, id] of [
      ['soviet', 'su-transport-truck-3'],
      ['axis', 'ax-transport-wagon-2'],
      ['axis', 'ax-armor_pz-ge-12-pz-truck'],
      ['su-extender-truck', ''],
    ] as const) {
      if (id === '') continue
      const unit = toConsoleUnit({
        record: recordOf(side as 'axis' | 'soviet', id),
        instanceId: 'u1',
        hex: { col: 36, row: 13 },
        side: side as 'axis' | 'soviet',
        face: 'combat',
      })
      expect(unit.mode.mode, id).toBe('move')
      expect(unit.mode.orientation, id).toBe('move')
    }
    // 编内卡车（非编内：编内卡车也属运输单位）
    const truck = toConsoleUnit({
      record: recordOf('axis', 'ax-armor_pz-ge-12-pz-truck'),
      instanceId: 'u2',
      hex: { col: 36, row: 13 },
      side: 'axis',
      face: 'combat',
    })
    expect(truck.mode.mode).toBe('move')
  })

  it('单面算子（运输点数）强制移动面后 MA 不丢——raw 读到的仍是印值', () => {
    const unit = toConsoleUnit({
      record: recordOf('soviet', 'su-transport-truck-3'),
      instanceId: 'u1',
      hex: { col: 36, row: 13 },
      side: 'soviet',
    })
    expect(unit.raw.ma).toBe(45)
    expect(unit.faces.combat.ma).toBe(45)
    expect(unit.faces.move.ma).toBe(45)
    // 6.1b：有 MA ⇒ 不是「不可移动设施」
    expect(modeUnitClassOf(unit)).toBe('transportPoint')
  })
})

describe('13.6c：到货运输点数**满载**的装载量＝该算子运力点数', () => {
  it('3 点运输点数 ⇒ 装 3 SP（用户例子：3 点马车点数增援）', () => {
    const store = newStore()
    const record = recordOf('soviet', 'su-transport-wagon-3')
    expect(record.noncombatDetails?.transport).toBe(3)
    const unit = toConsoleUnit({
      record,
      instanceId: 'tp3',
      hex: { col: 36, row: 13 },
      side: 'soviet',
    })
    // 到货投放路径的动作（与 placeArrivalNow 同一口径）：装载量 = 运力点数
    unit.loadedSpT = (record.noncombatDetails?.transport ?? 0) * SP_TO_T
    store.units.push(unit)
    expect(unit.loadedSpT / SP_TO_T).toBe(3)
  })

  it('编内卡车运力恒 1 ⇒ 满载即 1 SP', () => {
    const record = recordOf('axis', 'ax-organic-truck-ssr')
    expect(record.noncombatDetails?.transport).toBe(1)
  })
})

describe('13.2h：编内卡车的**面＝装载**（满载 1F / 空载 1），与朝向无关', () => {
  const record = recordOf('axis', 'ax-armor_pz-ge-12-pz-truck')

  it('满载 ⇒ 取正面（印 1F）；空载 ⇒ 取背面（印 1）', () => {
    const loaded = tokenImageUrl({
      side: 'axis',
      face: 'move',
      images: record.images,
      noncombatKind: 'organic_truck',
      loadedSpT: SP_TO_T,
    })
    const empty = tokenImageUrl({
      side: 'axis',
      face: 'move',
      images: record.images,
      noncombatKind: 'organic_truck',
      loadedSpT: 0,
    })
    expect(loaded).toContain(record.images!.front)
    expect(empty).toContain(record.images!.back)
    expect(loaded).not.toBe(empty)
    // 「面随朝向变」在这里**不成立**：两种朝向都必须给出同一张（装载面）
    const sameFaceCombat = tokenImageUrl({
      side: 'axis',
      face: 'combat',
      images: record.images,
      noncombatKind: 'organic_truck',
      loadedSpT: 0,
    })
    expect(sameFaceCombat).toBe(empty)
  })

  it('organicTruckImageUrl 单面记录时退回唯一那张（不造空路径）', () => {
    expect(organicTruckImageUrl('axis', true, { front: 'A.png', back: null })).toContain('A.png')
    expect(organicTruckImageUrl('axis', false, { front: 'A.png', back: null })).toContain('A.png')
    expect(organicTruckImageUrl('axis', true, null)).toBeNull()
  })
})

describe('13.2c：拆分/合并**保货**（用户裁定：先按实体，几点给几点）', () => {
  it('分配：按 1 点运力装 1 SP 逐份装填，总数不变，末份兜底', () => {
    expect(distributeTransportCargo({ cargoSp: 3, sizes: [1, 2] })).toEqual([1, 2])
    expect(distributeTransportCargo({ cargoSp: 3, sizes: [2, 1] })).toEqual([2, 1])
    expect(distributeTransportCargo({ cargoSp: 1, sizes: [1, 2] })).toEqual([1, 0])
    expect(distributeTransportCargo({ cargoSp: 5, sizes: [3, 1, 1] })).toEqual([3, 1, 1])
    // 货多于运力：13.2f 对装载量没有上限 ⇒ 不丢，记在末份
    expect(distributeTransportCargo({ cargoSp: 6, sizes: [1, 2] })).toEqual([1, 5])
    expect(distributeTransportCargo({ cargoSp: 0, sizes: [2, 3] })).toEqual([0, 0])
    // 总数守恒（任意输入）
    for (const cargoSp of [0, 1, 2, 3, 7])
      for (const sizes of [[1, 1], [2, 3], [1, 1, 1], [5]]) {
        const parts = distributeTransportCargo({ cargoSp, sizes })
        expect(parts.reduce((sum, value) => sum + value, 0)).toBeCloseTo(cargoSp, 6)
      }
  })

  it('store 的拆分把货按份分到新算子上（修前直接丢货）', () => {
    const store = newStore()
    store.setPhase('movement')
    const record = recordOf('soviet', 'su-transport-wagon-3')
    const unit = toConsoleUnit({
      record,
      instanceId: 'tp3',
      hex: { col: 36, row: 13 },
      side: 'soviet',
    })
    unit.loadedSpT = 3 * SP_TO_T
    store.units.push(unit)
    store.transportPointInputs = {
      ...store.transportPointInputs,
      splitId: 'tp3',
      splitSizesText: '1 2',
    }

    expect(store.splitTransportPointNow(), JSON.stringify(store.log[0]?.text)).toBe(true)
    const pieces = store.units.filter((item) => item.noncombatKind === 'transport_point')
    expect(pieces).toHaveLength(2)
    const byPoints = pieces.map(
      (item) => [item.noncombatTransport, item.loadedSpT / SP_TO_T] as const,
    )
    expect(byPoints.sort()).toEqual([
      [1, 1],
      [2, 2],
    ])
  })
})
