import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { emptyReplHoldings } from '@/engine/rules'
import {
  actionGateOf,
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

import { CORE_HEX, sealTraceSupplyByZoc } from '../flows/sop-harness'

/**
 * 第五批 C3（docs/第五批修改方案.md 族 C5＋C7）：单机扫射（14.7d-B）＋ 飞机重建入口（13.5f / 专规 1.6）
 *
 * 原文：
 *   · 14.7d-B「低空扫射必须由**单独一个飞机**完成」；
 *   · 13.5f「**飞机在任一友方空军基地以激活状态从死亡堆抵达**」（无论飞行条件如何）；
 *   · 专规 1.6 Notes「Eq 不重建飞机；**Ftr 补员重建 F 型、Tac 补员重建 T / S / Tpt 型，且只重建
 *     一个军力、不可留存**」；placement「新造与重建飞机在**任一处于追溯补给的空军基地**以激活状态出现」。
 *
 * 病灶（2026-09-30 review）：① hip_shoot 只要求"≥1 架可扫射"、任务上限仍 4 ⇒ 多机扫射把轰炸值
 *   相加；② `rebuildUnitNow` 对死亡堆空军条目**显式拒绝**（"空军重建尚未接线"，引擎 `planRebuild`
 *   的飞机分支早已实现但 store 从未传 `isAircraft: true`）。
 *
 * ★ 测法边界（如实）：① 引擎的 1-step 口径（专规 1.6「只重建一个军力」）在本文件由 stepsAfter
 *   断言钉住（`tests/engine/rebuild.test.ts` 另有一条判据层用例）；② "处于追溯补给"用同格声明
 *   来源构造（12.6a①），无来源的对照用例在第三条；③ 14.7d-B 的引擎层判据在
 *   `tests/engine/air-interaction.test.ts` 另有用例。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

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
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

/**
 * 13.5f / 专规 1.6 placement：基地格（六邻皆图内，不受地图削角干扰）。
 * 「不在追溯补给 ⇒ 拒」由 `sealTraceSupplyByZoc` 现场卡断，见 `setupRebuild`。
 */

function airBaseRecord() {
  const found = unitChoices('axis').find((record) => record.noncombatKind === 'air_base')
  if (found === undefined) throw new Error('单位库中没有空军基地算子')
  return found
}

const recordOf = (side: 'axis' | 'soviet', aircraftId: string) => {
  const found = aircraftChoices(side).find((record) => record.aircraftId === aircraftId)
  if (found === undefined) throw new Error(`飞机库没有 ${aircraftId}`)
  return found
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 苏方重建现场：基地格 + 同格来源（专规 1.6 的"处于追溯补给的空军基地"） */
function setupRebuild(store: ReturnType<typeof newStore>, withSource: boolean): void {
  store.setActiveSide('soviet')
  store.setPhase('reinforcement')
  goToActionStep(store, 'rein.rebuild')
  if (!withSource) {
    /*
     * 13.5f 的"基地不在追溯补给 ⇒ 拒"必须由 **ZOC / 敌占**造成，不能被"离源超过 5 轮式 MP"顶替
     * （U23 落地后 2.1 本来就离苏方源太远 —— 那样这条用例就不再验 12.6 的阻断）。
     *
     * 做法：先在基地格声明一个苏方来源（不加卡断时距离 0 ⇒ 确实在补给），
     * 再用敌方 ZOC / 敌占封死第一圈：2.1 是地图角，2.0 / 1.1 没有第二圈可摆 ⇒ 敌占那两格；
     * 基地是**非战斗单位**（4.5b 不抵消 ZOC）⇒ 基地格本身落入敌方 ZOC，按 12.6b
     * "源格内有未抵消的敌方 ZOC ⇒ 不可从该源获得追溯补给"判为断补。
     */
    store.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'supplySourceHex' }
    expect(store.addSupplySource()).toBe(true)
    sealTraceSupplyByZoc(store, CORE_HEX, 'soviet', true)
  }
  store.units.push(
    toConsoleUnit({
      record: airBaseRecord(),
      instanceId: 'base-su',
      hex: CORE_HEX,
      side: 'soviet',
    }),
  )
  if (withSource) {
    store.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'supplySourceHex' }
    expect(store.addSupplySource()).toBe(true)
  }
}

