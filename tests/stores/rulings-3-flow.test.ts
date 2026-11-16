import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it } from 'vitest'

import { sameHex } from '@/engine/hex-geometry'
import type { HexRef } from '@/data'
import { useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround, type Workbench } from '../flows/sop-harness'

/**
 * 裁定 3 的规格用例（用户 2026-11-13）：
 * 铁路运输通用流程＝合法位置点「铁路运输」→ 有运力则高亮可达目的地 →
 * 点目的地到达 → 弹「确认／撤回」小窗；增援放置的铁路按钮复用同一条流程。
 *
 * 另钉住例外边界：13.6b 是 13.3b「运力只在移动阶段」的例外，**不撬**通用阶段闸门。
 */
const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/* ───────────────────────── 移动阶段 ───────────────────────── */

/** 与 `rail-cargo-flow.test.ts` 同一段实测铁路：15.10（起点聚落）→ 18.18（Orsha） */
const RAIL_RUN: HexRef[] = [
  { col: 15, row: 10 },
  { col: 15, row: 11 },
  { col: 15, row: 12 },
  { col: 15, row: 13 },
  { col: 16, row: 13 },
  { col: 16, row: 14 },
  { col: 16, row: 15 },
  { col: 17, row: 16 },
  { col: 17, row: 17 },
  { col: 18, row: 17 },
  { col: 18, row: 18 },
]
const FROM: HexRef = RAIL_RUN[0]!
const TO: HexRef = RAIL_RUN[RAIL_RUN.length - 1]!

function prepareRailRun(store: Workbench): void {
  store.supplySourceDraft = { hexText: label(FROM), kind: 'supplySourceHex' }
  expect(store.addSupplySource()).toBe(true)
  expect(store.detrainableHexes.some((hex) => label(hex) === label(FROM))).toBe(true)
  expect(store.detrainableHexes.some((hex) => label(hex) === label(TO))).toBe(true)
}

function railUnit(
  store: Workbench,
  hex: HexRef,
  instanceId: string,
): ReturnType<typeof placeGround> {
  const record = groundRecord(
    'soviet',
    (item) =>
      item.isCombat === true &&
      item.attackCapable === true &&
      item.classes?.movementClass !== 'leg',
  )
  const unit = placeGround(store, record, hex, 'soviet', instanceId)
  unit.mode = { mode: 'move', orientation: 'move', dg: false, exploit: false }
  unit.mpSpent = 0
  unit.movementEnded = false
  return unit
}

function movementRailStore(): Workbench {
  setActivePinia(createPinia())
  const store = useWorkbenchStore()
  store.switchSide()
  store.setPhase('movement')
  store.setTurn(5) // 专规 1.2：7/19 后苏方运力 3
  prepareRailRun(store)
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('裁定 3：铁路运输通用流程（确认／撤回）', () => {
  it('点目的地只进「待确认」，不落子、不扣运力；确认后才落子并扣点', () => {
    const store = movementRailStore()
    const cargo = railUnit(store, FROM, 'cargo-confirm')
    store.selectedId = cargo.instanceId
    const before = store.railCapRemaining[store.activeSide]

    store.beginRailMoveHexPickNow('unit')
    expect(store.pickHexFor(TO)).toBe(true)

    // 到这一步只应出现确认窗，不应结算
    expect(store.pendingRailTransport).toMatchObject({ kind: 'unit', to: TO })
    expect(cargo.hex).toEqual(FROM)
    expect(store.railCapRemaining[store.activeSide]).toBe(before)

    expect(store.confirmRailTransportNow()).toBe(true)
    expect(cargo.hex).toEqual(TO)
    expect(cargo.movementEnded).toBe(true)
    expect(store.railCapRemaining[store.activeSide]).toBeLessThan(before)
    expect(store.pendingRailTransport).toBeNull()
  })

  it('撤回：清掉待确认落点，单位与运力都不动', () => {
    const store = movementRailStore()
    const cargo = railUnit(store, FROM, 'cargo-cancel')
    store.selectedId = cargo.instanceId
    const before = store.railCapRemaining[store.activeSide]

    store.beginRailMoveHexPickNow('unit')
    expect(store.pickHexFor(TO)).toBe(true)
    expect(store.cancelRailTransportNow()).toBe(true)

    expect(store.pendingRailTransport).toBeNull()
    expect(cargo.hex).toEqual(FROM)
    expect(store.railCapRemaining[store.activeSide]).toBe(before)
  })

  it('例外边界：13.3b 通用闸门不撬——增援阶段的普通铁路运货仍被拒', () => {
    const store = movementRailStore()
    const cargo = railUnit(store, FROM, 'cargo-phase-gate')
    store.selectedId = cargo.instanceId
    store.setPhase('reinforcement')
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }

    expect(store.railMoveNow('unit')).toBe(false)
    expect(cargo.hex).toEqual(FROM)
  })
})

/* ───────────────────────── 增援阶段 ───────────────────────── */

/** 裁定 1 认可的轴方铁路入场格（含铁路的字母入场段） */
const AXIS_RAIL_ENTRY = new Set(['8.0', '1.7', '1.19', '1.3'])

