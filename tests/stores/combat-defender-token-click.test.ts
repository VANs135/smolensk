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
 * 9.1b：战斗环节里**点敌方算子本身**就该选定防御格
 *
 * 红用例来源（2026-11-14 实点）：F 段「战斗环节」按提示点敌方格，落点在敌方算子图徽上时
 * `handleStackClick` 先命中令牌、再被「不参与本环节／敌方算子只读（4.9a）」闸门吞掉这一击，
 * 于是 `battleTarget` 仍是 null、面板不出现，玩家只看到一行"敌方算子只读"。
 * 口径：战斗环节里敌方堆叠**就是**防御格，点图徽与点格面同义（9.1b）。
 */

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
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)) {
      continue
    }
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

describe('9.1b：战斗环节点敌方图徽＝选定防御格', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
    // 实点现场是单人局（4.9a 战雾关闭）⇒ 敌方令牌会画在地图上、也会被命中
    useHotseatStore().setMode('solo')
  })

  it('点敌方堆叠的令牌中心（不是格面空白）也能锁定防御格，且不再报「敌方算子只读」', () => {
    const { workbench, mapView } = stores
    workbench.setPhase('combat')
    goToActionStep(workbench, 'combat.declare')
    workbench.setTool('battle')
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

    // ① 点己方格 ⇒ 加入攻方
    mapView.onHexClick(ATTACKER_HEX)
    expect(workbench.combatAttackerIds).toContain('a1')

    // ② 点敌方堆叠的**令牌中心**（实点就是这样落下的）
    const center = hexCanvasPoint(DEFENDER_HEX)
    const before = workbench.log.length
    mapView.onHexClick(DEFENDER_HEX, undefined, { x: center.x, y: center.y })
    const fresh = workbench.log.slice(0, workbench.log.length - before)

    expect(fresh.some((line) => line.text.includes('敌方算子只读'))).toBe(false)
    expect(workbench.combatState?.composition.defendingHex ?? workbench.battleTarget).toEqual(
      DEFENDER_HEX,
    )
  })
})
