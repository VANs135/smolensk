import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  actionGateOf,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 13.2g：编内卡车＝**特殊的运输点数**（独立算子）
 *
 * 原文：「多单位编队有时拥有特殊的附属运输点数。编内卡车**与其他运输点数基本一样**，但有几点例外：
 * A) 永远无法在地图上卸载它们的 SP；B) 只允许同一多单位编队内的单位拖取它们的 SP；
 * C) 永远不能合并为延补队；D) 可进入预备模式……；E) 可跟随堆叠中的其他撤退的战斗单位一起撤退
 * （但不可单独撤退）；F) 被夺取后会转换为常规运输点数；G) 可以保留 SP 而不支付战斗补给。」
 *
 * 所以：它就是运输点数 —— **可单独选中、可单独开拔**（载运/MA/装卸复用既有实现）；
 * 也可以和同编队单位一起选中、一起走。原文没有"不能独立移动"这一条，不设特判。
 * 保留的那条是**不阻断**：随行后不记 13.2a「暂停」、不出现在"没动完"清单、不挡其它单位。
 *
 * 用户 2026-11-10 更正：先前"编内卡车不是独立算子"的口径作废。
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

describe('13.2g 编内卡车＝特殊运输点数（独立可动）', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
    store.setPhase('movement')
    goToActionStep(store, 'move.order')
  })

  it('★ 单点选中编内卡车 ⇒ 可单独开拔（运输点数行为，13.2g「基本一样」）', () => {
    const { truck } = pzWithTruck()
    const t = placeGround(store, truck, HEX, 'axis', 'truck')
    t.fuelled = true

    store.beginMovePick(HEX, ['truck'])
    expect(store.movePick?.ids).toEqual(['truck'])
    expect(store.beginMoveFor(['truck'])).toBe(true)
    expect(store.moveInteraction?.unitIds).toEqual(['truck'])
  })

  it('★ 同格编队：卡车与战斗单位都在取子清单里（可选整堆，也可只选其一）', () => {
    const { truck, combat } = pzWithTruck()
    placeGround(store, combat, HEX, 'axis', 'pz')
    placeGround(store, truck, HEX, 'axis', 'truck')

    store.beginMovePick(HEX, ['pz', 'truck'])
    expect([...(store.movePick?.ids ?? [])].sort()).toEqual(['pz', 'truck'])
    expect([...store.movePickChoices.map((unit) => unit.instanceId)].sort()).toEqual([
      'pz',
      'truck',
    ])
  })

  it('★ 随编队一起走 ⇒ 不记 13.2a「暂停」，不出"卡车没动完"提示，下一枚可立即开拔', () => {
    const { truck, combat } = pzWithTruck()
    const c = placeGround(store, combat, HEX, 'axis', 'pz')
    c.fuelled = true
    const t = placeGround(store, truck, HEX, 'axis', 'truck')
    t.fuelled = true
    placeGround(store, legUnit(), OTHER, 'axis', 'other')

    store.beginMovePick(HEX, ['pz', 'truck'])
    expect(store.confirmMovePick()).toBe(true)
    expect([...(store.moveInteraction?.unitIds ?? [])].sort()).toEqual(['pz', 'truck'])

    store.finishMove()
    expect(store.log.some((entry) => entry.rule === '13.2a' && entry.text.includes(t.name))).toBe(
      false,
    )
    expect(t.movementEnded).toBe(true)

    store.beginMovePick(OTHER, ['other'])
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction?.unitIds).toEqual(['other'])
  })

  it('★ 只选编队战斗单位 ⇒ 卡车留在原地（独立算子，不被强拉随行）', () => {
    const { truck, combat } = pzWithTruck()
    const c = placeGround(store, combat, HEX, 'axis', 'pz')
    c.fuelled = true
    const t = placeGround(store, truck, HEX, 'axis', 'truck')
    t.fuelled = true

    store.beginMovePick(HEX, ['pz'])
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction?.unitIds).toEqual(['pz'])
    expect(t.movementEnded).toBe(false)
    expect(t.mpSpent).toBe(0)
  })

  it('★ 两条路径连做：先随编队走一堆、再单独走一辆，全程无阻断', () => {
    const { truck, combat } = pzWithTruck()
    const c1 = placeGround(store, combat, HEX, 'axis', 'pz')
    c1.fuelled = true
    const t1 = placeGround(store, truck, HEX, 'axis', 'truck')
    t1.fuelled = true
    const { truck: truck2, combat: combat2 } = pzWithTruck()
    const c2 = placeGround(store, combat2, OTHER, 'axis', 'pz2')
    c2.fuelled = true
    const t2 = placeGround(store, truck2, OTHER, 'axis', 'truck2')
    t2.fuelled = true

    // 第一堆：整堆一起走（含卡车）
    store.beginMovePick(HEX, ['pz', 'truck'])
    expect(store.confirmMovePick()).toBe(true)
    store.finishMove()

    // 第二堆：只开拔卡车（独立算子）
    store.beginMovePick(OTHER, ['truck2'])
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction?.unitIds).toEqual(['truck2'])
    store.finishMove()

    // 两条路径都没产生 13.2a 暂停提示
    expect(store.log.some((entry) => entry.rule === '13.2a')).toBe(false)
    expect(t1.movementEnded).toBe(true)
    expect(t2.movementEnded).toBe(true)
  })

  it('★ 堆叠窗与地图：卡车作为**可点选算子**出现，并标出与编队的随行关系', () => {
    const { truck, combat } = pzWithTruck()
    placeGround(store, combat, HEX, 'axis', 'pz')
    placeGround(store, truck, HEX, 'axis', 'truck')
    const mapView = useMapViewStore()

    // 地图：卡车是独立令牌（可单点命中，同其它算子）
    expect(mapView.overlay.tokens.map((token) => token.id)).toContain('truck')
    // 堆叠窗：列表里必须有这枚卡车（否则玩家不知道它跟着谁）
    mapView.openPopup(HEX, 10, 10)
    expect(mapView.popupContent?.units.map((unit) => unit.id)).toContain('truck')
    // 13.2g 随行关系：窗口按同 `formation` 标注「随 <编队>」（组件层由此取数）
    expect(store.units.find((unit) => unit.instanceId === 'truck')?.formation).toBe(
      store.units.find((unit) => unit.instanceId === 'pz')?.formation,
    )
  })
})
