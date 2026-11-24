import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { createAiMemory, runAiStep, type AiContext } from '@/ai/driver'
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
  type ConsolePhase,
} from '@/stores'

/**
 * PVE：AI 不能代答玩家的战斗补给（12.4 / 9.5b）
 *
 * 用户 2026-11-16 报：PVE 操作守方，到了「守方支付补给」这一步，地图上没有可点的补给站，
 * 支付进行不下去。根因在 AI 的 `combatSupply` 决策：旧实现只看 `control.attacker`，
 * AI 攻方一票确认**两侧**，把人类守方的付款（从哪座站付 / 拒付改半战斗值）一并代答。
 *
 * 原文（12.4）：攻方 1T／攻击军力、守方 2T/战斗（≤1RE 为 1T）；来源为 12.3a 直接拖取
 * 或 12.3b HQ 投递；守方**可选**不付（9.5b，改以一半战斗值防御）。付不付、从哪付属于
 * 该方自己的决定 ⇒ AI 只能落它控制的一方。
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
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row))
      continue
    if (canEnter('leg', candidate, DEFENDER_HEX)) return candidate
  }
  throw new Error('防御格没有「步兵可进入」的图内邻格')
})()

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

/** 摆一场：轴心攻方在邻格、守方在防御格；默认双方各给一座够付的站 */
function mountBattle(options: {
  activeSide: 'axis' | 'soviet'
  attackerSide: 'axis' | 'soviet'
  defenderSide: 'axis' | 'soviet'
  defenderDump: boolean
}) {
  setActivePinia(createPinia())
  const w = useWorkbenchStore()
  const g = useGameSessionStore()
  const setup = useSetupStore()
  const mapView = useMapViewStore()
  const hotseat = useHotseatStore()

  w.activeSide = options.activeSide
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

  const attacker = toConsoleUnit({
    record: pick(options.attackerSide),
    instanceId: 'a1',
    hex: ATTACKER_HEX,
    side: options.attackerSide,
  })
  const defender = toConsoleUnit({
    record: pick(options.defenderSide),
    instanceId: 'd1',
    hex: DEFENDER_HEX,
    side: options.defenderSide,
  })
  w.units.push(attacker, defender)
  w.spDumps.push({
    id: 'sd-att',
    side: options.attackerSide,
    hex: { ...ATTACKER_HEX },
    sp: 4,
    t: 0,
  })
  if (options.defenderDump) {
    w.spDumps.push({
      id: 'sd-def',
      side: options.defenderSide,
      hex: { ...DEFENDER_HEX },
      sp: 2,
      t: 0,
    })
  }

  w.clickHex(DEFENDER_HEX)
  if (!w.combatAttackerIds.includes(attacker.instanceId))
    w.toggleCombatAttacker(attacker.instanceId)
  expect(w.beginCombatNow()).toBe(true)
  expect(w.combatState?.step).toBe('combatSupply')

  const ctx: AiContext = { workbench: w, session: g, setup }
  return { w, g, setup, mapView, hotseat, ctx, attacker, defender }
}

