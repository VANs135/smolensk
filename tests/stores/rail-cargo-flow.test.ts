import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 13.3 铁路运货（store 级）：13.3a 容量费用 / 13.3b 移动阶段与每回合额度 / 13.3e 三步
 *
 * 条文：
 *   · **13.3a**「每个铁路运量点数可以运输一个 SP 或 RE，**距离不限**；路径含**运输破坏区**则翻倍、
 *     **全程多轨**则减半」（两条累计）。
 *   · **13.3b** 铁路运量只能在**移动阶段**用；当日容量由专规 1.2 给定（轴 0/苏 2，7 月 19 日起轴 1/苏 3）。
 *   · **13.3e** 三步：登车（不在 EZOC 的可卸货铁路格）→ 沿铁路移动（相连、轨距正确、受控、无敌军与 EZOC）
 *     → 卸货（同登车条件）；**卸货后不得再移动**（4.7d）。
 *   · **13.3f / 13.3h**：错误轨距与未控制的铁路格不可用。
 *
 * ★ 修前 `validateRailMovement` / `railCapacityCost` / `createRailFacts` **全部零消费** ⇒
 *   盘面上根本没有「用铁路运兵/运货」这条路（而专规 1.2 的轨距账本、13.3c 的火车卸货格都已就位）。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/**
 * 地图上的**一段实际铁路线**（主轴干线，自 15.10 起向东）
 *
 * 两端都是**聚落格**（13.3c 的可火车卸货格要求村庄/城市），且沿线各格都能放本单位控住。
 * ★ 这段走线由地图数据实测得出（脚本从 `map-layers.edges` 的 `rail === true` 边建图后取最短路），
 *   不是猜的坐标——写死是为了让用例稳定。
 */
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

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 起点（15.10）与终点（18.18，Orsha）——两端都是聚落格（13.3c） */
const FROM: HexRef = RAIL_RUN[0]!
const TO: HexRef = RAIL_RUN[RAIL_RUN.length - 1]!