/** 往死亡堆放一枚飞机（被打光 ⇒ steps 0） */
function placeInDeadPile(
  store: ReturnType<typeof newStore>,
  aircraftId: string,
  instanceId: string,
) {
  store.deadPile.push(
    toConsoleAirUnit({
      aircraft: recordOf('soviet', aircraftId),
      instanceId,
      hex: CORE_HEX,
      side: 'soviet',
      airStatus: 'inactive',
    }),
  )
  const onDead = store.deadPile.find((item) => item.instanceId === instanceId)
  if (onDead === undefined) throw new Error('死堆条目没进去')
  onDead.steps = 0
  return onDead
}

describe('第五批 C3：飞机重建入口（13.5f / 专规 1.6）', () => {
  it('专规 1.6：Tac 补员重建 IL.2（T 型）⇒ 以**激活**状态、**1 军力**抵达空军基地；死亡堆取回、Tac −1', () => {
    const store = newStore()
    setupRebuild(store, true)
    placeInDeadPile(store, 'su-aircraft-ru-il-2', 'air-il2')
    store.setReplHoldingsNow({ ...emptyReplHoldings(), tac: 1 }, CORE_HEX)

    expect(store.rebuildUnitNow({ unitId: 'air-il2', rebuildType: 'Aircraft' })).toBe(true)
    const onMap = store.airUnits.find((item) => item.instanceId === 'air-il2')
    expect(onMap).toBeDefined()
    expect(onMap!.airStatus).toBe('active') // 13.5f：以激活状态抵达
    expect(onMap!.steps).toBe(1) // 专规 1.6：只重建一个军力
    expect(onMap!.hex).toEqual(CORE_HEX)
    expect(store.deadPile.some((item) => item.instanceId === 'air-il2')).toBe(false)
    expect(store.replHoldings.tac).toBe(0)
    expect(store.lastRebuild?.rule).toBe('13.5f')
  })

  it('专规 1.6：Ftr 补员重建 F 型（LaGG-3）——两补员对照（Tac 不被动用）', () => {
    const store = newStore()
    setupRebuild(store, true)
    placeInDeadPile(store, 'su-aircraft-ru-lagg-3', 'air-lagg')
    store.setReplHoldingsNow({ ...emptyReplHoldings(), ftr: 1, tac: 3 }, CORE_HEX)

    expect(store.rebuildUnitNow({ unitId: 'air-lagg', rebuildType: 'Aircraft' })).toBe(true)
    const onMap = store.airUnits.find((item) => item.instanceId === 'air-lagg')
    expect(onMap).toBeDefined()
    expect(onMap!.airStatus).toBe('active')
    expect(onMap!.steps).toBe(1)
    expect(store.replHoldings.ftr).toBe(0)
    expect(store.replHoldings.tac).toBe(3) // 对照：Tac 未动
  })

  it('专规 1.6 placement：空军基地**不在追溯补给** ⇒ 拒（13.5f），且补员与死亡堆分文未动', () => {
    const store = newStore()
    setupRebuild(store, false) // 不声明任何来源
    placeInDeadPile(store, 'su-aircraft-ru-il-2', 'air-il2')
    store.setReplHoldingsNow({ ...emptyReplHoldings(), tac: 1 }, CORE_HEX)

    expect(store.rebuildUnitNow({ unitId: 'air-il2', rebuildType: 'Aircraft' })).toBe(false)
    expect(store.reinforcementError).toMatchObject({ rule: '13.5f' })
    expect(store.airUnits.some((item) => item.instanceId === 'air-il2')).toBe(false)
    expect(store.deadPile.some((item) => item.instanceId === 'air-il2')).toBe(true)
    expect(store.replHoldings.tac).toBe(1)
  })
})

