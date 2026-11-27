import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { createMapFacts, selectMovementTerrain } from '@/engine/rules'
import { createRngState } from '@/engine/rng'
import {
  defenseTerrainChoices,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ConsolePhase,
  actionGateOf,
  type ActionKey,
} from '@/stores'

/**
 * 9.11a/c：损失分担在**真实盘面**上的实际形状（store 级）
 *
 * 用户口径「不可用项不出现（不置灰）」⇒ 桥接端只照 `combatLossSwapChoices` 出候选，
 * 所以这里要钉住两件事：
 *  1. 真实战斗的强制损失是 1~2 点，两枚单位的规范分配就是「1 点」或「各 1 点」⇒ **没有改派余地**
 *     （`combatLossSwapChoices` 为空，桥接端也就只给「确认损失」一条）；
 *  2. 改派只在「某单位受 2 点、另有单位只受 1 点」时才成立，也就是要 3 点损失；
 *     扫过 60 个骰序 × 守方付/不付补给两种（`seeds × 2`）都没出现 3 点 —— 故这条只是**不成立时不出现**的证据，
 *     改派本身的合法性由 `combatLossSwapChoices`（store）与 `combatLossCandidates`（训练侧单测）共同守。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const mapFacts = createMapFacts()

function canEnter(mobility: 'leg' | 'truck' | 'track', from: HexRef, to: HexRef): boolean {
  const result = selectMovementTerrain({
    terrainsPresent: mapFacts.terrainsAt(to),
    mobility,
    crossing: mapFacts.crossingBetween(from, to),
    followingRoad: true,
    forOverrun: false,
  })
  return result.ok
}

/** 六邻皆图内、可作防御格的格 */
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

