import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useContainersStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ActionKey,
} from '@/stores'

/**
 * P3 / UI3：**会话身份与关闭语义**（计划 §3「session.kind 作为会话 key」/ §5「显示会话身份 / closePolicy」）
 *
 * 本文件钉三件事：
 *   ① `sessionId`：同类会话关掉重开递增、换 kind 必变、无关重绘不变；
 *   ② `closePolicy`：取消 / 收起 / 域拒绝三态由既有 store 事实推出；
 *   ③ 域拒绝时 `cancelSession()` 如实返回 `false`，且既有结算不被清空；关突围不再误触轰炸。
 *
 * ★ 用真实地图与单位库（不造数）；规则结论全部取 store 既有事实。
 */

const ATTACKER_HEX: HexRef = { col: 1, row: 2 }
const DEFENDER_HEX: HexRef = { col: 1, row: 1 }

/** 突围用例用的内陆两格（远离边缘，避免边角地形把突围路径判死） */
const [BREAK_TRAPPED, BREAK_FRIEND] = (() => {
  for (const hex of mapLayers.hexes) {
    if (hex.col < 12 || hex.row < 12 || hex.col > 40 || hex.row > 24) continue
    const a: HexRef = { col: hex.col, row: hex.row }
    const b = neighbor(a, HEX_DIRECTIONS[0])
    if (!mapLayers.hexes.some((item) => item.col === b.col && item.row === b.row)) continue
    return [a, b] as const
  }
  throw new Error('地图上找不到合适的两格')
})()

const newStores = () => {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return {
    workbench: useWorkbenchStore(),
    mapView: useMapViewStore(),
    containers: useContainersStore(),
  }
}

type Stores = ReturnType<typeof newStores>

const attackerRecord = () =>
  unitChoices('axis').find(
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.attack ?? 0) >= 3,
  )!

const defenderRecord = () =>
  unitChoices('soviet').find(
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.factors?.combat?.attack ?? 0) >= 1,
  )!

const artilleryRecord = () =>
  unitChoices('axis').find(
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
  )!

