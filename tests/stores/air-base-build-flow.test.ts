import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  AIRSTRIP_BUILD_T,
  AIRSTRIP_UPGRADE_T,
  AIR_BASE_COST_SP_PER_LEVEL,
  AIR_BASE_MAX_LEVEL,
  SP_TO_T,
  holdingsToT,
} from '@/engine/rules'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'
import { mapLayers, type HexRef } from '@/data'
import { hexDistance } from '@/engine/hex-geometry'

import { CORE_HEX, NEAR_HEX, airBaseRecord, groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 15.3 / 15.2A / 15.2E 空军基地与简易机场的**修建·升格·拒绝缩减**（＋13.8d 施工前提）
 *
 * 条文：
 *   · **15.3**「只能在移动阶段中修建或改进，而且只能由**具备工程能力的单位**执行修建（13.8d）。
 *     费用为 1SP。」「等级每回合只能提升一级。」「永远无法改进大于三级。」
 *   · **15.2A** 简易机场按 15.3 的流程，**建造 1T**；可支付 **3T 升级为一级空军基地**。
 *   · **15.2E** 简易机场**永远不会**被缩减降级（伤害或玩家自愿都不行）。
 *   · **13.8d**「具有工程能力的单位可在半径为 2 格的范围内进行建造（无视敌方 ZOC，但地形效果会影响
 *     这 2 格的长度计算，以步行 MP 计算）」「只能在一个格内进行建造，而且只能进行一种类型的建造」。
 *   · **4.8 / 15.0a** 一格至多 1 个空中设施。
 *
 * ★ 修前：`planAirBaseBuild` / `planAirstripBuild` / `planAirstripUpgrade` / `canReduceAirstrip` /
 *   `airBaseBuildCostSp` **全部零消费** ⇒ **只能缩不能建**：盘面上再也造不出任何基地/机场，
 *   而 15.1 的整备与 14.2d 的航程都以基地为锚点。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/**
 * 摆一名**具工程能力**的单位（13.8 首段只认**指挥部**）
 *
 * ★ B43：修前这里取的是 `Ge 43 Pioneer Bn`（`specialized` 含 `engineer`）—— 而 13.8 首段明写
 *   「**指挥部和工程兵 (Engineer)** 是唯二可执行工程能力的单位……相似的类型单位，如**铁路修理单位**、
 *   突击工兵单位、**工兵单位(Pioneer)** 和空降/滑翔机工程兵单位，**不能**执行本节所列的能力。」
 *   本作单位库里没有 Engineer 类型的算子 ⇒ 施工者只能是**指挥部**。
 */
function placeEngineer(store: Workbench, hexText: string, instanceId = 'e1') {
  const hex = { col: Number(hexText.split('.')[0]), row: Number(hexText.split('.')[1]) }
  const record = groundRecord('axis', (item) => (item.specialized ?? []).includes('hq'))
  const unit = placeGround(store, record, hex, 'axis', instanceId)
  unit.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
  unit.mpSpent = 0
  unit.movementEnded = false
  return unit
}

/**
 * B43 的反例夹具：`specialized` 含 `engineer`（Pioneer）或 `rail_repair`（铁路修理）的单位
 *
 * 13.8 首段把它们与"突击工兵 / 空降滑翔工程兵"并列，明写**不能**执行 13.8 的能力；
 * 铁路修理单位的那一族是 13.3f/13.3g **换轨**（store 的 `isRailRepairUnit`），与本节无关。
 */
function placeNonEngineerSpecialist(
  store: Workbench,
  hexText: string,
  tag: 'engineer' | 'rail_repair',
  instanceId = 'n1',
) {
  const hex = { col: Number(hexText.split('.')[0]), row: Number(hexText.split('.')[1]) }
  const record = groundRecord('axis', (item) => (item.specialized ?? []).includes(tag))
  const unit = placeGround(store, record, hex, 'axis', instanceId)
  unit.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
  unit.mpSpent = 0
  unit.movementEnded = false
  return unit
}

/** 摆一名**非**工程单位（用于「谁可施工」的反例） */
function placePlainUnit(store: Workbench, hexText: string, instanceId = 'p1') {
  const hex = { col: Number(hexText.split('.')[0]), row: Number(hexText.split('.')[1]) }
  const record = groundRecord(
    'axis',
    (item) =>
      item.isCombat === true &&
      item.attackCapable === true &&
      !(item.specialized ?? []).some((tag) => ['hq', 'engineer', 'rail_repair'].includes(tag)),
  )
  const unit = placeGround(store, record, hex, 'axis', instanceId)
  unit.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
  unit.mpSpent = 0
  return unit
}

function withDump(store: Workbench, input: { sp?: number; t?: number } = {}) {
  store.spDumps.push({
    id: 'd1',
    hex: { ...CORE_HEX },
    side: 'axis',
    sp: input.sp ?? 4,
    t: input.t ?? 0,
  })
  return store.spDumps[0]!
}

/** 到达移动阶段并选好目标格 / 工程兵 / 付款站 */
function prepare(
  store: Workbench,
  input: {
    hexText: string
    engineerId: string | null
    payDumpId: string | null
  },
) {
  store.setPhase('movement')
  store.setTurn(4)
  store.constructionInputs = { ...input }
}

const coreText = `${CORE_HEX.col}.${CORE_HEX.row}`

describe('13.8a / 5.5b：谁可以施工（工程能力 × 模式）', () => {
  it('工程兵在战斗模式 ⇒ 进候选；普通单位不进候选', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    placePlainUnit(store, `${CORE_HEX.col + 1}.${CORE_HEX.row}`)
    expect(store.canEngineerInPhase(engineer)).toBe(true)
    expect(store.engineerChoices.map((unit) => unit.instanceId)).toEqual([engineer.instanceId])
  })

  it('工程兵切到移动模式 ⇒ 不再具工程能力（5.5b：须战斗模式）', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    engineer.mode = { mode: 'move', orientation: 'move', dg: false, exploit: false }
    expect(store.canEngineerInPhase(engineer)).toBe(false)
    expect(store.engineerChoices).toEqual([])
  })
})

