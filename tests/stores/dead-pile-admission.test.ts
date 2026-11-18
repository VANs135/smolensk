import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import {
  deadPileDispositionOf,
  toConsoleUnit,
  unitChoices,
  useContainersStore,
  useWorkbenchStore,
} from '@/stores'
import { REGION_OF_BOX, allBoxViews, type BoxUnitView } from '@/engine/rules/containers'

/**
 * 死亡堆/特殊补员池的**收纳判据**（用户 2026-11-18）
 *
 * 原文：
 * - 13.5：被摧毁的单位进死亡堆；13.5a：只有死亡堆里的单位可重建；
 * - 13.5b：拆分单位被毁**返回资源池**，不重建；
 * - 13.5c：`rebuildable = false`（AR 后有黄点）⇒ 永久移除；
 * - 13.5e：运输点/编内卡车可重建（1 Eq）；
 * - 重建表（charts-supply-repl.json）：airbase / supply / extender / hedgehog / port
 *   没有对应行 ⇒ 不是可重建单位，不能进死亡堆，也不能进 1.6c 特殊补员池。
 */

const ground = (
  overrides: Partial<{
    replKind: 'pax' | 'eq' | null
    rebuildable: boolean
    noncombatKind: string | null
    specialized: string[]
  }> = {},
): Parameters<typeof deadPileDispositionOf>[0] => ({
  replKind: null,
  rebuildable: true,
  noncombatKind: null,
  specialized: [],
  ...overrides,
})

describe('13.5：死亡堆收纳判据', () => {
  it('★ 空军基地 / SP / 工事 / 延补队 / 港口 ⇒ 直接移除，不进死亡堆', () => {
    for (const kind of ['air_base', 'sp', 'hedgehog', 'supply_extender', 'port']) {
      expect(deadPileDispositionOf(ground({ noncombatKind: kind })), kind).toBe('remove')
    }
  })

  it('★ 拆分单位被毁 ⇒ 返回拆分资源池（13.5b），不进死亡堆', () => {
    expect(deadPileDispositionOf(ground({ specialized: ['breakdown'] }))).toBe('pool')
  })

  it('★ 补员 / 13.5c 黄点 ⇒ 永久移除', () => {
    expect(deadPileDispositionOf(ground({ replKind: 'pax' }))).toBe('remove')
    expect(deadPileDispositionOf(ground({ replKind: 'eq' }))).toBe('remove')
    expect(deadPileDispositionOf(ground({ rebuildable: false }))).toBe('remove')
  })

  it('★ 该进池的仍进：HQ / 运输点 / 编内卡车 / 普通战斗单位', () => {
    expect(deadPileDispositionOf(ground())).toBe('deadPile')
    expect(deadPileDispositionOf(ground({ noncombatKind: 'transport_point' }))).toBe('deadPile')
    expect(deadPileDispositionOf(ground({ noncombatKind: 'organic_truck' }))).toBe('deadPile')
    // HQ 在重建表里（1 Eq + 1 Pax），属于可重建单位
    expect(deadPileDispositionOf(ground({ specialized: ['hq'] }))).toBe('deadPile')
  })
})

