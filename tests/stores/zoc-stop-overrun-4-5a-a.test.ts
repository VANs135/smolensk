import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { areAdjacent, neighbor } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

/**
 * 第六批批 P0 切片 2（条 14）：**4.5a-A「结束移动**或进行突袭**」**
 *
 * 原文（`_ocs_v43_clean.txt:508-515`）：
 *   「4.5a 下列行动不可在一个敌方 ZOC 内进行……A) 轮式移动 <抵消> —— 拥有轮式 MP 类型的单位，
 *    在进入一个敌方 ZOC 后，要么必须在此处**结束移动**，要么必须**进行突袭**。如果选择突袭，
 *    则每次突袭后，还能进行下一次突袭，以此方式单位能连续通过多个 ZOC。」
 *
 * 修前的病灶（一句话）：**停车把 `movementEnded` 置真，而突袭候选只取"未结束"者**
 *   ⇒ 轮式单位一进 ZOC 就同时失去"继续移动"与"突袭"两条路，4.5a-A 的后一半**实际不可达**。
 *   具体三处：`overrunTargets`（紫环候选）、`overrunNow`（发起）、`moveMinRemainingMp`（8.1a 的 3 MP 门槛）
 *   都只读 `activeMoveUnits`（`movementEnded === false`）。
 *
 * 修法：`zocStoppedMoveUnitIds` 记下"本次因进 ZOC 停车"的单位 ⇒ 它们**仍在突袭候选里**；
 *   同时 `planStep` 因"全体 ended"标出的 `finished` 在此时不算收束（`applyOverrunMove` 拒绝 finished 的交互）。
 *
 * ## 测法边界（如实交代）
 *   · 用真实地图、真实单位库；轮式对象取「**朝移动面**轮式」的摩托化战斗单位（3.1a 逐面机动类型）；
 *   · 只钉**资格链**（候选非空 + 能发起 + 结束移动后即消失）；突袭的**结算**（9.2 九步、8.1a 的 3 MP 记账）
 *     在 `tests/stores/overrun-conclude-flow.test.ts` 与 `tests/engine/overrun*.test.ts`；
 *   · **不覆盖**：连续穿越多个 ZOC（"每次突袭后再突袭"）——那需要走完整场 9.2，属 `overrun-conclude-flow` 的地盘。
 */

const START: HexRef = { col: 36, row: 13 }

function newStore() {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

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
  face: 'combat' | 'move' = 'combat',
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side, face })
  store.units.push(unit)
  return unit
}

/** 轮式对象：**朝移动面**轮式的摩托化战斗单位（12.5a / 4.5a-A 真正发生的场合） */
const wheeledMover = () =>
  pickRecord(
    'axis',
    (record) =>
      record.mobilityByFace?.move === 'truck' &&
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.noncombatKind ?? null) === null,
  )

/** 敌方 ZOC 源：可攻击的苏方单位（4.5：战斗模式 + 可攻击 + 有追溯补给才投射） */
const zocSource = () => pickRecord('soviet', (record) => record.attackCapable === true)

const same = (a: HexRef, b: HexRef) => a.col === b.col && a.row === b.row

const adjacentReachable = (
  store: ReturnType<typeof newStore>,
  start: HexRef,
): { hex: HexRef; mpSpent: number } | undefined =>
  store.groupReachable.hexes.find((node) => areAdjacent(start, node.hex))

function findFreeNeighborOf(
  store: ReturnType<typeof newStore>,
  target: HexRef,
  avoid: HexRef,
): HexRef | null {
  const occupied = new Set(store.units.map((unit) => `${unit.hex.col}.${unit.hex.row}`))
  for (const direction of ['N', 'NE', 'SE', 'S', 'SW', 'NW'] as const) {
    const candidate = neighbor(target, direction)
    if (same(candidate, avoid)) continue
    if (occupied.has(`${candidate.col}.${candidate.row}`)) continue
    return candidate
  }
  return null
}

/**
 * 摆好「轮式单位进未抵消敌方 ZOC 并就地停车」的盘面
 *
 * 返回停车后的车与它所进入的格、以及那个敌方单位所在的格（突袭目标）。
 */
