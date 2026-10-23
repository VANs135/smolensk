import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { createMapFacts, selectMovementTerrain } from '@/engine/rules'
import { createRngState } from '@/engine/rng'
import {
  actionGateOf,
  defenseTerrainChoices,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * 第五批 A3（docs/第五批修改方案.md 族 A3）：9.10 **选项**的军力损失分配也受 9.11c 约束，
 * 且拥有者玩家有分配入口（9.11a）
 *
 * 病灶：`planOptions`（combat-interaction.ts）的注释把 9.11c 末段读宽了——那段只豁免
 * 「**轰炸或撤退**中产生的军力损失」（txt:1377-1380），**选项损失是战斗结果中的损失** ⇒
 * 「AR 单位必须承受己方第一点；各受一点后才能有单位受第二点」照样适用（9.6 重要提示
 * txt:1255-1258 同旨）。修前实现按「剩余军力**从高到低**」确定性硬分 ⇒ AR 单位可能不受第一点、
 * 单位可能没轮到就受第二点；且玩家没有任何分配入口（面板只有点数输入）。
 *
 * 修后口径（本切片）：① 玩家**未给**分配 ⇒ 引擎按 `allocateBattleLosses` 的**规范分配**
 * （AR 优先＋均匀展开——两条都合法，旧测试与 NKVD 覆盖路径照常走）；
 * ② 玩家**给了**分配 ⇒ `validateBattleLossAllocation` 严格校验（与强制损失同一处判据）。
 *
 * ★ 测法边界（如实）：引擎层的 `planOptions` 单元断言不单独建（构造 `CombatInteractionState`
 *   夹具成本高），本文件经 store 的 `confirmCombatOptions` 端到端覆盖同一段判据；
 *   骰面由种子驱动 ⇒ 用"扫种子"找"守方选项 ≥2"的骰序（找不到即抛错，不静默跳过）。
 *   面板像素无断言（无组件渲染测试），分配入口的接线靠源码守卫。
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

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

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

function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`${side} 单位库里找不到满足条件的记录`)
  return found
}

const attackerRecord = (): ReturnType<typeof unitChoices>[number] =>
  pickRecord(
    'axis',
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.attack ?? 0) >= 3,
  )

const defenderRecord = (): ReturnType<typeof unitChoices>[number] =>
  pickRecord(
    'soviet',
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.factors?.combat?.attack ?? 0) >= 1,
  )

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