describe('重建候选/死亡堆展示：旧存档里的错项不再出现', () => {
  it('★ 空军基地 / SP / 工事 / 拆分单位被滤掉；战斗单位保留', () => {
    setActivePinia(createPinia())
    const workbench = useWorkbenchStore()
    workbench.setActiveSide('axis')
    const side = workbench.activeSide
    const containers = useContainersStore()

    const pick = (predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean) => {
      const record = unitChoices(side).find(predicate)
      if (record === undefined) throw new Error('单位库里缺少测试记录')
      return record
    }
    const make = (record: ReturnType<typeof pick>, id: string) =>
      toConsoleUnit({ record, instanceId: id, hex: { col: 30, row: 12 }, side })

    const combat = make(
      unitChoices(side).find(
        (record) => record.isCombat === true && record.branch !== 'breakdown',
      )!,
      'combat-1',
    )
    const airBase = make(
      pick((record) => record.noncombatKind === 'air_base'),
      'base-1',
    )
    const supply = make(
      pick((record) => record.noncombatKind === 'sp'),
      'sp-1',
    )
    const hedgehog = make(
      pick((record) => record.noncombatKind === 'hedgehog'),
      'hedge-1',
    )
    const breakdown = make(
      pick((record) => record.branch === 'breakdown'),
      'breakdown-1',
    )
    workbench.deadPile.push(combat, airBase, supply, hedgehog, breakdown)

    const ids = workbench.rebuildCandidates.map((unit) => unit.instanceId)
    expect(ids).toContain('combat-1')
    expect(ids).not.toContain('base-1')
    expect(ids).not.toContain('sp-1')
    expect(ids).not.toContain('hedge-1')
    expect(ids).not.toContain('breakdown-1')

    const shown = containers.deadPileUnits[side].map((unit) => unit.id)
    expect(shown).toContain('combat-1')
    expect(shown).not.toContain('base-1')
    expect(shown).not.toContain('breakdown-1')
  })

  it('★ 手工「移入死亡堆」同判据：空军基地直接移除、拆分单位回资源池', () => {
    setActivePinia(createPinia())
    const workbench = useWorkbenchStore()
    workbench.setActiveSide('axis')
    const side = workbench.activeSide

    const airBase = toConsoleUnit({
      record: unitChoices(side).find((record) => record.noncombatKind === 'air_base')!,
      instanceId: 'base-manual',
      hex: { col: 30, row: 12 },
      side,
    })
    const breakdown = toConsoleUnit({
      record: unitChoices(side).find((record) => record.branch === 'breakdown')!,
      instanceId: 'breakdown-manual',
      hex: { col: 30, row: 12 },
      side,
    })
    workbench.units.push(airBase, breakdown)
    const poolBefore = workbench.breakdownPool[side === 'axis' ? 'ax' : 'su'] ?? 0

    workbench.sendToDeadPileNow('base-manual')
    workbench.sendToDeadPileNow('breakdown-manual')

    expect(workbench.deadPile.some((unit) => unit.instanceId === 'base-manual')).toBe(false)
    expect(workbench.deadPile.some((unit) => unit.instanceId === 'breakdown-manual')).toBe(false)
    expect(workbench.breakdownPool[side === 'axis' ? 'ax' : 'su']).toBe(poolBefore + 1)
  })
})

describe('专规 2.3a：警戒单位存放栏不再与免费重建师池混装', () => {
  const unit = (id: string, name: string): BoxUnitView => ({
    id,
    name,
    side: 'soviet',
    branch: 'infantry',
    attack: 3,
    ar: 1,
    ma: 1,
  })

  it('★ alarm_pool 映射到特补盒第二栏（second）', () => {
    expect(REGION_OF_BOX.alarm_pool).toEqual({
      boxKind: 'specialReplBox',
      sectionId: 'second',
      rule: '专规 2.3a',
    })
  })

  it('★ 死亡堆里的 Alarm 单位进第二栏；免费重建师只留在第一栏', () => {
    const alarm = unit('alarm-1', '3-1-1 民兵团')
    const division: BoxUnitView = {
      ...unit('div-1', '12-2-2 步兵师'),
      attack: 12,
      ar: 2,
      ma: 2,
    }
    const boxes = allBoxViews({
      scenarioId: 'scenario-1',
      deadPile: { axis: [], soviet: [alarm, division] },
      alarmUnits: { axis: [], soviet: [alarm] },
      breakdownUnits: { axis: [], soviet: [] },
      breakdownOnMap: { axis: [], soviet: [] },
      aircraftInBox: { axis: [], soviet: [] },
      edgeBoxUnits: { northeast: [], southeast: [] },
      formationBoxes: [],
      date: '1941-07-01',
    })
    const special = boxes.find((box) => box.kind === 'specialReplBox' && box.side === 'soviet')!
    const main = special.holdings.filter((holding) => holding.sectionId === 'main')
    const second = special.holdings.filter((holding) => holding.sectionId === 'second')
    expect(main.map((holding) => holding.unitId)).toContain(division.id)
    expect(main.map((holding) => holding.unitId)).not.toContain(alarm.id)
    expect(second.map((holding) => holding.unitId)).toEqual([alarm.id])
  })
})
