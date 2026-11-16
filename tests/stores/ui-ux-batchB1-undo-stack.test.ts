import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useContainersStore } from '@/stores'
import { fresh } from '../flows/flow-harness'

/**
 * B1（用户 2026-11-17）：初设落位的撤回必须是一个**真正的栈**
 *
 *   · 飞机进盒 / 西移编队落位与地面落位一样可撤；
 *   · 撤回只回滚最近一次落位，撤完按钮指向真正的上一步（没有就收起）；
 *   · 不允许借「撤回上一步」回滚更早的落位。
 */

beforeEach(() => {
  setActivePinia(createPinia())
})

function setupStarted() {
  const ctx = fresh()
  expect(ctx.setup.enterSetup('1')).toBe(true)
  return ctx
}

type Pending = ReturnType<typeof setupStarted>['setup']['pendingPlacement'][number]

function placeableGround(ctx: ReturnType<typeof setupStarted>, skip = new Set<number>()): Pending {
  const found = ctx.setup.pendingPlacement.find(
    (item) =>
      item.kind === 'self' &&
      !item.raw.includes('SP') &&
      item.candidates.length > 0 &&
      !skip.has(item.entryIndex),
  )
  expect(found, '应至少有一条可落位的地面项').toBeDefined()
  return found!
}

function placeGround(ctx: ReturnType<typeof setupStarted>, item: Pending): void {
  expect(ctx.setup.beginSelfPlacement(item.entryIndex)).toBe(true)
  expect(ctx.setup.placeAtHex(item.candidates[0]!)).toBe(true)
  ctx.setup.cancelPlacement()
}