describe('15.3：修建 / 改进空军基地（1 SP/级、每回合 +1、上限 3）', () => {
  it('移动阶段 + 工程兵同格 + 足 SP ⇒ 摆出 1 级基地并扣 1 SP', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 4 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })

    expect(store.airBaseLevelAt(CORE_HEX)).toBe(0)
    expect(store.buildAirBaseNow()).toBe(true)
    expect(store.airBaseLevelAt(CORE_HEX)).toBe(1)
    // 15.3：1 SP/级 ⇒ 4 T
    expect(holdingsToT(store.spDumps[0]!)).toBe(4 * SP_TO_T - AIR_BASE_COST_SP_PER_LEVEL * SP_TO_T)
    // 13.8d：施工者在它执行建造的阶段中不能移动
    expect(engineer.movementEnded).toBe(true)
    expect(store.constructionLedgerOf(engineer.instanceId).task).toBe('buildAirBase')
    expect(store.constructionError).toBeNull()
  })

  it('同格再来一次 ⇒ 升级到 2 级（换算子，等级随算子走）', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 8 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.buildAirBaseNow()).toBe(true)

    // 换回合 ⇒ 15.3 的「每回合 +1 级」额度复位；换阶段 ⇒ 13.8d 的一格一任务复位
    store.setTurn(5)
    store.setPhase('movement')
    const again = placeEngineer(store, coreText, 'e2')
    store.constructionInputs = {
      hexText: coreText,
      engineerId: again.instanceId,
      payDumpId: dump.id,
    }

    expect(store.buildAirBaseNow()).toBe(true)
    expect(store.airBaseLevelAt(CORE_HEX)).toBe(2)
    // 4.8：一格至多 1 个空中设施 ⇒ 算子被换掉而不是叠两个
    expect(store.airBaseUnitAt(CORE_HEX)).not.toBeUndefined()
    expect(store.airBases.filter((base) => base.level === 2)).toHaveLength(1)
    expect(store.airBases.filter((base) => base.level === 1)).toHaveLength(0)
  })

  it('该格本回合已提升过 ⇒ 拒（15.3：等级每回合只能提升一级）', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 8 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.buildAirBaseNow()).toBe(true)

    // 只换阶段（同一回合）⇒ 13.8d 的额度复位，但 15.3 的「每回合 +1」仍在
    store.setPhase('supply')
    store.setPhase('movement')
    const again = placeEngineer(store, coreText, 'e2')
    store.constructionInputs = {
      hexText: coreText,
      engineerId: again.instanceId,
      payDumpId: dump.id,
    }
    expect(store.buildAirBaseNow()).toBe(false)
    expect(store.constructionError?.rule).toBe('15.3')
    expect(store.constructionError?.reason).toBe('airBaseAlreadyImprovedThisTurn')
    expect(store.airBaseLevelAt(CORE_HEX)).toBe(1)
  })

  it('3 级后再加 ⇒ 拒（15.3：永远无法改进大于三级）', () => {
    const store = newStore()
    // 直接摆一个 3 级基地（省的走三级）
    placeGround(store, airBaseRecord(AIR_BASE_MAX_LEVEL), CORE_HEX, 'axis', 'ab3')
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 8 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.airBaseLevelAt(CORE_HEX)).toBe(AIR_BASE_MAX_LEVEL)
    expect(store.buildAirBaseNow()).toBe(false)
    expect(store.constructionError?.reason).toBe(`airBaseAtMaxLevel:${AIR_BASE_MAX_LEVEL}`)
  })

  it('★ 15.3：目标格是**敌方**空军基地 ⇒ 预检先报 9.14f，落盘不得把敌方算子换成本方', () => {
    const store = newStore()
    const enemy = placeGround(store, airBaseRecord(2), CORE_HEX, 'soviet', 'enemy-base')
    const engineer = placeEngineer(store, `${NEAR_HEX.col}.${NEAR_HEX.row}`, 'eng-near-enemy')
    const dump = withDump(store, { sp: 8 })
    prepare(store, {
      hexText: coreText,
      engineerId: engineer.instanceId,
      payDumpId: dump.id,
    })
    expect(store.airConstructionMissing('baseBuild')).toContain('9.14f')
    expect(store.buildAirBaseNow()).toBe(false)
    expect(store.constructionError?.reason).toBe('airBaseTargetIsEnemy')
    // 敌方基地原样保留（等级/归属都没被“改进”掉）
    expect(store.airBaseUnitAt(CORE_HEX)?.side).toBe('soviet')
    expect(enemy.noncombatLevel).toBe(2)
    expect(store.airBases.filter((base) => base.side === 'axis')).toHaveLength(0)
  })

  it('★ 15.3 / 15.2A：目标格是建造标记的简易机场 ⇒ 预检与落盘都拒绝，不再叠第二座设施', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(4)
    const worker = placePlainUnit(store, coreText, 'marker-worker')
    worker.mode = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
    const engineer = placeEngineer(store, `${NEAR_HEX.col}.${NEAR_HEX.row}`, 'eng-marker')
    expect(store.useConstructionMarkerNow('airStrip', coreText)).toBe(true)
    expect(store.airBases.some((base) => base.isAirstrip === true)).toBe(true)

    const dump = withDump(store, { sp: 8, t: 4 })
    prepare(store, {
      hexText: coreText,
      engineerId: engineer.instanceId,
      payDumpId: dump.id,
    })
    expect(store.airConstructionMissing('baseBuild')).toContain('建造标记')
    expect(store.buildAirBaseNow()).toBe(false)
    expect(store.constructionError?.reason).toBe('airBaseTargetIsMarkerAirstrip')
    expect(store.airConstructionMissing('airstripBuild')).toContain('建造标记')
    expect(store.buildAirstripNow()).toBe(false)
    // 标记仍在、盘面只有这一座简易机场
    expect(store.airBases.filter((base) => base.isAirstrip === true)).toHaveLength(1)
    expect(store.airBaseUnitAt(CORE_HEX)).toBeUndefined()
  })

  it('★ B43（13.8 首段）：**Pioneer 与铁路修理单位不能施工** —— 候选里没有它们，点名施工也被拒', () => {
    const store = newStore()
    store.setPhase('movement')
    const core = `${CORE_HEX.col}.${CORE_HEX.row}`
    const pioneer = placeNonEngineerSpecialist(store, core, 'engineer', 'pio-1')
    const railRepair = placeNonEngineerSpecialist(store, core, 'rail_repair', 'rr-1')
    const hq = placeEngineer(store, core, 'hq-1')

    /* 13.8 首段：Pioneer／铁路修理都不算"具工程能力" ⇒ 不进施工者候选 */
    const ids = store.engineerChoices.map((unit) => unit.instanceId)
    expect(ids).toContain('hq-1')
    expect(ids).not.toContain('pio-1')
    expect(ids).not.toContain('rr-1')
    expect(store.canEngineerInPhase(pioneer)).toBe(false)
    expect(store.canEngineerInPhase(railRepair)).toBe(false)
    expect(store.canEngineerInPhase(hq)).toBe(true)

    /* 点名让 Pioneer 修机场 ⇒ 被拒（13.8a 的资格判据）；先给出目标格，否则会先被格号校验拦下 */
    store.constructionInputs.hexText = core
    store.selectedId = pioneer.instanceId
    expect(store.buildAirstripNow()).toBe(false)
    expect(store.constructionError?.rule).toBe('13.8a')
  })
  it('非移动阶段 ⇒ 拒（13.8d 只能在一个移动阶段施工）', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 8 })
    store.setPhase('reinforcement')
    store.constructionInputs = {
      hexText: coreText,
      engineerId: engineer.instanceId,
      payDumpId: dump.id,
    }
    expect(store.buildAirBaseNow()).toBe(false)
    // ★ B8：段/环节不对由**统一闸门**拦下（引擎的 phase 判断不再被走到）
    expect(store.actionRefusal).toMatchObject({
      key: 'move.construction',
      rule: '13.8d / 15.3 / 15.2 / 专规 3.5',
    })
  })

  it('工程兵本阶段已移动 ⇒ 拒（13.8d）', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 8 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    // ★ 必须在 `prepare` 之后置：`setPhase` 会重置本阶段的 MP 记账
    engineer.mpSpent = 1
    expect(store.buildAirBaseNow()).toBe(false)
    expect(store.constructionError?.reason).toBe('builderMovedThisPhase')
  })

  it('13.8d：**同一名**施工者同阶段已施工过一格 ⇒ 换格再建被拒', () => {
    const store = newStore()
    const firstHex = coreText
    const secondHex = `${CORE_HEX.col + 1}.${CORE_HEX.row}`
    const a = placeEngineer(store, firstHex, 'e1')
    const dump = withDump(store, { sp: 8 })
    prepare(store, { hexText: firstHex, engineerId: a.instanceId, payDumpId: dump.id })
    expect(store.buildAirBaseNow()).toBe(true)

    // 13.8d「An Engineer-Capable unit can only perform construction in a single hex」
    store.constructionInputs = { hexText: secondHex, engineerId: a.instanceId, payDumpId: dump.id }
    expect(store.buildAirBaseNow()).toBe(false)
    expect(store.constructionError?.reason).toBe('oneHexPerPhase')
    expect(store.airBaseLevelAt({ col: CORE_HEX.col + 1, row: CORE_HEX.row })).toBe(0)
  })

  it('13.8d：**另一名**施工者同阶段可另行施工（额度按单位分账）', () => {
    const store = newStore()
    const firstHex = coreText
    const secondHex = `${CORE_HEX.col + 1}.${CORE_HEX.row}`
    const a = placeEngineer(store, firstHex, 'e1')
    const dump = withDump(store, { sp: 8 })
    prepare(store, { hexText: firstHex, engineerId: a.instanceId, payDumpId: dump.id })
    expect(store.buildAirBaseNow()).toBe(true)

    const b = placeEngineer(store, secondHex, 'e2')
    store.constructionInputs = { hexText: secondHex, engineerId: b.instanceId, payDumpId: dump.id }
    expect(store.buildAirBaseNow()).toBe(true)
    expect(store.airBaseLevelAt({ col: CORE_HEX.col + 1, row: CORE_HEX.row })).toBe(1)
    expect(store.constructionLedgerOf(a.instanceId).hexes).toEqual([firstHex])
    expect(store.constructionLedgerOf(b.instanceId).hexes).toEqual([secondHex])
  })

  it('同一阶段内换任务类型/换格 ⇒ 拒（13.8d 的门先在运行规则之前生效）', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 8, t: 8 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    // 先做「修建简易机场」（buildAirstrip）
    expect(store.buildAirstripNow()).toBe(true)
    expect(store.constructionLedgerOf(engineer.instanceId).task).toBe('buildAirstrip')

    /*
     * 同一阶段内改做「修建空军基地」（buildAirBase）⇒ 13.8d 门先在 `planAirBaseBuild` 之前拦下。
     * ★ 报的是两个子理由中**先判**的那个：`validateConstructionBase` 的次序是「一格」先于「一任务」，
     *   故此处是 `oneHexPerPhase`（同格）；`oneTaskTypePerPhase` 本身的成立由引擎用例单独钉住
     *   （tests/engine/construction.test.ts 的「只能在一个格内建造、只能一种类型」）。
     * ★ 必须用**同一名**施工者：13.8d 的额度按单位分账，换人就不该再被这条拦。
     */
    store.constructionInputs = {
      hexText: coreText,
      engineerId: engineer.instanceId,
      payDumpId: dump.id,
    }
    expect(store.buildAirBaseNow()).toBe(false)
    expect(store.constructionError?.rule).toBe('13.8d')
    expect(store.constructionError?.reason).toBe('oneHexPerPhase')
  })

  it('目标格超出 2 格**步行 MP** 半径 ⇒ 拒（13.8d）', () => {
    const store = newStore()
    const far = { col: CORE_HEX.col + 30, row: CORE_HEX.row }
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 8 })
    prepare(store, {
      hexText: `${far.col}.${far.row}`,
      engineerId: engineer.instanceId,
      payDumpId: dump.id,
    })
    expect(store.buildAirBaseNow()).toBe(false)
    expect(store.constructionError?.rule).toBe('13.8d')
    expect(store.constructionError?.reason.startsWith('targetBeyondConstructionRadius')).toBe(true)
  })

  it('未指定付款站 ⇒ 拒（12.1b/12.3a：建造费用只能从己方补给站扣）', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    withDump(store, { sp: 8 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: null })
    expect(store.buildAirBaseNow()).toBe(false)
    expect(store.airBaseLevelAt(CORE_HEX)).toBe(0)
  })
})

