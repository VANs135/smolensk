import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { isExtenderUnit, toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

import { CORE_HEX } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 9.14d 延补队崩溃：**移动阶段的主动入口** + 落格后**真的翻面**
 *
 * 条文：「当一个可攻击单位进入包含延补队的格时，该延补队**必须**进行崩溃。**在延补队的常规移动时，
 *   玩家也可以选择使用与崩溃相同的流程，替代常规移动**（这在延补队没有追溯补给时很有用）。
 *   将已崩溃的延补队位移到该延补队**特殊拖取距离内**的任意格中，前提是**该格此时拥有追溯补给**。
 *   敌方单位、ZOC 和禁入地形对位移均无影响，且不会产生损失或被夺取。**在新的格内，要将延补队
 *   翻面到其常规运输点数的一面。**」「重要提示：如果不存在"合法"格，则**无法进行崩溃**。此时应在
 *   原格内不动，将延补队翻面，让它根据 9.14c 的规则进行夺取的判定。」
 *
 * ★ 修前：`extenderDisplacementCandidates` 零消费 ⇒ 被动路径虽有（经 `resolveSpecialCombat`），
 *   但**主动崩溃完全没有入口**；且崩溃确认步只写日志、把"翻面"留给裁判手工标注。
 * ★ 另修一处口径：9.14 的对象视图里延补队距离原写 `unit.raw.ma`（当前面）——延补队实测
 *   `combat.ma=20 / move.ma=0`，以移动面摆放时位移半径会被算成 **0**；已统一为 `faces.combat.ma`（12.7b）。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 摆一枚延补队（真实记录；12.7b：距离＝战斗面印值 MA） */
function placeExtender(store: Workbench, kind: 'truck' | 'wagon' = 'truck', id = 'ext1') {
  const record = unitChoices('axis').find(
    (item) =>
      item.noncombatKind === 'supply_extender' &&
      (item.noncombatDetails?.transportKind ?? 'truck') === kind,
  )
  if (record === undefined) throw new Error(`单位库没有 ${kind} 延补队`)
  const unit = toConsoleUnit({
    record,
    instanceId: id,
    hex: CORE_HEX,
    side: 'axis',
    face: 'combat',
  })
  store.units.push(unit)
  return store.units.find((item) => item.instanceId === id)!
}

/** 12.6a①：声明若干补给源格（让追溯补给覆盖到这些格）——这样才有"合法落点" */
function declareSources(store: Workbench, hexes: readonly HexRef[]): void {
  store.setSupplyActive(true)
  for (const hex of hexes) {
    store.supplySourceDraft = { hexText: `${hex.col}.${hex.row}`, kind: 'supplySourceHex' }
    store.addSupplySource()
  }
}

describe('9.14d：移动阶段的主动崩溃（替代常规移动）', () => {
  it('有合法落点时：挂出待选落点，落点集合＝拖取距离内且该格有追溯补给', () => {
    const store = newStore()
    store.setPhase('movement')
    const extender = placeExtender(store)
    // 把追溯补给的源声明在若干格上，使其中一部分落在 20 MP 距离内
    const ring: HexRef[] = [
      { col: CORE_HEX.col + 1, row: CORE_HEX.row },
      { col: CORE_HEX.col, row: CORE_HEX.row + 1 },
      { col: CORE_HEX.col + 1, row: CORE_HEX.row + 1 },
    ]
    declareSources(store, ring)
    store.evaluateTraceSupplyNow()

    expect(store.collapseExtenderNow(extender.instanceId)).toBe(true)
    const item = store.specialPending?.items[0]
    expect(item?.kind).toBe('extender')
    expect(item!.candidates.length).toBeGreaterThan(0)
    // 候选必须在**特殊拖取距离**内（12.7b：战斗面印值 MA = 20）
    for (const candidate of item!.candidates) {
      const distance = Math.max(
        Math.abs(candidate.col - extender.hex.col),
        Math.abs(candidate.row - extender.hex.row),
      )
      expect(distance).toBeLessThanOrEqual(extender.faces.combat.ma)
    }
  })

  it('非移动环节不得主动崩溃（9.14d：发生在「延补队的常规移动时」）', () => {
    const store = newStore()
    store.setPhase('supply')
    const extender = placeExtender(store)
    expect(store.collapseExtenderNow(extender.instanceId)).toBe(false)
    expect(store.specialPending).toBeNull()
  })

  it('选一个非法落点 ⇒ 被拒（不在候选集内）', () => {
    const store = newStore()
    store.setPhase('movement')
    const extender = placeExtender(store)
    declareSources(store, [{ col: CORE_HEX.col + 1, row: CORE_HEX.row }])
    store.evaluateTraceSupplyNow()
    store.collapseExtenderNow(extender.instanceId)
    // 找一个距起点**远超** 20 MP 拖取距离的图内格（CORE_HEX 靠近地图西缘，故取东侧）
    const far: HexRef = { col: CORE_HEX.col + 30, row: Math.min(CORE_HEX.row + 20, 35) }
    expect(store.setSpecialDisplacement(extender.instanceId, far)).toBe(false)
  })

  it('确认崩溃 ⇒ 位移到落点并**翻面到运输点数面**（库里换成 5 点算子）', () => {
    const store = newStore()
    store.setPhase('movement')
    const extender = placeExtender(store)
    const target: HexRef = { col: CORE_HEX.col + 1, row: CORE_HEX.row }
    declareSources(store, [target])
    store.evaluateTraceSupplyNow()
    expect(store.collapseExtenderNow(extender.instanceId)).toBe(true)
    expect(store.setSpecialDisplacement(extender.instanceId, target)).toBe(true)
    expect(store.confirmSpecialCombatNow()).toBe(true)

    // 12.7a/9.14d：崩溃后成为**运输点数**（5 点），且已不在延补队之列
    expect(store.units.filter(isExtenderUnit)).toHaveLength(0)
    const flipped = store.transportPointsOfSide
    expect(flipped).toHaveLength(1)
    expect(flipped[0]!.noncombatTransport).toBe(5)
    expect(flipped[0]!.hex).toEqual(target)
  })

  it('无合法落点 ⇒ 无法崩溃：原地不动 + 翻面 + 挂出 9.14c 的夺取判定义务', () => {
    const store = newStore()
    store.setPhase('movement')
    const extender = placeExtender(store)
    // 不声明任何补给源 ⇒ 全图无追溯补给 ⇒ 没有合法落点
    expect(store.collapseExtenderNow(extender.instanceId)).toBe(true)
    expect(store.specialPending).toBeNull()
    // 9.14d 重要提示：原地不动、翻面、并按 9.14c 判夺取
    expect(store.units.filter(isExtenderUnit)).toHaveLength(0)
    const flipped = store.transportPointsOfSide
    expect(flipped).toHaveLength(1)
    expect(flipped[0]!.hex).toEqual(CORE_HEX)
    expect(store.log.some((entry) => entry.rule === '9.14d' && entry.text.includes('9.14c'))).toBe(
      true,
    )
  })
})