/** 摆一个**移动模式**的战斗单位（13.3e：铁路运输须移动模式；取非步行的以免 4.7b 减半） */
function railUnit(store: Workbench, hex: HexRef, instanceId: string) {
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

/**
 * 把这段铁路置成**苏方可用且受控**（13.3f/13.3h），并给铁路一个**基础补给源**（13.3c）
 *
 * - 专规 1.2：印刷图全是宽轨、轴方只能用标准轨 ⇒ 苏方在未换轨的格上天然可用（13.3f）；
 * - 13.3h 控制＝同格**唯一**战斗单位所属方（与补给层 `controlByHex` 同一口径）⇒ 沿线各格放一个苏军单位；
 * - 13.3c 的可火车卸货格须有一条**免 EZOC 的铁路路径回到补给源** ⇒ 在此声明起点（15.10）为该方的补给源格。
 */
function controlRailRun(store: Workbench): void {
  RAIL_RUN.forEach((hex) => railUnit(store, hex, `ctl-${label(hex)}`))
  // 12.6a①：把起点声明为该方的补给源格（13.3c 的「免 EZOC 铁路路径回到补给源」由此成立）
  store.supplySourceDraft = { hexText: label(FROM), kind: 'supplySourceHex' }
  expect(store.addSupplySource()).toBe(true)
  expect(store.detrainableHexes.some((hex) => label(hex) === label(FROM))).toBe(true)
  expect(store.detrainableHexes.some((hex) => label(hex) === label(TO))).toBe(true)
}

/** 切到苏方（13.3b：只用本方铁路容量；专规 1.2：苏方用宽轨） */
function sovietStore(): Workbench {
  const store = newStore()
  store.switchSide()
  return store
}

describe('13.3e 三步：登车 → 铁路移动 → 卸货', () => {
  it('满足条件的单位可沿铁路整段移动（距离不限），卸货后不能再移动（4.7d）', () => {
    const store = sovietStore()
    store.setPhase('movement')
    store.setTurn(5) // 专规 1.2：7/19 之后苏方容量 3
    controlRailRun(store)
    const cargo = railUnit(store, FROM, 'cargo-1')
    store.selectedId = cargo.instanceId
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }

    // 13.3a：1 RE 单位（该单位非「步行 1–6 MA」，故 4.7b 不减半）；整段走在多轨干线上 ⇒ 13.3a 减半
    expect(store.railMoveNow('unit')).toBe(true)
    expect(cargo.hex).toEqual(TO)
    expect(cargo.movementEnded).toBe(true)
    expect(store.lastRailMove!.detail).toContain('全程多轨')
    expect(store.lastRailMove?.cost).toBeGreaterThan(0)
    expect(store.railMoveError).toBeNull()
    // 13.3b：容量账本记上了
    expect(store.railCapUsedBy('soviet')).toBe(store.lastRailMove!.cost)
    expect(store.railMovedUnitIdsThisPhase).toContain(cargo.instanceId)
  })

  it('13.3b：非移动阶段一律拒（铁路运量只能在移动阶段用）', () => {
    const store = sovietStore()
    store.setPhase('combat')
    store.setTurn(5)
    controlRailRun(store)
    const cargo = railUnit(store, FROM, 'cargo-1')
    store.selectedId = cargo.instanceId
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }

    expect(store.railMoveNow('unit')).toBe(false)
    // ★ B8：非移动阶段的拒绝由统一闸门给（13.3 只在移动阶段）
    expect(store.actionRefusal).toMatchObject({ key: 'move.railTransport', rule: '13.3' })
    expect(cargo.hex).toEqual(FROM)
    expect(store.railCapUsedBy('soviet')).toBe(0)
  })

  it('13.3e-1：须移动模式 —— 战斗模式的单位被 5.6a 拒', () => {
    const store = sovietStore()
    store.setPhase('movement')
    store.setTurn(5)
    controlRailRun(store)
    const cargo = railUnit(store, FROM, 'cargo-1')
    cargo.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
    store.selectedId = cargo.instanceId
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }

    expect(store.railMoveNow('unit')).toBe(false)
    expect(store.railMoveError?.rule).toBe('5.6a')
    expect(cargo.hex).toEqual(FROM)
  })

  it('5.10d：DG 单位不能用铁路（无例外）', () => {
    const store = sovietStore()
    store.setPhase('movement')
    store.setTurn(5)
    controlRailRun(store)
    const cargo = railUnit(store, FROM, 'cargo-1')
    cargo.mode = { mode: 'move', orientation: 'move', dg: true, exploit: false }
    store.selectedId = cargo.instanceId
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }

    expect(store.railMoveNow('unit')).toBe(false)
    expect(store.railMoveError?.rule).toBe('5.10d')
  })

  it('13.3e-1：登车前已耗 MP 超过一半 MA ⇒ 拒', () => {
    const store = sovietStore()
    store.setPhase('movement')
    store.setTurn(5)
    controlRailRun(store)
    const cargo = railUnit(store, FROM, 'cargo-1')
    cargo.mpSpent = cargo.raw.ma // 全部 MA 已耗 ⇒ 远超一半
    store.selectedId = cargo.instanceId
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }

    expect(store.railMoveNow('unit')).toBe(false)
    expect(store.railMoveError?.rule).toBe('13.3e')
    expect(store.railMoveError?.reason.startsWith('preLoadMpExceedsHalfMa')).toBe(true)
  })

  it('13.3e-2：两格之间没有可用铁路路径 ⇒ 拒（noRailPath）', () => {
    const store = sovietStore()
    store.setPhase('movement')
    store.setTurn(5)
    controlRailRun(store)
    const cargo = railUnit(store, FROM, 'cargo-1')
    store.selectedId = cargo.instanceId
    // 一个远离铁路的格（30 列之外）
    store.railMoveInputs = {
      toHexText: `${FROM.col + 30}.${FROM.row}`,
      spAmount: 1,
      fromDumpId: null,
    }

    expect(store.railMoveNow('unit')).toBe(false)
    expect(store.railMoveError?.reason).toBe('noRailPath')
  })

  it('13.3h：沿线被敌方战斗单位占住 ⇒ 无可用路径（不能穿过敌军的格）', () => {
    const store = sovietStore()
    store.setPhase('movement')
    store.setTurn(5)
    controlRailRun(store)
    const cargo = railUnit(store, FROM, 'cargo-1')
    store.selectedId = cargo.instanceId
    // 在中间格放一个**敌方**战斗单位
    const middle = RAIL_RUN[1]!
    const enemyRecord = groundRecord('axis', (item) => item.isCombat === true)
    placeGround(store, enemyRecord, middle, 'axis', 'enemy-1')
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }

    expect(store.railMoveNow('unit')).toBe(false)
    expect(store.railMoveError?.reason).toBe('noRailPath')
  })
})

