import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  createMapFacts,
  holdingsToT,
  PANZER_GROUP_OPTION_ITEM,
  selectMovementTerrain,
} from '@/engine/rules'
import { hexCanvasPoint } from '@/render/map-layout'
import {
  actionGateOf,
  defenseTerrainChoices,
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useMapViewStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'
import { readStoreSource } from '../shared/store-source'

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

describe('12.4：点含部队的补给站格必须选得中（与 12.3 选源同口径，先于堆叠展开）', () => {
  it('★ 战斗补给步点「攻方同格」的补给站 ⇒ 选为来源（不被堆叠点击吃掉）', () => {
    const store = newStore()
    const { attackerA } = setupTwoAttackerBattle(store)
    expect(store.combatState?.step).toBe('combatSupply')

    // 站就摆在攻方脚下（12.1b：含 SP 的位置即补给站；实战里站与部队同格是常态）
    store.spDumps.push({
      id: 'sd-same',
      side: 'axis',
      hex: { ...attackerA.hex },
      sp: 4,
      t: 0,
    })

    const mapView = useMapViewStore()
    // 真实地图点击：带 world/scale ⇒ 这一击会先过「摊开堆叠」这一层
    mapView.onHexClick({ ...attackerA.hex }, undefined, hexCanvasPoint(attackerA.hex), 0.5)

    expect(store.combatSupplyDumpIds.attacker, '点自己的站格＝选中这座站').toBe('sd-same')
    expect(store.combatInputs.attackerAvailableT).toBe(holdingsToT({ sp: 4, t: 0 }))
  })
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

describe('9.5：多枚攻方挤在同一格（实战形态）', () => {
  /**
   * ★ 红用例（用户实测：多攻方那场「进入行动值」点不动——按钮看着启用、点击无反应、无报错、账不扣）。
   *
   * 载荷：4 枚同格攻方（军力 2 / 2 / 3 / 3 ⇒ 合计 10T），已选两座各 5T 的站（合计正好 10T）。
   * 这笔钱**付得出**（A 站付 2+3、B 站付 2+3），但"先到先得"的逐单位分配会按名单顺序
   * 把 2、2 都塞进 A 站（剩 1），再把 3 塞进 B 站（剩 2），最后一枚 3 无处可取 ⇒ 整笔被拒：
   * 引擎的 12.4 只按**总额**判（10 ≥ 10）已放行，于是界面既不报红字、账也不动、步也不进。
   */
  it('★ 四枚同格攻方 + 两座各 5T 的站（总额正好够）⇒ 进入行动值必须推进到 declareAr', () => {
    const store = newStore()
    store.setPhase('combat')
    goToActionStep(store, 'combat.declare')
    store.setTool('battle')
    const records = [
      place(store, attackerRecord(), ATTACKER_HEX, 'axis', 's1'),
      place(store, attackerRecord(), ATTACKER_HEX, 'axis', 's2'),
      place(store, attackerRecord(), ATTACKER_HEX, 'axis', 's3'),
      place(store, attackerRecord(), ATTACKER_HEX, 'axis', 's4'),
    ]
    // 军力 2 / 2 / 3 / 3（12.4：攻方需求 = 参战军力合计 T）
    const stepsOf = [2, 2, 3, 3]
    records.forEach((unit, index) => {
      unit.steps = stepsOf[index]!
    })
    place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
    store.clickHex(DEFENDER_HEX)
    for (const unit of records) ensureAttacker(store, unit.instanceId)
    expect(store.beginCombatNow()).toBe(true)
    expect(store.combatState?.composition.attackerIds).toHaveLength(4)

    // 两座各 5T（1 SP + 1 T）＝合计 10T，与上面 2+2+3+3 正好相等
    store.spDumps.push({ id: 'sd-a', side: 'axis', hex: { ...ATTACKER_HEX }, ...exactT(5) })
    store.spDumps.push({ id: 'sd-b', side: 'axis', hex: { ...SECOND_ATTACKER_HEX }, ...exactT(5) })
    store.spDumps.push({ id: 'sd-so', side: 'soviet', hex: { ...DEFENDER_HEX }, sp: 8, t: 0 })
    expect(store.pickCombatSupplyDump('attacker', 'sd-a')).toBe(true)
    expect(store.pickCombatSupplyDump('attacker', 'sd-b')).toBe(true)
    expect(store.pickCombatSupplyDump('defender', 'sd-so')).toBe(true)
    expect(store.combatInputs.attackerAvailableT).toBe(10)
    expect(store.confirmCombatSupplySide('attacker')).toBe(true)
    expect(store.confirmCombatSupplySide('defender')).toBe(true)

    expect(store.confirmCombatSupply()).toBe(true)
    expect(store.combatState?.step).toBe('declareAr')
    // 两座站都被真的扣到 0（各付 5T：一座付 2+3，另一座付 2+3）
    expect(store.spDumps.find((item) => item.id === 'sd-a')).toMatchObject({ sp: 0, t: 0 })
    expect(store.spDumps.find((item) => item.id === 'sd-b')).toMatchObject({ sp: 0, t: 0 })
  })

  it('★ 仍要全额：两座 4T 凑不出「5T + 3T」的两枚 ⇒ 拒绝，且红字与日志都在', () => {
    const store = newStore()
    store.setPhase('combat')
    goToActionStep(store, 'combat.declare')
    store.setTool('battle')
    const units = [
      place(store, attackerRecord(), ATTACKER_HEX, 'axis', 's1'),
      place(store, attackerRecord(), ATTACKER_HEX, 'axis', 's2'),
    ]
    units[0]!.steps = 5
    units[1]!.steps = 3
    place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
    store.clickHex(DEFENDER_HEX)
    for (const unit of units) ensureAttacker(store, unit.instanceId)
    expect(store.beginCombatNow()).toBe(true)

    store.spDumps.push({ id: 'sd-a', side: 'axis', hex: { ...ATTACKER_HEX }, ...exactT(4) })
    store.spDumps.push({ id: 'sd-b', side: 'axis', hex: { ...SECOND_ATTACKER_HEX }, ...exactT(4) })
    store.spDumps.push({ id: 'sd-so', side: 'soviet', hex: { ...DEFENDER_HEX }, sp: 8, t: 0 })
    expect(store.pickCombatSupplyDump('attacker', 'sd-a')).toBe(true)
    expect(store.pickCombatSupplyDump('attacker', 'sd-b')).toBe(true)
    expect(store.pickCombatSupplyDump('defender', 'sd-so')).toBe(true)
    // 总额 8T ＝ 需求 8T，但每枚单位只能从**一座**站取（12.3a），5T 反而无处可取
    expect(store.combatInputs.attackerAvailableT).toBe(8)

    expect(store.confirmCombatSupply()).toBe(false)
    expect(store.combatState?.step).toBe('combatSupply')
    // 不再是"静默无用"：红字（12.4）与结算日志都给出
    expect(store.combatError).not.toBeNull()
    expect(store.combatErrorLine).toContain('战斗补给')
    expect(store.log.some((entry) => entry.rule === '12.4')).toBe(true)
  })
})

describe('9.5：补给段逐方确认（热座）', () => {
  it('★ 两侧各自确认；改任一方输入只撤该方，攻方改动连带撤销守方', () => {
    const store = newStore()
    setupTwoAttackerBattle(store)
    /*
     * B4：逐方确认现在先验「有没有付款来源」 ⇒ 两侧各放一座可达站。
     * 本用例只钉确认标记的翻/撤关系，付款是否够整笔仍由共用出口裁决。
     */
    store.spDumps.push({ id: 'sd-a1', side: 'axis', hex: { ...ATTACKER_HEX }, sp: 8, t: 0 })
    store.spDumps.push({ id: 'sd-a2', side: 'axis', hex: { ...SECOND_ATTACKER_HEX }, sp: 8, t: 0 })
    store.spDumps.push({ id: 'sd-d', side: 'soviet', hex: { ...DEFENDER_HEX }, sp: 8, t: 0 })
    expect(store.pickCombatSupplyDump('attacker', 'sd-a1')).toBe(true)
    expect(store.pickCombatSupplyDump('attacker', 'sd-a2')).toBe(true)
    expect(store.pickCombatSupplyDump('defender', 'sd-d')).toBe(true)

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

    // 再点同一座＝取消来源、且全方都已耗尽 ⇒ 付不清也不能用储备 ⇒ 不适用
    expect(store.pickCombatSupplyDump('attacker', 'sd-a')).toBe(true)
    unitA.internalStocks = 'exhausted'
    unitB.internalStocks = 'exhausted'
    expect(store.combatAttackerStocksApplicable).toBe(false)
    // 有一枚还能用 ⇒ 适用
    unitB.internalStocks = null
    expect(store.combatAttackerStocksApplicable).toBe(true)

    // 守方：可达来源里没有一座能付足（此处根本没有站）且要付 ⇒ 适用
    expect(store.combatDefenderStocksApplicable).toBe(true)
    // 12.10a 新口径：看**全部可达来源**有没有一座能单座付足，不看"玩家已点选那座站的 T"。
    // 这里只摆站、不点选 ⇒ 仍算图上付得清 ⇒ 储备行不出现。
    store.spDumps.push({ id: 'sd-d', side: 'soviet', hex: { ...DEFENDER_HEX }, sp: 2, t: 0 })
    expect(store.combatInputs.defenderAvailableT).toBe(0)
    expect(store.combatDefenderStocksApplicable).toBe(false)
    // 改为不付 ⇒ 不适用
    store.combatInputs.defenderProvides = false
    expect(store.combatDefenderStocksApplicable).toBe(false)
  })

  it('★ 守方所有可达来源都付不足 ⇒ 储备行出现', () => {
    const store = newStore()
    setupTwoAttackerBattle(store)
    // 地图上离防御格最远的一格：守方拖不到、也没有 HQ 能投递到 ⇒ 全不可达
    const far = mapLayers.hexes.reduce((best, hex) => {
      const distance = Math.abs(hex.col - DEFENDER_HEX.col) + Math.abs(hex.row - DEFENDER_HEX.row)
      const bestDistance =
        Math.abs(best.col - DEFENDER_HEX.col) + Math.abs(best.row - DEFENDER_HEX.row)
      return distance > bestDistance ? hex : best
    })
    expect(Math.abs(far.col - DEFENDER_HEX.col)).toBeGreaterThan(3)
    store.spDumps.push({
      id: 'sd-far',
      side: 'soviet',
      hex: { col: far.col, row: far.row },
      sp: 8,
      t: 0,
    })

    const reachable = store.combatSupplyDumps.find((item) => item.side === 'defender')?.dumps ?? []
    expect(reachable).toEqual([])
    expect(store.combatDefenderStocksApplicable).toBe(true)
  })

  it('B7 守卫：判据只看全部可达来源，不看已点选那座站的 T', () => {
    const source = readStoreSource()
    const start = source.indexOf('const combatDefenderStocksApplicable')
    const end = source.indexOf('\n  })', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const block = source.slice(start, end)
    expect(block).toContain('combatSupplyDumps')
    expect(block).toContain('carrierIsOrganicTruck')
    expect(block).not.toContain('defenderAvailableT')
  })
})

describe('B6：再点同一座补给站＝取消该方来源（地图唯一入口）', () => {
  it('第二次点同一座 ⇒ 来源清空、可用 T 归零', () => {
    const store = newStore()
    setupTwoAttackerBattle(store)
    store.spDumps.push({ id: 'sd-a', side: 'axis', hex: { ...ATTACKER_HEX }, sp: 4, t: 0 })

    expect(store.pickCombatSupplyDump('attacker', 'sd-a')).toBe(true)
    expect(store.combatSupplyDumpPicks.attacker).toEqual(['sd-a'])
    expect(store.combatInputs.attackerAvailableT).toBe(holdingsToT({ sp: 4, t: 0 }))

    // 再点同一座 ⇒ 从多选来源里撤掉；撤空后可用 T 归零（12.4）
    expect(store.pickCombatSupplyDump('attacker', 'sd-a')).toBe(true)
    expect(store.combatSupplyDumpPicks.attacker).toEqual([])
    expect(store.combatSupplyDumpIds.attacker).toBeNull()
    expect(store.combatInputs.attackerAvailableT).toBe(0)
  })

  it('面板不再有「清除攻方 / 清除守方」按钮，也不再暴露清除动作', () => {
    const src = readFileSync('src/components/combat/CombatPanel.vue', 'utf8')
    expect(src).not.toContain('清除攻方')
    expect(src).not.toContain('清除守方')
    expect(src).not.toContain('clearCombatSupplyDump')
  })
})

describe('3.4b：战斗补给被规则拒 ⇒ 面板必须出红字（不能只落战报）', () => {
  it('★ 错误装甲集群的站付款被拒 ⇒ combatError / combatErrorLine 都在', () => {
    const store = newStore()
    const session = useGameSessionStore()
    const optionIndex = session.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM)
    expect(optionIndex).toBeGreaterThanOrEqual(0)
    session.setAgreedCheck(optionIndex, true)
    // 1941-08-15：3.4 族仍在生效期内（PANZER_GROUP_CONSTRAINT_END = 08-19）
    store.setTurn(12)
    store.setActiveSide('axis')
    expect(store.panzerGroupRulesOn).toBe(true)

    store.setPhase('combat')
    goToActionStep(store, 'combat.declare')
    store.setTool('battle')
    const attacker = place(
      store,
      pickRecord(
        'axis',
        (record) =>
          record.isCombat === true &&
          record.attackCapable === true &&
          record.panzerGroup === 'guderian',
      ),
      ATTACKER_HEX,
      'axis',
      'pg-gud',
    )
    place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd-pg')
    store.clickHex(DEFENDER_HEX)
    ensureAttacker(store, attacker.instanceId)
    expect(store.beginCombatNow()).toBe(true)
    expect(store.combatState?.step).toBe('combatSupply')

    // 古德里安编队却由「霍特」的站付款（3.4b：错误集群的 SP 不能支付战斗成本）
    store.spDumps.push({ id: 'sd-hoth', side: 'axis', hex: { ...ATTACKER_HEX }, sp: 8, t: 0 })
    store.setDumpPanzerGroupNow('sd-hoth', 'hoth')
    expect(
      store.panzerGroupSpGate({
        dumpId: 'sd-hoth',
        purpose: 'combat',
        beneficiaryUnitIds: [attacker.instanceId],
      }),
    ).toMatchObject({ rule: '3.4b' })
    expect(store.pickCombatSupplyDump('attacker', 'sd-hoth')).toBe(true)

    expect(store.confirmCombatSupply()).toBe(false)
    // 修前：只在战报留一行（danger 日志），`combatError` 仍为 null ⇒ 面板没有红字
    expect(store.combatError).toMatchObject({ rule: '3.4b' })
    expect(store.combatErrorLine).toContain('集群')
    expect(store.combatState?.step).toBe('combatSupply')
  })
})

describe('12.10a 括注例外的边界（13.2g-B 追加后）', () => {
  /**
   * 每次用**新 store**：编内卡车的编队是它在数据/实例上的固有属性，
   * 而同一次会话里改 `formation` 不会让已算出的取补来源刷新（那是另一条链路的缓存），
   * 所以两种编队各起一局，避免测到缓存而不是判据。
   */
  function fightWithOrganicTruck(formation: string) {
    const store = newStore()
    store.setActiveSide('soviet')
    store.setPhase('combat')
    goToActionStep(store, 'combat.declare')
    store.setTool('battle')
    const attacker = place(
      store,
      pickRecord(
        'soviet',
        (record) =>
          record.isCombat === true &&
          record.attackCapable === true &&
          record.classes?.movementClass === 'leg' &&
          (record.factors?.combat?.attack ?? 0) >= 2,
      ),
      ATTACKER_HEX,
      'soviet',
      'sa1',
    )
    // 德军守方：编队 10PZ（单位库里编内卡车全在德方，正好用来钉这条判据）
    place(
      store,
      pickRecord('axis', (record) => record.isCombat === true && record.formation === '10PZ'),
      DEFENDER_HEX,
      'axis',
      'ad1',
    )
    store.clickHex(DEFENDER_HEX)
    ensureAttacker(store, attacker.instanceId)
    expect(store.beginCombatNow()).toBe(true)
    const truck = place(
      store,
      pickRecord(
        'axis',
        (record) => record.noncombatKind === 'organic_truck' && record.formation === formation,
      ),
      DEFENDER_HEX,
      'axis',
      'ot1',
    )
    truck.loadedSpT = 4 // 1 SP = 4 T ＞ 12.4 的守方整笔（2 T；≤1 RE 时 1 T）
    return { store, truck }
  }

  it('★ 唯一够额的站是编内卡车的 SP：同编队拖得到 ⇒ 不算"取不到"；不同编队 ⇒ 才留储备行', () => {
    // ① 同编队：守方按 13.2g-B 本来就拖得到 ⇒ 不是 12.10a 括注里的"唯一可用站取不到"
    const same = fightWithOrganicTruck('10PZ')
    const reachable =
      same.store.combatSupplyDumps.find((item) => item.side === 'defender')?.dumps ?? []
    expect(reachable.some((dump) => dump.id === 'unit:ot1')).toBe(true)
    expect(same.store.combatDefenderStocksApplicable).toBe(false)

    // ② 别的编队：守方拖不到 ⇒ 括注例外成立 ⇒ 储备行出现
    const other = fightWithOrganicTruck('4PZ')
    expect(other.store.combatDefenderStocksApplicable).toBe(true)

    // ③ 同格再摆一份**地面**账本 ⇒ 与编队无关，一律算图上取得到
    other.store.spDumps.push({ id: 'sd-d', side: 'axis', hex: { ...DEFENDER_HEX }, sp: 1, t: 0 })
    expect(other.store.combatDefenderStocksApplicable).toBe(false)
  })
})