describe('15.2A / 15.2E：简易机场的修建、升格与「永不缩减」', () => {
  it('空格的 1 T 修建 ⇒ 该格成为简易机场（等级 0、整备 1 架）', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 0, t: AIRSTRIP_BUILD_T })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })

    expect(store.hexHasAirFacility(CORE_HEX)).toBe(false)
    expect(store.buildAirstripNow()).toBe(true)
    expect(store.hexHasAirFacility(CORE_HEX)).toBe(true)
    expect(store.isAirstripAt(CORE_HEX)).toBe(true)
    // 15.2F/B：简易机场等级记 0（整备 1 架、无防空值）
    expect(store.airBaseLevelAt(CORE_HEX)).toBe(0)
    const base = store.airBases.find((item) => item.isAirstrip === true)
    expect(base).not.toBeUndefined()
    // 15.2A：1 T
    expect(holdingsToT(store.spDumps[0]!)).toBe(0)
  })

  it('该格已有空中设施 ⇒ 拒（4.8 / 15.0a：每格至多 1 个）', () => {
    const store = newStore()
    placeGround(store, airBaseRecord(1), CORE_HEX, 'axis', 'ab1')
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 0, t: 4 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.buildAirstripNow()).toBe(false)
    expect(store.constructionError?.rule).toBe('4.8')
    expect(store.constructionError?.reason).toBe('airFacilityPerHexLimit')
  })

  it('空补给站（0 T）⇒ 12.1c 已不算站，主按钮不得出现', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 0, t: 0 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.airConstructionMissing('airstripBuild')).toContain('付款站')
    expect(store.buildAirstripNow()).toBe(false)
  })

  it('15.2A：付 3 T 把简易机场升格为一级空军基地', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 0, t: AIRSTRIP_BUILD_T + AIRSTRIP_UPGRADE_T })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.buildAirstripNow()).toBe(true)
    const baseId = store.airBases[0]!.id

    // 13.8d 一格一任务：换阶段再升格（同一回合内 15.2A 未设「每回合一次」的限制）
    store.setPhase('supply')
    store.setPhase('movement')
    const engineer2 = placeEngineer(store, coreText, 'e2')
    store.constructionInputs = {
      hexText: coreText,
      engineerId: engineer2.instanceId,
      payDumpId: dump.id,
    }
    expect(store.upgradeAirstripNow(baseId)).toBe(true)
    expect(store.isAirstripAt(CORE_HEX)).toBe(false)
    expect(store.airBaseLevelAt(CORE_HEX)).toBe(1)
    expect(holdingsToT(store.spDumps[0]!)).toBe(0)
  })

  it('15.3 不适用于简易机场格（升格须走 15.2A 的 3 T，不得用 1 SP 抄近路）', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 8, t: AIRSTRIP_BUILD_T })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.buildAirstripNow()).toBe(true)

    store.setPhase('supply')
    store.setPhase('movement')
    const engineer2 = placeEngineer(store, coreText, 'e2')
    store.constructionInputs = {
      hexText: coreText,
      engineerId: engineer2.instanceId,
      payDumpId: dump.id,
    }
    expect(store.buildAirBaseNow()).toBe(false)
    expect(store.constructionError?.rule).toBe('15.2A')
    expect(store.constructionError?.reason).toBe('airstripMustUseAirstripUpgrade')
    // 未升格（也不该扣钱）
    expect(store.isAirstripAt(CORE_HEX)).toBe(true)
  })

  it('15.2E：简易机场不被缩减（走 15.4 的入口也照样拒，理由来自引擎）', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 8, t: AIRSTRIP_BUILD_T })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.buildAirstripNow()).toBe(true)
    const baseId = store.airBases[0]!.id

    // 15.4 的前提都摆好（另派一名未施工的 HQ 执行；原施工者已受 13.8d 额度约束），
    // 仍必须被 15.2E 拒
    const reducer = placeEngineer(store, coreText, 'eng-reducer')
    store.airInputs.reductionUnitIds = [reducer.instanceId]
    expect(store.reduceBaseNow(baseId)).toBe(false)
    expect(store.airError).toMatchObject({ rule: '15.2E', reason: 'airstripCannotBeReduced' })
    // 设施仍在、仍是简易机场，且没落下任何缩减结算
    expect(store.isAirstripAt(CORE_HEX)).toBe(true)
    expect(store.lastReduction).toBeNull()
  })

  it('15.4：非工程单位在别的基地格 ⇒ 不进该基地候选，不能跨格缩减', () => {
    const store = newStore()
    store.setPhase('movement')
    const worker = placePlainUnit(store, coreText, 'plain-1')
    placeGround(store, airBaseRecord(2), CORE_HEX, 'axis', 'base-a')
    const farBase = placeGround(store, airBaseRecord(2), NEAR_HEX, 'axis', 'base-b')

    store.airInputs.reductionUnitIds = [worker.instanceId]
    expect(
      store
        .airReductionCandidates(farBase.instanceId)
        .some((unit) => unit.instanceId === worker.instanceId),
    ).toBe(false)
    expect(store.reduceBaseNow(farBase.instanceId)).toBe(false)
    expect(farBase.noncombatLevel).toBe(2)
    expect(store.lastReduction).toBeNull()
  })

  it('15.4：工程兵在相邻格（2 格步行 MP 内）⇒ 可缩减该基地', () => {
    const store = newStore()
    store.setPhase('movement')
    const engineer = placeEngineer(store, coreText, 'eng-near')
    engineer.mode = { mode: 'combat', orientation: 'combat', dg: true, exploit: false }
    const base = placeGround(store, airBaseRecord(2), NEAR_HEX, 'axis', 'base-near')

    store.airInputs.reductionUnitIds = [engineer.instanceId]
    expect(
      store
        .airReductionCandidates(base.instanceId)
        .some((unit) => unit.instanceId === engineer.instanceId),
    ).toBe(true)
    expect(store.reduceBaseNow(base.instanceId)).toBe(true)
    expect(base.noncombatLevel).toBe(1)
    expect(engineer.movementEnded).toBe(true)
  })

  it('15.4 / 13.8d：工程兵本阶段已缩减一个基地 ⇒ 同一阶段不能再缩第二个', () => {
    const store = newStore()
    store.setPhase('movement')
    const engineer = placeEngineer(store, coreText, 'eng-ledger')
    const baseA = placeGround(store, airBaseRecord(2), CORE_HEX, 'axis', 'base-ledger-a')
    const baseB = placeGround(store, airBaseRecord(2), NEAR_HEX, 'axis', 'base-ledger-b')

    store.airInputs.reductionUnitIds = [engineer.instanceId]
    expect(store.airReductionMissing(baseA.instanceId)).toBeNull()
    expect(store.reduceBaseNow(baseA.instanceId)).toBe(true)
    expect(store.airReductionMissing(baseB.instanceId)).toContain('13.8d')
    expect(store.reduceBaseNow(baseB.instanceId)).toBe(false)
    // 第二个基地没被降级
    expect(baseB.noncombatLevel).toBe(2)
  })

  it('15.4：单个 RE 0.5 单位 ⇒ 预检先报 RE 合计不足，主按钮不得出现；两枚 0.5 合计 1 才放行', () => {
    const store = newStore()
    store.setPhase('movement')
    const base = placeGround(store, airBaseRecord(2), CORE_HEX, 'axis', 'base-half')
    const halfA = placePlainUnit(store, coreText, 'half-a')
    const halfB = placePlainUnit(store, coreText, 'half-b')
    halfA.re = 0.5
    halfB.re = 0.5

    store.airInputs.reductionUnitIds = [halfA.instanceId]
    // 候选只含两枚战斗单位；同格的空军基地算子（非战斗）不得混进 15.4 执行者名单
    expect(store.airReductionCandidates(base.instanceId)).toHaveLength(2)
    expect(
      store
        .airReductionCandidates(base.instanceId)
        .some((unit) => unit.instanceId === halfA.instanceId),
    ).toBe(true)
    expect(store.airReductionMissing(base.instanceId)).toContain('RE 合计')
    expect(store.reduceBaseNow(base.instanceId)).toBe(false)
    expect(base.noncombatLevel).toBe(2)
    expect(store.lastReduction).toBeNull()

    // 既有口径：被指定单位 RE **合计** ≥1；两枚 0.5 单位合计 1，合法。
    store.airInputs.reductionUnitIds = [halfA.instanceId, halfB.instanceId]
    expect(store.airReductionMissing(base.instanceId)).toBeNull()
    expect(store.reduceBaseNow(base.instanceId)).toBe(true)
    expect(base.noncombatLevel).toBe(1)
    expect(halfA.movementEnded).toBe(true)
    expect(halfB.movementEnded).toBe(true)
  })
})

