import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers, scenarios } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'
import { runAiStep, type AiContext } from '@/ai/driver'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useSetupStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * PVE 进攻方 AI **多单位撤退**性能基线（9.12）
 *
 * 目的：把「AI 多单位同时撤退很卡」量化成三段耗时（生成快照 / AI 决策+提交 / 单独提交），
 * 并用 4/6/8 枚单位给出曲线；修后 8 枚决策必须在 200ms 内，且撤退结果与修前逐字一致。
 */

/**
 * 攻方用**最弱**的可攻击单位（PJ Bn，0.5RE/枚）：8 枚合计 4RE，堆叠合法（4.8）；
 * 攻方总攻击力低 ⇒ 战斗表给出 Ao1（选项 1），这正是「进攻方多单位撤退」的真实来源。
 */
const ATTACKER_RECORD = () =>
  unitChoices('axis')
    .filter((record) => record.isCombat === true && record.attackCapable === true)
    .sort((a, b) => (a.factors?.combat?.attack ?? 99) - (b.factors?.combat?.attack ?? 99))[0]!

/** 守方用防御力最高的战斗单位（战斗值 20） */
const DEFENDER_RECORD = () =>
  unitChoices('soviet')
    .filter((record) => record.isCombat === true)
    .sort((a, b) => (b.factors?.combat?.attack ?? 0) - (a.factors?.combat?.attack ?? 0))[0]!

/** 活动区内、六邻皆活动区的格（Intro 的活动区限定，见 intro-retreat-advance-map.test.ts） */
const IN_PLAY: ReadonlySet<string> = new Set(
  scenarios.scenarios.find((item) => item.id === 'Intro')?.playArea?.hexes ?? [],
)

const inPlay = (hex: HexRef): boolean => IN_PLAY.has(`${String(hex.col)}.${String(hex.row)}`)