function seekArrivalAt(store: Workbench, keys: Set<string>): { index: number; hex: HexRef } | null {
  for (let turn = 1; turn <= 40; turn += 1) {
    store.setTurn(turn)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan
    if (plan === null) continue
    for (let index = 0; index < plan.units.length; index += 1) {
      const unit = plan.units[index]!
      if (unit.kind === 'sp' || unit.kind === 'unclassified') continue
      const placement = store.arrivalPlacements[index]
      if (placement === undefined || !('hex' in placement) || placement.hex == null) continue
      if (keys.has(label(placement.hex))) return { index, hex: placement.hex }
    }
  }
  return null
}

/** 找一条「入场阶段 + 轴方有运力 + 入场格含铁路」的到达条目 */
function seekRailArrival(store: Workbench): { index: number; hex: HexRef } | null {
  for (let turn = 1; turn <= 40; turn += 1) {
    store.setTurn(turn)
    store.setPhase('reinforcement')
    if (store.railCapToday.axis < 1) continue
    const plan = store.arrivalPlan
    if (plan === null) continue
    for (let index = 0; index < plan.units.length; index += 1) {
      const unit = plan.units[index]!
      if (unit.kind === 'sp' || unit.kind === 'unclassified') continue
      const placement = store.arrivalPlacements[index]
      if (placement === undefined || !('hex' in placement) || placement.hex == null) continue
      if (AXIS_RAIL_ENTRY.has(label(placement.hex))) return { index, hex: placement.hex }
    }
  }
  return null
}

describe('裁定 3：增援放置的铁路运输按钮复用同一流程', () => {
  it('铁路入场格：点卸货格直接落子并扣运力；撤回一步退点', () => {
    const store = useWorkbenchStore()
    const hit = seekRailArrival(store)
    expect(hit, '真实到达表里应存在含铁路入场格的轴方增援').not.toBeNull()
    const { index, hex } = hit!
    store.applyArrivalRemovalsNow()

    expect(store.arrivalRailEligible(index)).toBe(true)
    expect(store.beginArrivalRailPickNow(index)).toBe(true)

    const view = store.hexPickView
    expect(view).not.toBeNull()
    const candidates =
      view === null || view.candidates === 'any' ? [] : view.candidates.map((item) => label(item))
    expect(candidates.length).toBeGreaterThan(0)
    for (const item of candidates) {
      expect(store.detrainableHexes.map(label), `${item} 不是 13.3c 可卸货格`).toContain(item)
    }

    const before = store.railCapRemaining[store.activeSide]
    const target = view === null || view.candidates === 'any' ? null : view.candidates[0]!
    expect(target).not.toBeNull()
    // M1/M2：点卸货格＝同一击落子（不再有确认窗）
    expect(store.pickHexFor(target!)).toBe(true)

    expect(store.pendingRailTransport).toBeNull()
    expect(store.railCapRemaining[store.activeSide]).toBeLessThan(before)
    const landed = store.units.filter((unit) => sameHex(unit.hex, target!))
    expect(landed.length).toBeGreaterThan(0)
    // 落点是目标格，不是入场格
    expect(sameHex(landed[0]!.hex, hex)).toBe(false)

    // 一步撤回：算子回手牌、运力退回
    expect(store.arrivalRailUndo).toMatchObject({ index, side: store.activeSide })
    expect(store.undoArrivalRailNow()).toBe(true)
    expect(store.arrivalRailUndo).toBeNull()
    expect(store.railCapRemaining[store.activeSide]).toBe(before)
    expect(store.units.some((unit) => sameHex(unit.hex, target!))).toBe(false)
  })

  it('非铁路入场格（K=1.26 / I=1.12）：按钮不可用（不可用项不出现）', () => {
    const store = useWorkbenchStore()
    const hit = seekArrivalAt(store, new Set(['1.26', '1.12']))
    expect(hit, '真实到达表里应存在 K / I 入场的轴方增援').not.toBeNull()
    expect(store.arrivalRailEligible(hit!.index)).toBe(false)
  })

  it('★ 运力为 0 ⇒ 铁路项整项不出现；真被拒时只点名"运力不足"，不把三种原因并成一句', () => {
    const store = useWorkbenchStore()
    const hit = seekRailArrival(store)
    expect(hit, '真实到达表里应存在含铁路入场格的轴方增援').not.toBeNull()
    const { index } = hit!
    store.applyArrivalRemovalsNow()
    // 执行侧判据（可达卸货格 + 运力）与按钮同源：先把本回合运力用光
    const remaining = store.railCapRemaining[store.activeSide]
    expect(remaining).toBeGreaterThan(0)
    store.spendRailCapacity(store.activeSide, remaining)

    expect(store.arrivalRailEligible(index)).toBe(false)
    expect(store.beginArrivalRailPickNow(index)).toBe(false)
    expect(store.reinforcementError?.reason).toMatch(/^arrivalRailCapacity:/)
    const last = store.log[0]?.text ?? ''
    expect(last).toContain('铁路运力不足')
    expect(last).not.toContain('没有可铁路抵达的卸货格')
    expect(last).not.toContain('入场格不含铁路')
  })

  it('面板拒绝文案按具体缺项给，不再把三种原因 OR 成一句', () => {
    const panel = readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')
    expect(panel).not.toContain('没有可抵达的卸货格，或运力不足')
    expect(panel).toContain('arrivalRailCapacity')
    expect(panel).toContain('arrivalRailNoDetrainable')
    expect(panel).toContain('arrivalRailEntryNoRail')
  })
})