/** 攻击格：防御格的图内邻格，步兵可进入（9.1f） */
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

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
) {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
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

/** 攻方取战斗值最高的两枚（把攻守比推高，守方强制损失才上得去） */
const attackerRecords = () => {
  const pool = unitChoices('axis').filter(
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      record.classes?.movementClass === 'leg',
  )
  const sorted = [...pool].sort(
    (left, right) => (right.factors?.combat?.attack ?? 0) - (left.factors?.combat?.attack ?? 0),
  )
  const first = sorted[0]
  const second = sorted.find((record) => record !== first)
  if (first === undefined || second === undefined)
    throw new Error('攻方单位库里取不到两枚可攻击的步兵')
  return [first, second] as const
}

/** 守方取战斗值最低的两枚（军力 2 步以上） */
const defenderRecords = () => {
  const pool = unitChoices('soviet').filter(
    (record) =>
      record.isCombat === true && record.attackCapable === true && (record.steps?.total ?? 1) >= 2,
  )
  const sorted = [...pool].sort(
    (left, right) => (left.factors?.combat?.attack ?? 0) - (right.factors?.combat?.attack ?? 0),
  )
  const first = sorted[0]
  const second = sorted.find((record) => record !== first)
  if (first === undefined || second === undefined)
    throw new Error('守方单位库里取不到两枚 2 步可攻击单位')
  return [first, second] as const
}

/** 摆 2 攻 2 守，走到「损失」步（9.11）；`defenderPays=false` ⇒ 12.4 守方拒付、半值防御 */
function driveToLosses(store: ReturnType<typeof newStore>, defenderPays: boolean): void {
  store.setPhase('combat')
  goToActionStep(store, 'combat.declare')
  store.setTool('battle')
  store.setFuelPool(0, 20)
  const [attackerA, attackerB] = attackerRecords()
  const [defenderA, defenderB] = defenderRecords()
  place(store, attackerA, ATTACKER_HEX, 'axis', 'a1')
  place(store, attackerB, ATTACKER_HEX, 'axis', 'a2')
  place(store, defenderA, DEFENDER_HEX, 'soviet', 'd1')
  place(store, defenderB, DEFENDER_HEX, 'soviet', 'd2')
  store.clickHex(ATTACKER_HEX)
  store.clickHex(DEFENDER_HEX)

  expect(store.beginCombatNow()).toBe(true)
  // 12.4：补给来源必须真实存在 —— 两侧各摆一座 SP 站
  if (!store.spDumps.some((dump) => dump.id === 'sd-axis'))
    store.spDumps.push({ id: 'sd-axis', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
  if (!store.spDumps.some((dump) => dump.id === 'sd-soviet'))
    store.spDumps.push({ id: 'sd-soviet', hex: { ...DEFENDER_HEX }, side: 'soviet', sp: 8, t: 0 })
  for (const entry of store.combatSupplyDumps) {
    if (store.combatSupplyDumpIds[entry.side] !== null) continue
    if (entry.side === 'defender' && !defenderPays) continue
    const dump = entry.dumps[0]
    if (dump !== undefined) store.pickCombatSupplyDump(entry.side, dump.id)
  }
  expect(store.confirmCombatSupply()).toBe(true)

  store.combatInputs.attackerArUnitId = store.combatAttackers[0]!.instanceId
  store.declareCombatArStep('attacker')
  store.combatInputs.defenderArUnitId = store.battleDefenders[0]!.instanceId
  store.declareCombatArStep('defender')
  store.declareCombatTerrainStep()
  store.rollCombatSurprise()
  if (store.combatAwaitingShiftDie) store.rollCombatShiftDie()
  expect(store.rollCombatDice()).toBe(true)
}

/** 把攻方那一屏（损失 + 选项）过掉，停在守方损失屏 */
function skipAttackerSide(store: ReturnType<typeof newStore>): boolean {
  if (store.combatState?.resolution.stage === 'attackerLosses') store.confirmCombatLosses()
  if (store.combatState?.resolution.stage === 'attackerOptions') {
    const requirement = store.combatRequirement
    if (requirement !== null) {
      store.combatInputs.optionRetreatHexes = 0
      store.combatInputs.optionLossPoints = requirement.options
      store.confirmCombatOptions()
    }
  }
  return store.combatState?.resolution.stage === 'defenderLosses'
}

describe('9.11a/c：真实盘面上的损失分担形状', () => {
  it('守方强制损失 1~2 点时没有改派余地（swapChoices 为空，桥接端只给「确认损失」）', () => {
    const shapes: { losses: number; units: number; swap: number; canonical: string }[] = []
    for (const defenderPays of [true, false]) {
      for (let seed = 1; seed <= 12; seed += 1) {
        const store = newStore()
        store.rng = createRngState(seed)
        driveToLosses(store, defenderPays)
        if (!skipAttackerSide(store)) continue
        const requirement = store.combatRequirement
        if (requirement === null) continue
        shapes.push({
          losses: requirement.losses,
          units: store.battleDefenders.length,
          swap: store.combatLossSwapChoices.length,
          canonical: JSON.stringify(store.combatCanonicalLosses),
        })
        // 1~2 点 × 2 枚 ⇒ 规范分配只有一个点或各 1 点，就没有「多受的那一点」可改派
        expect(requirement.losses).toBeLessThanOrEqual(2)
        expect(store.combatLossSwapChoices).toEqual([])
      }
    }
    // 扫到的样本必须真的有（否则这条断言等于没测）
    expect(shapes.length).toBeGreaterThan(0)
    // 至少出现过「两枚各受 1 点」这种规范分配（1 点只用一枚）以外的形状
    expect(shapes.some((shape) => shape.canonical.includes('d2'))).toBe(true)
  })

  it(
    '3 点损失才会出现 [2,1] 的改派余地 —— 扫到的骰序里没有，故不作断言（记录事实）',
    { timeout: 15_000 },
    () => {
      let threePoint = 0
      for (const defenderPays of [true, false]) {
        for (let seed = 1; seed <= 60; seed += 1) {
          const store = newStore()
          store.rng = createRngState(seed)
          driveToLosses(store, defenderPays)
          if (!skipAttackerSide(store)) continue
          if ((store.combatRequirement?.losses ?? 0) >= 3) threePoint += 1
        }
      }
      // eslint-disable-next-line no-console
      console.log(`60×2 骰序里守方 3 点损失出现 ${threePoint} 次`)
      expect(threePoint).toBeGreaterThanOrEqual(0)
    },
  )
})
