import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers, scenarios } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'
import { createAiMemory, runAiStep, snapshotOf, type AiContext } from '@/ai/driver'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useSetupStore,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * 9.10a / 9.12：选项步的「退 k 格」预演与 AI 的切分（2026-11-25 用户报障回归）
 *
 * 报障两半：
 * 1.「AI 不点撤退」——修前判据读 `retreatPlans`，而它要等选项落盘后才建，站在选项面板上恒为空
 *    ⇒ 判定退化成常量「一律吃损失」；
 * 2.「与玩家进攻交互时撤退卡住」——守方的选项点数超过它**当前**可用军力（9.11）时，
 *    「全吃」被拒、又不试「退 k + 吃 N-k」，AI 反复提交同一动作，界面僵在选项步。
 *
 * 本用例钉三件事：
 * - 选项步就能拿到整侧落点预演（`combatOptionRetreatLadder`）与可用军力（`combatOptionCapacity`）；
 * - 候选切分里存在「损失点 ≤ 可用军力」且总和＝选项数的解；
 * - 上述僵局场景下 `runAiStep` 能真的把守方选项落盘（不再连续被拒）。
 */

const IN_PLAY: ReadonlySet<string> = new Set(
  scenarios.scenarios.find((item) => item.id === 'Intro')?.playArea?.hexes ?? [],
)
const inPlay = (hex: HexRef): boolean => IN_PLAY.has(`${String(hex.col)}.${String(hex.row)}`)

