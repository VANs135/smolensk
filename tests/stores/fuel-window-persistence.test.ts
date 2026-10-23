import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { holdingsToT } from '@/engine/rules'
import { useWorkbenchStore } from '@/stores'

import { CORE_HEX, groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 燃料窗口的**持续期**（用户 2026-09-20 裁定）
 *
 * 用户原话：「一整个编队每阶段只付一次编队油，**应该是到下个己方清理阶段结束后为止**，例如同一个回合里
 *   在**敌方回合的己方反应阶段**移动环节编队加油，那么到**己方回合移动环节**，当时按编队加油的单位
 *   **仍是加油**，未加油的该编队单位**只能单独加油**，一直到**燃料状态重置的己方清理阶段结束后**，
 *   下次该编队单位要移动时再重新算编队加油」；并追加：「**HQ 加油也是到己方清理阶段结束后**」。
 *
 * 规则支撑（12.5c-A/B + 12.5d）：
 *   · 「燃料已补给状态会持续到**下一个友方清理阶段**」（A 与 B 两条都这么写）；
 *   · 12.5d：「当前阶段玩家必须在**自己的清理阶段**移除他指挥部的燃料已补给标记，并将他的编队标记
 *     翻面至燃料未补给的一面」⇒ 清理是**按方**的：对手的清理阶段不动本方的燃料窗口。
 *
 * 修前的病灶：两个台账（12.5e 的投递基点、12.5c-A 的编队油）在**换阶段**与**换回合**时被清空 ⇒
 *   「反应阶段付的油，到己方回合移动阶段就被当成没付过」—— 玩家可以在同一窗口里把同一支编队/同一座
 *   HQ 再买一次（多付），且界面的"已投递过"提示会凭空消失。
 *
 * 本文件钉四件事：① 用户举的那个例子逐字成立（反应阶段 ⇒ 己方移动阶段仍持油、编队法仍被台账挡住）；
 * ② HQ 法同理（窗口内不再重复付款）；③ **只有本方清理**才作废（对手清理不动）；④ 清理之后可重新付。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 3PZ 编队的一枚「徒步面摩托化」单位（战斗面 leg / 移动面 truck） */
function motRecord() {
  return groundRecord(
    'axis',
    (record) =>
      record.formation === '3PZ' &&
      record.mobilityByFace?.combat === 'leg' &&
      record.mobilityByFace?.move === 'truck',
  )
}

/** 指挥部（与 `fuel-three-paths-flow` 同一夹具口径：按 `branch === 'hq'` 取） */
function hqRecord() {
  const found = groundRecord('axis', (record) => record.branch === 'hq')
  expect(found, '单位库里应有指挥部').toBeDefined()
  return found
}

/** 摆一队 3PZ（`mine` 在补给站格、`mate` 在相邻格）＋一座站 */
function setupFormation(store: ReturnType<typeof newStore>) {
  const mine = placeGround(store, motRecord(), CORE_HEX, 'axis', 'mine', 'move')
  const mate = placeGround(
    store,
    motRecord(),
    { col: CORE_HEX.col + 1, row: CORE_HEX.row },
    'axis',
    'mate',
  )
  store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 0 })
  return { mine, mate }
}

