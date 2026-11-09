import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  actionGateOf,
  useSetupStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 13.2g：编内卡车不是独立算子
 *
 * 它随同编队单位移动：不进可开拔集、没有独立「开始移动」、结束移动时不记 13.2a「暂停」，
 * 也就不会把其它单位挡在移动段外。
 */

const HEX: HexRef = { col: 36, row: 13 }
const OTHER: HexRef = { col: 37, row: 13 }

function newStore() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('axis')
  return workbench
}

function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  expect(store.setSegmentStepIndex(index)).toBe(true)
}

/** 一支带编内卡车的装甲编队（卡车与战斗单位同 `formation`） */
function pzWithTruck() {
  const truck = groundRecord(
    'axis',
    (record) => record.noncombatKind === 'organic_truck' && typeof record.formation === 'string',
  )
  const formation = truck.formation
  const combat = groundRecord(
    'axis',
    (record) =>
      record.isCombat === true &&
      (record.noncombatKind ?? null) === null &&
      record.formation === formation &&
      record.attackCapable === true &&
      record.classes?.movementClass === 'tracked',
  )
  return { truck, combat }
}

const legUnit = () =>
  groundRecord(
    'axis',
    (record) =>
      record.isCombat === true &&
      (record.noncombatKind ?? null) === null &&
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true,
  )

describe('13.2g 编内卡车不是独立算子', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
    store.setPhase('movement')
    goToActionStep(store, 'move.order')
  })

  it('★ 不进可开拔集；只有卡车时没有「开始移动」', () => {
    const { truck } = pzWithTruck()
    placeGround(store, truck, HEX, 'axis', 'truck')

    store.beginMovePick(HEX, ['truck'])
    expect(store.movePick).toBeNull()
    expect(store.movePickChoices.map((unit) => unit.instanceId)).toEqual([])
    expect(store.beginMoveFor(['truck'])).toBe(false)
    expect(store.moveInteraction).toBeNull()
  })

  it('★ 同格有编队战斗单位时，卡车也不进取子清单，只按编队单位开拔', () => {
    const { truck, combat } = pzWithTruck()
    placeGround(store, combat, HEX, 'axis', 'pz')
    placeGround(store, truck, HEX, 'axis', 'truck')

    store.beginMovePick(HEX, ['pz', 'truck'])
    expect(store.movePick!.ids).toEqual(['pz'])
  })

  it('★ 编队移动带编内卡车；结束移动后不记 13.2a 暂停，其它单位可立即开拔', () => {
    const { truck, combat } = pzWithTruck()
    const c = placeGround(store, combat, HEX, 'axis', 'pz')
    c.fuelled = true
    const t = placeGround(store, truck, HEX, 'axis', 'truck')
    placeGround(store, legUnit(), OTHER, 'axis', 'other')

    store.beginMovePick(HEX, ['pz'])
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction!.unitIds).toContain('pz')
    expect(store.moveInteraction!.unitIds).toContain('truck') // 13.2g 随同编队

    store.finishMove()
    expect(store.log.some((entry) => entry.rule === '13.2a' && entry.text.includes(t.name))).toBe(
      false,
    )
    expect(t.movementEnded).toBe(true) // 随同移动已结束，不是「暂停」

    store.beginMovePick(OTHER, ['other'])
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction!.unitIds).toEqual(['other'])
  })

  it('★ 连做两次：第一堆结束移动后，第二堆不必先处理编内卡车', () => {
    const { truck, combat } = pzWithTruck()
    const c1 = placeGround(store, combat, HEX, 'axis', 'pz')
    c1.fuelled = true
    placeGround(store, truck, HEX, 'axis', 'truck')
    const { truck: truck2, combat: combat2 } = pzWithTruck()
    const c2 = placeGround(store, combat2, OTHER, 'axis', 'pz2')
    c2.fuelled = true
    placeGround(store, truck2, OTHER, 'axis', 'truck2')

    store.beginMovePick(HEX, ['pz'])
    expect(store.confirmMovePick()).toBe(true)
    store.finishMove()

    store.beginMovePick(OTHER, ['pz2'])
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction!.unitIds).toContain('pz2')
    expect(store.moveInteraction!.unitIds).toContain('truck2')
  })
})