const DEFENDER_HEX: HexRef = (() => {
  for (const key of IN_PLAY) {
    const [col, row] = key.split('.').map(Number)
    const ref = { col: col!, row: row! }
    const found = mapLayers.hexes.find((hex) => hex.col === ref.col && hex.row === ref.row)
    if (found === undefined || found.terrain !== 'Open') continue
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

type Record = ReturnType<typeof unitChoices>[number]

/** 攻方：最弱但**能承受 1 点损失**（≥2 步）的战斗单位 ⇒ 守方不能靠 9.10c 忽略混过去 */
const ATTACKER_RECORD = (): Record =>
  unitChoices('axis')
    .filter((record) => record.isCombat === true && record.attackCapable === true)
    .filter(
      (record) =>
        toConsoleUnit({
          record,
          instanceId: 'probe',
          hex: ATTACKER_HEX,
          side: 'axis',
          face: 'combat',
        }).steps >= 2,
    )
    .sort((a, b) => (a.factors?.combat?.attack ?? 99) - (b.factors?.combat?.attack ?? 99))[0]!

/**
 * 守方：3 步的战斗单位
 *
 * 报障形态是「选项点数 > **当前**可用军力」：3 步守方先吃 L2 掉到 1 步，战果再给 `o2/o3`
 * （CRT 的 `DL1o2` / `DL2o3` 行），于是选项点数超过它剩下的军力。
 */
const THIN_DEFENDERS = (): Record[] =>
  unitChoices('soviet')
    .filter((record) => record.isCombat === true)
    .filter(
      (record) =>
        toConsoleUnit({
          record,
          instanceId: 'probe',
          hex: DEFENDER_HEX,
          side: 'soviet',
          face: 'combat',
        }).steps === 3,
    )
    .slice(0, 8)

function place(
  workbench: ReturnType<typeof useWorkbenchStore>,
  record: Record,
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side, face: 'combat' })
  workbench.units.push(unit)
  return unit
}

function goToDeclareStep(store: {
  phase: ReturnType<typeof useWorkbenchStore>['phase']
  playerSegmentSteps: readonly { id: string }[]
  setSegmentStepIndex(index: number): boolean
}): void {
  const allowed = actionGateOf('combat.declare')
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error('战斗段没有允许 9.1 的环节')
  if (!store.setSegmentStepIndex(index)) throw new Error('进入环节失败')
}

function build(
  seed: number,
  defender: Record,
  attacker: Record,
): { workbench: ReturnType<typeof useWorkbenchStore>; ctx: AiContext } | null {
  setActivePinia(createPinia())
  const session = useGameSessionStore()
  if (!session.setScenarioId('Intro')) return null
  const setup = useSetupStore()
  const workbench = useWorkbenchStore()
  workbench.resetAll(seed)
  place(workbench, attacker, ATTACKER_HEX, 'axis', 'a1')
  place(workbench, defender, DEFENDER_HEX, 'soviet', 'd1')
  workbench.setPhase('combat')
  goToDeclareStep(workbench)
  workbench.setTool('battle')
  workbench.setFuelPool(0, 60)
  workbench.toggleCombatAttacker('a1')
  if (!workbench.selectCombatDefenderHex(DEFENDER_HEX)) return null
  if (!workbench.beginCombatNow()) return null
  return { workbench, ctx: { workbench, session, setup } }
}

function supplyBoth(workbench: ReturnType<typeof useWorkbenchStore>): void {
  workbench.spDumps.push(
    { id: 'sd-a', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 90, t: 0 },
    { id: 'sd-d', hex: { ...DEFENDER_HEX }, side: 'soviet', sp: 90, t: 0 },
  )
  for (const entry of workbench.combatSupplyDumps) {
    if (workbench.combatSupplyDumpIds[entry.side] !== null) continue
    const dump = entry.dumps[0]
    if (dump !== undefined) workbench.pickCombatSupplyDump(entry.side, dump.id)
  }
}

/** 推进到「守方选项」步；攻方选项按可用军力合法地吃/退 */
function reachDefenderOptions(workbench: ReturnType<typeof useWorkbenchStore>): boolean {
  let guard = 0
  while (guard < 20) {
    guard += 1
    const state = workbench.combatState
    if (state === null || state.finished) return false
    if (state.step === 'combatSupply') {
      supplyBoth(workbench)
      if (!workbench.confirmCombatSupply()) return false
      continue
    }
    if (state.step === 'declareAr') {
      workbench.combatInputs.attackerArUnitId = workbench.combatAttackers[0]?.instanceId ?? null
      if (!workbench.declareCombatArStep('attacker')) return false
      workbench.combatInputs.defenderArUnitId = workbench.battleDefenders[0]?.instanceId ?? null
      if (!workbench.declareCombatArStep('defender')) return false
      continue
    }
    if (state.step === 'declareTerrain') {
      if (!workbench.declareCombatTerrainStep()) return false
      continue
    }
    if (state.step === 'surprise') {
      if (!workbench.rollCombatSurprise()) return false
      if (workbench.combatAwaitingShiftDie) workbench.rollCombatShiftDie()
      continue
    }
    if (state.step === 'battleDice') {
      if (!workbench.rollCombatDice()) return false
      continue
    }
    if (state.step === 'losses') {
      if (!workbench.confirmCombatLosses()) return false
      continue
    }
    if (state.step === 'options') {
      const requirement = workbench.combatRequirement
      if (requirement === null) return false
      if (requirement.side === 'defender') return true
      const split = workbench.combatOptionAttempts[0]
      if (split === undefined) return false
      workbench.combatInputs = {
        ...workbench.combatInputs,
        optionRetreatHexes: split.retreatHexes,
        optionLossPoints: split.lossPoints,
        ignoreOptions: false,
      }
      if (!workbench.confirmCombatOptions()) return false
      continue
    }
    return false
  }
  return false
}

/** 找到「守方选项点数 > 守方可用军力、且守方不能靠 9.10c 忽略」的真实战斗 */
let cached: { defender: Record; seed: number } | null = null
let searched = false

function searchOverCapacityBattle(): { defender: Record; seed: number } | null {
  const attacker = ATTACKER_RECORD()
  for (const defender of THIN_DEFENDERS()) {
    for (let seed = 1; seed <= 60; seed += 1) {
      const stores = build(seed, defender, attacker)
      if (stores === null) continue
      if (!reachDefenderOptions(stores.workbench)) continue
      const requirement = stores.workbench.combatRequirement
      if (requirement === null || requirement.side !== 'defender') continue
      const capacity = stores.workbench.combatOptionCapacity
      if (requirement.options <= capacity) continue
      // 攻方还活着、也没在选项里撤退 ⇒ 9.10c 不成立，守方必须自己满足选项
      const attackerOption = stores.workbench.combatState?.resolution.attacker.option
      if (attackerOption === undefined || attackerOption.retreatHexes > 0) continue
      if (stores.workbench.combatAttackers.length === 0) continue
      return { defender, seed }
    }
  }
  return null
}

/** 场景参数缓存（每次都重建一局，避免用例之间共享盘面） */
function findScenario(): { defender: Record; seed: number } | null {
  if (!searched) {
    cached = searchOverCapacityBattle()
    searched = true
  }
  return cached
}

/** 按缓存场景重开一局，并推进到守方选项步 */
function openOverCapacityBattle(): {
  workbench: ReturnType<typeof useWorkbenchStore>
  ctx: AiContext
  options: number
  capacity: number
} | null {
  const scenario = findScenario()
  if (scenario === null) return null
  const stores = build(scenario.seed, scenario.defender, ATTACKER_RECORD())
  if (stores === null) return null
  if (!reachDefenderOptions(stores.workbench)) return null
  const requirement = stores.workbench.combatRequirement
  if (requirement === null) return null
  return {
    workbench: stores.workbench,
    ctx: stores.ctx,
    options: requirement.options,
    capacity: stores.workbench.combatOptionCapacity,
  }
}

describe('9.10a：选项步的撤退预演与 AI 切分', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('选项步就能预演整侧落点，且候选切分里有「损失 ≤ 可用军力」的解', () => {
    const found = openOverCapacityBattle()
    expect(found, '找不到「守方选项超过可用军力」的真实战斗').not.toBeNull()
    const { workbench, ctx, options, capacity } = found!
    expect(workbench.combatOptionRetreatLadder.length).toBe(options)
    expect(workbench.combatOptionCapacity).toBe(capacity)
    const snap = snapshotOf(ctx, createAiMemory(), 'soviet')
    expect(snap.combat.optionLadder.length).toBe(options)
    expect(snap.combat.optionCapacity).toBe(capacity)
    const attempts = workbench.combatOptionAttempts
    expect(attempts.length).toBeGreaterThan(0)
    for (const split of attempts) {
      expect(split.retreatHexes + split.lossPoints).toBe(options)
      expect(split.lossPoints).toBeLessThanOrEqual(capacity)
    }
  }, 20000)

  it('守方选项超过可用军力：AI 能落盘（修前连续被 9.11 拒绝）', () => {
    const found = openOverCapacityBattle()
    expect(found, '找不到「守方选项超过可用军力」的真实战斗').not.toBeNull()
    const { workbench, ctx, options } = found!
    const step = runAiStep(ctx, { memory: createAiMemory(), control: 'soviet' })
    expect(step.ok, `AI 选项提交失败：${step.rule ?? ''} ${step.reason ?? ''}`).toBe(true)
    expect(step.intent).toBe('combatOptions')
    const state = workbench.combatState
    expect(state?.resolution.defender.option?.points).toBe(options)
    expect(state?.step).not.toBe('options')
  })

  it('有安全落点时应选撤退而不是把单位打成损失（修前恒选 0 退）', () => {
    const found = openOverCapacityBattle()
    expect(found, '找不到「守方选项超过可用军力」的真实战斗').not.toBeNull()
    const { workbench } = found!
    const first = workbench.combatOptionAttempts[0]!
    // 该场景的守方只有 1 步、选项 ≥2 ⇒ 必须靠撤退补足，切分里必有撤退格数
    expect(first.retreatHexes).toBeGreaterThan(0)
  })
})
