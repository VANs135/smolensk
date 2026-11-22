import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { createMapFacts, selectMovementTerrain } from '@/engine/rules'
import { hexCanvasPoint } from '@/render/map-layout'
import {
  actionGateOf,
  defenseTerrainChoices,
  toConsoleUnit,
  unitChoices,
  useHotseatStore,
  useMapViewStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

/**
 * 9.1b：**战斗环节（正式界面、不切工具）点地图就能发起常规战斗**
 *
 * 红用例来源（2026-11-22 用户实点「选中单位后发不起常规战斗」）：
 *   · `onHexClick` 的「闲置态点格面 ⇒ 摊开堆叠 / 开格内容窗」分支排在战斗分派之前，
 *     于是战斗环节点己方格只摊开（攻方恒为空）、点敌方格只开窗（`battleTarget` 恒 null）；
 *   · 之后「其余交给操作台」那道 `needsActionApi` 判据也不含战斗环节，
 *     `tool` 在正式界面恒为 `move` ⇒ 这一击永远到不了 `clickHex` → `battleToolClick`。
 * 口径：环节驱动（用户 2026-09-16 #10：正式界面不切工具），点己方格＝加入/移出攻方，
 * 点敌方格＝定防御格并直接进 9.2（用户 2026-11-13 批 F）。
 */

const goToActionStep = (
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void => {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

const mapFacts = createMapFacts()

const DEFENDER_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    if (defenseTerrainChoices(ref).length === 0) return false
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到「六邻皆图内且可作防御格」的格')
  return { col: found.col, row: found.row }
})()

const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row))
      continue
    const result = selectMovementTerrain({
      terrainsPresent: mapFacts.terrainsAt(DEFENDER_HEX),
      mobility: 'leg',
      crossing: mapFacts.crossingBetween(candidate, DEFENDER_HEX),
      followingRoad: true,
      forOverrun: false,
    })
    if (result.ok) return candidate
  }
  throw new Error('防御格没有「步兵可进入」的图内邻格')
})()

/** 按真实点击落点（格中心）点一格 */
function clickAt(mapView: ReturnType<typeof useMapViewStore>, hex: HexRef): void {
  const center = hexCanvasPoint(hex)
  mapView.onHexClick(hex, undefined, { x: center.x, y: center.y })
}

describe('9.1b：战斗环节从地图发起常规战斗（不切工具）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
    useHotseatStore().setMode('solo')
  })

  function setupCombatPhase(): void {
    const { workbench } = stores
    workbench.setPhase('combat')
    goToActionStep(workbench, 'combat.declare')
    workbench.setFuelPool(0, 20)
    const attackerRecord = unitChoices('axis').find(
      (record) =>
        record.isCombat === true &&
        record.attackCapable === true &&
        record.classes?.movementClass === 'leg' &&
        (record.factors?.combat?.attack ?? 0) >= 3,
    )!
    const defenderRecord = unitChoices('soviet').find(
      (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) >= 1,
    )!
    workbench.units.push(
      toConsoleUnit({ record: attackerRecord, instanceId: 'a1', hex: ATTACKER_HEX, side: 'axis' }),
      toConsoleUnit({
        record: defenderRecord,
        instanceId: 'd1',
        hex: DEFENDER_HEX,
        side: 'soviet',
      }),
    )
  }

  it('点己方格面 ⇒ 加入攻方（不再只摊开）', () => {
    setupCombatPhase()
    clickAt(stores.mapView, ATTACKER_HEX)
    expect(stores.workbench.combatAttackerIds).toContain('a1')
  })

  it('再点敌方格面 ⇒ 定防御格并直接进 9.2 第 1 步（combatSupply）', () => {
    setupCombatPhase()
    clickAt(stores.mapView, ATTACKER_HEX)
    clickAt(stores.mapView, DEFENDER_HEX)
    expect(stores.workbench.battleTarget?.hex).toEqual(DEFENDER_HEX)
    expect(stores.workbench.combatState?.step).toBe('combatSupply')
  })

  it('没先点己方也能发起：点敌方格面 ⇒ 自动取相邻可攻击单位作攻方', () => {
    setupCombatPhase()
    clickAt(stores.mapView, DEFENDER_HEX)
    expect(stores.workbench.combatAttackerIds).toContain('a1')
    expect(stores.workbench.combatState?.step).toBe('combatSupply')
  })

  it('非战斗环节不受影响：移动段点己方格面仍只是摊开/选中，不进战斗', () => {
    const { workbench, mapView } = stores
    workbench.setPhase('movement')
    const attackerRecord = unitChoices('axis').find(
      (record) =>
        record.isCombat === true &&
        record.attackCapable === true &&
        record.classes?.movementClass === 'leg',
    )!
    workbench.units.push(
      toConsoleUnit({ record: attackerRecord, instanceId: 'm1', hex: ATTACKER_HEX, side: 'axis' }),
    )
    expect(workbench.combatPickActive).toBe(false)
    clickAt(mapView, ATTACKER_HEX)
    expect(workbench.combatAttackerIds).toEqual([])
    expect(workbench.battleTarget).toBeNull()
  })
})
