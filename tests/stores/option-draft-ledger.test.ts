import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

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
  useMapViewStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * 批 F·F1（条 15/16）：选项战果页「草稿账本」＋「受损 / 撤退（1 格）」双按钮
 *
 * 用户口径：
 *   ① 选项点数的消耗改成逐次点选——点"受损"再点单位图即受损；点"撤退"再点可撤退格即撤退；
 *   ② 每次应用只进**草稿账本**（不落盘），最后「提交」才一次性交给引擎（`planOptions` 不改）；
 *   ③ 攻方全灭时守方给「不选 / 结束战斗」一键（9.10c 例 B）。
 *
 * 夹具沿用 `option-loss-allocation.test.ts` 的扫种子建场（守方三枚、选项 ≥2），
 * 骰面由种子驱动 ⇒ 用"扫种子"找"守方选项 ≥2"的骰序（找不到即抛错，不静默跳过）。
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

function setupBattle(store: ReturnType<typeof newStore>) {
  store.setPhase('combat')
  goToActionStep(store, 'combat.declare')
  store.setTool('battle')
  store.setFuelPool(0, 20)
  const attacker = place(store, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
  const defender = place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
  place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd2')
  place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd3')
  store.clickHex(ATTACKER_HEX)
  store.clickHex(DEFENDER_HEX)
  return { attacker, defender }
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

/** 扫种子跑到「守方选项 ≥2」的那一局（三枚守方都还活着 ⇒ 增量断言有干净基线） */
function scanSeed(minSeed: number, maxSeed: number): ReturnType<typeof newStore> {
  for (let seed = minSeed; seed <= maxSeed; seed += 1) {
    const store = newStore()
    store.rng = createRngState(seed)
    setupBattle(store)
    const d1 = store.units.find((unit) => unit.instanceId === 'd1')
    const d2 = store.units.find((unit) => unit.instanceId === 'd2')
    if (d1 === undefined || d2 === undefined) throw new Error('夹具里找不到守方单位')
    d1.steps = 2
    d2.steps = 4
    try {
      driveToResolution(store)
      if (store.combatState === null || store.combatState.step !== 'losses') continue
      driveToDefenderOptions(store)
      const alive = ['d1', 'd2', 'd3'].every((id) =>
        store.units.some((unit) => unit.instanceId === id),
      )
      if (!alive) continue
      return store
    } catch {
      continue
    }
  }
  throw new Error(`扫了 ${minSeed}–${maxSeed} 号种子都没有"守方选项 ≥2"的骰序（用例前提不成立）`)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('批 F·F1（条 15/16）：选项页草稿账本与「受损 / 撤退（1 格）」双按钮', () => {
  /*
   * ★ 超时：扫种子建现场（每个种子都建一次 store）——与 option-loss-allocation.test.ts 同口径
   *   显式给足超时（判据与断言本身不变）。
   */
  it('双按钮逐次应用只进草稿账本（不落盘）；提交后引擎一次性结算', () => {
    const store = scanSeed(1, 400)
    const points = store.optionDraftPoints
    expect(points).toBeGreaterThanOrEqual(2)
    const stepsBefore = new Map(store.units.map((unit) => [unit.instanceId, unit.steps]))

    // ① 点"受损"两次（两枚不同单位各 1 点）——只进草稿，盘面不动
    expect(store.applyOptionDraftLoss('d1')).toBe(true)
    expect(store.applyOptionDraftLoss('d2')).toBe(true)
    expect(store.optionDraftUsed).toBe(2)
    expect(store.optionDraftRemaining).toBe(points - 2)
    expect(store.optionDraftEntries).toHaveLength(2)
    expect(store.units.find((unit) => unit.instanceId === 'd1')?.steps).toBe(stepsBefore.get('d1'))

    // ② 点数不够时拒绝再应用（草稿层护栏）
    if (points === 2) {
      expect(store.applyOptionDraftLoss('d3')).toBe(false)
      expect(store.applyOptionDraftRetreat(1)).toBe(false)
    }

    // ③ 提交 ⇒ planOptions 一发结算：d1（AR 单位）先受第一点、均匀展开（9.11c）
    expect(store.confirmCombatOptions()).toBe(true)
    const delta = (id: string): number =>
      (stepsBefore.get(id) ?? 0) - (store.units.find((unit) => unit.instanceId === id)?.steps ?? 0)
    expect(delta('d1'), 'AR 单位先受第一点（9.11c）').toBe(1)
    expect(delta('d2')).toBe(1)
    expect(delta('d3')).toBe(0)
    // ④ 提交后草稿收起（流水清空、模式回 idle）
    expect(store.optionDraftEntries).toHaveLength(0)
    expect(store.optionDraftMode).toBe('idle')
  }, 30_000)

  it('草稿可逐次撤销（流水末条按量精确回退）', () => {
    const store = scanSeed(1, 400)
    // 守方选项 ≥2 ⇒ 一笔损失 + 一笔撤退必定放得下（哪枚还有军力可损由事实决定）
    const lossTarget = ['d1', 'd2', 'd3'].find((id) => store.applyOptionDraftLoss(id))
    expect(lossTarget, '至少一枚守方还有军力可损').toBeDefined()
    expect(store.applyOptionDraftRetreat(1)).toBe(true)
    expect(store.combatInputs.optionLossPoints).toBe(1)
    expect(store.combatInputs.optionRetreatHexes).toBe(1)
    expect(store.combatInputs.optionLossAllocation[lossTarget!]).toBe(1)

    // 逆序撤销：先撤撤退、再撤损失
    expect(store.undoOptionDraftLast()).toBe(true)
    expect(store.combatInputs.optionRetreatHexes).toBe(0)
    expect(store.combatInputs.optionLossPoints).toBe(1)
    expect(store.undoOptionDraftLast()).toBe(true)
    expect(store.combatInputs.optionLossPoints).toBe(0)
    expect(store.combatInputs.optionLossAllocation[lossTarget!]).toBeUndefined()
    expect(store.optionDraftUsed).toBe(0)
    // 撤空了再撤 ⇒ false（流水已空）
    expect(store.undoOptionDraftLast()).toBe(false)
  }, 30_000)

  it('「撤退」草稿按点格距离记数；点数不足时截断到剩余', () => {
    const store = scanSeed(1, 400)
    const remaining = store.optionDraftRemaining
    // 面板按钮：1 格
    expect(store.applyOptionDraftRetreat(1)).toBe(true)
    expect(store.combatInputs.optionRetreatHexes).toBe(1)
    // 点远处的格（≥2 格）⇒ 截断到剩余点数
    expect(store.applyOptionDraftRetreat(99)).toBe(true)
    expect(store.combatInputs.optionRetreatHexes).toBe(Math.min(1 + 99, remaining))
    // 用光后拒绝
    expect(store.applyOptionDraftRetreat(1)).toBe(false)
  }, 30_000)

  it('★ 攻方全灭 ⇒ 守方「结束战斗」一键收尾（9.10c 例 B）', () => {
    const store = scanSeed(1, 400)
    // 攻方未全灭 ⇒ 一键不出现、调用也被拒
    expect(store.attackerWipedNow).toBe(false)
    expect(store.concludeCombatAfterWipe()).toBe(false)

    // 攻方被全灭（军力归零即离盘，与 applyCombatPatches 的死亡堆同效果）
    store.units = store.units.filter((unit) => unit.instanceId !== 'a1')
    expect(store.attackerWipedNow).toBe(true)

    expect(store.concludeCombatAfterWipe()).toBe(true)
    expect(store.combatState?.finished).toBe(true)
    expect(store.combatState?.resolution.defender.optionIgnored).toBe(true)
  }, 30_000)
})

describe('批 F·F1：选项草稿的地图点选（map-view 分派）', () => {
  /** 建到守方选项步（复用扫种子夹具） */
  function atDefenderOptions() {
    const store = scanSeed(1, 400)
    return { workbench: store, mapView: useMapViewStore() }
  }

  it('「受损」模式点本堆叠单位图 ⇒ 记 1 点草稿损失（点不到合法目标不落盘）', () => {
    const { workbench, mapView } = atDefenderOptions()
    workbench.setOptionDraftMode('loss')
    const target = workbench.combatOptionLossTargets[0]!
    mapView.onHexClick(target.hex, { x: 40, y: 40 })
    expect(workbench.combatInputs.optionLossPoints).toBe(1)
    expect(workbench.combatInputs.optionLossAllocation[target.id]).toBe(1)
    // 撤退模式下点同一个格不生效（模式不匹配）
    workbench.setOptionDraftMode('retreat')
    workbench.setOptionDraftMode('loss')
    mapView.onHexClick({ col: target.hex.col + 40, row: target.hex.row + 40 }, { x: 40, y: 40 })
    expect(workbench.combatInputs.optionLossPoints).toBe(1)
  }, 30_000)

  it('「撤退」模式铺出三色可撤退格预览；点高亮格按距离记草稿', () => {
    const { workbench } = atDefenderOptions()
    expect(workbench.optionDraftRetreatPreview).toBeNull()
    workbench.setOptionDraftMode('retreat')
    const preview = workbench.optionDraftRetreatPreview
    expect(preview).not.toBeNull()
    // 1 格距离的预览至少存在（起点邻格图内且可入）
    const near = preview!.distanceOf
    const anyHex = Object.keys(near)[0]
    expect(anyHex, '撤退预览应至少给出一个可退格').toBeDefined()
    const [col, row] = anyHex!.split(',').map(Number)
    const distance = near[anyHex!]!
    expect(workbench.applyOptionDraftRetreatAt({ col: col!, row: row! })).toBe(true)
    expect(workbench.combatInputs.optionRetreatHexes).toBe(
      Math.min(distance, workbench.optionDraftRemaining + distance),
    )
    // 非预览格 ⇒ 拒绝
    const outside = mapLayers.hexes.find((hex) => near[`${hex.col},${hex.row}`] === undefined)
    expect(outside, '地图上应有预览之外的格').toBeDefined()
    expect(workbench.applyOptionDraftRetreatAt({ col: outside!.col, row: outside!.row })).toBe(
      false,
    )
  }, 30_000)
})