function setupZocStop(store: ReturnType<typeof newStore>): {
  truck: ConsoleUnit
  stopHex: HexRef
  enemyHex: HexRef
} {
  const truck = place(store, wheeledMover(), START, 'axis', 'a1', 'move')
  // B18b（12.5c）：`toConsoleUnit` 缺省为「未加注」⇒ 本组考察 4.5a-A，燃料显式摆好
  truck.fuelled = true
  // 条 10（批 M）：点格只建取子清单，开拔交由「开始移动」按钮
  store.clickHex(START)
  expect(store.confirmMovePick()).toBe(true)
  const target = adjacentReachable(store, START)
  expect(target).toBeDefined()
  const enemyHex = findFreeNeighborOf(store, target!.hex, truck.hex)
  expect(enemyHex).not.toBeNull()
  place(store, zocSource(), enemyHex!, 'soviet', 'e1')
  store.clickHex(START)
  store.clickHex(target!.hex)
  expect(store.pendingZocConfirm).not.toBeNull()
  store.confirmZocEntry()
  expect(truck.hex).toEqual(target!.hex)
  return { truck, stopHex: target!.hex, enemyHex: enemyHex! }
}

describe('第六批 P0-2：4.5a-A 停车后仍可突袭（条 14）', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  it('前提自检：轮式单位进未抵消 EZOC ⇒ 就地停车（`movementEnded` 为真）', () => {
    const { truck } = setupZocStop(store)
    expect(truck.movementEnded).toBe(true)
    // 反空转：仍在移动交互里，且普通移动已被关掉（没有可到达格）
    expect(store.moveInteraction).not.toBeNull()
  })

  it('★ 停车后**仍在突袭候选里**（修前候选为空 ⇒ 4.5a-A 后一半不可达）', () => {
    const { truck } = setupZocStop(store)
    expect(store.overrunCandidateUnits.map((unit) => unit.instanceId)).toContain(truck.instanceId)
    expect(store.overrunStackHex).toEqual(truck.hex)
  })

  it('★ 紫环候选含相邻的敌方格 ⇒ 玩家能看见"还能突袭"', () => {
    const { enemyHex } = setupZocStop(store)
    const targets = store.overrunTargetHexes.map((hex) => `${hex.col}.${hex.row}`)
    expect(targets).toContain(`${enemyHex.col}.${enemyHex.row}`)
  })

  it('★ 停车后发起突袭成立（`overrunNow` 不再因"没有仍在移动中的单位"被拒）', () => {
    const { enemyHex } = setupZocStop(store)
    expect(store.overrunNow(enemyHex)).toBe(true)
    // 8.0：突袭走 9.2 九步 ⇒ 战斗已构成
    expect(store.combatState).not.toBeNull()
    expect(store.overrunContext).not.toBeNull()
    store.cancelCombat()
  })

  it('★ 玩家主动「结束移动」＝选了 4.5a-A 的前一支 ⇒ 突袭候选随之清空', () => {
    const { truck, enemyHex } = setupZocStop(store)
    expect(store.overrunCandidateUnits.map((unit) => unit.instanceId)).toContain(truck.instanceId)

    store.finishMove()
    expect(store.overrunCandidateUnits).toHaveLength(0)
    expect(store.overrunTargetHexes.map((hex) => `${hex.col}.${hex.row}`)).not.toContain(
      `${enemyHex.col}.${enemyHex.row}`,
    )
  })

  it('★ 停车**不改**普通移动：停车后依然走不了下一格（只有突袭这条路）', () => {
    const { truck } = setupZocStop(store)
    // `reachableForMove` 按运行态的 `ended` 过滤 ⇒ 停车者不在可到达集合里
    const reachable = store.groupReachable.hexes.map((node) => `${node.hex.col}.${node.hex.row}`)
    expect(reachable).not.toContain(`${truck.hex.col}.${truck.hex.row}`)
  })

  it('源码守卫：突袭候选＝`overrunCandidateUnits`（含 ZOC 停车者），不再是 `activeMoveUnits`', () => {
    const source = readFileSync('src/stores/workbench.ts', 'utf8')
    // ① 三个消费点都用突袭候选
    const targetsStart = source.indexOf('const overrunTargets = computed')
    const targetsBody = source.slice(targetsStart, targetsStart + 900)
    expect(targetsBody).toContain('overrunCandidateUnits.value.map')
    expect(targetsBody).not.toContain('activeMoveUnits.value.map')
    // ② 8.1a 的 MP 门槛也按同一口径（否则门槛恒为 0 ⇒ 永远突袭不了）
    const mpStart = source.indexOf('const moveMinRemainingMp = computed')
    const mpBody = source.slice(mpStart, mpStart + 700)
    expect(mpBody).toContain('zocStoppedMoveUnitIds.value.includes(id)')
    // ③ 记账只来自 `planStep` 的 `zocStoppedIds`（不另判一遍 ZOC）
    expect(source).toContain('result.data.record.zocStoppedIds')
  })
})