describe('PVE 战斗补给：AI 只答自己那一侧（12.4 / 9.5b）', () => {
  it('AI 攻方只确认攻方；守方候选与地图落点都还在，玩家能自己付款', () => {
    const { w, g, mapView, hotseat, ctx } = mountBattle({
      activeSide: 'axis',
      attackerSide: 'axis',
      defenderSide: 'soviet',
      defenderDump: true,
    })
    hotseat.mode = 'pve'
    hotseat.aiSide = 'axis'
    hotseat.setViewerSide('soviet')

    const ai = runAiStep(ctx, { memory: createAiMemory(), control: 'axis' })
    expect(ai.intent).toContain('combatSupply:attacker')
    expect(w.combatState?.step, 'AI 不得推进整个补给步（守方还没答）').toBe('combatSupply')
    expect(w.combatInputs.supplyConfirmed).toEqual({ attacker: true, defender: false })
    expect(w.combatInputs.defenderProvides, '守方付款与否仍由玩家决定').toBe(true)

    // 守方候选与地图可点来源都在
    const defenderDumps = w.combatSupplyDumps.find((entry) => entry.side === 'defender')?.dumps
    expect(defenderDumps?.map((dump) => dump.id)).toEqual(['sd-def'])
    expect(mapView.combatSourceDumps.map((entry) => `${entry.side}:${entry.id}`)).toContain(
      'defender:sd-def',
    )

    // 玩家真实点图：守方站被选为来源
    mapView.onHexClick({ ...DEFENDER_HEX }, undefined, hexCanvasPoint(DEFENDER_HEX), 0.5)
    expect(w.combatSupplyDumpIds.defender).toBe('sd-def')
    expect(w.combatInputs.defenderAvailableT).toBeGreaterThanOrEqual(2)

    // 玩家确认守方 + 进入行动值（9.6）
    expect(w.confirmCombatSupplySide('defender')).toBe(true)
    expect(w.confirmCombatSupply()).toBe(true)
    expect(w.combatState?.step).toBe('declareAr')
    expect(w.spDumps.find((dump) => dump.id === 'sd-def')!.sp).toBeLessThan(2)
    expect(g.terminated).toBe(false)
  })

  it('守方无站也不许 AI 代拒付：守方支付保持玩家选择（可改半战斗值）', () => {
    const { w, ctx } = mountBattle({
      activeSide: 'axis',
      attackerSide: 'axis',
      defenderSide: 'soviet',
      defenderDump: false,
    })
    runAiStep(ctx, { memory: createAiMemory(), control: 'axis' })

    expect(w.combatState?.step).toBe('combatSupply')
    expect(w.combatInputs.defenderProvides, 'AI 不得替玩家勾掉/勾上守方支付').toBe(true)
    expect(w.combatInputs.supplyConfirmed.defender).toBe(false)

    // 玩家选择不付（9.5b）⇒ 仍能推进
    w.combatInputs = { ...w.combatInputs, defenderProvides: false }
    expect(w.confirmCombatSupplySide('defender')).toBe(true)
    expect(w.confirmCombatSupply()).toBe(true)
    expect(w.combatState?.step).toBe('declareAr')
  })

  it('镜像：人类攻方先确认，AI 守方才落自己那一侧；无站但储备可用 ⇒ 按 12.10a 付储备', () => {
    const { w, ctx } = mountBattle({
      activeSide: 'soviet',
      attackerSide: 'soviet',
      defenderSide: 'axis',
      defenderDump: false,
    })

    // 攻方未确认 ⇒ AI 守方必须停手
    const first = runAiStep(ctx, { memory: createAiMemory(), control: 'axis' })
    expect(first.intent).toBe('wait')
    expect(w.combatInputs.supplyConfirmed.defender).toBe(false)

    // 人类攻方付款并确认
    expect(w.pickCombatSupplyDump('attacker', 'sd-att')).toBe(true)
    expect(w.confirmCombatSupplySide('attacker')).toBe(true)

    // AI 守方这时才落自己一侧：图上无来源（12.10a 的前提）⇒ 用自己的部队储备
    const second = runAiStep(ctx, { memory: createAiMemory(), control: 'axis' })
    expect(second.intent).toContain('combatSupply:defender')
    expect(w.combatInputs.supplyConfirmed.defender).toBe(true)
    expect(w.combatInputs.defenderProvides).toBe(true)
    expect(w.combatInputs.defenderUsesInternalStocks).toBe(true)
    expect(w.combatState?.step).toBe('combatSupply')

    // 两侧齐 ⇒ 玩家点「进入行动值」；12.10b：动用储备的单位标记为「低下」
    expect(w.confirmCombatSupply()).toBe(true)
    expect(w.combatState?.step).toBe('declareAr')
    expect(w.units.find((unit) => unit.instanceId === 'd1')?.internalStocks).toBe('low')
  })

  it('12.10a：AI 攻方图上够额时不得动储备；图上无站时才用自己的储备', () => {
    // ① 有站且够额（sd-att 4 SP = 16 T ≥ 攻方需求）⇒ 储备不置位
    const withDump = mountBattle({
      activeSide: 'axis',
      attackerSide: 'axis',
      defenderSide: 'soviet',
      defenderDump: true,
    })
    runAiStep(withDump.ctx, { memory: createAiMemory(), control: 'axis' })
    const attackerWithDump = withDump.w.units.find((unit) => unit.instanceId === 'a1')!
    expect(withDump.w.combatInputs.attackerUsesInternalStocks).toBe(false)
    expect(attackerWithDump.internalStocks).toBeNull()

    // ② 图上无站 ⇒ 攻方改用自己的储备（不再是"根本不攻击"的 combatSkip）
    const noDump = mountBattle({
      activeSide: 'axis',
      attackerSide: 'axis',
      defenderSide: 'soviet',
      defenderDump: true,
    })
    noDump.w.spDumps = noDump.w.spDumps.filter((dump) => dump.id !== 'sd-att')
    const ai = runAiStep(noDump.ctx, { memory: createAiMemory(), control: 'axis' })
    expect(ai.intent).toContain('combatSupply:attacker')
    expect(ai.ok).toBe(true)
    expect(noDump.w.combatInputs.supplyConfirmed.attacker).toBe(true)
    expect(noDump.w.combatInputs.attackerUsesInternalStocks).toBe(true)
    expect(noDump.w.combatState?.step).toBe('combatSupply')
  })
})
