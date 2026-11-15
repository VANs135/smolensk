import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers, scenarios } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'
import { hexCanvasPoint } from '@/render/map-layout'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useMapViewStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * F 段收尾（2026-11-15）：在**教学剧本 Intro: Vitebsk** 里用真实地图点击跑完
 *   ① 守方撤退选落点 → 攻方挺进（9.12 / 9.12g）
 *   ② 攻方撤退后不得挺进（9.12g-B / 8.1f）
 *
 * "实点"口径与用户操作一致：撤退落点与推进格都走 `map-view.onHexClick`
 * （不是直接调 `setRetreatDestinationNow` / `advanceNow`）。
 */

/*
 * ed44d89：Intro 的活动区限定 267 格，撤退落点与战后推进都按 `insidePlayArea` 判。
 * 本用例必须落在活动区内，否则实点会被当成「范围外」拒掉（修前用全图首格即踩这个坑）。
 */
const PLAY_AREA: ReadonlySet<string> = (() => {
  const intro = scenarios.scenarios.find((item) => item.id === 'Intro')
  const hexes = intro?.playArea?.hexes ?? []
  return new Set(hexes.map((key) => key))
})()

const inPlay = (hex: HexRef): boolean => PLAY_AREA.has(`${String(hex.col)}.${String(hex.row)}`)

const DEFENDER_HEX: HexRef = (() => {
  for (const key of PLAY_AREA) {
    const [col, row] = key.split('.').map(Number)
    const ref = { col: col!, row: row! }
    if (!mapLayers.hexes.some((hex) => hex.col === ref.col && hex.row === ref.row)) continue
    if (HEX_DIRECTIONS.every((direction) => inPlay(neighbor(ref, direction)))) return ref
  }
  throw new Error('活动区内找不到六邻皆在活动区的格')
})()

const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (!inPlay(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row))
      continue
    return candidate
  }
  throw new Error('防御格没有活动区内的邻格')
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

type Stores = {
  workbench: ReturnType<typeof useWorkbenchStore>
  mapView: ReturnType<typeof useMapViewStore>
}

function place(
  workbench: Stores['workbench'],
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side, face: 'combat' })
  workbench.units.push(unit)
  return unit
}

const attackerRecord = () =>
  unitChoices('axis').find(
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.factors?.combat?.attack ?? 0) >= 20 &&
      (record.steps?.total ?? 0) >= 4,
  )!

const defenderRecord = () =>
  unitChoices('soviet').find(
    (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) >= 5,
  )!