/** 走进某段的「移动环节」（燃料闸门在 C/E/G 的移动环节放行） */
function goToMovementStep(
  store: ReturnType<typeof newStore>,
  phase: 'movement' | 'reaction' | 'exploitation',
): void {
  store.setPhase(phase)
  // C 段的移动环节 id 是 `movement.modeAndMovement`（2.2 原文 "Mode & Movement"；段内首环是突围）
  const stepId = phase === 'movement' ? 'movement.modeAndMovement' : `${phase}.movement`
  const index = store.playerSegmentSteps.findIndex((step) => step.id === stepId)
  if (index < 0) throw new Error(`${phase} 段没有移动环节（${stepId}）`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入 ${phase} 移动环节失败`)
}

describe('燃料窗口（用户 2026-09-20 裁定）：持续到**本方清理阶段**结束', () => {
  it('★ 用户举的例子：敌方半场的**己方反应阶段**付编队油 ⇒ 己方回合移动阶段仍是加油，且其余成员只能单独付', () => {
    const store = newStore()
    const { mine, mate } = setupFormation(store)

    // ① 敌方回合：行动方＝苏方（activeSide），本方的反应阶段里给 3PZ 付编队油
    store.setActiveSide('soviet')
    goToMovementStep(store, 'reaction')
    store.selectedId = mine.instanceId
    store.fuelMethod = 'formation'
    expect(store.pickFuelDump('d1')).toBe(true)
    store.payFuel()
    expect(mine.fuelled).toBe(true)
    expect(mate.fuelled).toBe(true)

    // ② 己方回合的**移动阶段**：当时按编队法加注的单位**仍是加油**
    store.abortMoveNow()
    store.setActiveSide('axis')
    goToMovementStep(store, 'movement')
    expect(mine.fuelled).toBe(true)
    expect(mine.fuelMethod).toBe('formation')
    expect(mate.fuelled).toBe(true)

    // ③ 未加油的该编队单位**只能单独加油**：编队法仍被窗口台账挡住，单独单位法付得出去
    const before = holdingsToT(store.spDumps[0]!)
    // 摆在**同一来源范围内**（挨着 mate）：这样"被拒"只可能是因为窗口尚未结束，而不是够不着来源。
    // ★ 朝向取**移动面**（truck）：12.5c-C 是"为每个**需要燃料**的单位付 1T"，而"需要"按**当前朝向**
    //   的机动类型判（12.5a）—— 徒步面时它不需要油，付它反而会被 12.5a 拒（这与编队法的覆盖口径**不同**：
    //   编队法按 12.5c-A 覆盖整个编队，不管某枚此刻在哪一面）。
    const extra = placeGround(store, motRecord(), mate.hex, 'axis', 'extra', 'move')
    store.abortMoveNow()
    store.beginMovePick(extra.hex, ['extra'])
    store.fuelMethod = 'formation'
    store.payFuel()
    expect(extra.fuelled).toBe(false) // 编队法被拒
    expect(holdingsToT(store.spDumps[0]!)).toBe(before)
    // 拒的理由必须是**窗口未结束**（用户 2026-09-20 裁定），而不是"够不着来源"
    const refusalLog = store.log.map((entry) => entry.text).join('\n')
    expect(refusalLog).toContain('编队油窗口')

    store.abortMoveNow()
    store.fuelMethod = 'singleUnit'
    expect(store.pickFuelDump('d1')).toBe(true)
    store.payFuel()
    expect(extra.fuelled).toBe(true)
    expect(extra.fuelMethod).toBe('singleUnit')
  })

  it('★ HQ 法同理（用户追加口径）：窗口内**不再重复付款**，覆盖集照旧持油', () => {
    const store = newStore()
    const hq = placeGround(store, hqRecord(), CORE_HEX, 'axis', 'hq1')
    const lone = placeGround(
      store,
      groundRecord(
        'axis',
        (record) =>
          (record.formation ?? null) === null &&
          (record.steps?.total ?? 1) <= 1 &&
          (record.classes?.movementClass === 'truck' ||
            record.classes?.movementClass === 'tracked'),
      ),
      { col: CORE_HEX.col + 1, row: CORE_HEX.row },
      'axis',
      'lone',
    )
    store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 0 })

    store.setActiveSide('soviet')
    goToMovementStep(store, 'reaction')
    /*
     * ★ 反应阶段（本方＝**非行动方**）的受益集走 `selectedId`（与面板同一处口径）——
     *   不用 `beginMovePick`：那个按 `friendlyUnitsAt`（＝`side === activeSide`）滤"己方"，
     *   而 E 段的行动方是对手（这正是 E 段的定义：**非行动方**动）。
     */
    store.selectedId = 'hq1'
    store.fuelMethod = 'hq'
    expect(store.pickFuelDump('d1')).toBe(true)
    store.payFuel()
    expect(hq.fuelled).toBe(true)
    expect(lone.fuelled).toBe(true)
    const before = holdingsToT(store.spDumps[0]!)

    // 己方回合移动阶段：同一 HQ 再付 HQ 法 ⇒ 拒（窗口未结束）
    store.abortMoveNow()
    store.setActiveSide('axis')
    goToMovementStep(store, 'movement')
    expect(hq.fuelled).toBe(true)
    store.selectedId = 'hq1'
    store.fuelMethod = 'hq'
    store.payFuel()
    expect(holdingsToT(store.spDumps[0]!)).toBe(before) // 账本一字未动
    expect(store.formationFuelThrowOf('3PZ')).toBeNull() // 与本例无关：编队台账没被误写
    expect(store.hqFuelThrows['hq1']).toBeDefined() // 窗口台账仍在
  })

  it('★ 只有**本方**清理才作废：对手的清理阶段不动本方的燃料窗口', () => {
    const store = newStore()
    const { mine } = setupFormation(store)
    store.setActiveSide('soviet')
    goToMovementStep(store, 'reaction')
    store.selectedId = mine.instanceId
    store.fuelMethod = 'formation'
    store.pickFuelDump('d1')
    store.payFuel()
    store.abortMoveNow()

    // 对手（苏方）的清理阶段：清的是**苏方**的标记 ⇒ 本方的编队油窗口必须原样保留
    store.setActiveSide('soviet')
    store.setPhase('cleanUp')
    expect(store.runCleanUpNow()).toBe(true)
    expect(mine.fuelled).toBe(true)
    expect(store.formationFuelThrowOf('3PZ')).not.toBeNull()

    // 本方（轴方）的清理阶段：这才作废
    store.setActiveSide('axis')
    store.setPhase('cleanUp')
    expect(store.runCleanUpNow()).toBe(true)
    expect(mine.fuelled).toBe(false)
    expect(store.formationFuelThrowOf('3PZ')).toBeNull()
  })

  it('★ 清理之后：同一编队可以**重新**用编队法（下一个窗口）', () => {
    const store = newStore()
    const { mine } = setupFormation(store)
    store.setActiveSide('axis')
    goToMovementStep(store, 'movement')
    store.selectedId = mine.instanceId
    store.fuelMethod = 'formation'
    store.pickFuelDump('d1')
    store.payFuel()
    store.abortMoveNow()

    // 本方清理 ⇒ 窗口结束
    store.setActiveSide('axis')
    store.setPhase('cleanUp')
    expect(store.runCleanUpNow()).toBe(true)
    expect(store.formationFuelThrowOf('3PZ')).toBeNull()

    // 新窗口：再付一次编队法付得出去
    store.setActiveSide('axis')
    goToMovementStep(store, 'movement')
    store.selectedId = mine.instanceId
    store.fuelMethod = 'formation'
    expect(store.pickFuelDump('d1')).toBe(true)
    store.payFuel()
    expect(mine.fuelled).toBe(true)
    expect(store.formationFuelThrowOf('3PZ')).not.toBeNull()
  })

  it('★ 换回合**不**清窗口（后手方付款会跨过回合边界）', () => {
    const store = newStore()
    const { mine } = setupFormation(store)
    store.setActiveSide('soviet')
    goToMovementStep(store, 'reaction')
    store.selectedId = mine.instanceId
    store.fuelMethod = 'formation'
    store.pickFuelDump('d1')
    store.payFuel()
    store.abortMoveNow()

    store.setTurn(store.turn + 1)
    expect(store.formationFuelThrowOf('3PZ')).not.toBeNull()
    expect(mine.fuelled).toBe(true)
  })
})
