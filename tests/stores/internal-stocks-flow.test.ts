import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ConsoleUnit,
  actionGateOf,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

/**
 * 12.10a：**部队储备动用**（战斗补给的第三条付款途径）
 *
 * 条文：
 *   · 12.10「部队储备……只能用于战斗补给（见 9.5b）」；9.5b「战斗补给需要在战斗的瞬间使用
 *     SP 或部队储备(12.10)来支付」；
 *   · 12.10a「只有在单位无法从图上补给获得所需 SP 时（通过直接拖取或从指挥部投递），才能使
 *     用部队储备」；
 *   · 12.10b 用一次降一级（ready→low→exhausted）；
 *   · 12.10c 耗尽者无法再用 ⇒ 攻击不成立；
 *   · 12.10g 储备与图上 SP 可混用，但**单个算子**必须全额二选一。
 *
 * ★ 修前：`canUseInternalStocks`（引擎已写好，含 12.10a 的编内卡车例外）在 `src/` 内**零调用**，
 *   战斗补给只能用补给站付款 ⇒ **被围的单位永远无法攻击**（而它本可以动用储备）。
 *
 * 本文件钉住三件事：① 图上够 ⇒ 必须走图上（且**不**降级）；② 图上不够 ⇒ 勾选后可用储备补齐并
 * 按 12.10b 降一级；③ 已耗尽者 ⇒ 整笔拒绝（12.10c）。
 */

/**
 * B8：把 store 放到**本段里允许做该动作的那个环节**
 *
 * 段内动作只在对应环节放行（用户口径：「每个环节只能执行该环节能进行的操作」）。
 * 用 B7 的闸门表反查环节，而不是写死序号或环节名。
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

const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row))
      continue
    return candidate
  }
  throw new Error('防御格没有图内邻格')
})()

const attackerRecord = (): ReturnType<typeof unitChoices>[number] => {
  const found = unitChoices('axis').find(
    (record) => record.attackCapable === true && record.isCombat === true,
  )
  if (found === undefined) throw new Error('轴心国单位库中没有可攻击的战斗单位')
  return found
}

const defenderRecord = (): ReturnType<typeof unitChoices>[number] => {
  const found = unitChoices('soviet').find((record) => record.isCombat === true)
  if (found === undefined) throw new Error('苏联单位库中没有战斗单位')
  return found
}

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side, face: 'combat' })
  store.units.push(unit)
  return unit
}

/** 发起战斗 + 只给**攻方**一座"图上不够"的补给站（守方选择不付，避免干扰） */
function setupUnderSupplied(store: ReturnType<typeof newStore>) {
  store.setPhase('combat')
  // B8：F 段首环是炮击 ⇒ 宣告战斗前先进战斗环节
  goToActionStep(store, 'combat.declare')
  store.setTool('battle')
  const attacker = place(store, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
  const defender = place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
  store.clickHex(ATTACKER_HEX)
  store.clickHex(DEFENDER_HEX)
  expect(store.beginCombatNow()).toBe(true)
  // 攻方只有 0 T 的补给站（图上拿不到所需 SP ⇒ 满足 12.10a 的正面条件）
  store.spDumps.push({ id: 'sd-thin', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 0, t: 0 })
  store.pickCombatSupplyDump('attacker', 'sd-thin')
  // 守方不消耗战斗补给（9.5-B 允许），把变量减到只剩攻方
  store.combatInputs.defenderProvides = false
  return { attacker, defender }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('12.10a：图上补给够用时不得动用部队储备（走图上、不降级）', () => {
  it('给足图上 T 且勾选"动用储备" ⇒ 仍全部走图上，单位**不被标记**', () => {
    const store = newStore()
    const { attacker } = setupUnderSupplied(store)
    store.spDumps.push({ id: 'sd-rich', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
    store.pickCombatSupplyDump('attacker', 'sd-rich')
    store.combatInputs.attackerUsesInternalStocks = true

    expect(store.confirmCombatSupply()).toBe(true)
    expect(attacker.internalStocks).toBeNull() // 12.10a：图上够 ⇒ 不得用储备
  })
})

describe('12.10a/b：图上不够时动用储备（被围单位由此才能攻击）', () => {
  it('勾选后可用储备补齐 ⇒ 战斗补给通过，且该单位按 12.10b 降为 low', () => {
    const store = newStore()
    const { attacker } = setupUnderSupplied(store)
    expect(store.combatState?.step).toBe('combatSupply')
    store.combatInputs.attackerUsesInternalStocks = true

    expect(store.confirmCombatSupply()).toBe(true)
    expect(store.combatState?.step).not.toBe('combatSupply')
    expect(attacker.internalStocks).toBe('low') // ready → low（12.10b）
  })

  it('不勾选 ⇒ 维持原状：图上付不出即整笔拒绝（12.4）', () => {
    const store = newStore()
    setupUnderSupplied(store)
    expect(store.confirmCombatSupply()).toBe(false)
    expect(store.combatState?.step).toBe('combatSupply') // 停在原步，账本未动
  })

  it('已 low 的单位再用一次 ⇒ 翻面为 exhausted（12.10b）', () => {
    const store = newStore()
    const { attacker } = setupUnderSupplied(store)
    attacker.internalStocks = 'low'
    store.combatInputs.attackerUsesInternalStocks = true
    expect(store.confirmCombatSupply()).toBe(true)
    expect(attacker.internalStocks).toBe('exhausted')
  })
})

describe('12.10c：已耗尽的单位无法再用 ⇒ 攻击不成立', () => {
  it('耗尽 + 图上不够 ⇒ 战斗补给被拒并给 12.10c', () => {
    const store = newStore()
    const { attacker } = setupUnderSupplied(store)
    attacker.internalStocks = 'exhausted'
    store.combatInputs.attackerUsesInternalStocks = true

    expect(store.confirmCombatSupply()).toBe(false)
    expect(store.combatState?.step).toBe('combatSupply')
    expect(attacker.internalStocks).toBe('exhausted') // 账本未动
    expect(store.log.some((entry) => entry.rule === '12.10c')).toBe(true)
  })
})