describe('v7.1 §4.1：飞机重建的两个子项（地图基地 / 地图外盒）', () => {
  it('★ 子项按条件出现：可追溯基地 ⇒「放入地图空军基地」；盒恒可用 ⇒「放入地图外空军基地」', () => {
    const store = newStore()
    setupRebuild(store, true)
    placeInDeadPile(store, 'su-aircraft-ru-il-2', 'air-il2')
    store.setReplHoldingsNow({ ...emptyReplHoldings(), tac: 1 }, CORE_HEX)

    const keys = store.deadPileActionsOf('air-il2').map((item) => item.key)
    expect(keys).toContain('deadPile.rebuildAirBase')
    expect(keys).toContain('deadPile.rebuildAirBox')
  })

  it('★ 子项 1：点地图基地格 ⇒ 落在该基地、扣 Tac、不进盒', () => {
    const store = newStore()
    setupRebuild(store, true)
    placeInDeadPile(store, 'su-aircraft-ru-il-2', 'air-il2')
    store.setReplHoldingsNow({ ...emptyReplHoldings(), tac: 1 }, CORE_HEX)

    expect(store.beginAirRebuildBasePickNow('air-il2')).toBe(true)
    expect(store.hexPickView?.candidates).toContainEqual(CORE_HEX)
    expect(store.pickHexFor(CORE_HEX)).toBe(true)
    const onMap = store.airUnits.find((item) => item.instanceId === 'air-il2')
    expect(onMap?.hex).toEqual(CORE_HEX)
    expect(store.airBoxMembers).not.toContain('air-il2')
    expect(store.replHoldings.tac).toBe(0)
  })

  it('★ 子项 2：点即移入地图外盒（不弹二次确认），撤回回到死亡堆并退 Tac', () => {
    const store = newStore()
    setupRebuild(store, true)
    placeInDeadPile(store, 'su-aircraft-ru-il-2', 'air-il2')
    store.setReplHoldingsNow({ ...emptyReplHoldings(), tac: 1 }, CORE_HEX)

    expect(store.rebuildAircraftIntoBoxNow('air-il2')).toBe(true)
    expect(store.airBoxMembers).toContain('air-il2')
    expect(store.replHoldings.tac).toBe(0)

    // §1.1：本段内再点（或在死亡堆菜单外）撤回 ⇒ 回死亡堆、出盒、退 Tac
    expect(store.withdrawRebuildNow('air-il2')).toBe(true)
    expect(store.airBoxMembers).not.toContain('air-il2')
    expect(store.deadPile.some((item) => item.instanceId === 'air-il2')).toBe(true)
    expect(store.replHoldings.tac).toBe(1)
  })

  it('★ 第三段收束：补员点（Pax / Eq）留在盘面，不清空、不作废', () => {
    const store = newStore()
    setupRebuild(store, true)
    store.setReplHoldingsNow({ ...emptyReplHoldings(), pax: 3, eq: 2 }, CORE_HEX)

    expect(store.endRebuildSegmentNow()).toBe(true)
    expect(store.replHoldings.pax).toBe(3)
    expect(store.replHoldings.eq).toBe(2)
  })
})

describe('第五批 C3：14.7d-B 单机扫射（store 闸）', () => {
  it('两机扫射在**选择**这一步即被拦（14.7d-B）；候选阵列给出灰显原因', () => {
    const store = newStore()
    store.setAirActive(true)
    store.setAirMissionKind('hip_shoot')
    store.units.push(
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-ax',
        hex: CORE_HEX,
        side: 'axis',
      }),
    )
    for (const id of ['j1', 'j2'] as const) {
      store.airUnits.push(
        toConsoleAirUnit({
          aircraft: recordOf('axis', 'ax-aircraft-ge-ju-87b'),
          instanceId: id,
          hex: CORE_HEX,
          side: 'axis',
          airStatus: 'active',
        }),
      )
      const on = store.airUnits.find((item) => item.instanceId === id)
      if (on === undefined) throw new Error(`飞机 ${id} 不在盘面上`)
      on.canHipShoot = true
    }
    store.toggleAirMissionUnit('j1')
    expect(store.airMissionAirIds).toEqual(['j1'])
    // 第二架：14.7d-B 拦下（修前成功加入 ⇒ 红）
    store.toggleAirMissionUnit('j2')
    expect(store.airMissionAirIds).toEqual(['j1'])
    expect(store.airError).toMatchObject({ rule: '14.7d-B' })
    // 候选阵列逐机给原因（修前 null ⇒ 红）
    const choice = store.airMissionJoinChoices.find((item) => item.air.instanceId === 'j2')
    expect(choice?.disabledReason ?? '').toContain('14.7d-B')
  })
})
