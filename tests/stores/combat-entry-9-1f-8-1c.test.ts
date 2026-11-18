import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

/**
 * 9.1f / 8.1c：进入限制同时作用于「高亮哪些目标」与「结算是否允许」
 *
 * 9.1f：一个单位永远不能攻击移动规则（尤其 6.1d、6.2c）禁止它进入的格。
 * 8.1c：某格只能沿路进入时，只允许常规战斗，不允许突袭。
 * 沼泽：轮式/履带不能直接进入，但可以沿路进入与沿路进攻。
 *
 * 本文件用真实地图上的沼泽格：
 *   · (1,2) 沼泽，与 (2,2) 之间**无路**；
 *   · (2,3) 沼泽，与 (2,2) 之间有二级道路。
 */

const OPEN_HEX: HexRef = { col: 2, row: 2 }
const SWAMP_NO_ROAD: HexRef = { col: 1, row: 2 }
const SWAMP_WITH_ROAD: HexRef = { col: 2, row: 3 }

type Store = ReturnType<typeof useWorkbenchStore>
type UnitRecord = ReturnType<typeof unitChoices>[number]

function newStore(): Store {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

function pick(side: 'axis' | 'soviet', predicate: (record: UnitRecord) => boolean): UnitRecord {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

const wheeled = (): UnitRecord =>
  pick(
    'axis',
    (record) =>
      record.mobilityByFace?.move === 'truck' &&
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.noncombatKind ?? null) === null,
  )

const defender = (): UnitRecord =>
  pick('soviet', (record) => record.isCombat === true && record.attackCapable === true)

function place(
  store: Store,
  record: UnitRecord,
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
  face: 'combat' | 'move' = 'combat',
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side, face })
  store.units.push(unit)
  return unit
}

function setupCombatSegment(store: Store): void {
  store.setPhase('combat')
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'combat.combat')
  if (index < 0) throw new Error('战斗段没有战斗环节')
  expect(store.setSegmentStepIndex(index)).toBe(true)
  store.setTool('battle')
  store.setFuelPool(0, 20)
}

describe('9.1f：移动禁止进入的格不得攻击', () => {
  let store: Store

  beforeEach(() => {
    store = newStore()
    setupCombatSegment(store)
  })

  it('沼泽无路：轮式不能直接进入 ⇒ 不高亮、也不能开战', () => {
    place(store, wheeled(), OPEN_HEX, 'axis', 'a1', 'move')
    place(store, defender(), SWAMP_NO_ROAD, 'soviet', 'd1')

    expect(store.combatAttackableHexes).not.toContainEqual(SWAMP_NO_ROAD)
    expect(store.selectCombatDefenderHex(SWAMP_NO_ROAD)).toBe(true)
    expect(store.beginCombatNow()).toBe(false)
    expect(store.combatState).toBeNull()
  })

  it('6.1d 互逆性：从沼泽沿无路边出发也进不去 ⇒ 不高亮、也不能开战', () => {
    // 轮式单位站在沼泽里（合成场景），目标是无路的开阔格：正向可进，反向禁入 ⇒ 6.1d 拦住
    place(store, wheeled(), SWAMP_NO_ROAD, 'axis', 'a1', 'move')
    place(store, defender(), OPEN_HEX, 'soviet', 'd1')

    expect(store.combatAttackableHexes).not.toContainEqual(OPEN_HEX)
    expect(store.selectCombatDefenderHex(OPEN_HEX)).toBe(true)
    expect(store.beginCombatNow()).toBe(false)
    expect(store.combatState).toBeNull()
  })
})

describe('8.1c：只能沿路进入 ⇒ 只许常规战斗（沼泽沿路可进攻）', () => {
  let store: Store

  beforeEach(() => {
    store = newStore()
    setupCombatSegment(store)
  })

  it('沼泽有路：轮式可沿路进攻 ⇒ 高亮并进入 9.2 结算', () => {
    place(store, wheeled(), OPEN_HEX, 'axis', 'a1', 'move')
    place(store, defender(), SWAMP_WITH_ROAD, 'soviet', 'd1')

    expect(store.combatAttackableHexes).toContainEqual(SWAMP_WITH_ROAD)
    expect(store.selectCombatDefenderHex(SWAMP_WITH_ROAD)).toBe(true)
    expect(store.beginCombatNow()).toBe(true)
    expect(store.combatState?.step).toBe('combatSupply')
  })
})
