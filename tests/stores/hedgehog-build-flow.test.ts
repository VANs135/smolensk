import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { HEDGEHOG_COST_SP_PER_LEVEL, HEDGEHOG_MAX_LEVEL, holdingsToT } from '@/engine/rules'
import { neighbors } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

import { CORE_HEX, groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 16.0b/c 环形工事的**修建与缩减**（＋专规 1.3a 印刷工事、1.3b 等级上限、2.3e 苏军禁建期）
 *
 * 条文：
 *   · **16.0b**「具有工程能力的单位可修建/改进环形工事（+1 级）」；执行者＝**目标格内指定的一小队
 *     单位**（RE 合计 ≥ 1、逐员战斗模式、本阶段未移动）；该格每回合最多 +1 级；每级 **2 SP**；
 *     ★ 只有这批**被指定**的单位作业后不能再移动，格内其余单位照常行动；
 *   · **16.0c** 缩减（−1 级）**免费**；降到 1 级以下即**移除**；**专规 1.3a：印刷永久工事不可降低**；
 *   · **专规 1.3b** 本作工事等级上限 **1 级**；**专规 2.3e** 苏军 8 月 1 日前不得修建。
 *
 * ★ 修前：`planHedgehogBuild` / `planHedgehogReduce` / `hedgehogBuildCostSp` /
 *   `printedPermanentHedgehogAt` / `getAllPermanentHedgehogs` **全部零消费** ⇒ 16.0b/c 没有入口，
 *   玩家无法修建任何工事（而 16.0 的工事是守方的核心修正）。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/**
 * 摆一个"合格施工小队"：**RE 合计 ≥ 1** 的可攻击战斗单位（16.0b），逐员战斗模式、本阶段未移动
 *
 * ★ 用真实记录里 RE 最大的那一类（炮兵营的 RE 只有 0.25，凑不够 1RE 的门槛会被引擎按下述理由拒：
 *   `insufficientBuilderRe`——这正是 16.0b「1RE 的单位」的字面要求）。
 */
function placeWorkers(store: Workbench, hexText: string) {
  const hex = { col: Number(hexText.split('.')[0]), row: Number(hexText.split('.')[1]) }
  const candidates = unitChoices('axis')
    .filter((record) => record.attackCapable === true && record.isCombat === true)
    .map((record) => ({
      record,
      probe: toConsoleUnit({ record, instanceId: 'p', hex, side: 'axis' }),
    }))
    .sort((a, b) => b.probe.re - a.probe.re)
  const picked = candidates[0]
  if (picked === undefined || picked.probe.re < 1)
    throw new Error('单位库中没有 RE ≥ 1 的可攻击战斗单位（夹具不成立）')
  const a = placeGround(store, picked.record, hex, 'axis', 'w1')
  const b = placeGround(store, picked.record, hex, 'axis', 'w2')
  for (const unit of [a, b]) {
    unit.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
    unit.mpSpent = 0
  }
  return [a, b]
}

function withDump(store: Workbench, sp = 4) {
  store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp, t: 0 })
  return store.spDumps[0]!
}