const DEFENDER_HEX: HexRef = (() => {
  for (const key of IN_PLAY) {
    const [col, row] = key.split('.').map(Number)
    const ref = { col: col!, row: row! }
    // 开阔地：装甲类攻方才能「移动进入」该格（9.1f）
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

function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  // 与 intro 用例同口径：按环节清单定位
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

type Stores = {
  workbench: ReturnType<typeof useWorkbenchStore>
  ctx: AiContext
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

/** 开一局 Intro，摆 N 枚攻方 + 1 枚守方，推进到 options 步 */
function openCombat(seed: number, unitCount: number): Stores | null {
  setActivePinia(createPinia())
  const session = useGameSessionStore()
  if (!session.setScenarioId('Intro')) return null
  const setup = useSetupStore()
  const workbench = useWorkbenchStore()
  workbench.resetAll(seed)
  for (let index = 0; index < unitCount; index += 1)
    place(workbench, ATTACKER_RECORD(), ATTACKER_HEX, 'axis', `a${String(index + 1)}`)
  place(workbench, DEFENDER_RECORD(), DEFENDER_HEX, 'soviet', 'd1')
  workbench.setPhase('combat')
  goToActionStep(workbench, 'combat.declare')
  workbench.setTool('battle')
  workbench.setFuelPool(0, 60)
  for (let index = 0; index < unitCount; index += 1)
    workbench.toggleCombatAttacker(`a${String(index + 1)}`)
  if (!workbench.selectCombatDefenderHex(DEFENDER_HEX)) return null
  if (!workbench.beginCombatNow()) return null
  const ctx: AiContext = { workbench, session, setup }
  return { workbench, ctx }
}

const attackerId = (workbench: Stores['workbench']): string =>
  workbench.combatAttackers[0]?.instanceId ?? ''

function supplyBoth(workbench: Stores['workbench']): void {
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

/** 9.5 → 9.9：把战斗推到损失/选项步 */
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
        workbench.combatInputs.attackerArUnitId = attackerId(workbench)
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

/**
 * 9.11/9.10：攻方把选项全部当**撤退**（retreatHexes = 选项数），守方吃损失，
 * 把战斗推到 retreat 步（守方不撤 = 单一变量，便于锁定攻方多单位撤退）。
 */
function driveAttackerRetreat(workbench: Stores['workbench']): boolean {
  let guard = 0
  while (guard < 12) {
    guard += 1
    const state = workbench.combatState
    if (state === null || state.finished) return false
    if (state.step === 'losses') {
      if (!workbench.confirmCombatLosses()) return false
      continue
    }
    if (state.step === 'options') {
      const requirement = workbench.combatRequirement
      if (requirement === null) return false
      if (state.resolution.stage === 'attackerOptions') {
        if (requirement.options <= 0) return false
        workbench.combatInputs.optionRetreatHexes = requirement.options
        workbench.combatInputs.optionLossPoints = 0
      } else {
        const capacity = workbench.battleDefenders.reduce((sum, unit) => sum + unit.steps, 0)
        if (requirement.options > capacity) return false
        workbench.combatInputs.optionRetreatHexes = 0
        workbench.combatInputs.optionLossPoints = requirement.options
      }
      if (!workbench.confirmCombatOptions()) return false
      continue
    }
    break
  }
  return workbench.combatState?.step === 'retreat'
}

/**
 * 撤退计划签名：把「每方撤退格数 + 每单位候选落点（格 / 必死 / ZOC / 完整路径）」压成一行。
 *
 * 修性能不允许改判据 ⇒ 同一场景下这份签名必须与修前**逐字一致**（规则结论锁死）。
 */
function retreatSignature(workbench: Stores['workbench']): string {
  return workbench.combatRetreatPlans
    .map(
      (plan) =>
        `${plan.side}:${String(plan.distance)}:` +
        plan.units
          .map(
            (row) =>
              `${row.unitId}=` +
              row.destinations
                .map(
                  (destination) =>
                    `${String(destination.hex.col)}.${String(destination.hex.row)}` +
                    `${destination.forcedDestruction ? '!' : ''}` +
                    `${destination.inEnemyZoc ? 'z' : ''}` +
                    `[${destination.path
                      .map((hex) => `${String(hex.col)}.${String(hex.row)}`)
                      .join('>')}]`,
                )
                .join(','),
          )
          .join(';'),
    )
    .join('|')
}

/** 撤退落地后的盘面签名：各单位最终所在格（9.12 的实际结果） */
function landedSignature(workbench: Stores['workbench']): string {
  return workbench.units
    .filter((unit) => unit.instanceId.startsWith('a'))
    .map((unit) => `${unit.instanceId}@${String(unit.hex.col)}.${String(unit.hex.row)}`)
    .join(',')
}

/**
 * 修前实测的签名（2026-11-16，性能修复之前用同一场景跑出，4/6/8 三档逐字一致）：
 *
 * 本场景里同堆叠的各枚单位参数相同，故每枚单位的落点串相同、落地格相同。
 * 修后必须逐字相同 —— 剪枝只剪「不可能到达」的分支，缓存只复用同参数同事实的结论。
 */
const EXPECTED_UNIT_DESTINATIONS = '5.25![5.25],5.26[5.26],6.26[6.26],7.25[7.25],7.26[7.26]'
const EXPECTED_LANDED_HEX = '5.26'

function expectedPlansSignature(unitCount: number): string {
  const rows = Array.from(
    { length: unitCount },
    (_unused, index) => `a${String(index + 1)}=${EXPECTED_UNIT_DESTINATIONS}`,
  )
  return `attacker:1:${rows.join(';')}`
}

function expectedLandedSignature(unitCount: number): string {
  const rows = Array.from(
    { length: unitCount },
    (_unused, index) => `a${String(index + 1)}@${EXPECTED_LANDED_HEX}`,
  )
  return rows.join(',')
}

describe('PVE 多单位撤退性能（9.12）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('8 枚攻方同时撤退：AI 决策 200ms 内，且撤退结论与修前逐字一致', () => {
    const rows: string[] = []
    for (const unitCount of [4, 6, 8]) {
      const found = findRetreatBattle(unitCount)
      expect(found, `${String(unitCount)} 枚攻方找不到「必须在选项中撤退」的战斗`).not.toBeNull()
      const { seed } = found!

      // ① 生成快照（撤退计划投影，冷）+ 修前/修后签名
      const first = openCombat(seed, unitCount)!
      driveToResolution(first.workbench)
      expect(driveAttackerRetreat(first.workbench)).toBe(true)
      first.workbench.combatInputs = { ...first.workbench.combatInputs, retreatPaths: {} }
      const snapshotStart = performance.now()
      const plans = first.workbench.combatRetreatPlans
      const snapshotMs = performance.now() - snapshotStart
      const plansSignature = retreatSignature(first.workbench)

      // ② AI 决策 + 提交（单步；含生成快照）
      first.workbench.combatInputs = { ...first.workbench.combatInputs, retreatPaths: {} }
      const aiStart = performance.now()
      const step = runAiStep(first.ctx, { control: 'both' })
      const aiMs = performance.now() - aiStart
      expect(step.ok, `AI 撤退提交失败：${step.reason ?? ''}`).toBe(true)
      expect(step.intent).toBe('combatRetreatPaths')
      const landed = landedSignature(first.workbench)

      // ③ 单独提交：另一局同场景，落点按计划写好后只跑 confirm（引擎校验本身）
      const second = openCombat(seed, unitCount)!
      driveToResolution(second.workbench)
      expect(driveAttackerRetreat(second.workbench)).toBe(true)
      const paths: Record<string, string> = {}
      for (const plan of plans) {
        for (const row of plan.units) {
          const destination = row.destinations[0]
          if (destination === undefined) continue
          paths[row.unitId] = destination.path.map((hex) => `${hex.col}.${hex.row}`).join(',')
        }
      }
      second.workbench.combatInputs = { ...second.workbench.combatInputs, retreatPaths: paths }
      const commitStart = performance.now()
      const committed = second.workbench.confirmCombatRetreats()
      const commitMs = performance.now() - commitStart
      expect(committed).toBe(true)

      rows.push(
        `单位 ${String(unitCount)}（seed ${String(seed)}）：快照 ${snapshotMs.toFixed(1)}ms / ` +
          `AI 决策+提交 ${aiMs.toFixed(1)}ms / 单独提交 ${commitMs.toFixed(1)}ms / ` +
          `动作 ${step.intent} ok=${String(step.ok)}`,
      )
      console.log(rows[rows.length - 1])

      // 修后门槛：8 枚单位的整步决策必须 200ms 内
      if (unitCount === 8) expect(aiMs).toBeLessThan(200)
      // 结论锁：同一场景的落点/路径/落地格与修前逐字一致
      expect(plansSignature, `${String(unitCount)} 枚：撤退落点集合变了`).toBe(
        expectedPlansSignature(unitCount),
      )
      expect(landed, `${String(unitCount)} 枚：撤退落地结果变了`).toBe(
        expectedLandedSignature(unitCount),
      )
    }
    console.log(rows.join('\n'))
  }, 180_000)
})

/** 逐种子找「攻方必须在选项中撤退且单位全活」的战斗 */
function findRetreatBattle(unitCount: number): { seed: number } | null {
  for (let seed = 1; seed <= 400; seed += 1) {
    const stores = openCombat(seed, unitCount)
    if (stores === null) continue
    driveToResolution(stores.workbench)
    if (!driveAttackerRetreat(stores.workbench)) continue
    if (stores.workbench.combatRetreatPlans[0]?.units.length !== unitCount) continue
    return { seed }
  }
  return null
}