describe('13.8d / 15.3 的额度复位（换阶段 / 换回合 / 换方 / 重置）', () => {
  it('换回合后同一格的「每回合 +1」复位、一格一任务也复位', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 12 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.buildAirBaseNow()).toBe(true)
    expect(store.constructionLedgerOf(engineer.instanceId).hexes).toEqual([coreText])
    expect(store.airBaseTurnLedger[coreText]).toBe(1)

    // 同一回合内、换阶段：13.8d 额度复位，但 15.3 的每回合 +1 仍拦
    store.setPhase('supply')
    store.setPhase('movement')
    expect(store.constructionLedgerOf(engineer.instanceId).hexes).toEqual([])
    expect(store.airBaseTurnLedger[coreText]).toBe(1)

    // 换回合：两者都复位
    store.setTurn(5)
    expect(store.constructionLedgerOf(engineer.instanceId).hexes).toEqual([])
    expect(store.airBaseTurnLedger).toEqual({})
  })

  it('重置局 ⇒ 施工账本与输入一并回到初始', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 8 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.buildAirBaseNow()).toBe(true)

    store.resetAll()
    expect(store.constructionLedgerOf(engineer.instanceId)).toEqual({ hexes: [], task: null })
    expect(store.airBaseTurnLedger).toEqual({})
    expect(store.constructionError).toBeNull()
    expect(store.constructionInputs).toEqual({ hexText: '', engineerId: null, payDumpId: null })
    expect(store.hedgehogTurnLedger).toEqual({})
  })
})

