import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import type { HexRef } from '@/data'
import {
  toConsoleUnit,
  unitChoices,
  useHotseatStore,
  useMapViewStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 9.x 战斗中段的地图强调（用户 2026-11-18 走查）
 *
 * 现状：进入 9.2 后地图没有任何攻方格/守方格标记；`selectedIds` 只跟移动选择集走，
 * 切到守方视角时攻方那圈选中环还在，守方看不到"哪一格被打、哪一格在防"。
 * 口径：攻方格 / 守方格都要标；参与枚只标本方（4.9b 不展示敌方具体算子）；
 * 当前结算步强调该决策的一侧；切视角不沿用上一视角的选择环。
 */

const ATTACKER_HEX: HexRef = { col: 1, row: 2 }
const DEFENDER_HEX: HexRef = { col: 1, row: 1 }

const attackerRecord = () => {
  const found = unitChoices('axis').find(
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.attack ?? 0) >= 3,
  )
  if (found === undefined) throw new Error('没有轴心国徒步战斗单位')
  return found
}

const defenderRecord = () => {
  const found = unitChoices('soviet').find(
    (record) => record.isCombat === true && record.attackCapable === true,
  )
  if (found === undefined) throw new Error('没有苏联战斗单位')
  return found
}

function setupCombat() {
  setActivePinia(createPinia())
  const workbench = useWorkbenchStore()
  const mapView = useMapViewStore()
  const hotseat = useHotseatStore()
  workbench.setPhase('combat')
  const index = workbench.playerSegmentSteps.findIndex((step) => step.id === 'combat.combat')
  expect(workbench.setSegmentStepIndex(index)).toBe(true)
  workbench.setTool('battle')
  workbench.setFuelPool(0, 20)
  for (const [id, record, hex, side] of [
    ['a1', attackerRecord(), ATTACKER_HEX, 'axis'],
    ['a2', attackerRecord(), ATTACKER_HEX, 'axis'],
    ['d1', defenderRecord(), DEFENDER_HEX, 'soviet'],
  ] as const) {
    workbench.units.push(
      toConsoleUnit({ record, instanceId: id, hex, side }) as (typeof workbench.units)[number],
    )
  }
  // 只把 a1（不把 a2）放进参战集：同格未参战的那枚不得冒充参战
  workbench.combatAttackerIds = ['a1']
  expect(workbench.selectCombatDefenderHex(DEFENDER_HEX)).toBe(true)
  expect(workbench.beginCombatNow()).toBe(true)
  expect(workbench.combatState?.step).toBe('combatSupply')
  return { workbench, mapView, hotseat }
}

describe('9.x 战斗中段：攻方格 / 守方格 / 参与枚', () => {
  let stores: ReturnType<typeof setupCombat>

  beforeEach(() => {
    stores = setupCombat()
  })

  it('★ 守方视角：攻方格与守方格都标，只有守方参与枚有角色', async () => {
    const { mapView, hotseat } = stores
    hotseat.setViewerSide('soviet')
    await nextTick()
    const combat = mapView.overlay.combat
    expect(combat?.attackerHexes).toEqual([ATTACKER_HEX])
    expect(combat?.defenderHex).toEqual(DEFENDER_HEX)
    const byId = new Map(mapView.overlay.tokens.map((token) => [token.id, token]))
    expect(byId.get('d1')?.combatRole).toBe('defender')
    expect(byId.get('a1')?.combatRole ?? null).toBeNull()
    expect(byId.get('a2')?.combatRole ?? null).toBeNull()
  })

  it('★ 攻方视角：只有攻方参与枚有角色；同格未参战的 a2 不冒充', async () => {
    const { mapView, hotseat } = stores
    hotseat.setViewerSide('axis')
    await nextTick()
    const byId = new Map(mapView.overlay.tokens.map((token) => [token.id, token]))
    expect(byId.get('a1')?.combatRole).toBe('attacker')
    expect(byId.get('a2')?.combatRole ?? null).toBeNull()
    expect(byId.get('d1')?.combatRole ?? null).toBeNull()
  })

  it('★ 切到守方后不沿用上一视角的选中环', async () => {
    const { mapView, hotseat } = stores
    hotseat.setViewerSide('axis')
    await nextTick()
    mapView.stackSelection = ['a1']
    expect(mapView.overlay.tokens.find((token) => token.id === 'a1')?.selected).toBe(true)
    hotseat.setViewerSide('soviet')
    await nextTick()
    expect(mapView.stackSelection).toEqual([])
    expect(mapView.overlay.tokens.find((token) => token.id === 'a1')?.selected).toBe(false)
  })

  it('★ 当前结算步强调该决策的一侧', async () => {
    const { workbench, mapView } = stores
    const state = workbench.combatState!
    state.step = 'declareAr'
    state.declaredAttackerArUnitId = undefined
    expect(mapView.overlay.combat?.emphasis).toBe('attacker')
    state.declaredAttackerArUnitId = 'a1'
    expect(mapView.overlay.combat?.emphasis).toBe('defender')
    state.step = 'declareTerrain'
    expect(mapView.overlay.combat?.emphasis).toBe('defender')
    state.step = 'losses'
    state.resolution.stage = 'attackerLosses'
    expect(mapView.overlay.combat?.emphasis).toBe('attacker')
    state.resolution.stage = 'defenderOptions'
    expect(mapView.overlay.combat?.emphasis).toBe('defender')
    state.step = 'retreat'
    expect(mapView.overlay.combat?.emphasis).toBe('defender')
    state.step = 'advance'
    expect(mapView.overlay.combat?.emphasis).toBe('attacker')
  })
})