/** 放一枚单位（同 id 已存在则复用：重开会话时不重复压栈） */
function place(
  store: Stores['workbench'],
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
) {
  const existing = store.units.find((unit) => unit.instanceId === instanceId)
  if (existing !== undefined) return existing
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

/** B8：把 store 放到本段里允许做该动作的那个环节（反查闸门表） */
function goToActionStep(store: Stores['workbench'], key: ActionKey): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

/** 起一次常规战斗（9.2），停在战斗补给步 */
function openCombatSession(stores: Stores): boolean {
  const { workbench } = stores
  workbench.setPhase('combat')
  goToActionStep(workbench, 'combat.declare')
  workbench.setTool('battle')
  workbench.setFuelPool(0, 20)
  place(workbench, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
  place(workbench, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
  workbench.clickHex(ATTACKER_HEX)
  workbench.clickHex(DEFENDER_HEX)
  return workbench.beginCombatNow()
}

/** 起一次轰炸（10.0），停在补给步 */
function openBarrageSession(stores: Stores): boolean {
  const { workbench } = stores
  workbench.setPhase('combat')
  const artillery = place(workbench, artilleryRecord(), ATTACKER_HEX, 'axis', 'art-1')
  const defender = place(workbench, defenderRecord(), DEFENDER_HEX, 'soviet', 'def-1')
  workbench.battleTarget = { hex: DEFENDER_HEX, defenderIds: [defender.instanceId] }
  workbench.setBarrageActive(true)
  workbench.toggleBarrageUnit(artillery.instanceId)
  return workbench.beginBarrageNow()
}

/** 12.4：为双方各放一座补给站并声明为战斗补给来源（须在 beginCombatNow 之后） */
function declareCombatSupplyForBoth(store: Stores['workbench']): void {
  if (!store.spDumps.some((dump) => dump.id === 'sd-axis'))
    store.spDumps.push({ id: 'sd-axis', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
  if (!store.spDumps.some((dump) => dump.id === 'sd-soviet'))
    store.spDumps.push({ id: 'sd-soviet', hex: { ...DEFENDER_HEX }, side: 'soviet', sp: 8, t: 0 })
  for (const entry of store.combatSupplyDumps) {
    if (store.combatSupplyDumpIds[entry.side] !== null) continue
    const dump = entry.dumps[0]
    if (dump !== undefined) store.pickCombatSupplyDump(entry.side, dump.id)
  }
}

/** 10.1b / 12.3a：声明一座当前行动方的补给站并点选为轰炸来源 */
function withBarrageDump(store: Stores['workbench']): string {
  const id = `bd-${store.spDumps.length}`
  store.spDumps.push({ id, hex: { ...ATTACKER_HEX }, side: store.activeSide, sp: 0, t: 20 })
  expect(store.pickBarrageSupplyDump(id)).toBe(true)
  const group = store.groupOfUnit(store.units.find((unit) => unit.side === store.activeSide)!)
  if (group !== null) store.setDumpPanzerGroupNow(id, group)
  return id
}

/** 单位动作会话（条 12 M2）：C 段移动环节点一枚补给站 */
function openUnitSession(stores: Stores): boolean {
  const { workbench, mapView } = stores
  workbench.setPhase('movement')
  goToActionStep(workbench, 'move.dumpBlow')
  const record = unitChoices('axis').find((item) => item.noncombatKind === 'sp')
  if (record === undefined) throw new Error('单位库中没有补给站')
  place(workbench, record, ATTACKER_HEX, 'axis', 'sp-1')
  return mapView.openUnitActionAt(ATTACKER_HEX, 'sp-1')
}

/** 突围会话（12.8e）：摆一枚断补战斗单位并把 store 放到突围环节 */
function openBreakoutSession(stores: Stores): boolean {
  const { workbench, mapView } = stores
  workbench.setPhase('movement')
  const record = unitChoices('axis').find(
    (item) => item.isCombat === true && (item.steps?.total ?? 1) <= 1,
  )!
  place(workbench, record, BREAK_TRAPPED, 'axis', 'bl-1')
  place(workbench, record, BREAK_FRIEND, 'axis', 'fr-1')
  const liveTrapped = workbench.units.find((unit) => unit.instanceId === 'bl-1')!
  const liveFriend = workbench.units.find((unit) => unit.instanceId === 'fr-1')!
  liveTrapped.hasTraceSupply = false
  liveFriend.hasTraceSupply = true
  const index = workbench.playerSegmentSteps.findIndex((step) => step.id === 'movement.breakout')
  if (index < 0) throw new Error('移动阶段没有突围环节（断补单位在场时它应出现）')
  if (!workbench.setSegmentStepIndex(index)) throw new Error('进入突围环节失败')
  // U1-b：突围会话由「打开突围会话」入口触发（不再随环节自动弹出）
  mapView.openBreakoutNow()
  return mapView.session?.kind === 'breakout'
}

describe('P3：会话实例身份（sessionId）', () => {
  let stores: Stores

  beforeEach(() => {
    stores = newStores()
  })

  it('同一种会话关掉再开 ⇒ sessionId 递增（不串草稿 / 滚动 / 锚点）', () => {
    expect(openUnitSession(stores)).toBe(true)
    const first = stores.mapView.session
    expect(first?.kind).toBe('unit')
    expect(first?.sessionId).toMatch(/^unit#\d+$/)

    expect(stores.mapView.cancelSession()).toBe(true)
    expect(stores.mapView.session).toBeNull()

    expect(openUnitSession(stores)).toBe(true)
    const second = stores.mapView.session
    expect(second?.sessionId).toMatch(/^unit#\d+$/)
    expect(second?.sessionId).not.toBe(first?.sessionId)
  })

  it('换 kind ⇒ sessionId 必变（前缀随 kind）', () => {
    expect(openUnitSession(stores)).toBe(true)
    const first = stores.mapView.session!.sessionId
    expect(stores.mapView.cancelSession()).toBe(true)
    stores.mapView.setExclusiveOpen(true)
    const second = stores.mapView.session
    expect(second?.kind).toBe('exclusive')
    expect(second?.sessionId).toMatch(/^exclusive#\d+$/)
    expect(second?.sessionId).not.toBe(first)
  })

  it('同一会话内无关重绘 ⇒ sessionId 不变', () => {
    expect(openUnitSession(stores)).toBe(true)
    const before = stores.mapView.session!.sessionId
    stores.mapView.openPopup(ATTACKER_HEX, 10, 10)
    stores.mapView.closePopup()
    expect(stores.mapView.session!.sessionId).toBe(before)
  })
})

describe('P3：关闭语义（cancel / collapse / refused）', () => {
  let stores: Stores

  beforeEach(() => {
    stores = newStores()
  })

  it('战斗未提交 ⇒ cancel；已提交未完成 ⇒ refused，且原因与领域判据同源', () => {
    const { workbench, mapView } = stores
    expect(openCombatSession(stores)).toBe(true)
    expect(mapView.session?.closePolicy).toBe('cancel')
    expect(workbench.combatCancelBlocker()).toBeNull()

    declareCombatSupplyForBoth(workbench)
    expect(workbench.confirmCombatSupply()).toBe(true)
    expect(workbench.combatCancelBlocker()).not.toBeNull()

    expect(mapView.session?.closePolicy).toBe('refused')
    expect(mapView.session?.closeBlockedReason).toBe(workbench.combatCancelBlocker())
    // 域拒绝：如实说没关掉，且盘面结算仍在
    expect(mapView.cancelSession()).toBe(false)
    expect(workbench.combatState).not.toBeNull()
  })

  it('轰炸已提交 ⇒ refused；传送相同判据到界面', () => {
    const { workbench, mapView } = stores
    expect(openBarrageSession(stores)).toBe(true)
    expect(mapView.session?.closePolicy).toBe('cancel')
    expect(workbench.barrageCancelBlocker()).toBeNull()

    withBarrageDump(workbench)
    expect(workbench.confirmBarrageSupplyStep()).toBe(true)
    expect(workbench.barrageCancelBlocker()).not.toBeNull()

    expect(mapView.session?.closePolicy).toBe('refused')
    expect(mapView.session?.closeBlockedReason).toBe(workbench.barrageCancelBlocker())
    expect(mapView.cancelSession()).toBe(false)
    expect(workbench.barrageState).not.toBeNull()
  })

  it('单位 / 专规 / 盒内 / 增援 ⇒ collapse（收起而不是造第二套取消语义）', () => {
    const { containers, mapView } = stores
    expect(openUnitSession(stores)).toBe(true)
    expect(mapView.session?.closePolicy).toBe('collapse')

    expect(mapView.cancelSession()).toBe(true)
    containers.cardOpenId = 'c1'
    expect(mapView.session?.kind).toBe('containers')
    expect(mapView.session?.closePolicy).toBe('collapse')

    expect(mapView.cancelSession()).toBe(true)
    expect(containers.cardOpenId).toBeNull()

    // 显式打开会压过"上一环节已收起"（B37），所以这里不会受 containers 的收起态影响
    mapView.setExclusiveOpen(true)
    expect(mapView.session?.kind).toBe('exclusive')
    expect(mapView.session?.closePolicy).toBe('collapse')
    expect(mapView.cancelSession()).toBe(true)

    stores.workbench.setPhase('reinforcement')
    expect(mapView.session?.kind).toBe('reinforce')
    expect(mapView.session?.closePolicy).toBe('collapse')
  })

  it('突围会话：collapse，且收起不误触轰炸分支', () => {
    const { workbench, mapView } = stores
    expect(openBreakoutSession(stores)).toBe(true)
    expect(mapView.session?.kind).toBe('breakout')
    expect(mapView.session?.closePolicy).toBe('collapse')

    expect(mapView.cancelSession()).toBe(true)
    expect(mapView.session).toBeNull()
    expect(workbench.barrageState).toBeNull()
  })
})

describe('P3：只读拒绝判据（查询与提交同一来源）', () => {
  let stores: Stores

  beforeEach(() => {
    stores = newStores()
  })

  it('cancelCombat 在已提交未完成时零状态变化，并给出同一条原因', () => {
    const { workbench } = stores
    expect(openCombatSession(stores)).toBe(true)
    declareCombatSupplyForBoth(workbench)
    expect(workbench.confirmCombatSupply()).toBe(true)
    const stepBefore = workbench.combatState?.step
    const blocker = workbench.combatCancelBlocker()

    workbench.cancelCombat()

    expect(workbench.combatState?.step).toBe(stepBefore)
    expect(workbench.combatState).not.toBeNull()
    expect(blocker).not.toBeNull()
  })
})
