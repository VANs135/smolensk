import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { createMapFacts, holdingsToT, selectMovementTerrain } from '@/engine/rules'
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
 * 12.4：战斗补给**不要求同源**
 *
 * 原文（12.4 前段）只写「直接拖取(12.3a)和指挥部投递(12.3b)都可用于接收及分配战斗补给(9.5)」，
 * 没有「同一方的参战单位必须从同一座补给站付款」这一条（同源限制只出现在 10.1b-A 的炮击）。
 * 因此本文件钉住：
 *   ① 一方可以同时点选多座补给站（`combatSupplyDumpPicks` 逐枚追加）；
 *   ② 落账时**逐单位取源**：两枚攻方分别从两座站扣款，两座站的持仓都真的减少；
 *   ③ 减少总额恰等于引擎给出的 `supply.attacker.requiredT`（不凭空多扣/少扣）。
 *
 * ★ 不是放宽：仍要「全额付清才可攻」。第二例钉住"只声明一座、余额不够整笔 ⇒ 拒绝且不动账本"。
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

/** 该记录能否从 `from` 进入 `to`（9.1f 探针；与既有战斗测试同口径） */
function canEnter(mobility: 'leg' | 'truck' | 'track', from: HexRef, to: HexRef): boolean {
  return selectMovementTerrain({
    terrainsPresent: mapFacts.terrainsAt(to),
    mobility,
    crossing: mapFacts.crossingBetween(from, to),
    followingRoad: true,
    forOverrun: false,
  }).ok
}

/** 防御格：六邻皆图内且格内有防御地形 */
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

/** 攻方格①：防御格的图内邻格，且步兵可进入 */
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

/** 攻方格②：另一侧的邻格（与①不同格）——用于让两枚攻方分别就位 */
const SECOND_ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (candidate.col === ATTACKER_HEX.col && candidate.row === ATTACKER_HEX.row) continue
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)) {
      continue
    }
    if (canEnter('leg', candidate, DEFENDER_HEX)) return candidate
  }
  throw new Error('防御格没有第二个「步兵可进入」的图内邻格')
})()

function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

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

/** 9.1b：把某一枚加进攻方名单（已在名单里就不再 toggle——toggle 会把它取消） */
function ensureAttacker(store: ReturnType<typeof newStore>, unitId: string): void {
  if (!store.combatAttackerIds.includes(unitId)) store.toggleCombatAttacker(unitId)
}

