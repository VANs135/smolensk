/**
 * 批 C：三类拒绝的**实跑复现**（撤退落点 / 落账计划 / 增援落点）
 *
 * 这三条路径原先要么落到「本次操作被规则拒绝（9.12）」这类通用兜底，
 * 要么把内部码直接印给玩家。本文件用真实流程把拒绝码跑出来，
 * 再钉住界面上那句人话必须点名缺的是距离 / 入场格 / 补给站。
 */

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { mapLayers, scenarios } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import { createMapFacts, selectMovementTerrain } from '@/engine/rules'
import { ruleErrorTextOf } from '@/engine/rules/rule-error-text'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'
import { useLegalActionsStore } from '@/stores/legal-actions-store'
import { groundRecord, label, newConsole, placeGround } from './sop-harness'

const mapFacts = createMapFacts()

const DEFENDER_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到六邻皆图内的格')
  return { col: found.col, row: found.row }
})()

function canEnter(mobility: 'leg' | 'truck' | 'track', from: HexRef, to: HexRef): boolean {
  return selectMovementTerrain({
    terrainsPresent: mapFacts.terrainsAt(to),
    mobility,
    crossing: mapFacts.crossingBetween(from, to),
    followingRoad: true,
    forOverrun: false,
  }).ok
}

const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row))
      continue
    if (canEnter('leg', candidate, DEFENDER_HEX)) return candidate
  }
  throw new Error('防御格没有「步兵可进入」的图内邻格')
})()

function straightPath(from: HexRef, count: number): HexRef[] {
  for (const direction of HEX_DIRECTIONS) {
    const path: HexRef[] = []
    let current = from
    let valid = true
    for (let index = 0; index < count; index += 1) {
      const next = neighbor(current, direction)
      if (
        !isOnMap(next) ||
        !mapLayers.hexes.some((h) => h.col === next.col && h.row === next.row)
      ) {
        valid = false
        break
      }
      path.push(next)
      current = next
    }
    if (valid && hexDistance(from, current) === count) return path
  }
  throw new Error(`找不到 ${count} 格的直线撤退路径`)
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

type Store = ReturnType<typeof newConsole>

const strongAttackerRecord = () =>
  groundRecord(
    'axis',
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.factors?.combat?.attack ?? 0) >= 8,
  )

const weakDefenderRecord = () =>
  groundRecord('soviet', (record) => {
    const attack = record.factors?.combat?.attack ?? 99
    const ar = record.factors?.combat?.ar ?? 99
    return record.isCombat === true && attack >= 2 && attack <= 3 && ar <= 2
  })