/** 开一局 Intro 并摆一对攻守，返回 workbench/mapView */
function openIntro(seed: number): Stores {
  setActivePinia(createPinia())
  const session = useGameSessionStore()
  expect(session.setScenarioId('Intro')).toBe(true)
  const workbench = useWorkbenchStore()
  const mapView = useMapViewStore()
  workbench.resetAll(seed)
  place(workbench, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
  place(workbench, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
  workbench.setPhase('combat')
  goToActionStep(workbench, 'combat.declare')
  workbench.setTool('battle')
  workbench.setFuelPool(0, 60)
  // 实点：点己方格 ⇒ 加入攻方；点敌方格 ⇒ 锁定防御格
  mapView.onHexClick(ATTACKER_HEX)
  const center = hexCanvasPoint(DEFENDER_HEX)
  mapView.onHexClick(DEFENDER_HEX, undefined, { x: center.x, y: center.y })
  expect(workbench.beginCombatNow()).toBe(true)
  return { workbench, mapView }
}

function supplyBoth(workbench: Stores['workbench']): void {
  workbench.spDumps.push(
    { id: 'sd-a', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 },
    { id: 'sd-d', hex: { ...DEFENDER_HEX }, side: 'soviet', sp: 8, t: 0 },
  )
  for (const entry of workbench.combatSupplyDumps) {
    if (workbench.combatSupplyDumpIds[entry.side] !== null) continue
    const dump = entry.dumps[0]
    if (dump !== undefined) workbench.pickCombatSupplyDump(entry.side, dump.id)
  }
}

/** 9.5 → 9.6 → 9.4 → 9.8 → 9.9 */
function driveToResolution(workbench: Stores['workbench']): void {
  let guard = 0
  while (guard < 16) {
    guard += 1
    const state = workbench.combatState
    if (state === null || state.finished) break
    if (state.step === 'combatSupply') {
      supplyBoth(workbench)
      if (!workbench.confirmCombatSupply()) break
      continue
    }
    if (state.step === 'declareAr') {
      if (workbench.combatInputs.attackerArUnitId === null) {
        workbench.combatInputs.attackerArUnitId = workbench.combatAttackers[0]?.instanceId ?? null
      }
      if (!workbench.declareCombatArStep('attacker')) break
      if (workbench.combatInputs.defenderArUnitId === null) {
        workbench.combatInputs.defenderArUnitId = workbench.battleDefenders[0]?.instanceId ?? null
      }
      if (!workbench.declareCombatArStep('defender')) break
      continue
    }
    if (state.step === 'declareTerrain') {
      if (!workbench.declareCombatTerrainStep()) break
      continue
    }
    if (state.step === 'surprise') {
      if (!workbench.rollCombatSurprise()) break
      if (workbench.combatAwaitingShiftDie) workbench.rollCombatShiftDie()
      continue
    }
    if (state.step === 'battleDice') {
      if (!workbench.rollCombatDice()) break
      continue
    }
    break
  }
}

/** 9.11/9.10：双方损失各按强制值吃；选项按传入策略 */
function driveResolution(
  workbench: Stores['workbench'],
  opts: { attackerRetreats: boolean; defenderRetreats: boolean },
): boolean {
  let guard = 0
  while (guard < 10) {
    guard += 1
    const state = workbench.combatState
    if (state === null || state.finished) break
    if (state.step === 'losses') {
      if (!workbench.confirmCombatLosses()) return false
      continue
    }
    if (state.step === 'options') {
      const requirement = workbench.combatRequirement
      if (requirement === null) return false
      const isAttacker = state.resolution.stage === 'attackerOptions'
      const units = isAttacker ? workbench.combatAttackers : workbench.battleDefenders
      const capacity = units.reduce((sum, unit) => sum + unit.steps, 0)
      const retreats = isAttacker ? opts.attackerRetreats : opts.defenderRetreats
      if (retreats) {
        if (requirement.options <= 0 || capacity < requirement.options) return false
        workbench.combatInputs.optionRetreatHexes = requirement.options
        workbench.combatInputs.optionLossPoints = 0
      } else {
        workbench.combatInputs.optionRetreatHexes = 0
        if (requirement.options > capacity) return false
        workbench.combatInputs.optionLossPoints = requirement.options
      }
      if (!workbench.confirmCombatOptions()) return false
      continue
    }
    break
  }
  return true
}

/** 9.12 实点：给当前待选单位的第一个合法落点点地图 */
function clickAllRetreatsByMap(stores: Stores): boolean {
  for (const plan of stores.workbench.combatRetreatPlans) {
    for (const row of plan.units) {
      const destination = row.destinations[0]
      if (destination === undefined) return false
      stores.mapView.setRetreatUnit(row.unitId)
      stores.mapView.onHexClick(destination.hex)
      if (stores.workbench.combatInputs.retreatPaths[row.unitId] === '') return false
    }
  }
  return true
}

describe('F 段实点（Intro: Vitebsk）：守方撤退 → 攻方挺进 / 攻方撤退 → 不得挺进', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('9.12/9.12g：守方在地图上点落点撤退，攻方在地图上点防御格挺进', () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const stores = openIntro(seed)
      const { workbench, mapView } = stores
      driveToResolution(workbench)
      if (!driveResolution(workbench, { attackerRetreats: false, defenderRetreats: true })) continue
      if (workbench.combatState?.step !== 'retreat') {
        // 无守方撤退可点（选项为 0 或守方已灭）⇒ 换种子
        continue
      }
      expect(clickAllRetreatsByMap(stores)).toBe(true)
      expect(workbench.confirmCombatRetreats()).toBe(true)
      expect(workbench.combatState?.step).toBe('advance')
      expect(workbench.combatState?.finished).not.toBe(true)
      expect(workbench.combatDefendingHexCleared).toBe(true)
      expect(workbench.combatAdvanceHex).toEqual(DEFENDER_HEX)

      // 实点推进格
      const center = hexCanvasPoint(DEFENDER_HEX)
      mapView.onHexClick(DEFENDER_HEX, undefined, { x: center.x, y: center.y })
      expect(workbench.combatInputs.advanceUnitIds.length).toBeGreaterThan(0)
      expect(workbench.confirmCombatAdvance()).toBe(true)
      expect(workbench.combatState?.finished).toBe(true)
      expect(
        workbench.units.some(
          (unit) =>
            unit.side === 'axis' &&
            unit.hex.col === DEFENDER_HEX.col &&
            unit.hex.row === DEFENDER_HEX.row,
        ),
      ).toBe(true)
      return
    }
    throw new Error('120 个种子里没有「守方需撤退且守方存活」的战斗')
  })

  it('9.12g-B：攻方在地图上撤退后没有推进步，点防御格也不得选挺进', () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const stores = openIntro(seed)
      const { workbench, mapView } = stores
      driveToResolution(workbench)
      if (!driveResolution(workbench, { attackerRetreats: true, defenderRetreats: false })) continue
      if (workbench.combatState?.step !== 'retreat') continue
      expect(clickAllRetreatsByMap(stores)).toBe(true)
      expect(workbench.confirmCombatRetreats()).toBe(true)
      // 8.1f/9.12g-B：攻方在选项中撤退 ⇒ 不推进（引擎以「成功但推进 0 单位」收束，
      // step 仍保留 advance 是既有契约，故这里判 finished / 无推进格 / 无推进单位）
      expect(workbench.combatState?.finished).toBe(true)
      expect(workbench.combatAdvanceHex).toBeNull()
      const center = hexCanvasPoint(DEFENDER_HEX)
      mapView.onHexClick(DEFENDER_HEX, undefined, { x: center.x, y: center.y })
      expect(workbench.combatInputs.advanceUnitIds).toEqual([])
      // 本场已收束；此后点地图会按 `battleToolClick` 清掉已结束的战斗（同一枚防御格不再有推进语义）
      expect(workbench.combatState === null || workbench.combatState.finished === true).toBe(true)
      expect(
        workbench.units.some(
          (unit) =>
            unit.side === 'axis' &&
            unit.hex.col === DEFENDER_HEX.col &&
            unit.hex.row === DEFENDER_HEX.row,
        ),
      ).toBe(false)
      return
    }
    throw new Error('120 个种子里没有「攻方需在选项中撤退」的战斗')
  })
})