describe('15.3 的费用预显与算子库一致性', () => {
  it('`airBaseBuildCostSpPerLevel` 与引擎同源（1 SP/级）', () => {
    const store = newStore()
    expect(store.airBaseBuildCostSpPerLevel).toBe(AIR_BASE_COST_SP_PER_LEVEL)
    expect(AIR_BASE_COST_SP_PER_LEVEL * SP_TO_T).toBe(4)
  })

  it('单位库三个等级的基地算子都能取到（15.0c 的 1–3 级刻度）', () => {
    const store = newStore()
    const levels = [1, 2, 3]
    for (const level of levels) {
      expect(airBaseRecord(level)).not.toBeUndefined()
    }
    // 摆出的算子等级与记录一致（逐级换算子的前提）
    for (const level of levels) {
      setActivePinia(createPinia())
      const fresh = useWorkbenchStore()
      const placed = toConsoleUnit({
        record: airBaseRecord(level),
        instanceId: `ab${level}`,
        hex: { ...CORE_HEX },
        side: 'axis',
      })
      fresh.units.push(placed)
      expect(fresh.airBaseLevelAt(CORE_HEX)).toBe(level)
    }
    expect(store).not.toBeUndefined()
  })

  it('中立基地算子对双方都可用（15.0：归属由摆放方决定）', () => {
    expect(unitChoices('axis').some((record) => record.noncombatKind === 'air_base')).toBe(true)
    expect(unitChoices('soviet').some((record) => record.noncombatKind === 'air_base')).toBe(true)
  })
})