describe('B1：初设撤回栈', () => {
  it('连续两次落位：撤回只退最近一次，按钮指向上一步，再退回并收起', () => {
    const ctx = setupStarted()
    const units0 = ctx.w.units.length
    const a = placeableGround(ctx)
    placeGround(ctx, a)
    const unitsA = ctx.w.units.length
    expect(unitsA).toBe(units0 + 1)
    const labelA = ctx.setup.lastPlacement?.label
    expect(labelA).toBeTruthy()

    const b = placeableGround(ctx, new Set([a.entryIndex]))
    placeGround(ctx, b)
    const labelB = ctx.setup.lastPlacement?.label
    expect(labelB).not.toBe(labelA)
    expect(ctx.w.units.length).toBe(unitsA + 1)

    expect(ctx.setup.undoLastPlacementNow()).toBe(true)
    expect(ctx.w.units.length).toBe(unitsA)
    expect(ctx.setup.lastPlacement?.label).toBe(labelA)

    expect(ctx.setup.undoLastPlacementNow()).toBe(true)
    expect(ctx.w.units.length).toBe(units0)
    expect(ctx.setup.lastPlacement).toBeNull()
    expect(ctx.setup.undoLastPlacementNow()).toBe(false)
  })

  it('飞机进盒可撤：撤回后飞机回图上、按钮回到上一条地面落位', () => {
    const ctx = setupStarted()
    const ground = placeableGround(ctx)
    placeGround(ctx, ground)
    const groundLabel = ctx.setup.lastPlacement?.label

    const air = ctx.setup.pendingPlacement.find(
      (item) => item.kind === 'air' && ctx.setup.canPlaceAirInOffMapBox(item.side, item.entryIndex),
    )
    expect(air, '当前游标方应有可进盒的飞机项').toBeDefined()
    const boxBefore = ctx.w.airBoxMembers.length
    expect(ctx.setup.placeAirInOffMapBoxNow(air!.side, air!.entryIndex)).toBe(true)
    expect(ctx.w.airBoxMembers.length).toBe(boxBefore + 1)
    // 按钮必须改指飞机这一手，而不是还挂着更早的地面落位
    expect(ctx.setup.lastPlacement?.label).toContain(air!.label)

    expect(ctx.setup.undoLastPlacementNow()).toBe(true)
    expect(ctx.w.airBoxMembers.length).toBe(boxBefore)
    expect(ctx.setup.lastPlacement?.label).toBe(groundLabel)
  })

  it('图上飞机移入盒可撤：撤回后回到图上', () => {
    const ctx = setupStarted()
    const air = ctx.setup.pendingPlacement.find(
      (item) => item.kind === 'air' && ctx.setup.canPlaceAirInOffMapBox(item.side, item.entryIndex),
    )
    expect(air).toBeDefined()
    expect(ctx.setup.beginAirPlacement(air!.side, air!.entryIndex)).toBe(true)
    expect(ctx.setup.placeAtHex(air!.candidates[0]!)).toBe(true)
    ctx.setup.cancelPlacement()
    const plane = ctx.w.airUnits.find(
      (unit) => unit.side === air!.side && unit.aircraftId === air!.raw,
    )
    expect(plane).toBeDefined()
    expect(ctx.w.airBoxMembers).not.toContain(plane!.instanceId)

    expect(ctx.setup.moveSetupAirToBoxNow(plane!.instanceId)).toBe(true)
    expect(ctx.w.airBoxMembers).toContain(plane!.instanceId)
    expect(ctx.setup.lastPlacement?.label).toContain('地图外盒')
    const airOnMap = ctx.w.airUnits.length

    expect(ctx.setup.undoLastPlacementNow()).toBe(true)
    expect(ctx.w.airBoxMembers).not.toContain(plane!.instanceId)
    // 只撤"进盒"这一手：飞机仍留在图上
    expect(ctx.w.airUnits.length).toBe(airOnMap)
  })

  it('西移编队落位可撤：撤回还原图上位置与西移台账', () => {
    const ctx = setupStarted()
    const containers = useContainersStore()
    const beforeHexText = { ...containers.drawShiftHexText }
    const beforeOutcomes = containers.formationDrawOutcomes
    const beforeUnits = ctx.w.units.map(
      (unit) => `${unit.instanceId}@${unit.hex.col}.${unit.hex.row}`,
    )
    expect(ctx.w.units.length).toBeGreaterThan(0)
    const target = ctx.w.units[0]!

    const spy = vi.spyOn(containers, 'applyShiftWestAtNow').mockImplementation(() => {
      // 模拟真实落盘会写的那两本账
      containers.drawShiftHexText = { ...containers.drawShiftHexText, X: '9.1' }
      containers.formationDrawOutcomes = [
        ...containers.formationDrawOutcomes,
        {
          groupKind: 'shiftWest',
          groupLabel: 'A 组',
          formationIds: ['X'],
          detail: '',
          destinations: [],
        },
      ]
      return true
    })
    ctx.setup.placing = {
      kind: 'shift',
      formationId: 'X',
      label: 'X（ch10 西移 3 格）',
      raw: 'X',
      count: 1,
      total: 1,
      placed: 0,
      remaining: 1,
      chunk: 1,
      candidates: [],
      category: 'ground',
      imageUrl: null,
      blockedReason: null,
    } as never
    expect(ctx.setup.placeAtHex(target.hex)).toBe(true)
    expect(ctx.setup.lastPlacement?.label).toContain('ch10 西移')
    expect(containers.drawShiftHexText.X).toBe('9.1')
    expect(ctx.setup.completed['shift:X']).toBe(true)

    expect(ctx.setup.undoLastPlacementNow()).toBe(true)
    expect(containers.drawShiftHexText).toEqual(beforeHexText)
    expect(containers.formationDrawOutcomes).toEqual(beforeOutcomes)
    expect(ctx.setup.completed['shift:X']).toBeUndefined()
    expect(ctx.w.units.map((unit) => `${unit.instanceId}@${unit.hex.col}.${unit.hex.row}`)).toEqual(
      beforeUnits,
    )
    spy.mockRestore()
  })
})
