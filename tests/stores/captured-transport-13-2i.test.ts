import { describe, expect, it } from 'vitest'

import { CORE_HEX, NEAR_HEX, groundRecord, newConsole, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 13.2i：被夺取运输点数的可动时点（store 级）
 *
 * 原文：
 *   · 13.2i「在移动阶段内被夺取（见 9.14c）的运输点数可以立即移动。如果是在其他任何阶段中被夺取，
 *     则该运输点数在夺取方的下一个移动阶段开始之前都不能移动。」
 *   · 9.14c「在移动阶段被夺取的运输点数可以立即移动（但在其他阶段被夺取的则不行）。」
 *
 * 夺取发生的阶段由 `resolveSpecialCombat` 的 `phase` 入参记录（`capturedTransportMayMoveNow`），
 * 本组用例只核对该事实在 store 层是否真的落到「能不能开拔」上——不改引擎判据、不新增存档字段。
 */
const newStore = (): Workbench => newConsole()

/** 可攻击的步行单位（移动阶段的进入方；9.14 的触发前提） */
function attackerRecord() {
  return groundRecord(
    'axis',
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      record.classes?.movementClass === 'leg',
  )
}

/** 苏军 1 点卡车运输点（1 点 × 50% ⇒ 取整到 1 ⇒ 全被夺取，无位移待决） */
function transportRecord() {
  return groundRecord(
    'soviet',
    (record) =>
      record.noncombatKind === 'transport_point' &&
      (record.noncombatDetails?.transportKind ?? '') === 'truck' &&
      (record.noncombatDetails?.transport ?? 0) === 1,
  )
}

/** 摆一组「进入方 + 敌方运输点」到同格 */
function stageCapture(store: Workbench) {
  const transport = placeGround(store, transportRecord(), CORE_HEX, 'soviet', 'tp-1')
  placeGround(store, attackerRecord(), CORE_HEX, 'axis', 'a1')
  return transport
}

describe('13.2i：移动阶段被夺取 ⇒ 可立即移动', () => {
  it('移动阶段：进入方走完当前移动后，被夺取的运输点可以开拔', () => {
    const store = newStore()
    const transport = stageCapture(store)

    // 真实的 9.14 触发路径：进入方先开拔、走进该格 ⇒ 特殊战斗结算并夺取
    store.setPhase('movement')
    placeGround(store, attackerRecord(), NEAR_HEX, 'axis', 'a2')
    store.clickHex(NEAR_HEX)
    expect(store.confirmMovePick()).toBe(true)
    store.clickHex(CORE_HEX)
    // 终点可能是绕行路径（含中途格），只看「确实走到了 CORE 且已触发夺取」
    expect(store.moveInteraction?.steps.length).toBeGreaterThan(0)
    expect(transport.side).toBe('axis')

    // 9.14c 算例：进入方用剩余的 MP 继续前进、完成该营的移动后，被夺取的卡车也可以移动
    store.finishMove()
    expect(store.beginMoveFor([transport.instanceId])).toBe(true)
    expect(store.moveInteraction?.unitIds).toEqual([transport.instanceId])
  })

  it('移动阶段：直接结算夺取后同样可以开拔（无待决位移）', () => {
    const store = newStore()
    const transport = stageCapture(store)
    store.setPhase('movement')
    expect(store.resolveSpecialCombatAt(CORE_HEX, 'axis')).toBe(true)
    expect(transport.side).toBe('axis')
    expect(store.specialPending).toBeNull()
    expect(store.beginMoveFor([transport.instanceId])).toBe(true)
  })
})

describe('13.2i：其他阶段被夺取 ⇒ 须等夺取方的下一个移动阶段', () => {
  it('战斗阶段被夺取：本阶段不能开拔；进入下一个移动阶段后可开拔', () => {
    const store = newStore()
    const transport = stageCapture(store)
    store.setPhase('combat')
    expect(store.resolveSpecialCombatAt(CORE_HEX, 'axis')).toBe(true)
    expect(transport.side).toBe('axis')

    expect(store.beginMoveFor([transport.instanceId])).toBe(false)
    expect(store.moveInteraction).toBeNull()

    store.setPhase('movement')
    expect(store.beginMoveFor([transport.instanceId])).toBe(true)
  })

  it('进击阶段被夺取：本阶段不能开拔（11.0a 模式限制）；下一个移动阶段可开拔', () => {
    const store = newStore()
    const transport = stageCapture(store)
    store.setPhase('exploitation')
    expect(store.resolveSpecialCombatAt(CORE_HEX, 'axis')).toBe(true)
    expect(transport.side).toBe('axis')

    expect(store.beginMoveFor([transport.instanceId])).toBe(false)
    expect(store.moveBlocked?.rule).toBe('11.0a')

    store.setPhase('movement')
    expect(store.beginMoveFor([transport.instanceId])).toBe(true)
  })
})

describe('13.2i：未落到存档字段', () => {
  it('阶段边界清零：换段后不会残留「已可动」或「被锁」的专档', () => {
    const store = newStore()
    stageCapture(store)
    store.setPhase('movement')
    expect(store.resolveSpecialCombatAt(CORE_HEX, 'axis')).toBe(true)
    // 只依赖阶段事实（`phase` 入参），单位自身的阶段级字段由既有 `resetMovementTracking` 统一清零
    store.setPhase('combat')
    expect(store.units.every((unit) => unit.mpSpent === 0)).toBe(true)
    expect(store.units.every((unit) => unit.movementEnded === false)).toBe(true)
  })
})

describe('13.2i：非移动阶段被夺取的单位不被错误地当成「本轮已结束」', () => {
  it('战斗阶段夺取后单位仍需保留移动资格（只是当下不在移动阶段）', () => {
    const store = newStore()
    const transport = stageCapture(store)
    store.setPhase('combat')
    store.resolveSpecialCombatAt(CORE_HEX, 'axis')
    expect(transport.movementEnded).toBe(false)
    expect(transport.mpSpent).toBe(0)
  })
})