/** 摆好攻守并走到「战斗补给」步（9.2 第 1 步）；守方两枚（d1 为 AR 单位、步数较小）＋ d3 */
function setupBattle(store: ReturnType<typeof newStore>) {
  store.setPhase('combat')
  goToActionStep(store, 'combat.declare')
  store.setTool('battle')
  store.setFuelPool(0, 20)
  const attacker = place(store, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
  const defender = place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
  const helper = place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd2')
  place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd3')
  // 与 flow 夹具同口径：摊开攻方与防御格，建立交战（没有这两击就没有战斗目标）
  store.clickHex(ATTACKER_HEX)
  store.clickHex(DEFENDER_HEX)
  return { attacker, defender, helper }
}

function declareSupplyForBoth(store: ReturnType<typeof newStore>): void {
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

function driveToResolution(store: ReturnType<typeof newStore>) {
  const opened = store.beginCombatNow()
  if (opened) declareSupplyForBoth(store)
  expect(opened).toBe(true)
  expect(store.confirmCombatSupply()).toBe(true)
  store.combatInputs.attackerArUnitId = store.combatAttackers[0]!.instanceId
  store.declareCombatArStep('attacker')
  store.combatInputs.defenderArUnitId = 'd1'
  store.declareCombatArStep('defender')
  expect(store.declareCombatTerrainStep()).toBe(true)
  store.rollCombatSurprise()
  if (store.combatAwaitingShiftDie) store.rollCombatShiftDie()
  expect(store.rollCombatDice()).toBe(true)
}

/**
 * 结算到「守方选项」步并要求**守方选项 ≥2**（扫种子；攻方选项用损失先清掉）
 * 返回时：stage === 'defenderOptions'，且未给任何 lossAllocation（修前口径的输入）。
 */
function driveToDefenderOptions(store: ReturnType<typeof newStore>): void {
  expect(store.confirmCombatLosses()).toBe(true)
  let guard = 0
  while (store.combatState?.resolution.stage === 'attackerOptions') {
    guard += 1
    if (guard > 8) throw new Error('攻方选项环没有收敛')
    const requirement = store.combatRequirement
    if (requirement === null) throw new Error('此刻不该没有损失/选项需求')
    const capacity = store.combatAttackers.reduce((sum, unit) => sum + unit.steps, 0)
    if (requirement.options > capacity) throw new Error('夹具需要攻方撤退，换个种子')
    store.combatInputs.optionRetreatHexes = 0
    store.combatInputs.optionLossPoints = requirement.options
    expect(store.confirmCombatOptions()).toBe(true)
    if (store.combatState?.step !== 'losses') break
    expect(store.confirmCombatLosses()).toBe(true)
  }
  if (store.combatState?.resolution.stage !== 'defenderOptions') {
    // 守方强制损失可能还没确认（攻方无选项时直落守方损失）
    if (store.combatState?.step === 'losses') expect(store.confirmCombatLosses()).toBe(true)
  }
  if (store.combatState?.resolution.stage !== 'defenderOptions') {
    throw new Error('没走到守方选项步（该换种子）')
  }
  const requirement = store.combatRequirement
  if (requirement === null || requirement.options < 2) {
    throw new Error('守方选项不足 2 点（该换种子）')
  }
}

/** 扫种子跑到「守方选项 ≥2」的那一局（夹具前提自检；找不到即抛错） */
function scanSeed(minSeed: number, maxSeed: number): ReturnType<typeof newStore> {
  for (let seed = minSeed; seed <= maxSeed; seed += 1) {
    const store = newStore()
    store.rng = createRngState(seed)
    setupBattle(store)
    // 守方军力造型：d1（AR 单位）2 步、d2 4 步、d3 3 步 ⇒ 旧"从高到低"会把损失全压给 d2
    const d1 = store.units.find((unit) => unit.instanceId === 'd1')
    const d2 = store.units.find((unit) => unit.instanceId === 'd2')
    if (d1 === undefined || d2 === undefined) throw new Error('夹具里找不到守方单位')
    d1.steps = 2
    d2.steps = 4
    try {
      driveToResolution(store)
      if (store.combatState === null || store.combatState.step !== 'losses') continue
      driveToDefenderOptions(store)
      // 三枚守方都还活着（强制损失没打死谁）⇒ 选项分配的增量断言才有干净基线
      const alive = ['d1', 'd2', 'd3'].every((id) =>
        store.units.some((unit) => unit.instanceId === id),
      )
      if (!alive) continue
      return store
    } catch {
      continue // 该种子不满足夹具前提 ⇒ 换下一个
    }
  }
  throw new Error(`扫了 ${minSeed}–${maxSeed} 号种子都没有"守方选项 ≥2"的骰序（用例前提不成立）`)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('第五批 A3：9.10 选项损失的分配（9.11a/9.11c）', () => {
  /*
   * ★ 超时（2026-10-15 修正）：这两条用**扫种子**建现场（最多 400 个种子、每个都建一次 store）——
   *   单跑 300–700 ms，但整仓并发门禁下实测 **5170 ms** ⇒ 触发 vitest 默认 5 s 超时（不是断言失败）。
   *   与仓库既有先例同口径（`setup-sp-dumps-flow.test.ts` 的 `60_000`）显式给足超时；
   *   判据与断言一字未动。
   */
  it('未给分配 ⇒ 按规范分配（AR 单位先受第一点），不再"从高到低"', () => {
    const store = scanSeed(1, 400)
    // 旧口径：从高到低 ⇒ 损失全压给步数最多者（d2）；9.11c：第一点归 AR 单位 d1
    const stepsBefore = new Map(store.units.map((unit) => [unit.instanceId, unit.steps]))
    store.combatInputs.optionRetreatHexes = 0
    store.combatInputs.optionLossPoints = 2
    expect(store.confirmCombatOptions()).toBe(true)
    const delta = (id: string): number =>
      (stepsBefore.get(id) ?? 0) - (store.units.find((unit) => unit.instanceId === id)?.steps ?? 0)
    // 9.11c 首句：第一点必须归 AR 单位 d1（修前 d1 的 delta 是 0 ⇒ 红）
    expect(delta('d1'), 'AR 单位必须先受第一点（9.11c 首句）').toBe(1)
    // 均匀展开：2 点落在两枚不同单位上，没有人先受第二点
    expect(delta('d2') + delta('d3')).toBe(1)
    expect(Math.max(delta('d1'), delta('d2'), delta('d3'))).toBeLessThanOrEqual(1)
  }, 30_000)

  it('玩家给的合法分配被采纳（第二点改派 d3）；跳过 AR 单位的分配被拒（9.11c）', () => {
    const store = scanSeed(1, 400)
    const stepsBefore = new Map(store.units.map((unit) => [unit.instanceId, unit.steps]))
    store.combatInputs.optionRetreatHexes = 0
    store.combatInputs.optionLossPoints = 2
    // 9.11a 授权下的另一份合法分配：AR（d1）受第一点后，第二点由玩家选 d3（而不是规范分配里的另一枚）
    store.combatInputs.optionLossAllocation = { d1: 1, d3: 1 }
    expect(store.confirmCombatOptions()).toBe(true)
    const delta = (id: string): number =>
      (stepsBefore.get(id) ?? 0) - (store.units.find((unit) => unit.instanceId === id)?.steps ?? 0)
    expect(delta('d1'), 'AR 单位仍须先受第一点').toBe(1)
    expect(delta('d3'), '玩家把第二点改派给 d3 ⇒ 应被采纳').toBe(1)
    expect(delta('d2'), 'd2 未被分到损失').toBe(0)

    // 违规分配：跳过 AR 单位 ⇒ 9.11c 拒（修前分配根本不上交 ⇒ 这一步会成功 ⇒ 红）
    const store2 = scanSeed(1, 400)
    store2.combatInputs.optionRetreatHexes = 0
    store2.combatInputs.optionLossPoints = 2
    store2.combatInputs.optionLossAllocation = { d2: 2 }
    expect(store2.confirmCombatOptions()).toBe(false)
    expect(store2.combatError?.rule).toBe('9.11c')
  }, 30_000)

  it('源码守卫：面板的选项块有逐单位分配输入（读 store 投影）', () => {
    const panel = readFileSync('src/components/combat/CombatPanel.vue', 'utf8')
    expect(panel).toContain('workbench.combatOptionLossTargets')
    expect(panel).toContain('optionLossAllocation')
  })
})
