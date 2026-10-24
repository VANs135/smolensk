import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { areAdjacent, neighbor } from '@/engine/hex-geometry'
import { OVERRUN_COST_MP } from '@/engine/rules/overrun'
import { operationTimingOf } from '@/engine/rules/sop-segments'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * 第六批 BUG ①：**4.5a-A 的「突袭」那一支必须是可点的**（不是"先停车再自己找紫环"）
 *
 * 原文（`_ocs_v43_clean.txt:508-515`）：
 *   「A) 轮式移动 <抵消>——拥有轮式 MP 类型的单位，在进入一个敌方 ZOC 后，
 *     **要么必须在此处结束移动，要么必须进行突袭**。如果选择突袭，则每次突袭后，
 *    还能进行下一次突袭，以此方式单位能连续通过多个 ZOC。」
 *
 * 修前的病灶：进 ZOC 的待决框只给了前一支（「确认进入并停止」）——
 *   停车确实把该单位留在了突袭候选里（条 14 已修），但玩家**看不见**后一支，
 *   实测就是「轮式单位进入控制区后立即停下、无法突袭」。
 *
 * 修法：新增 `zocOverrunChoices`（进格后**可立即突袭**的敌方格，资格全部由引擎
 *   `overrunEligibility` 给）+ `confirmZocEntryAndOverrun`（先按 6.1 进格，再从该格
 *   按 8.0 宣布突袭）；参突者锁定为「因进 ZOC 被停车」的那几枚（8.1g）。
 *
 * 测法边界（如实交代）：只钉**分支可达性**（候选非空 + 一点即开局 + 参突者与发起格同口径）；
 *   突袭的**结算**（9.2 九步、8.1a 的 3 MP 记账）在 `overrun-conclude-flow.test.ts`。
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

/** 轮式对象：**朝移动面**轮式的可攻击战斗单位（4.5a-A 真正发生的场合） */
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

const keyOf = (hex: HexRef) => `${hex.col}.${hex.row}`

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

/**
 * 摆到「轮式单位**正要**进入未抵消敌方 ZOC」的那一刻（待决框已弹出、尚未进入）
 *
 * 返回停车格与敌方格（＝4.5a-A 后一支的突袭目标）。
 */