/** 摆两枚分处两格的攻方 + 一枚守方，走到「战斗补给」步（9.2 第 1 步） */
function setupTwoAttackerBattle(store: ReturnType<typeof newStore>) {
  store.setPhase('combat')
  goToActionStep(store, 'combat.declare')
  store.setTool('battle')
  const attackerA = place(store, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
  const attackerB = place(store, attackerRecord(), SECOND_ATTACKER_HEX, 'axis', 'a2')
  const defender = place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
  store.clickHex(DEFENDER_HEX)
  ensureAttacker(store, attackerA.instanceId)
  ensureAttacker(store, attackerB.instanceId)
  expect(store.beginCombatNow()).toBe(true)
  expect(store.combatState?.step).toBe('combatSupply')
  return { attackerA, attackerB, defender }
}

/** 把 T 精确分成 `sp`/`t`（1 SP = 4 T），用于"这座站恰好只够一枚单位" */
function exactT(t: number): { sp: number; t: number } {
  return { sp: Math.floor(t / 4), t: t % 4 }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('12.4：战斗补给逐单位取源（不要求同源）', () => {
  it('★ 两枚攻方各从一座站付款：两座站持仓都减少，减少总额 == 引擎 requiredT', () => {
    const store = newStore()
    const { attackerA, defender } = setupTwoAttackerBattle(store)

    const needT = store.combatAttackers.reduce((sum, unit) => sum + unit.steps, 0)
    // 攻方 A 的站**恰好只够它自己**（余额不够第二枚） ⇒ 逼着分配器使用第二座站
    store.spDumps.push({
      id: 'sd-a',
      side: 'axis',
      hex: { ...ATTACKER_HEX },
      ...exactT(attackerA.steps),
    })
    store.spDumps.push({ id: 'sd-b', side: 'axis', hex: { ...SECOND_ATTACKER_HEX }, sp: 4, t: 0 })
    store.spDumps.push({ id: 'sd-d', side: 'soviet', hex: { ...DEFENDER_HEX }, sp: 2, t: 0 })
    expect(defender.instanceId).toBe('d1')

    // ① 一方可同时点选多座（逐枚追加）
    expect(store.pickCombatSupplyDump('attacker', 'sd-a')).toBe(true)
    expect(store.pickCombatSupplyDump('attacker', 'sd-b')).toBe(true)
    expect(store.pickCombatSupplyDump('defender', 'sd-d')).toBe(true)
    expect(store.combatSupplyDumpPicks.attacker).toEqual(['sd-a', 'sd-b'])
    // 单值字段保留第一座（兼容既有界面/测试）
    expect(store.combatSupplyDumpIds.attacker).toBe('sd-a')
    // 可用 T = 两座合计
    expect(store.combatInputs.attackerAvailableT).toBe(
      attackerA.steps + holdingsToT({ sp: 4, t: 0 }),
    )

    const before = (id: string) => {
      const dump = store.spDumps.find((item) => item.id === id)!
      return holdingsToT({ sp: dump.sp, t: dump.t })
    }
    const beforeA = before('sd-a')
    const beforeB = before('sd-b')
    const beforeD = before('sd-d')

    // ② 确认付款
    expect(store.confirmCombatSupply()).toBe(true)
    expect(store.combatState?.step).toBe('declareAr')
    const supply = store.combatState!.supply!
    expect(supply.attacker.requiredT).toBe(needT)
    expect(supply.attacker.paid).toBe(true)

    // ③ 两座攻方站都真的被扣（不是只动第一座）
    expect(before('sd-a')).toBeLessThan(beforeA)
    expect(before('sd-b')).toBeLessThan(beforeB)
    // 守方自己的站也扣了
    expect(before('sd-d')).toBeLessThan(beforeD)
    // 总额守恒：两座攻方站减少之和 == 引擎要求的战斗补给
    expect(beforeA + beforeB - (before('sd-a') + before('sd-b'))).toBe(supply.attacker.requiredT)
  })

  it('★ 仍要全额：只声明一座且余额不够整笔 ⇒ 拒绝，且不改动任何账本', () => {
    const store = newStore()
    const { attackerA } = setupTwoAttackerBattle(store)

    store.spDumps.push({
      id: 'sd-a',
      side: 'axis',
      hex: { ...ATTACKER_HEX },
      ...exactT(attackerA.steps),
    })
    store.spDumps.push({ id: 'sd-d', side: 'soviet', hex: { ...DEFENDER_HEX }, sp: 2, t: 0 })
    expect(store.pickCombatSupplyDump('attacker', 'sd-a')).toBe(true)
    expect(store.pickCombatSupplyDump('defender', 'sd-d')).toBe(true)

    const dumpA = store.spDumps.find((item) => item.id === 'sd-a')!
    const snapshot = { sp: dumpA.sp, t: dumpA.t }
    const dumpD = store.spDumps.find((item) => item.id === 'sd-d')!
    const snapshotD = { sp: dumpD.sp, t: dumpD.t }

    expect(store.confirmCombatSupply()).toBe(false)
    // 停在原地、账本原样（12.4：无法满足完整战斗补给者不能攻击）
    expect(store.combatState?.step).toBe('combatSupply')
    expect({ sp: dumpA.sp, t: dumpA.t }).toEqual(snapshot)
    expect({ sp: dumpD.sp, t: dumpD.t }).toEqual(snapshotD)
  })
})

describe('9.5：补给段逐方确认（热座）', () => {
  it('★ 两侧各自确认；改任一方输入只撤该方，攻方改动连带撤销守方', () => {
    const store = newStore()
    setupTwoAttackerBattle(store)

    expect(store.combatInputs.supplyConfirmed).toEqual({ attacker: false, defender: false })
    expect(store.confirmCombatSupplySide('attacker')).toBe(true)
    expect(store.combatInputs.supplyConfirmed).toEqual({ attacker: true, defender: false })
    expect(store.confirmCombatSupplySide('defender')).toBe(true)
    expect(store.combatInputs.supplyConfirmed).toEqual({ attacker: true, defender: true })

    // 守方改自己的输入 ⇒ 只撤守方
    store.combatInputs.defenderProvides = false
    expect(store.combatInputs.supplyConfirmed).toEqual({ attacker: true, defender: false })

    expect(store.confirmCombatSupplySide('defender')).toBe(true)
    // 攻方改输入 ⇒ 连带撤销守方（守方看到的是改前的攻方来源）
    store.combatInputs.attackerUsesInternalStocks = true
    expect(store.combatInputs.supplyConfirmed).toEqual({ attacker: false, defender: false })
  })
})

describe('12.10a：部队储备只在图上付不清时出现', () => {
  it('★ 图上足额⇒不适用；付不清⇒适用；全方耗尽⇒不适用；守方不付⇒不适用', () => {
    const store = newStore()
    setupTwoAttackerBattle(store)
    const unitA = store.units.find((unit) => unit.instanceId === 'a1')!
    const unitB = store.units.find((unit) => unit.instanceId === 'a2')!

    // 未声明来源 ⇒ 图上付不清 ⇒ 攻方适用（默认未耗尽）
    expect(store.combatInputs.attackerAvailableT).toBe(0)
    expect(store.combatAttackerStocksApplicable).toBe(true)

    // 声明一座足额来源 ⇒ 图上能全额付清 ⇒ 不适用
    store.spDumps.push({ id: 'sd-a', side: 'axis', hex: { ...ATTACKER_HEX }, sp: 4, t: 0 })
    expect(store.pickCombatSupplyDump('attacker', 'sd-a')).toBe(true)
    expect(store.combatInputs.attackerAvailableT).toBe(holdingsToT({ sp: 4, t: 0 }))
    expect(store.combatAttackerStocksApplicable).toBe(false)

    // 清掉来源、且全方都已耗尽 ⇒ 付不清也不能用储备 ⇒ 不适用
    store.clearCombatSupplyDump('attacker')
    unitA.internalStocks = 'exhausted'
    unitB.internalStocks = 'exhausted'
    expect(store.combatAttackerStocksApplicable).toBe(false)
    // 有一枚还能用 ⇒ 适用
    unitB.internalStocks = null
    expect(store.combatAttackerStocksApplicable).toBe(true)

    // 守方：默认要付且图上付不清 ⇒ 适用；改为不付 ⇒ 不适用
    expect(store.combatDefenderStocksApplicable).toBe(true)
    store.combatInputs.defenderProvides = false
    expect(store.combatDefenderStocksApplicable).toBe(false)
  })
})
