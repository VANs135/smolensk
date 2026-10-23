import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { scenarios } from '@/data'
import { actionGateOf, toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * 批 F 切片 3：**到货 SP 的免费铁运落点**（专规 2.1 / 3.1 + 通规 13.3c）与 **3.6 补给列车**
 *
 * ## 原文
 *   - 专规 2.1/3.1（`rules.json → free_rail_cap_sp`）：「每个**可卸载城市格**可放 1 SP（免费铁运），
 *     其余 SP 放**图边补给源格**；须有 13.3e 的合法铁路移动路径」；
 *   - 通规 13.3c：可卸货格 = 有村庄/城市/港口/工程 HQ ＋ 受本方控制（13.3h）＋ 免 EZOC 铁路路径回补给源；
 *   - 通规 13.3b：铁路运量每回合清零、只在移动阶段用 ⇒ 免费铁运**不扣**运量；
 *   - 专规 3.6：随机事件掷出 **Supply Train**（表 5–9）⇒ 轴方在**任一可卸货格**得 2 SP，不用 Rail Cap。
 *
 * ## 测法边界（如实交代）
 *   - 判据来自引擎（`tests/engine/free-rail-arrival.test.ts` 用合成格钉住）；
 *     本文件钉**数据面 + 接线 + 落账**：候选清单取自真实地图数据，运行时交集取自 `rail-supply` 的 13.3c；
 *   - **控制（13.3h）仍是操作台的近似**（「格内仅有单方战斗单位」⇒ 空城视为未控制，**宁可少给**）——
 *     故本用例必须把轴方算子摆进城里才拿得到候选；这条近似是既有约定，见 §17.111 的边界说明；
 *   - **不覆盖界面**（仓库无组件渲染测试）：面板上的勾选按钮由 store 用例与源码守卫间接盯。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const hex = (col: number, row: number): HexRef => ({ col, row })
const CITY_HEX = hex(2, 2) // 剧本 1 里轴方唯一能"免费铁运"落到的城市格（见用例②）

/** 剧本 1 的轴方图边补给源格（`scenarios.json` 的 `supplySources.axisLive`） */
const AXIS_SOURCES = ['1.03', '1.04', '1.07', '1.12', '1.19', '1.26', '4.00', '8.00']

/** 工程库 `detrainable_hexes.json → free_rail_cap_city=true` 的 9 格（逐格对照用） */
const DOCUMENTED_FREE_RAIL_CITIES = [
  '2.2 Bobruysk',
  '15.10 Mogilev',
  '18.18 Orsha',
  '19.27 Vitebsk',
  '19.28 Vitebsk',
  '34.18 Smolensk',
  '38.5 Roslavl',
  '56.20 Vyazma',
  '60.34 Rzhev',
]

/** 摆一套「轴方在剧本 1 的可用铁路状态」：初设换轨 + 声明边缘源 + 城里摆一个战斗单位 */
function armAxisRail(store: ReturnType<typeof newStore>, occupied: HexRef[] = [CITY_HEX]): void {
  store.setScenarioId('1')
  store.seedConvertedRailsNow()
  for (const text of AXIS_SOURCES) {
    const [col, row] = text.split('.').map(Number)
    store.supplySourceDecls.push({
      id: `src-${text}`,
      hex: hex(col!, row!),
      side: 'axis',
      kind: 'edgeRail',
    })
  }
  const record = unitChoices('axis').find(
    (item) => item.isCombat === true && item.attackCapable === true,
  )
  if (record === undefined) throw new Error('轴方单位库里没有战斗单位')
  occupied.forEach((item, index) => {
    store.units.push(
      toConsoleUnit({ record, instanceId: `u-${index}`, hex: { ...item }, side: 'axis' }),
    )
  })
}

/** 进 B 段里允许「到货 SP 落位」的环节（闸门表反查，不写死序号） */
function enterArrivalStep(store: ReturnType<typeof newStore>): void {
  store.setPhase('reinforcement')
  const allowed = actionGateOf('rein.supplyArrival')
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error('B 段没有允许 rein.supplyArrival 的环节')
  expect(store.setSegmentStepIndex(index)).toBe(true)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('批 F 切片 3：免费铁运候选（数据面 + 运行期 13.3c）', () => {
  it('★ 数据面：可卸载**城市**格（城市符号 ＋ 格内有铁路）＝工程库记的 9 格', () => {
    const store = newStore()
    const listed = store.freeRailCityHexes.map(
      (item) => `${item.hex.col}.${item.hex.row} ${item.name}`,
    )
    expect(listed).toEqual(DOCUMENTED_FREE_RAIL_CITIES)
    // 34.17 同是"Smolensk"却是**城格无铁路** ⇒ 按 13.3c 首句不是可卸货格，不得进清单
    expect(listed.some((text) => text.startsWith('34.17'))).toBe(false)
  })

  it('★ 运行期：候选＝城市格 ∩ 13.3c 可卸货格（城里没有本方战斗单位 ⇒ 未控制 ⇒ 不是候选）', () => {
    const store = newStore()
    armAxisRail(store, [])
    expect(store.freeRailCityCandidates).toEqual([])

    // 往 2.2 摆一个轴方战斗单位（单方占据 ⇒ 控制），铁路路径通到边缘源 ⇒ 成为候选
    armAxisRail(store, [CITY_HEX])
    expect(store.freeRailCityCandidates.map((item) => `${item.hex.col}.${item.hex.row}`)).toEqual([
      '2.2',
    ])
    // 候选恒是静态清单的子集（判据只有一处：rail-supply 的 13.3c）
    expect(store.detrainableHexes.map((item) => `${item.col}.${item.row}`)).toEqual(['2.2'])
  })

  it('★ 两侧都可用：换成苏方后候选改按苏方口径（宽轨 + 苏方图边源）重算', () => {
    const store = newStore()
    // 苏方：印刷轨距即宽轨（专规 1.2）⇒ 不需要换轨；把 9 座城市都摆上苏方战斗单位
    store.setScenarioId('1')
    const sovietSources =
      scenarios.scenarios.find((item) => item.id === '1')?.supplySources?.sovietLive ?? []
    expect(sovietSources.length).toBeGreaterThan(0)
    for (const text of sovietSources) {
      const [col, row] = text.split('.').map(Number)
      store.supplySourceDecls.push({
        id: `ssrc-${text}`,
        hex: hex(col!, row!),
        side: 'soviet',
        kind: 'edgeRail',
      })
    }
    const record = unitChoices('soviet').find(
      (item) => item.isCombat === true && item.attackCapable === true,
    )
    if (record === undefined) throw new Error('苏方单位库里没有战斗单位')
    const cities = store.freeRailCityHexes.map((item) => item.hex)
    cities.forEach((item, index) => {
      store.units.push(
        toConsoleUnit({ record, instanceId: `su-${index}`, hex: { ...item }, side: 'soviet' }),
      )
    })
    store.setActiveSide('soviet')
    expect(store.activeSide).toBe('soviet')

    const candidates = store.freeRailCityCandidates.map((item) => `${item.hex.col}.${item.hex.row}`)
    /*
     * 剧本 1 的苏方：9 座城市格里 8 座可免费铁运（**除 2.2 Bobruysk**）——
     * Bobruysk 在轴军推进方向上、铁路路径回不到苏方边缘源 ⇒ 13.3c 第三条不成立。
     * 这条与"轴方只有 2.2"正好相反，两侧都不是空集 ⇒ 功能对双方都可用。
     */
    expect(candidates).toEqual([
      '15.10',
      '18.18',
      '19.27',
      '19.28',
      '34.18',
      '38.5',
      '56.20',
      '60.34',
    ])
    // 至少有一处（宽轨图上铁路 + 苏方边缘源 ⇒ 城格可卸货）；且候选恒是 9 座城市格的子集
    expect(candidates.length).toBeGreaterThan(0)
    const cityKeys = new Set(cities.map((item) => `${item.col}.${item.row}`))
    for (const key of candidates) expect(cityKeys.has(key)).toBe(true)
  })

  it('★ 落账：1 SP 进城市格（免费）、余额进图边补给源格；落完即清空、再点一次无事可做', () => {
    const store = newStore()
    armAxisRail(store)
    enterArrivalStep(store)

    store.supplyArrivalSp = 7
    store.toggleFreeRailPick(CITY_HEX)
    store.pickFreeRailEdgeHex(hex(1, 3))
    expect(store.freeRailError).toBe(null)
    expect(store.freeRailPlan?.freeSp).toBe(1)
    expect(store.freeRailPlan?.edgeSp).toBe(6)
    expect(store.freeRailPlan?.railCapUsed).toBe(0)

    expect(store.applySupplyArrivalsNow()).toBe(true)
    const dumps = store.spDumps.map((dump) => `${dump.hex.col}.${dump.hex.row}:${dump.sp}`)
    expect(dumps).toContain('2.2:1')
    expect(dumps).toContain('1.3:6')
    expect(store.spDumps.reduce((sum, dump) => sum + dump.sp, 0)).toBe(7)
    expect(store.log.some((entry) => (entry.text ?? '').includes('免费铁运'))).toBe(true)
    // 13.3b：免费铁运**不扣**铁路运量（运量账本一动不动）
    expect(store.railCapUsedBy('axis')).toBe(0)
    // 落账后清空：勾选与 SP 数都归零，再点一次没有可落的 SP
    expect(store.freeRailPicked).toEqual([])
    expect(store.supplyArrivalSp).toBe(0)
    expect(store.applySupplyArrivalsNow()).toBe(false)
  })

  it('★ 闸门：C 移动段拒绝（到货 SP 落位属 B 段）', () => {
    const store = newStore()
    armAxisRail(store)
    enterArrivalStep(store)
    store.supplyArrivalSp = 2
    store.toggleFreeRailPick(CITY_HEX)

    store.setPhase('movement')
    expect(store.applySupplyArrivalsNow()).toBe(false)
    expect(store.actionRefusal).toMatchObject({ key: 'rein.supplyArrival' })
    expect(store.spDumps).toEqual([])
  })

  it('★ 拒绝面走引擎：勾了非候选格（未控制的城市格）即拒并给 13.3c', () => {
    const store = newStore()
    armAxisRail(store)
    enterArrivalStep(store)
    store.supplyArrivalSp = 3
    // 60.34（Rzhev）在静态清单里，但此刻不受控、铁路也不通 ⇒ 不是候选
    store.toggleFreeRailPick(hex(60, 34))
    expect(store.freeRailPlan).toBe(null)
    expect(store.freeRailError?.rule).toBe('13.3c')
    expect(store.applySupplyArrivalsNow()).toBe(false)
    expect(store.spDumps).toEqual([])
  })
})

describe('批 F 切片 3：3.6 补给列车（2 SP，任一可卸货格，不用 Rail Cap）', () => {
  it('★ 掷出 Supply Train ⇒ 2 SP 落可卸货格；与免费铁运同格时账本合并成一条', () => {
    const store = newStore()
    armAxisRail(store)
    enterArrivalStep(store)
    store.setTurn(4)
    expect(store.date).toBe('1941-07-19')

    // 3.6 事件表：2 骰 5–9 ⇒ Supply Train（`arrivals-axis.json → randomEvents.table`）
    store.variableReplInputs.autoRoll = false
    store.variableReplInputs.supplyDice = 8
    store.variableReplInputs.replDice = 7
    store.variableReplInputs.specialDie = 1
    store.variableReplInputs.randomEventDice = 7
    expect(store.rollVariableReplNow()).toBe(true)
    expect(store.lastVariableRepl?.randomEvent?.kind).toBe('supplyTrain')
    expect(store.supplyTrainSp).toBe(2)
    // 专规 2.1/3.1：补给表到货 SP 自动填进落账输入（免得裁判再抄一遍数）
    expect(store.supplyArrivalSp).toBe(store.lastVariableRepl?.sp)

    store.toggleFreeRailPick(CITY_HEX)
    store.pickFreeRailEdgeHex(hex(1, 3))
    store.pickSupplyTrainHex(CITY_HEX)
    expect(store.applySupplyArrivalsNow()).toBe(true)

    // 2.2：免费铁运 1 SP ＋ 补给列车 2 SP ⇒ **同格合并成一条**（3 SP）
    const atCity = store.spDumps.filter((dump) => dump.hex.col === 2 && dump.hex.row === 2)
    expect(atCity).toHaveLength(1)
    expect(atCity[0]?.sp).toBe(3)
    const atEdge = store.spDumps.filter((dump) => dump.hex.col === 1 && dump.hex.row === 3)
    expect(atEdge).toHaveLength(1)
    expect(atEdge[0]?.sp).toBe(store.lastFreeRailPlan?.edgeSp ?? 0)
    expect(store.railCapUsedBy('axis')).toBe(0)
  })

  it('★ 补给列车没选落点 ⇒ 拒（原文"任一可卸货格"必须落到某格）', () => {
    const store = newStore()
    armAxisRail(store)
    enterArrivalStep(store)
    store.setTurn(4)
    store.variableReplInputs.autoRoll = false
    store.variableReplInputs.supplyDice = 8
    store.variableReplInputs.replDice = 7
    store.variableReplInputs.specialDie = 1
    store.variableReplInputs.randomEventDice = 7
    expect(store.rollVariableReplNow()).toBe(true)

    store.toggleFreeRailPick(CITY_HEX)
    expect(store.freeRailPlan).toBe(null)
    expect(store.freeRailError?.rule).toBe('3.6')
    expect(store.applySupplyArrivalsNow()).toBe(false)
  })
})