describe('13.3b：每回合的铁路容量额度', () => {
  it('超出当日容量 ⇒ 拒，且货物与账本都不动', () => {
    const store = sovietStore()
    store.setPhase('movement')
    store.setTurn(4) // 专规 1.2：7/19 **之前**苏方容量 2
    controlRailRun(store)
    const cargo = railUnit(store, FROM, 'cargo-1')
    store.selectedId = cargo.instanceId
    // 手工把额度用满（模拟本回合已运过）
    store.railCapSpentThisTurn = [{ side: 'soviet', points: store.railCapToday.soviet }]
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }

    expect(store.railMoveNow('unit')).toBe(false)
    expect(store.railMoveError?.rule).toBe('13.3b')
    expect(store.railMoveError?.reason.startsWith('railCapExceeded')).toBe(true)
    expect(cargo.hex).toEqual(FROM)
  })

  it('换回合即清零额度（13.3b 的额度按回合计）', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(5)
    store.railCapSpentThisTurn = [{ side: 'soviet', points: 3 }]
    store.setTurn(6)
    expect(store.railCapSpentThisTurn).toEqual([])
    expect(store.railCapRemaining.soviet).toBe(store.railCapToday.soviet)
  })

  it('当日容量随专规 1.2 的时点提升（7/19 起）', () => {
    const store = newStore()
    // 回合轨：3 = 1941-07-15（提升前）、4 = 1941-07-19（提升当日即生效）
    store.setTurn(3)
    const before = store.railCapToday
    store.setTurn(4)
    const after = store.railCapToday
    expect(after.soviet).toBeGreaterThan(before.soviet)
    expect(after.axis).toBeGreaterThan(before.axis)
  })
})

describe('13.3a：SP 作为铁路货物', () => {
  it('从起运站扣 SP、在卸货格落 SP，并按容量点数记账', () => {
    const store = sovietStore()
    store.setPhase('movement')
    store.setTurn(5)
    controlRailRun(store)
    const dump = { id: 'src', hex: { ...FROM }, side: 'soviet' as const, sp: 4, t: 0 }
    store.spDumps.push(dump)
    store.railMoveInputs = { toHexText: label(TO), spAmount: 2, fromDumpId: 'src' }

    expect(store.railMoveNow('sp')).toBe(true)
    // 起点站少了 2 SP（8 T）
    const after = store.spDumps.find((item) => item.id === 'src')!
    expect(after.sp + after.t / 4).toBe(2)
    // 终点格出现 2 SP 的账本
    const arrived = store.spDumps.find(
      (item) => item.side === 'soviet' && item.hex.col === TO.col && item.hex.row === TO.row,
    )
    expect(arrived).not.toBeUndefined()
    expect(arrived!.sp + arrived!.t / 4).toBe(2)
    // 13.3a：2 SP 的运输当量为 2，**全程多轨**（15.10→18.18 整段走的是多轨干线）⇒ 费用减半 = 1 点
    expect(store.lastRailMove?.cost).toBe(1)
  })

  it('未指定起运站（或不是己方）⇒ 拒', () => {
    const store = sovietStore()
    store.setPhase('movement')
    store.setTurn(5)
    controlRailRun(store)
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }
    expect(store.railMoveNow('sp')).toBe(false)
    expect(store.railMoveError?.rule).toBe('13.3a')
  })
})

