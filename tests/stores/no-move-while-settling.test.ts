import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { areAdjacent, neighbor } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

/**
 * 第六批 BUG ②：**在任何结算战斗或者轰炸的时候，不应该有单位能动**
 *
 * 规则依据：
 *   · 8.0 首段：「请**像结算其他战斗一样**来结算突袭（按照 9.2 中的战斗流程）」
 *     ⇒ 突袭（乃至任何一场 9.0 战斗）一开局就**在 9.2 的九步流程里**；
 *   · 流程走完前，8.1a 的 3 MP、8.0 的进格、9.12 的推进与撤退**都还没落盘**
 *     （`finishMove` 早按同一理由拒绝在突袭未收束时结束移动）；
 *   · 10.0 的轰炸同样是「宣布 → 补给 → 横移 → 掷骰 → 结果」的单一流程，DG 与损失同理。
 *
 * ⇒ 修前那段空档里玩家还能点别的算子继续走（同一批单位同时处在两个流程里，记账无从收束）。
 *
 * 修法：新增 `settlementInProgress`（9.2 / 10.0 的**唯一**判据）+ `refuseWhileSettling`，
 *   三个移动入口（开拔 `beginMoveFor` / 走一步 `tryMoveTo` / 进 ZOC `confirmZocEntry`）都问它。
 *
 * 测法边界：只钉**闸门**（结算中 ⇒ 动不了、给原因；收束 ⇒ 立刻恢复）；
 *   9.2 九步与 10.0 五步的结算本身在各自端到端测试里。
 */

const START: HexRef = { col: 36, row: 13 }

type Store = ReturnType<typeof newStore>
type Record = ReturnType<typeof unitChoices>[number]

function newStore() {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

function pickRecord(side: 'axis' | 'soviet', predicate: (record: Record) => boolean): Record {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

function place(
  store: Store,
  record: Record,
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
  face: 'combat' | 'move' = 'combat',
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side, face })
  store.units.push(unit)
  return unit
}

const wheeledMover = () =>
  pickRecord(
    'axis',
    (record) =>
      record.mobilityByFace?.move === 'truck' &&
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.noncombatKind ?? null) === null,
  )

const zocSource = () => pickRecord('soviet', (record) => record.attackCapable === true)

/** 另一枚**可移动**的本方单位（结算中想去动它 ⇒ 应被拒） */
const otherMover = () =>
  pickRecord(
    'axis',
    (record) => record.isCombat === true && record.mobilityByFace?.move !== undefined,
  )

const keyOf = (hex: HexRef) => `${hex.col}.${hex.row}`
const same = (a: HexRef, b: HexRef) => a.col === b.col && a.row === b.row

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

/** 摆到「轮式单位正要进入未抵消敌方 ZOC」的那一刻（待决框已弹出） */
function setupPendingZoc(store: Store): { truck: ConsoleUnit; zocHex: HexRef; enemyHex: HexRef } {
  const truck = place(store, wheeledMover(), START, 'axis', 'a1', 'move')
  truck.fuelled = true
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
  return { truck, zocHex: target!.hex, enemyHex: enemyHex! }
}

/** 另一枚本方单位与轰炸棋盘的落位（与 `START` 错开，避免撞到突袭那一组） */
const SPARE: HexRef = { col: 40, row: 13 }
const BARRAGE_FIRING: HexRef = { col: 36, row: 13 }
const BARRAGE_TARGET: HexRef = { col: 36, row: 14 }