function declareSupplyForBoth(store: Store): void {
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

function driveToRetreat(store: Store): { distance: number; unitId: string } {
  store.setPhase('combat')
  goToActionStep(store, 'combat.declare')
  store.setTool('battle')
  store.setFuelPool(0, 20)
  placeGround(store, strongAttackerRecord(), ATTACKER_HEX, 'axis', 'a1')
  placeGround(store, weakDefenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
  store.clickHex(ATTACKER_HEX)
  store.clickHex(DEFENDER_HEX)
  expect(store.beginCombatNow()).toBe(true)
  declareSupplyForBoth(store)
  expect(store.confirmCombatSupply()).toBe(true)
  store.combatInputs.attackerArUnitId = 'a1'
  expect(store.declareCombatArStep('attacker')).toBe(true)
  store.combatInputs.defenderArUnitId = 'd1'
  expect(store.declareCombatArStep('defender')).toBe(true)
  expect(store.declareCombatTerrainStep()).toBe(true)
  expect(store.rollCombatSurprise()).toBe(true)
  if (store.combatAwaitingShiftDie) expect(store.rollCombatShiftDie()).toBe(true)
  expect(store.rollCombatDice()).toBe(true)
  expect(store.confirmCombatLosses()).toBe(true)
  const requirement = store.combatRequirement
  expect(requirement?.side).toBe('attacker')
  const distance = requirement?.options ?? 0
  expect(distance).toBeGreaterThan(0)
  store.combatInputs.optionRetreatHexes = distance
  store.combatInputs.optionLossPoints = 0
  expect(store.confirmCombatOptions()).toBe(true)
  expect(store.confirmCombatLosses()).toBe(true)
  if (store.combatState?.resolution.stage === 'defenderOptions') {
    store.combatInputs.ignoreOptions = true
    expect(store.confirmCombatOptions()).toBe(true)
  }
  expect(store.combatState?.step).toBe('retreat')
  return { distance, unitId: 'a1' }
}

describe('批 C：三类拒绝实跑', () => {
  it('① 撤退落点：落点不在完整撤退距离上 ⇒ 文案点名「撤退距离」', () => {
    const store = newConsole()
    const { distance, unitId } = driveToRetreat(store)
    const unit = store.units.find((item) => item.instanceId === unitId)!
    // 走 `distance + 1` 格直线：路径够长，但终点直线距离不是完整撤退距离
    const path = straightPath(unit.hex, distance + 1)
    store.combatInputs.retreatPaths = { [unitId]: path.map(label).join(',') }

    expect(store.confirmCombatRetreats()).toBe(false)
    expect(store.combatError?.rule).toBe('9.12')
    expect(store.combatError?.reason).toContain('retreatMustEndAtFullDistance')
    const line = ruleErrorTextOf(store.combatError!)
    expect(line).toContain('撤退距离')
    expect(line).not.toContain('本次操作被规则拒绝')
  }, 60000)

  it('② 落账计划：勾到不可卸货城市格 ⇒ 计划不可用（13.3c），不再显示「当前落账计划不可用」', () => {
    const store = newConsole()
    store.setScenarioId('1')
    store.seedConvertedRailsNow()
    const sources = scenarios as unknown as Record<
      string,
      { supplySources?: { axisLive?: string[] } }
    >
    const texts = sources['1']?.supplySources?.axisLive ?? []
    for (const text of texts) {
      const [col, row] = text.split('.').map(Number)
      store.supplySourceDecls.push({
        id: `src-${text}`,
        hex: { col: col!, row: row! },
        side: 'axis',
        kind: 'edgeRail',
      })
    }
    const record = unitChoices('axis').find(
      (item) => item.isCombat === true && item.attackCapable === true,
    )!
    store.units.push(
      toConsoleUnit({ record, instanceId: 'u-0', hex: { col: 2, row: 2 }, side: 'axis' }),
    )
    store.setPhase('reinforcement')
    const allowed = actionGateOf('rein.supplyArrival')
      .where.filter((item) => item.phase === store.phase)
      .map((item) => item.segment)
    const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
    expect(store.setSegmentStepIndex(index)).toBe(true)

    // 真实路径 A：玩家勾了不受控的城市格（60.34 Rzhev）
    store.supplyArrivalSp = 3
    store.toggleFreeRailPick({ col: 60, row: 34 })

    expect(store.freeRailPlan).toBeNull()
    expect(store.freeRailError?.rule).toBe('13.3c')
    expect(store.freeRailError?.reason).toContain('notDetrainableCityHex')
    expect(store.applySupplyArrivalsNow()).toBe(false)

    const legal = useLegalActionsStore()
    const entry = legal.view.entries.find((item) => item.key === 'rein.supplyArrival')
    expect(entry?.status).toBe('blocked')
    expect(entry?.candidates?.[0]?.disabledReason).toBe(store.freeRailError?.reason)
  }, 60000)

  it('③ 增援落点：候选外的格 ⇒ 拒绝码是「不在入场格」', () => {
    setActivePinia(createPinia())
    const store = useWorkbenchStore()
    store.setActiveSide('axis')
    let found = -1
    for (let turn = 1; turn <= 40 && found < 0; turn += 1) {
      store.setTurn(turn)
      store.setPhase('reinforcement')
      const plan = store.arrivalPlan
      if (plan === null || plan.removals.length > 0) continue
      const index = plan.units.findIndex(
        (unit, at) =>
          unit.kind !== 'sp' &&
          unit.kind !== 'unclassified' &&
          (store.arrivalCandidates[at]?.length ?? 0) > 0,
      )
      if (index >= 0) found = index
    }
    expect(found).toBeGreaterThanOrEqual(0)
    const allowed = actionGateOf('rein.arrival')
      .where.filter((item) => item.phase === store.phase)
      .map((item) => item.segment)
    const stepIndex = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
    expect(store.setSegmentStepIndex(stepIndex)).toBe(true)
    expect(store.placeArrivalNow(found, undefined, '99.99')).toBe(false)
    expect(store.reinforcementError?.reason).toBe('arrivalHexOutsideCandidates')
    // 面板把该码翻成「这一格不是入场格…」（见 tests/render/ui-ux-batchC.test.ts）
  }, 60000)
})