describe('13.3a：容量费用的两条路径修正', () => {
  it('路径含运输破坏区 ⇒ 费用翻倍（14.8）', () => {
    const store = sovietStore()
    store.setPhase('movement')
    store.setTurn(5)
    controlRailRun(store)
    const cargo = railUnit(store, FROM, 'cargo-1')
    store.selectedId = cargo.instanceId
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }
    expect(store.railMoveNow('unit')).toBe(true)
    const base = store.lastRailMove!.cost

    // 第二次：在起点与终点之间放一枚运输破坏标记 ⇒ 同一段路费用翻倍
    store.setTurn(6)
    store.setPhase('movement')
    cargo.hex = { ...FROM }
    cargo.movementEnded = false
    store.trainbustingMarks.push({ id: 'tb-1', hex: { ...RAIL_RUN[1]! }, side: 'soviet' })
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }
    expect(store.railMoveNow('unit')).toBe(true)
    expect(store.lastRailMove!.cost).toBe(base * 2)
  })

  it('13.3a：整段走在多轨干线上 ⇒ 费用减半（数据侧 125 条多轨格边已入库）', () => {
    const store = sovietStore()
    store.setPhase('movement')
    store.setTurn(5)
    controlRailRun(store)
    // 用 SP 做货物：当量 = SP 数，不受 4.7b 影响，故好数
    store.spDumps.push({ id: 'src', hex: { ...FROM }, side: 'soviet', sp: 4, t: 0 })
    store.railMoveInputs = { toHexText: label(TO), spAmount: 2, fromDumpId: 'src' }

    expect(store.railMoveNow('sp')).toBe(true)
    // 当量 2 × 多轨 ½ = 1 点
    expect(store.lastRailMove!.cost).toBe(1)
    expect(store.lastRailMove!.detail).toContain('全程多轨')
    // 走的就是多轨干线本身（15.10 → 18.18 逐格在 RAIL_RUN 上）
    expect(store.lastRailMove!.path.map(label)).toEqual(RAIL_RUN.map(label))
  })

  it('13.3a：支线是单轨 ⇒ 不减半（同一对起讫、只换终点即见差别）', () => {
    const store = sovietStore()
    store.setPhase('movement')
    store.setTurn(5)
    controlRailRun(store)
    // Mogilev（15.10）唯一西北向的支线 15.10→14.9→…→13.5（Bykhov，聚落）**整段单轨**
    const SPUR: HexRef[] = [
      { col: 14, row: 9 },
      { col: 13, row: 9 },
      { col: 13, row: 8 },
      { col: 13, row: 7 },
      { col: 13, row: 6 },
      { col: 13, row: 5 },
    ]
    SPUR.forEach((hex) => railUnit(store, hex, `spur-${label(hex)}`))
    expect(store.detrainableHexes.some((hex) => label(hex) === '13.5')).toBe(true)

    store.spDumps.push({ id: 'src', hex: { ...FROM }, side: 'soviet', sp: 4, t: 0 })
    store.railMoveInputs = { toHexText: '13.5', spAmount: 2, fromDumpId: 'src' }
    expect(store.railMoveNow('sp')).toBe(true)
    // 运输当量 2、全程单轨 ⇒ 全额 2 点（13.3a 的减半要求**全程**多轨）
    expect(store.lastRailMove!.cost).toBe(2)
    expect(store.lastRailMove!.detail).not.toContain('全程多轨')
    expect(store.lastRailMove!.path.map(label)).toEqual(['15.10', ...SPUR.map(label)])
  })
})