describe('16.0b：修建环形工事（+1 级、2 SP、被指定者本阶段不能再移动）', () => {
  it('合格小队 + 足 SP ⇒ 摆出 1 级工事算子并扣 2 SP', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(4) // 轴方无 2.3e 限制，日期随便取轨内回合
    const [a, b] = placeWorkers(store, `${CORE_HEX.col}.${CORE_HEX.row}`)
    const dump = withDump(store, 4) // 16 T = 4 SP
    store.hedgehogInputs = {
      hexText: `${CORE_HEX.col}.${CORE_HEX.row}`,
      workerIds: [a!.instanceId, b!.instanceId],
      payDumpId: dump.id,
    }
    expect(store.buildHedgehogNow()).toBe(true)
    expect(store.hedgehogLevelOf(CORE_HEX)).toBe(1)
    expect(holdingsToT(store.spDumps[0]!)).toBe(16 - HEDGEHOG_COST_SP_PER_LEVEL * 4)
    // 16.0b：**被指定的**单位本阶段不能再移动
    expect(a!.movementEnded).toBe(true)
    expect(b!.movementEnded).toBe(true)
  })

  it('未指定任何单位 ⇒ 拒（RE 合计须 ≥ 1）', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(4)
    const dump = withDump(store)
    store.hedgehogInputs = {
      hexText: `${CORE_HEX.col}.${CORE_HEX.row}`,
      workerIds: [],
      payDumpId: dump.id,
    }
    expect(store.buildHedgehogNow()).toBe(false)
    expect(store.hedgehogError?.rule).toBe('16.0b')
  })

  it('本回合该格已提升过 ⇒ 拒（每格每回合最多 +1 级）', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(4)
    const hexText = `${CORE_HEX.col}.${CORE_HEX.row}`
    const [a, b] = placeWorkers(store, hexText)
    const dump = withDump(store, 8)
    store.hedgehogInputs = {
      hexText,
      workerIds: [a!.instanceId, b!.instanceId],
      payDumpId: dump.id,
    }
    // 专规 1.3b：上限 1 级 ⇒ 建满后再建会被"已达上限"拒（两种拒绝都属 16.0b，用满级路径覆盖）
    expect(store.buildHedgehogNow()).toBe(true)
    // 第二次：先受"本回合已提升"拦下（同一格同一回合）
    expect(store.buildHedgehogNow()).toBe(false)
  })

  it('专规 1.3b：等级上限 1 ⇒ 满级后不再提升', () => {
    expect(HEDGEHOG_MAX_LEVEL).toBe(1)
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(5) // 换回合，清掉"本回合已提升"的额度
    const hexText = `${CORE_HEX.col}.${CORE_HEX.row}`
    const [a, b] = placeWorkers(store, hexText)
    const dump = withDump(store, 8)
    store.hedgehogInputs = {
      hexText,
      workerIds: [a!.instanceId, b!.instanceId],
      payDumpId: dump.id,
    }
    expect(store.buildHedgehogNow()).toBe(true)
    store.setTurn(6)
    expect(store.buildHedgehogNow()).toBe(false)
    expect(store.hedgehogError?.reason).toContain('hedgehogAtMaxLevel')
  })

  it('专规 2.3e：苏军在 8 月 1 日之前不得修建', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setActiveSide('soviet')
    store.setTurn(1) // 1941-07-08 < 1941-08-01
    const hexText = `${CORE_HEX.col}.${CORE_HEX.row}`
    const workers = placeWorkers(store, hexText)
    store.spDumps.push({ id: 'sd', hex: { ...CORE_HEX }, side: 'soviet', sp: 4, t: 0 })
    store.hedgehogInputs = {
      hexText,
      workerIds: workers.map((unit) => unit.instanceId),
      payDumpId: 'sd',
    }
    expect(store.buildHedgehogNow()).toBe(false)
    expect(store.hedgehogError?.rule).toBe('专规 2.3e')
  })

  it('未指定付款站 ⇒ 拒（费用须由己方补给站支付，12.1b/12.3a）', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(4)
    const hexText = `${CORE_HEX.col}.${CORE_HEX.row}`
    const [a, b] = placeWorkers(store, hexText)
    store.hedgehogInputs = { hexText, workerIds: [a!.instanceId, b!.instanceId], payDumpId: null }
    expect(store.buildHedgehogNow()).toBe(false)
  })
})

describe('16.0c：缩减环形工事（−1 级、免费、印刷工事不可降低）', () => {
  it('摆出的 1 级工事缩减 ⇒ 降到 0 级即移除，且**不花 SP**', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(4)
    const hexText = `${CORE_HEX.col}.${CORE_HEX.row}`
    const [a, b] = placeWorkers(store, hexText)
    const dump = withDump(store, 4)
    store.hedgehogInputs = {
      hexText,
      workerIds: [a!.instanceId, b!.instanceId],
      payDumpId: dump.id,
    }
    store.buildHedgehogNow()
    const spAfterBuild = holdingsToT(store.spDumps[0]!)
    store.setTurn(5) // 换回合清额度

    expect(store.reduceHedgehogNow()).toBe(true)
    expect(store.hedgehogLevelOf(CORE_HEX)).toBe(0)
    // 16.0c：缩减免费
    expect(holdingsToT(store.spDumps[0]!)).toBe(spAfterBuild)
  })

  it('该格无工事 ⇒ 拒', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(4)
    const hexText = `${CORE_HEX.col}.${CORE_HEX.row}`
    const [a, b] = placeWorkers(store, hexText)
    store.hedgehogInputs = { hexText, workerIds: [a!.instanceId, b!.instanceId], payDumpId: null }
    expect(store.reduceHedgehogNow()).toBe(false)
    expect(store.hedgehogError?.reason).toBe('noHedgehogInHex')
  })
})

