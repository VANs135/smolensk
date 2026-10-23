import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

/**
 * 条 21（批 F·F2）：战斗段「可攻击位置」高亮（随选人实时算）
 *
 * `combatAttackableHexes` 在「打一仗」工具激活、且尚未选定防御格时，把当前攻方选择集
 * 能合法攻击的敌方战斗单位所在格实时算出来（引擎 `checkLegality` 裁决）。点它即
 * `selectCombatDefenderHex` 选定防御格。
 */

const DEFENDER_HEX: HexRef = { col: 1, row: 1 }
const ATTACKER_HEX: HexRef = { col: 1, row: 2 }
const FAR_ENEMY_HEX: HexRef = { col: 5, row: 5 }

function newStores() {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
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
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

const attackerRecord = () => {
  const found = unitChoices('axis').find(
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.attack ?? 0) >= 3,
  )
  if (found === undefined) throw new Error('轴心国单位库中没有徒步战斗单位')
  return found
}

const defenderRecord = () => {
  const found = unitChoices('soviet').find(
    (record) => record.isCombat === true && record.attackCapable === true,
  )
  if (found === undefined) throw new Error('苏联单位库中没有战斗单位')
  return found
}

function place(
  store: ReturnType<typeof useWorkbenchStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
) {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

/** 进入战斗段、切「打一仗」工具、摆好相邻攻防双方（未选防御格） */
function setupBattleTool(store: ReturnType<typeof useWorkbenchStore>): void {
  store.setPhase('combat')
  goToActionStep(store, 'combat.declare')
  store.setTool('battle')
  store.setFuelPool(0, 20)
  place(store, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
  place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
}

describe('条 21（批 F·F2）：战斗段「可攻击位置」高亮', () => {
  let workbench: ReturnType<typeof useWorkbenchStore>
  let mapView: ReturnType<typeof useMapViewStore>

  beforeEach(() => {
    const stores = newStores()
    workbench = stores.workbench
    mapView = stores.mapView
  })

  it('战斗工具激活、未选防御格 ⇒ 高亮相邻敌方格', () => {
    setupBattleTool(workbench)
    expect(workbench.combatAttackableHexes).toContainEqual(DEFENDER_HEX)
  })

  it('非战斗工具（移动）激活 ⇒ 不高亮', () => {
    setupBattleTool(workbench)
    workbench.setTool('move')
    expect(workbench.combatAttackableHexes).toEqual([])
  })

  it('选定防御格后 ⇒ 高亮撤掉（避免与战斗流程图层打架）', () => {
    setupBattleTool(workbench)
    expect(workbench.combatAttackableHexes).toContainEqual(DEFENDER_HEX)
    workbench.selectCombatDefenderHex(DEFENDER_HEX)
    expect(workbench.battleTarget?.hex).toEqual(DEFENDER_HEX)
    expect(workbench.combatAttackableHexes).toEqual([])
  })

  it('不相邻的敌方格不在高亮内（合法性：9.0 相邻 + checkLegality）', () => {
    setupBattleTool(workbench)
    place(workbench, defenderRecord(), FAR_ENEMY_HEX, 'soviet', 'd2')
    const hexes = workbench.combatAttackableHexes
    expect(hexes).toContainEqual(DEFENDER_HEX)
    expect(hexes).not.toContainEqual(FAR_ENEMY_HEX)
  })

  it('已点选攻方 ⇒ 高亮随选择集收窄（只留全部已选攻方都能打到的格）', () => {
    setupBattleTool(workbench)
    // 第二枚攻方摆在远离防御格的格 ⇒ 它无法攻击 DEFENDER_HEX ⇒ 交集后 DEFENDER_HEX 不再高亮
    const a2hex: HexRef = { col: 3, row: 3 }
    place(workbench, attackerRecord(), a2hex, 'axis', 'a2')
    workbench.toggleCombatAttacker('a2')
    expect(workbench.combatAttackerIds).toContain('a2')
    expect(workbench.combatAttackableHexes).not.toContainEqual(DEFENDER_HEX)
  })

  it('地图覆盖层（MapView overlay）同步暴露 combatAttackableHexes', () => {
    setupBattleTool(workbench)
    // mapView.overlay 是 computed，重算后应含该格
    const inOverlay = mapView.overlay.combatAttackableHexes?.some(
      (hex) => hex.col === DEFENDER_HEX.col && hex.row === DEFENDER_HEX.row,
    )
    expect(inOverlay).toBe(true)
  })
})