function setupPendingZoc(store: Store): { truck: ConsoleUnit; zocHex: HexRef; enemyHex: HexRef } {
  const truck = place(store, wheeledMover(), START, 'axis', 'a1', 'move')
  // B18b（12.5c）：`toConsoleUnit` 缺省未加注 ⇒ 本组考察 4.5a-A，燃料显式摆好
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

describe('第六批 BUG ①：4.5a-A 的「突袭」分支可点（进 ZOC 前就给出）', () => {
  let store: Store

  beforeEach(() => {
    store = newStore()
  })

  it('★ 待决时即给出「进入后可立即突袭」的敌方格（修前界面只有「停止」一支）', () => {
    const { enemyHex } = setupPendingZoc(store)
    const choices = store.zocOverrunChoices.map((choice) => keyOf(choice.hex))
    expect(choices).toContain(keyOf(enemyHex))
  })

  it('★ 候选的 MP 门槛按**进格之后**的剩余算（8.1a：≥ 3 MP 才可突袭）', () => {
    const { truck } = setupPendingZoc(store)
    const before = store.moveMinRemainingMp
    for (const choice of store.zocOverrunChoices) {
      // 进格要花 MP ⇒ 突袭可用的剩余**不可能**大于进格前的剩余
      expect(choice.mpRemaining).toBeLessThanOrEqual(before)
      expect(choice.mpRemaining).toBeGreaterThanOrEqual(OVERRUN_COST_MP)
      expect(choice.entryCost).toBeLessThanOrEqual(OVERRUN_COST_MP) // 8.1b
      expect(choice.mpCost).toBe(OVERRUN_COST_MP) // 8.1a
    }
    expect(truck.movementEnded).toBe(false) // 还没进格 ⇒ 还没停车
  })

  it('★ 一点即成：进入该格**并**立即发起突袭（进格照 6.1、突袭照 8.0）', () => {
    const { truck, zocHex, enemyHex } = setupPendingZoc(store)
    expect(store.confirmZocEntryAndOverrun(enemyHex)).toBe(true)
    // 6.1a：先走进 ZOC 那一格
    expect(keyOf(truck.hex)).toBe(keyOf(zocHex))
    // 4.5a-A：轮式单位进 ZOC ⇒ 就地停车（走的是"停止"这一支的进格，只是随后就突袭）
    expect(truck.movementEnded).toBe(true)
    // 8.0：从该格发起的突袭已构成 ⇒ 进入 9.2 流程
    expect(store.combatState).not.toBeNull()
    expect(store.overrunContext).not.toBeNull()
    expect(store.pendingZocConfirm).toBeNull()
    store.cancelCombat()
  })

  it('★ 参突者＝因进 ZOC 被停车的那几枚，且发起格就是那一格（8.1g 同格）', () => {
    const { zocHex, enemyHex } = setupPendingZoc(store)
    const preview = store.pendingZocConfirm?.preview
    expect(preview).toBeDefined()
    const stopping = [...preview!.zocStoppingIds]
    expect(stopping.length).toBeGreaterThan(0)
    const choice = store.zocOverrunChoices.find((item) => keyOf(item.hex) === keyOf(enemyHex))
    expect(choice).toBeDefined()
    expect([...choice!.participantIds].sort()).toEqual([...stopping].sort())

    expect(store.confirmZocEntryAndOverrun(enemyHex)).toBe(true)
    // 8.1g：发起格＝参突者所在格（不是"候选里第一枚"的格子）
    expect(store.overrunStackHex).toEqual(zocHex)
    expect(store.overrunParticipantIds.sort()).toEqual([...stopping].sort())
    store.cancelCombat()
  })

  it('目标不在候选里 ⇒ 拒绝并给原因（不静默、也不"看见能突点下去被拒"）', () => {
    const { enemyHex } = setupPendingZoc(store)
    // 构造一个"相邻但不是候选"的格：拿敌方格之外的另一个邻格
    const other = neighbor(enemyHex, 'N')
    if (store.zocOverrunChoices.some((choice) => keyOf(choice.hex) === keyOf(other))) {
      // 极小概率撞上真候选 —— 那就换个方向再试
      expect(store.confirmZocEntryAndOverrun(other)).toBe(true)
      store.cancelCombat()
      return
    }
    expect(store.confirmZocEntryAndOverrun(other)).toBe(false)
    expect(store.pendingZocConfirm).not.toBeNull() // 拒绝 ⇒ 待决仍在（玩家可以改选）
    expect(store.moveBlocked?.rule).toBe('8.1')
  })

  it('★ 7.0 首句 / 7.0b：反应阶段的移动环节也放行突袭（8.0「各个移动环节」）', () => {
    // 7.0：「反应阶段是非阶段玩家可利用移动、**突袭**和轰炸打乱敌方计划的机会」；
    // 7.0b：「反应阶段中，轰炸和突袭的结算**照常**」⇒ 修前缺这一环 ⇒ 反应阶段停车即无处突袭
    const segments = actionGateOf('move.overrun')
      .where.map((where) => where.segment)
      .sort()
    expect(segments).toContain('reaction.movement')
    expect(segments).toContain('movement.modeAndMovement')
    expect(segments).toContain('exploitation.movement')
    // 与引擎的时机表同口径（两张表由 phase-gate 的不变量钉住，此处只钉"三个移动环节都在"）
    expect(operationTimingOf('overrun')?.segments.slice().sort()).toEqual(segments)
  })

  it('源码守卫：待决框的两个分支都来自同一份 `pendingZocConfirm`（不另起一套进格）', () => {
    const source = readFileSync('src/stores/workbench.ts', 'utf8')
    // ① 后一支的进格复用 `commitStep`（与「停止」那一支同一条落盘路径）
    const start = source.indexOf('function confirmZocEntryAndOverrun')
    const body = source.slice(start, start + 1600)
    expect(body).toContain('commitStep(pending.to, pending.preview.path)')
    // ② 资格一律问引擎，本层不重算
    expect(body).toContain('overrunNow(target)')
    expect(source).toContain('const zocOverrunChoices = computed')
    const choicesBody = source.slice(
      source.indexOf('const zocOverrunChoices = computed'),
      source.indexOf('const zocOverrunChoices = computed') + 1600,
    )
    expect(choicesBody).toContain('overrunEligibility(')
  })
})
