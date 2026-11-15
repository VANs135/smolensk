import { describe, expect, it } from 'vitest'

import { aircraft, formations, scenarios, scenarioSetup, unitsAxis, unitsSoviet } from '@/data'

/**
 * Intro: Vitebsk 的初设数据锁
 *
 * 只钉「条数 + unitId 链接」这两件会因改库/改脚本而漂移的事；剧本字段与玩法断言在
 * `tests/data/scenarios.test.ts`，初设原文对照在界面侧（`SetupPanel`）展示。
 */
const intro = scenarioSetup.entries.filter((entry) => entry.scenarioId === 'Intro')

describe('Intro: Vitebsk 初设数据', () => {
  it('29 条；轴 13 / 苏 16；按类别计数冻结', () => {
    expect(intro).toHaveLength(29)
    const bySide = intro.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.side] = (acc[entry.side] ?? 0) + 1
      return acc
    }, {})
    expect(bySide).toEqual({ soviet: 16, axis: 13 })

    const byKind = intro.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.kind] = (acc[entry.kind] ?? 0) + 1
      return acc
    }, {})
    expect(byKind).toEqual({
      unit: 13,
      formation: 4,
      hq: 2,
      aircraft: 4,
      sp: 3,
      transport_point: 2,
      airbase: 1,
    })
  })

  it('7 架飞机全部按图外空军盒（air_box）初设', () => {
    const air = intro.filter((entry) => entry.kind === 'aircraft')
    expect(air).toHaveLength(4)
    expect(air.reduce((sum, entry) => sum + entry.count, 0)).toBe(7)
    for (const entry of air) {
      expect(entry.locationKind).toBe('air_box')
      expect(entry.unitIdKind).toBe('aircraft')
    }
  })

  it('每条非 none 的 unitId 都能在对应库解析（地面 / 飞机 / 编队）', () => {
    const ground = new Set([...unitsAxis.units, ...unitsSoviet.units].map((unit) => unit.id))
    const air = new Set(aircraft.aircraft.map((item) => item.aircraftId))
    const forms = new Set(formations.formations.map((item) => item.formationId))

    for (const entry of intro) {
      if (entry.unitIdKind === 'none') continue
      expect(entry.unitId, `条目「${entry.raw}」缺 unitId`).toBeTruthy()
      const id = entry.unitId as string
      if (entry.unitIdKind === 'unit') {
        expect(ground.has(id), `地面算子 ${id} 不在单位库（${entry.raw}）`).toBe(true)
      } else if (entry.unitIdKind === 'aircraft') {
        expect(air.has(id), `飞机 ${id} 不在空军库（${entry.raw}）`).toBe(true)
      } else if (entry.unitIdKind === 'formation') {
        expect(forms.has(id), `编队 ${id} 不在编队库（${entry.raw}）`).toBe(true)
      } else {
        throw new Error(`未知 unitIdKind：${String(entry.unitIdKind)}（${entry.raw}）`)
      }
    }
  })

  it('四个编队各带 1 辆编内卡车：共 4 辆，载重 1，剧本口径为全部满载', () => {
    const formations = intro.filter((entry) => entry.kind === 'formation')
    const trucks = formations.flatMap(
      (entry) => entry.subordinates?.filter((item) => item.isOrganicTruck === true) ?? [],
    )
    expect(trucks).toHaveLength(4)

    // 载重字段取算子库（13.2h：满载面记作「运力 F」，不另定数字）
    for (const truck of trucks) {
      const unit = unitsAxis.units.find((item) => item.id === truck.unitId)
      expect(unit?.noncombatDetails?.transport, `${truck.name} 缺运力`).toBe(1)
    }

    const introScenario = scenarios.scenarios.find((item) => item.id === 'Intro')
    expect(introScenario?.setup.organicTrucks.mode).toBe('all_loaded')
  })

  it('计数类条目（SP / 运输点 / 空军基地）不指向具体算子', () => {
    const counters = intro.filter((entry) =>
      ['sp', 'transport_point', 'airbase'].includes(entry.kind),
    )
    expect(counters).toHaveLength(6)
    for (const entry of counters) expect(entry.unitIdKind).toBe('none')
  })
})