describe('12.1b：施工费可以由**装载在运输点数上**的 SP 支付', () => {
  it('15.2A 简易机场：付款站是运输点数上的 1 SP ⇒ 修得起来（修前读 spDumps 判成"没有 SP"）', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    // 同格摆一枚**常规**运输点数（13.2f：不是编内卡车），车上 1 SP（4 T）
    const point = placeGround(
      store,
      groundRecord(
        'axis',
        (item) =>
          item.noncombatKind === 'transport_point' && (item.noncombatDetails?.transport ?? 0) >= 2,
      ),
      CORE_HEX,
      'axis',
      'tp-1',
    )
    point.loadedSpT = SP_TO_T
    prepare(store, {
      hexText: coreText,
      engineerId: engineer.instanceId,
      payDumpId: `unit:${point.instanceId}`,
    })
    expect(store.buildAirstripNow()).toBe(true)
    // 15.2A：建造 1T ⇒ 车上剩 3T（12.1a：1 SP = 4 T）
    expect(point.loadedSpT).toBe(SP_TO_T - 1)
    expect(point.loadedSpT).toBe(3)
  })
})

describe('15.3 / 15.2A 主按钮预检（与落盘同一组引擎判据）', () => {
  it('15.3：目标格是简易机场 ⇒ 预检直接指向 15.2A 的 3 T，不给 1 SP 主按钮', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 4, t: 1 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.buildAirstripNow()).toBe(true)
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.airConstructionMissing('baseBuild')).toContain('15.2A')
    expect(store.airConstructionMissing('baseBuild')).toContain('简易机场')
  })

  it('15.3：三级基地 ⇒ 预检给出上限，不出现主按钮', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    placeGround(store, airBaseRecord(AIR_BASE_MAX_LEVEL), CORE_HEX, 'axis', 'base-max')
    const dump = withDump(store, { sp: 4 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.airConstructionMissing('baseBuild')).toContain('15.3')
    expect(store.airConstructionMissing('baseBuild')).toContain(String(AIR_BASE_MAX_LEVEL))
  })

  it('15.3：目标超出 2 格步行 MP ⇒ 预检给出 13.8d 半径', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 4 })
    const far = `${CORE_HEX.col + 4}.${CORE_HEX.row}`
    prepare(store, { hexText: far, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.airConstructionMissing('baseBuild')).toContain('13.8d')
    expect(store.airConstructionMissing('baseBuild')).toContain('半径')
  })

  it('15.2A：目标格已有空中设施 ⇒ 预检给出 4.8，不覆盖原设施', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    placeGround(store, airBaseRecord(2), CORE_HEX, 'axis', 'base-here')
    const dump = withDump(store, { sp: 4, t: 8 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.airConstructionMissing('airstripBuild')).toContain('4.8')
  })

  it('15.2A：升格 T 不足 ⇒ 预检给出 T 不足，不出现升格按钮', () => {
    const store = newStore()
    const engineer = placeEngineer(store, coreText)
    const dump = withDump(store, { sp: 0, t: AIRSTRIP_BUILD_T + 1 })
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    expect(store.buildAirstripNow()).toBe(true)
    store.setPhase('supply')
    store.setPhase('movement')
    engineer.movementEnded = false
    engineer.mpSpent = 0
    prepare(store, { hexText: coreText, engineerId: engineer.instanceId, payDumpId: dump.id })
    const baseId = store.airBases[0]!.id
    expect(store.airConstructionMissing('airstripUpgrade', baseId)).toContain('T')
  })

  it('15.3：窗内换工程兵后旧付款站已不可达 ⇒ 预检拦下，不得扣旧站 SP', () => {
    const store = newStore()
    // 旧站摆 CORE；换成 8 格外的工程兵与目标格后，旧站不再可达
    const far = mapLayers.hexes
      .map((hex): HexRef => ({ col: hex.col, row: hex.row }))
      .find((hex) => hexDistance(CORE_HEX, hex) >= 8)
    if (far === undefined) throw new Error('地图上找不到距 CORE ≥8 的格')
    const farText = `${far.col}.${far.row}`
    const oldEngineer = placeEngineer(store, coreText, 'eng-pay-old')
    const dump = withDump(store, { sp: 4 })
    placeEngineer(store, farText, 'eng-pay-new')
    prepare(store, { hexText: farText, engineerId: 'eng-pay-new', payDumpId: dump.id })

    expect(store.airConstructionMissing('baseBuild')).toContain('付款站不在施工者可达范围')
    expect(store.buildAirBaseNow()).toBe(false)
    expect(store.airBaseLevelAt(far)).toBe(0)
    expect(holdingsToT(store.spDumps[0]!)).toBe(4 * SP_TO_T)
    expect(oldEngineer.movementEnded).toBe(false)
  })
})