describe('第六批 BUG ②：结算进行中 ⇒ 任何单位都不得移动', () => {
  let store: Store

  beforeEach(() => {
    store = newStore()
  })

  it('前提自检：未开局时没有结算锁 ⇒ 可以正常开拔', () => {
    expect(store.settlementInProgress).toBeNull()
    const mover = place(store, otherMover(), START, 'axis', 'b1', 'move')
    mover.fuelled = true
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction).not.toBeNull()
    store.cancelWholeMove()
  })

  it('★ 突袭（8.0 照 9.2 结算）开局 ⇒ 结算期间不得开拔别的单位', () => {
    const { enemyHex } = setupPendingZoc(store)
    const mover = place(store, otherMover(), SPARE, 'axis', 'b1', 'move')
    mover.fuelled = true

    expect(store.confirmZocEntryAndOverrun(enemyHex)).toBe(true)
    // 8.0：突袭开局 ⇒ 已在 9.2 流程里
    expect(store.settlementInProgress).not.toBeNull()
    expect(store.settlementInProgress?.kind).toBe('combat')
    expect(store.settlementInProgress?.rule).toBe('9.2')

    expect(store.beginMoveFor([mover.instanceId])).toBe(false)
    expect(store.moveBlocked?.rule).toBe('9.2')
    expect(store.moveInteraction).not.toBeNull() // 突袭那一方的移动交互还在（收束后要接着走）
    expect(store.moveInteraction?.unitIds).toContain('a1')

    // 收束（放弃本场）⇒ 闸门立即解除
    store.cancelCombat()
    expect(store.settlementInProgress).toBeNull()
    expect(store.beginMoveFor([mover.instanceId])).toBe(true)
  })

  it('★ 结算期间「走一步」也被拒（不是静默：给出 9.2 的原因）', () => {
    const { enemyHex } = setupPendingZoc(store)
    expect(store.confirmZocEntryAndOverrun(enemyHex)).toBe(true)
    const before = { ...store.units.find((unit) => unit.instanceId === 'a1')!.hex }
    // `tryMoveTo` 由地图点选（`clickHex`）进入 ⇒ 走玩家真正的那条路
    const step = store.groupReachable.hexes[0]?.hex ?? START
    store.clickHex(step)
    expect(store.moveBlocked?.rule).toBe('9.2')
    const after = store.units.find((unit) => unit.instanceId === 'a1')!.hex
    expect(keyOf(after)).toBe(keyOf(before))
    store.cancelCombat()
  })

  it('★ 轰炸（10.0）结算期间同样不得移动', () => {
    store.setPhase('combat')
    // B8：轰炸在本段的轰炸环节（F 段首环即炮击）
    const barrageStep = store.playerSegmentSteps.find((step) => step.id === 'combat.barrage')
    if (barrageStep !== undefined) {
      const index = store.playerSegmentSteps.indexOf(barrageStep)
      expect(store.setSegmentStepIndex(index)).toBe(true)
    }
    const artillery = place(
      store,
      pickRecord(
        'axis',
        (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
      ),
      BARRAGE_FIRING,
      'axis',
      'art-1',
    )
    const defender = place(
      store,
      pickRecord('soviet', (record) => record.isCombat === true),
      BARRAGE_TARGET,
      'soviet',
      'def-1',
    )
    store.battleTarget = { hex: BARRAGE_TARGET, defenderIds: [defender.instanceId] }
    store.setBarrageActive(true)
    store.toggleBarrageUnit(artillery.instanceId)
    expect(store.beginBarrageNow()).toBe(true)

    expect(store.settlementInProgress).not.toBeNull()
    expect(store.settlementInProgress?.kind).toBe('barrage')
    expect(store.settlementInProgress?.rule).toBe('10.0')
    const mover = place(store, otherMover(), SPARE, 'axis', 'b1', 'move')
    mover.fuelled = true
    expect(store.beginMoveFor([mover.instanceId])).toBe(false)
    expect(store.moveBlocked?.rule).toBe('10.0')

    store.cancelBarrage()
    expect(store.settlementInProgress).toBeNull()
  })

  it('源码守卫：三个移动入口都问同一个闸门，且锁同时覆盖战斗与轰炸', () => {
    const source = readFileSync('src/stores/workbench.ts', 'utf8')
    // ① 判据唯一：只看 `combatState` / `barrageState` 的"未收束"
    const lockStart = source.indexOf('const settlementInProgress = computed')
    const lockBody = source.slice(lockStart, lockStart + 700)
    expect(lockBody).toContain('combatState.value')
    expect(lockBody).toContain('barrageState.value')
    expect(lockBody).toContain('!combat.finished')
    expect(lockBody).toContain('!barrage.finished')
    // ② 三个入口都接了闸门
    const beginBody = source.slice(
      source.indexOf('function beginMoveFor('),
      source.indexOf('function beginMoveFor(') + 600,
    )
    expect(beginBody).toContain("refuseWhileSettling('移动')")
    const tryBody = source.slice(
      source.indexOf('function tryMoveTo('),
      source.indexOf('function tryMoveTo(') + 400,
    )
    expect(tryBody).toContain("refuseWhileSettling('继续移动')")
    const zocBody = source.slice(
      source.indexOf('function confirmZocEntry('),
      source.indexOf('function confirmZocEntry(') + 400,
    )
    expect(zocBody).toContain("refuseWhileSettling('继续移动')")
  })
})
