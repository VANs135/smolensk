import { describe, expect, it } from 'vitest'
import { createAirUnitTransitDomain } from '@/stores/air-unit-transit'
import { toConsoleUnit, unitChoices, type ConsoleUnit } from '@/stores/workbench-model'
import type { AirMissionCargo } from '@/engine/rules'

const origin = { col: 36, row: 13 }
const target = { col: 37, row: 13 }

function fixture() {
  const record = unitChoices('axis').find((unit) => unit.isCombat === true)!
  const a = toConsoleUnit({ record, instanceId: 'a', side: 'axis', hex: { ...origin } })
  const b = toConsoleUnit({ record, instanceId: 'b', side: 'axis', hex: { ...origin } })
  a.mpSpent = 1
  b.mpSpent = 2
  let board: ConsoleUnit[] = [a, b]
  const domain = createAirUnitTransitDomain({
    units: () => board,
    removeFromMap(ids) {
      board = board.filter((unit) => !ids.includes(unit.instanceId))
    },
    addToMap(unit) {
      board = [...board, unit]
    },
  })
  const cargo: AirMissionCargo[] = [
    { id: 'unit:a', kind: 'unit' },
    { id: 'unit:b', kind: 'unit' },
  ]
  const plan = () => {
    const result = domain.prepare(cargo)
    if (!result.ok) throw new Error(result.reason)
    return result.data
  }
  return {
    a,
    b,
    domain,
    cargo,
    plan,
    board: () => board,
    replaceBoard: (next: ConsoleUnit[]) => (board = next),
  }
}

describe('14.9 / 14.10：地面单位在途账本', () => {
  it('装载前单位被移走或替换时整份计划失效，不会先移走其余货物', () => {
    const f = fixture()
    const plan = f.plan()
    f.b.hex = { ...target }
    expect(f.domain.load(plan)).toBe(false)
    expect(f.board()).toEqual([f.a, f.b])
    expect(f.domain.manifest.value).toEqual([])
    f.b.hex = { ...origin }
    f.replaceBoard([f.a, { ...f.b }])
    expect(f.domain.load(plan)).toBe(false)
    expect(f.board()).toHaveLength(2)
    expect(f.domain.load(f.plan())).toBe(true)
    expect(f.board()).toEqual([])
    expect(f.domain.load(plan)).toBe(false)
  })

  it('宣布失败不取走单位，已在途的任务也不能被下一份货单覆盖', () => {
    const f = fixture()
    expect(f.domain.prepare([...f.cargo, f.cargo[0]!]).ok).toBe(false)
    expect(f.domain.prepare([{ id: 'unit:missing', kind: 'unit' }]).ok).toBe(false)
    expect(f.board()).toEqual([f.a, f.b])
    expect(f.domain.load(f.plan())).toBe(true)
    expect(f.domain.prepare([]).ok).toBe(false)
    expect(f.domain.find('unit:a')).toBe(f.a)
    expect(f.domain.manifest.value.map((item) => item.fate)).toEqual(['aboard', 'aboard'])
  })

  it('落地和退运沿用原单位及移动状态，已结算单位不能再落地或重放装载计划', () => {
    const f = fixture()
    const plan = f.plan()
    expect(f.domain.load(plan)).toBe(true)
    expect(f.domain.find('unit:a')).toBe(f.a)
    f.domain.find('unit:a')!.mpSpent = 3
    expect(f.domain.land(['unit:a'], target, 'delivered')).toBe(true)
    expect(f.domain.land(['unit:a'], target, 'delivered')).toBe(false)
    expect(f.domain.lose(['unit:a'])).toBeNull()
    expect(f.domain.land(['unit:b'], origin, 'returned')).toBe(true)
    expect(f.board()).toEqual([f.a, f.b])
    expect(f.board()[0]).toBe(f.a)
    expect(f.a.hex).toEqual(target)
    expect(f.a.mpSpent).toBe(3)
    expect(f.b.mpSpent).toBe(2)
    expect(f.domain.find('unit:a')).toBeUndefined()
    expect(f.domain.manifest.value).toMatchObject([
      { cargoId: 'unit:a', sourceHex: origin, fate: 'delivered' },
      { cargoId: 'unit:b', sourceHex: origin, fate: 'returned' },
    ])
    expect(f.domain.load(plan)).toBe(false)
    expect(f.board()).toHaveLength(2)
  })

  it('批量落地遇到缺失货物、重复ID或地图同ID冲突时，整组仍留在途', () => {
    const f = fixture()
    expect(f.domain.load(f.plan())).toBe(true)
    expect(f.domain.land(['unit:a', 'unit:missing'], target, 'delivered')).toBe(false)
    expect(f.domain.land(['unit:a', 'unit:a'], target, 'delivered')).toBe(false)
    const duplicate = { ...f.b }
    f.replaceBoard([duplicate])
    expect(f.domain.canLand(['unit:a', 'unit:b'])).toBe(false)
    expect(f.domain.land(['unit:a', 'unit:b'], target, 'delivered')).toBe(false)
    expect(f.board()).toEqual([duplicate])
    expect(f.a.hex).toEqual(origin)
    expect(f.domain.manifest.value.map((item) => item.fate)).toEqual(['aboard', 'aboard'])
  })

  it('货损只交付一次原单位给死亡结算，错误的选择不损失其余货物', () => {
    const f = fixture()
    expect(f.domain.load(f.plan())).toBe(true)
    expect(f.domain.lose(['unit:a', 'unit:missing'])).toBeNull()
    expect(f.domain.lose(['unit:a', 'unit:a'])).toBeNull()
    expect(f.domain.find('unit:a')).toBe(f.a)
    const losses = f.domain.lose(['unit:a'])
    expect(losses).toEqual([f.a])
    expect(losses![0]).toBe(f.a)
    expect(f.domain.lose(['unit:a'])).toBeNull()
    expect(f.domain.canLand(['unit:a'])).toBe(false)
    expect(f.domain.find('unit:a')).toBeUndefined()
    expect(f.domain.find('unit:b')).toBe(f.b)
    expect(f.domain.manifest.value.map((item) => item.fate)).toEqual(['lost', 'aboard'])
    expect(f.board()).toEqual([])
  })

  it('全盘重置清掉在途归属并废弃先前准备的装载计划', () => {
    const f = fixture()
    const plan = f.plan()
    f.domain.reset()
    expect(f.domain.load(plan)).toBe(false)
    expect(f.domain.load(f.plan())).toBe(true)
    f.domain.reset()
    expect(f.domain.manifest.value).toEqual([])
    expect(f.domain.find('unit:a')).toBeUndefined()
    expect(f.domain.land(['unit:a'], target, 'returned')).toBe(false)
  })
})
