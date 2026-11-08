import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { areAdjacent, neighbor } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

/**
 * BUG 1：**混合堆叠的突袭只有轮式单位能参与**
 *
 * 原文（`_ocs_v43_clean.txt` 8.1 / 8.1g / 8.1h；4.5a-A）：
 *   - 8.1：参与突袭的单位须在**阶段开始时同格堆叠**、可攻击、处于战斗/移动/进击模式；
 *     **没有按移动力类型（轮式/履带/徒步）限制参与**；
 *   - 4.5a-A：「拥有轮式 MP 类型的单位，在进入一个敌方 ZOC 后，要么必须在此处结束移动，
 *     要么必须进行突袭」——**被强制停车的只有轮式单位**，同行的其它单位仍可继续走；
 *   - 8.1g/h：进行突袭的单位随堆叠移动；**不参与突袭的友方单位可以留在格内**（仍计 4.8a），
 *     突袭结果对它们无影响。
 *
 * 故「混合堆叠一起进入 ZOC」时，轮式单位触发停/突选择，而**同格所有合格单位都可参突**；
 * 不合格者（DG / 不可攻击 / MP 不足）不参突、也不得阻塞其余单位。
 *
 * 修前病灶：`zocOverrunChoices` 的参突者被锁成 `preview.zocStoppingIds`（只含轮式），
 * 于是同堆叠的履带/徒步合格单位被漏掉，看起来「只有轮式能突袭」。
 */

const START: HexRef = { col: 36, row: 13 }

type Store = ReturnType<typeof newStore>
type UnitRecord = ReturnType<typeof unitChoices>[number]

function newStore() {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

function pick(side: 'axis' | 'soviet', predicate: (record: UnitRecord) => boolean): UnitRecord {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

function place(
  store: Store,
  record: UnitRecord,
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
  face: 'combat' | 'move' = 'combat',
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side, face })
  store.units.push(unit)
  return unit
}

/** 轮式合格者：轮式移动面 + 可攻击战斗单位 */
const wheeled = (): UnitRecord =>
  pick(
    'axis',
    (record) =>
      record.mobilityByFace?.move === 'truck' &&
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.noncombatKind ?? null) === null,
  )

/** 非轮式合格者：徒步/履带 + 可攻击战斗单位（8.1 未按移动力类型限制参与） */
const tracked = (): UnitRecord =>
  pick(
    'axis',
    (record) =>
      (record.mobilityByFace?.move === 'tracked' || record.mobilityByFace?.move === 'leg') &&
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.noncombatKind ?? null) === null,
  )

const zocSource = (): UnitRecord => pick('soviet', (record) => record.attackCapable === true)

const keyOf = (hex: HexRef) => `${hex.col}.${hex.row}`
const same = (a: HexRef, b: HexRef) => keyOf(a) === keyOf(b)

const adjacentReachable = (store: Store, start: HexRef) =>
  store.groupReachable.hexes.find((node) => areAdjacent(start, node.hex))

function findFreeNeighborOf(store: Store, target: HexRef, avoid: HexRef): HexRef | null {
  const occupied = new Set(store.units.map((unit) => keyOf(unit.hex)))
  for (const direction of ['N', 'NE', 'SE', 'S', 'SW', 'NW'] as const) {
    const candidate = neighbor(target, direction)
    if (same(candidate, avoid)) continue
    if (occupied.has(keyOf(candidate))) continue
    return candidate
  }
  return null
}

/** 摆到「混合堆叠正要进入未抵消敌方 ZOC」的那一刻（待决框已弹出、尚未进入） */
function setupPendingMixedZoc(
  store: Store,
  opts: { dgIdle?: boolean } = {},
): { truck: ConsoleUnit; walker: ConsoleUnit; dg: ConsoleUnit | null; enemyHex: HexRef } {
  const truck = place(store, wheeled(), START, 'axis', 'a1', 'move')
  const walker = place(store, tracked(), START, 'axis', 'a2', 'move')
  truck.fuelled = true
  walker.fuelled = true
  const dg = opts.dgIdle === true ? place(store, tracked(), START, 'axis', 'a3', 'move') : null
  if (dg !== null) {
    // 5.10：DG 不可突袭 ⇒ 应被排除，但不得阻塞其它单位（状态位在 `mode.dg`）
    dg.mode = { ...dg.mode, dg: true }
    dg.fuelled = true
  }

  store.clickHex(START)
  // 6.1：整堆叠一起开拔（三名单位都在交互里）
  store.stackSelect = true
  store.clickHex(START)
  expect(store.confirmMovePick()).toBe(true)
  expect(store.moveInteraction?.unitIds.slice().sort()).toEqual(
    (dg === null ? ['a1', 'a2'] : ['a1', 'a2', 'a3']).sort(),
  )

  const target = adjacentReachable(store, START)
  expect(target).toBeDefined()
  const enemyHex = findFreeNeighborOf(store, target!.hex, truck.hex)
  expect(enemyHex).not.toBeNull()
  place(store, zocSource(), enemyHex!, 'soviet', 'e1')
  store.clickHex(START)
  store.clickHex(target!.hex)
  expect(store.pendingZocConfirm).not.toBeNull()
  return { truck, walker, dg, enemyHex: enemyHex! }
}