describe('专规 1.3a：印刷永久工事', () => {
  it('印刷工事格被识别为不可降低（`isPrintedHedgehogAt` 与引擎同源）', () => {
    const store = newStore()
    // 地图印刷工事共 58 处；取一处做样本（数据在 map-layers.json）
    const printed = store.printedHedgehogPositions[0]
    if (printed === undefined) return
    expect(store.isPrintedHedgehogAt(printed)).toBe(true)
    expect(store.hedgehogLevelOf(printed)).toBeGreaterThan(0)
    // 缩减它必须被拒（专规 1.3a）
    store.setPhase('movement')
    store.setTurn(4)
    store.hedgehogInputs = {
      hexText: `${printed.col}.${printed.row}`,
      workerIds: [],
      payDumpId: null,
    }
    expect(store.reduceHedgehogNow()).toBe(false)
    expect(store.hedgehogError?.rule).toBe('专规 1.3a')
  })
})

describe('16.0b/c 工程兵途径（13.8d 的 2 格半径施工）', () => {
  /** 摆一名具工程能力的单位（单位库里唯一的轴方工程兵：leg 机动） */
  function placeEngineer(store: Workbench, col: number, row: number, instanceId = 'eng-1') {
    /* B43（13.8 首段）：13.8d 的施工者**只认指挥部** —— Pioneer（`specialized` 含 engineer）
     与铁路修理按原文都不能施工，故这里改用 hq 算子当夹具（断言不变）。 */
    const record = groundRecord('axis', (item) => (item.specialized ?? []).includes('hq'))
    const unit = placeGround(store, record, { col, row }, 'axis', instanceId)
    unit.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
    unit.mpSpent = 0
    unit.movementEnded = false
    return unit
  }

  /** 切到 13.8d 途径并选好工程兵 */
  function useEngineerRoute(
    store: Workbench,
    engineer: ConsoleUnit,
    hexText: string,
    dumpId: string | null,
  ) {
    store.hedgehogExecutorMode = 'engineer'
    store.hedgehogEngineerId = engineer.instanceId
    store.hedgehogInputs = { ...store.hedgehogInputs, hexText, payDumpId: dumpId }
  }

  it('工程兵在**目标格内** ⇒ 直接按 13.8d 修建（此时不必勾选任何小队单位）', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(4)
    const hexText = `${CORE_HEX.col}.${CORE_HEX.row}`
    const engineer = placeEngineer(store, CORE_HEX.col, CORE_HEX.row)
    const dump = withDump(store, 4)
    useEngineerRoute(store, engineer, hexText, dump.id)

    expect(store.hedgehogUsesEngineerRoute).toBe(true)
    expect(store.hedgehogEngineerLegRange).toBe(0)
    expect(store.buildHedgehogNow()).toBe(true)
    expect(store.hedgehogLevelOf(CORE_HEX)).toBe(1)
    // 13.8d：施工者在它执行建造的阶段中不能移动
    expect(engineer.movementEnded).toBe(true)
    // 13.8d 的一格一任务账本被记下（原地小队途径不记）
    expect(store.constructionPhaseLedger.task).toBe('buildHedgehog')
    expect(store.constructionPhaseLedger.hexes).toEqual([hexText])
  })

  it('工程兵在**相邻格**（步行 1 MP ≤ 2）⇒ 照样能施工（不必在目标格内）', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(4)
    const neighbor = neighbors(CORE_HEX)[0]!.hex
    const engineer = placeEngineer(store, neighbor.col, neighbor.row)
    const dump = withDump(store, 4)
    useEngineerRoute(store, engineer, `${CORE_HEX.col}.${CORE_HEX.row}`, dump.id)

    // 邻格的实际步行消耗按地形算（目标格可能有地形效果 ⇒ 1–2 MP 之间），只要 ≤ 2 即合规
    const distance = store.hedgehogEngineerLegRange
    expect(distance).not.toBeNull()
    expect(distance!).toBeGreaterThan(0)
    expect(distance!).toBeLessThanOrEqual(2)
    expect(store.buildHedgehogNow()).toBe(true)
    expect(store.hedgehogLevelOf(CORE_HEX)).toBe(1)
  })

  it('超出 2 格步行 MP 半径 ⇒ 拒（13.8d）', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(4)
    // 沿一个方向走 3 格（leg 机动，开阔地每格 ≥ 1 MP ⇒ 距离 ≥ 3 > 2）
    let far = CORE_HEX
    for (let step = 0; step < 3; step += 1) far = neighbors(far)[0]!.hex
    const engineer = placeEngineer(store, far.col, far.row)
    const dump = withDump(store, 4)
    useEngineerRoute(store, engineer, `${CORE_HEX.col}.${CORE_HEX.row}`, dump.id)

    const distance = store.hedgehogEngineerLegRange
    expect(distance === null || distance > 2).toBe(true)
    expect(store.buildHedgehogNow()).toBe(false)
    expect(store.hedgehogError?.rule).toBe('13.8d')
    expect(store.hedgehogError?.reason.startsWith('targetBeyondConstructionRadius')).toBe(true)
    // 没有任何结算落盘
    expect(store.hedgehogLevelOf(CORE_HEX)).toBe(0)
    expect(engineer.movementEnded).toBe(false)
  })

  it('13.8d：一格一任务 —— 同阶段已施工过另一格 ⇒ 拒', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(4)
    const engineer = placeEngineer(store, CORE_HEX.col, CORE_HEX.row)
    const dump = withDump(store, 8)
    useEngineerRoute(store, engineer, `${CORE_HEX.col}.${CORE_HEX.row}`, dump.id)
    expect(store.buildHedgehogNow()).toBe(true)

    // 同一阶段：换一名工程兵、换一格 ⇒ 13.8d 拦下
    const second = neighbors(CORE_HEX)[0]!.hex
    const engineer2 = placeEngineer(store, second.col, second.row, 'eng-2')
    useEngineerRoute(store, engineer2, `${second.col}.${second.row}`, dump.id)
    expect(store.buildHedgehogNow()).toBe(false)
    expect(store.hedgehogError?.rule).toBe('13.8d')
    expect(store.hedgehogError?.reason).toBe('oneHexPerPhase')
  })

  it('13.8d：工程兵本阶段已移动 ⇒ 拒', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(4)
    const engineer = placeEngineer(store, CORE_HEX.col, CORE_HEX.row)
    const dump = withDump(store, 4)
    useEngineerRoute(store, engineer, `${CORE_HEX.col}.${CORE_HEX.row}`, dump.id)
    // ★ 必须在 `setPhase` 之后置（换阶段会重置本阶段的 MP 记账）
    engineer.mpSpent = 1
    expect(store.buildHedgehogNow()).toBe(false)
    expect(store.hedgehogError?.rule).toBe('13.8d')
    expect(store.hedgehogError?.reason).toBe('builderMovedThisPhase')
  })

  it('原地小队途径**不**受 13.8d 的一格一任务约束（那条的主语是"具有工程能力的单位"）', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(4)
    const [a, b] = placeWorkers(store, `${CORE_HEX.col}.${CORE_HEX.row}`)
    const dump = withDump(store, 8)
    store.hedgehogInputs = {
      hexText: `${CORE_HEX.col}.${CORE_HEX.row}`,
      workerIds: [a!.instanceId, b!.instanceId],
      payDumpId: dump.id,
    }
    expect(store.buildHedgehogNow()).toBe(true)
    // 原地途径不记 13.8d 的账本
    expect(store.constructionPhaseLedger.task).toBeNull()
    expect(store.constructionPhaseLedger.hexes).toEqual([])
  })

  it('工程兵途径也能**缩减**（16.0c：免费），并记一格一任务', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(4)
    const engineer = placeEngineer(store, CORE_HEX.col, CORE_HEX.row)
    const dump = withDump(store, 4)
    useEngineerRoute(store, engineer, `${CORE_HEX.col}.${CORE_HEX.row}`, dump.id)
    expect(store.buildHedgehogNow()).toBe(true)

    // 换回合（清 16.0b/c 的每回合额度）再换阶段（清 13.8d 的一格一任务）
    store.setTurn(5)
    store.setPhase('movement')
    const engineer2 = placeEngineer(store, CORE_HEX.col, CORE_HEX.row, 'eng-3')
    useEngineerRoute(store, engineer2, `${CORE_HEX.col}.${CORE_HEX.row}`, null)
    expect(store.reduceHedgehogNow()).toBe(true)
    expect(store.hedgehogLevelOf(CORE_HEX)).toBe(0)
    expect(engineer2.movementEnded).toBe(true)
    expect(store.constructionPhaseLedger.task).toBe('reduceHedgehog')
  })
})
