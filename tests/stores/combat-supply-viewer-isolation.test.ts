import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { createMapFacts, selectMovementTerrain } from '@/engine/rules'
import { hexCanvasPoint } from '@/render/map-layout'
import {
  actionGateOf,
  defenseTerrainChoices,
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ActionKey,
} from '@/stores'

/**
 * 战斗补给支付按**视角方**隔离（用户 2026-11-18 实盘返修：第 3 条）
 *
 * 现场：玩轴心防守、被苏联进攻时，地图上仍能点苏军的补给站，并在战斗面板里点
 * 「确认攻方补给」替苏联付款。口径：**任何一方只能为自己的单位选源与付款**。
 *
 * 判据只在界面层（AI 驱动仍走 store 的具名入口）：
 *   · `mapView.viewerCombatRoles` ＝ 当前视角方可代其操作的角色；
 *   · `mapView.combatSourceDumps` 只列这些角色的补给站。
 */

const mapFacts = createMapFacts()

function canEnter(mobility: 'leg' | 'truck' | 'track', from: HexRef, to: HexRef): boolean {
  return selectMovementTerrain({
    terrainsPresent: mapFacts.terrainsAt(to),
    mobility,
    crossing: mapFacts.crossingBetween(from, to),
    followingRoad: true,
    forOverrun: false,
  }).ok
}

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
    if (canEnter('leg', candidate, DEFENDER_HEX)) return candidate
  }
  throw new Error('防御格没有「步兵可进入」的图内邻格')
})()

function goToActionStep(store: ReturnType<typeof useWorkbenchStore>, key: ActionKey): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

function mountBattle(input: {
  activeSide: 'axis' | 'soviet'
  attackerSide: 'axis' | 'soviet'
  defenderSide: 'axis' | 'soviet'
}) {
  setActivePinia(createPinia())
  const w = useWorkbenchStore()
  const g = useGameSessionStore()
  const setup = useSetupStore()
  const mapView = useMapViewStore()
  const hotseat = useHotseatStore()

  w.activeSide = input.activeSide
  w.setPhase('combat')
  goToActionStep(w, 'combat.declare')
  w.setTool('battle')

  const pick = (side: 'axis' | 'soviet') =>
    unitChoices(side).find(
      (record) =>
        record.isCombat === true &&
        record.attackCapable === true &&
        record.classes?.movementClass === 'leg' &&
        (record.factors?.combat?.attack ?? 0) >= 1,
    )!

  w.units.push(
    toConsoleUnit({
      record: pick(input.attackerSide),
      instanceId: 'a1',
      hex: ATTACKER_HEX,
      side: input.attackerSide,
    }),
    toConsoleUnit({
      record: pick(input.defenderSide),
      instanceId: 'd1',
      hex: DEFENDER_HEX,
      side: input.defenderSide,
    }),
  )
  w.spDumps.push(
    { id: 'sd-att', side: input.attackerSide, hex: { ...ATTACKER_HEX }, sp: 4, t: 0 },
    { id: 'sd-def', side: input.defenderSide, hex: { ...DEFENDER_HEX }, sp: 4, t: 0 },
  )

  w.clickHex(DEFENDER_HEX)
  if (!w.combatAttackerIds.includes('a1')) w.toggleCombatAttacker('a1')
  expect(w.beginCombatNow()).toBe(true)
  expect(w.combatState?.step).toBe('combatSupply')

  return { w, g, setup, mapView, hotseat }
}

describe('战斗补给支付：按视角方隔离（12.4 / 9.5）', () => {
  it('PVE 玩家守方（AI 苏联进攻轴心）：只能看到/操作守方补给', () => {
    const { w, mapView, hotseat } = mountBattle({
      activeSide: 'soviet',
      attackerSide: 'soviet',
      defenderSide: 'axis',
    })
    hotseat.mode = 'pve'
    hotseat.aiSide = 'soviet'
    hotseat.setViewerSide('axis')

    expect(mapView.viewerCombatRoles).toEqual(['defender'])
    expect(mapView.combatSourceDumps.map((dump) => `${dump.side}:${dump.id}`)).toEqual([
      'defender:sd-def',
    ])

    // 真实点图：攻方补给站不能被选中
    mapView.onHexClick({ ...ATTACKER_HEX }, undefined, hexCanvasPoint(ATTACKER_HEX), 0.5)
    expect(w.combatSupplyDumpIds.attacker).toBeNull()
  })

  it('PVE 玩家守方（AI 轴心进攻苏联）：镜像同样只给守方', () => {
    const { mapView, hotseat } = mountBattle({
      activeSide: 'axis',
      attackerSide: 'axis',
      defenderSide: 'soviet',
    })
    hotseat.mode = 'pve'
    hotseat.aiSide = 'axis'
    hotseat.setViewerSide('soviet')

    expect(mapView.viewerCombatRoles).toEqual(['defender'])
    expect(mapView.combatSourceDumps.map((dump) => `${dump.side}:${dump.id}`)).toEqual([
      'defender:sd-def',
    ])
  })

  it('PVE 玩家攻方（AI 守方）：只能看到/操作攻方补给', () => {
    const { mapView, hotseat } = mountBattle({
      activeSide: 'soviet',
      attackerSide: 'soviet',
      defenderSide: 'axis',
    })
    hotseat.mode = 'pve'
    hotseat.aiSide = 'axis'
    hotseat.setViewerSide('soviet')

    expect(mapView.viewerCombatRoles).toEqual(['attacker'])
    expect(mapView.combatSourceDumps.map((dump) => `${dump.side}:${dump.id}`)).toEqual([
      'attacker:sd-att',
    ])
  })

  it('solo：同一人操作双方 ⇒ 两侧都可点（与 fogDisabled 同口径）', () => {
    const { mapView, hotseat } = mountBattle({
      activeSide: 'axis',
      attackerSide: 'axis',
      defenderSide: 'soviet',
    })
    hotseat.mode = 'solo'

    expect(mapView.viewerCombatRoles).toEqual(['attacker', 'defender'])
    expect(mapView.combatSourceDumps.map((dump) => `${dump.side}:${dump.id}`).sort()).toEqual([
      'attacker:sd-att',
      'defender:sd-def',
    ])
  })

  it('战斗面板源码守卫：攻/守两侧的付款控件都按视角角色收口', () => {
    const panel = readFileSync('src/components/combat/CombatPanel.vue', 'utf8')
    expect(panel).toContain("canActCombatRole('attacker')")
    expect(panel).toContain("canActCombatRole('defender')")
  })
})