describe('BUG 1：混合堆叠进入 ZOC 后可一起突袭（参与范围按 8.1，不按移动力类型）', () => {
  let store: Store

  beforeEach(() => {
    store = newStore()
  })

  it('★ 轮式 + 非轮式同堆叠：突袭候选的参突者包含**两者**（修前只有轮式）', () => {
    const { enemyHex } = setupPendingMixedZoc(store)
    const choice = store.zocOverrunChoices.find((item) => same(item.hex, enemyHex))
    expect(choice).toBeDefined()
    expect([...choice!.participantIds].sort()).toEqual(['a1', 'a2'])
    // 4.5a-A 只管轮式停车；这不等于只有轮式能突袭
    expect(store.pendingZocConfirm?.preview.zocStoppingIds).toEqual(['a1'])
  })

  it('★ 一点即成：进入并突袭时两枚合格单位都锁定为参突者（8.1g 同格）', () => {
    const { truck, walker, enemyHex } = setupPendingMixedZoc(store)
    expect(store.confirmZocEntryAndOverrun(enemyHex)).toBe(true)
    expect(keyOf(truck.hex)).toBe(keyOf(store.overrunStackHex!))
    expect(keyOf(walker.hex)).toBe(keyOf(store.overrunStackHex!))
    expect([...store.overrunParticipantIds].sort()).toEqual(['a1', 'a2'])
    expect(store.overrunContext?.participantIds.slice().sort()).toEqual(['a1', 'a2'])
    store.cancelCombat()
  })

  it('★ 不可突袭者（DG）不参与，也不阻塞其余单位（8.1h 留驻）', () => {
    const { enemyHex } = setupPendingMixedZoc(store, { dgIdle: true })
    const choice = store.zocOverrunChoices.find((item) => same(item.hex, enemyHex))
    expect(choice).toBeDefined()
    expect(choice!.participantIds).not.toContain('a3')
    expect([...choice!.participantIds].sort()).toEqual(['a1', 'a2'])
  })

  it('★ 移动力不足 ⇒ 整体不可突袭（8.1a：剩余 MP 不足 3 的单位不能突袭）', () => {
    setupPendingMixedZoc(store)
    // 本步进格之后剩余 < 3 MP ⇒ 整堆叠都不满足 8.1a（把已耗 MP 推高来制造该局面）
    for (const unit of store.units.filter((item) => item.side === 'axis')) unit.mpSpent += 99
    expect(store.zocOverrunChoices).toEqual([])
  })

  it('★ 非 ZOC 路径（`overrunTargets`）同样按合格者取参突集，DG 不阻塞', () => {
    // 直接让混合堆叠从起始格突袭相邻敌方格（不经过 ZOC 待决框）
    const truck = place(store, wheeled(), START, 'axis', 'a1', 'move')
    const walker = place(store, tracked(), START, 'axis', 'a2', 'move')
    const dg = place(store, tracked(), START, 'axis', 'a3', 'move')
    for (const unit of [truck, walker, dg]) unit.fuelled = true
    dg.mode = { ...dg.mode, dg: true }
    store.stackSelect = true
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)

    const enemyHex = neighbor(START, 'N')
    place(store, zocSource(), enemyHex, 'soviet', 'e1')
    expect(store.overrunTargetHexes.some((hex) => same(hex, enemyHex))).toBe(true)

    expect(store.overrunNow(enemyHex)).toBe(true)
    // 未显式勾选 ⇒ 默认参突集＝合格者（`overrunParticipantIds` 为空表示"全部合格者"）
    expect([...store.overrunContext!.participantIds].sort()).toEqual(['a1', 'a2'])
    expect(store.overrunContext!.participantIds).not.toContain('a3')
    store.cancelCombat()
  })
})
