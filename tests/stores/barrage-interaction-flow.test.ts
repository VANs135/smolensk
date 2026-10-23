import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { createMapFacts, holdingsToT, selectMovementTerrain } from '@/engine/rules'
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
 * C7 轰炸交互的**端到端流程**（store 级）
 *
 * 覆盖用户要求的交互链：目标与轰炸值分配 → 横移地形确认 → 结果确认 → 对设施轰炸；
 * 并核对 10.0 通用流程的**顺序**（加总轰炸值 → 定初始列 → 按该列付补给 → 横移 → 掷骰 → 结果）。
 *
 * 用**真实地图与真实单位库**（不造数）：结论全部来自引擎，故断言的是「流程走通 + 状态写对」。
 * 规则细节（密度/工事/观察员横移、`1/2` 取整骰、对设施 A/B/C、损失足额校验）在
 * `tests/engine/barrage-interaction.test.ts`。
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

const mapFacts = createMapFacts()

function canEnter(mobility: 'leg' | 'truck' | 'track', from: HexRef, to: HexRef): boolean {
  return selectMovementTerrain({
    terrainsPresent: mapFacts.terrainsAt(to),
    mobility,
    crossing: mapFacts.crossingBetween(from, to),
    followingRoad: true,
    forOverrun: false,
  }).ok
}

/** 目标格：六邻皆图内 */
const TARGET_HEX: HexRef = (() => {
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

/** 参炸格：目标格的图内邻格（10.0b 观察员也要求相邻；10.1a 射程按格） */
const FIRING_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(TARGET_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)) {
      continue
    }
    if (canEnter('leg', candidate, TARGET_HEX)) return candidate
  }
  throw new Error('目标格没有可进入的图内邻格')
})()

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

/** 有印刷轰炸值的火炮（10.0e-B：不得低于印刷值轰炸） */
function artilleryRecord(): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('axis').find(
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
  )
  if (found === undefined) throw new Error('轴心国单位库中没有带轰炸值的火炮')
  return found
}

function defenderRecord(): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('soviet').find((record) => record.isCombat === true)
  if (found === undefined) throw new Error('苏联单位库中没有战斗单位')
  return found
}

/**
 * 10.1b / 12.3a：声明一座**当前行动方**的补给站并点选为轰炸补给来源
 *
 * 「只能来自 SP：同一 HQ 或同一 dump」⇒ 火炮的这笔 T 必须落到一座具体的站上；
 * 该站也是断言的锚点（账本真的动了才说明付了）。
 */
function withBarrageDump(
  store: ReturnType<typeof newStore>,
  input: { sp?: number; t?: number } = {},
): string {
  const id = `bd-${store.spDumps.length}`
  store.spDumps.push({
    id,
    hex: FIRING_HEX,
    side: store.activeSide,
    sp: input.sp ?? 0,
    t: input.t ?? 0,
  })
  expect(store.pickBarrageSupplyDump(id)).toBe(true)
  // 3.4b：受益编队若属某装甲集群，这座站须声明同一归属（否则受限用途会被拒）
  const group = store.groupOfUnit(store.units.find((unit) => unit.side === store.activeSide)!)
  if (group !== null) store.setDumpPanzerGroupNow(id, group)
  return id
}

/** 该站**当前**的持仓（★ 现读：`setSpDumpHoldings` 会替换数组，旧引用会过期） */
function holdingsOf(store: ReturnType<typeof newStore>, dumpId: string) {
  const dump = store.spDumps.find((item) => item.id === dumpId)
  if (dump === undefined) throw new Error(`补给站 ${dumpId} 不存在`)
  return { sp: dump.sp, t: dump.t }
}

/**
 * 该站的**总吨位**
 *
 * ★ 别直接比 `.t`：12.1a 的扣款会**规范化**（T 满 4 并为 SP），故「20 T 扣 3 T」落在
 *   `{sp: 4, t: 1}` 上——`.t` 是 1、总吨位才是 17。比 `.t` 会把规范化误读成多扣了。
 */
function tonsOf(store: ReturnType<typeof newStore>, dumpId: string): number {
  const dump = holdingsOf(store, dumpId)
  return holdingsToT({ sp: dump.sp, t: dump.t })
}

/** 摆好双方并选好目标格（10.0d），返回参炸单位与目标格守军 */
function setupBarrage(store: ReturnType<typeof newStore>, phase: 'movement' | 'combat') {
  store.setPhase(phase)
  // B8：轰炸在**本段的轰炸环节**（C 段首环是突围跳过、次环才是轰炸；F 段首环即炮击）
  goToActionStep(store, 'barrage.declare')
  const artillery = place(store, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
  const defender = place(store, defenderRecord(), TARGET_HEX, 'soviet', 'def-1')
  store.battleTarget = { hex: TARGET_HEX, defenderIds: [defender.instanceId] }
  store.setBarrageActive(true)
  store.toggleBarrageUnit(artillery.instanceId)
  return { artillery, defender }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('C7 轰炸交互：10.0 通用流程端到端', () => {
  it('走通①宣布 → ②补给 → ③横移 → ④掷骰 → ⑤结果（10.0a）', () => {
    const store = newStore()
    const { defender } = setupBarrage(store, 'combat')

    // ① 宣布整体目标与轰炸值（10.0d / 10.0e）
    expect(store.beginBarrageNow()).toBe(true)
    expect(store.barrageState?.step).toBe('supply')
    expect(store.barrageState?.totalValue).toBeGreaterThan(0)

    // ② 按初始列付火炮补给（10.1b）：先声明来源，再付（账本真扣）
    const dump = withBarrageDump(store, { sp: 0, t: 20 })
    const before = tonsOf(store, dump)
    expect(store.confirmBarrageSupplyStep()).toBe(true)
    expect(store.barrageState?.step).toBe('shifts')
    expect(tonsOf(store, dump)).toBe(before - store.barrageState!.supply!.requiredT)

    // ③ 目标玩家选地形（10.0a；本次不选 ⇒ 无地形横移）
    expect(store.confirmBarrageShiftsStep()).toBe(true)
    expect(store.barrageState?.step).toBe('dice')

    // ④ 掷骰（10.0a：2 骰 2–12）。骰 12 必出结果且多为 DG/[1/2]
    store.barrageInputs.die = 12
    store.barrageInputs.halfDie = 4
    expect(store.rollBarrageDiceStep()).toBe(true)
    expect(store.barrageState?.step).toBe('outcome')
    expect(store.barrageState?.result?.code).toBeTruthy()

    // ⑤ 结果确认（10.0a）：按引擎要求足额分配损失
    const required = store.barrageSummary?.unitOutcome?.stepLosses ?? 0
    if (required > 0) {
      store.barrageInputs.losses = { [defender.instanceId]: required }
    }
    expect(store.confirmBarrageOutcomeStep()).toBe(true)
    expect(store.barrageState?.finished).toBe(true)

    // 战果落盘：DG 结果必须写进守方算子（10.0a 的主要目的是把它们 DG）
    const dg = store.barrageState?.outcome
    if (dg?.table === 'barrage' && dg.value.dg) {
      expect(defender.mode.dg).toBe(true)
    }
  })

  it('10.0：顺序不可颠倒（未付补给就横移 / 未横移就掷骰均被拒）', () => {
    const store = newStore()
    setupBarrage(store, 'combat')
    expect(store.beginBarrageNow()).toBe(true)
    // 仍在补给步 ⇒ 横移被拒
    expect(store.confirmBarrageShiftsStep()).toBe(false)
    expect(store.barrageError?.reason).toBe('notAtShiftsStep:supply')
    // 补给步掷骰被拒
    expect(store.rollBarrageDiceStep()).toBe(false)
    expect(store.barrageError?.reason).toBe('notAtDiceStep:supply')
  })

  it('10.1b：付不出火炮补给即不能执行（且不算已轰炸过）', () => {
    const store = newStore()
    setupBarrage(store, 'combat')
    expect(store.beginBarrageNow()).toBe(true)
    // 12.3a：火炮补给必须落到一座声明的补给站上（原先手填一个数字就算"付了"）
    expect(store.pickBarrageSupplyDump(null)).toBe(true)
    expect(store.confirmBarrageSupplyStep()).toBe(false)
    expect(store.barrageError).toMatchObject({ rule: '12.3a', reason: 'barrageSupplyNeedsADump' })

    // 声明一座**空**站 ⇒ 可用量为 0，引擎给 10.1b 的 cannotAfford
    const empty = withBarrageDump(store, { sp: 0, t: 0 })
    expect(store.confirmBarrageSupplyStep()).toBe(false)
    expect(store.barrageError).toMatchObject({ rule: '10.1b', reason: 'cannotAfford' })
    expect(store.barrageState?.step).toBe('supply')
    // 10.1b-C：动用部队储备（明令禁止）——补一座够付的站，仍被专项拒绝
    withBarrageDump(store, { sp: 0, t: 20 })
    store.barrageInputs.usedInternalStocks = true
    expect(store.confirmBarrageSupplyStep()).toBe(false)
    expect(store.barrageError).toMatchObject({ rule: '10.1b-C', reason: 'internalStocksForbidden' })
    // 站上的 T 分文未动（拒付即不落盘）
    expect(tonsOf(store, empty)).toBe(0)
  })

  it('10.1b / 12.3a：火炮补给**真的从声明的补给站扣款**（原先只把状态标成"已付"）', () => {
    const store = newStore()
    setupBarrage(store, 'combat')
    expect(store.beginBarrageNow()).toBe(true)
    const required = store.barrageState!.table.costT
    expect(required).toBeGreaterThan(0)
    const dump = withBarrageDump(store, { sp: 0, t: required + 5 })
    const before = tonsOf(store, dump)

    expect(store.confirmBarrageSupplyStep()).toBe(true)
    expect(store.barrageState?.supply).toMatchObject({ requiredT: required, paid: true })
    expect(tonsOf(store, dump)).toBe(before - required)
  })

  it('10.0e-D：火炮不能在移动阶段轰炸（阶段门槛由引擎裁决）', () => {
    const store = newStore()
    setupBarrage(store, 'movement')
    expect(store.beginBarrageNow()).toBe(false)
    expect(store.barrageError).toMatchObject({
      rule: '10.0e-D',
      reason: 'wrongPhaseForartillery:movement',
    })
  })

  it('10.0d：整体目标决定用哪张表，且**不**混用（战斗单位用轰炸表）', () => {
    const store = newStore()
    setupBarrage(store, 'combat')
    expect(store.beginBarrageNow()).toBe(true)
    expect(store.barrageState?.table.tableId).toBe('barrage')
    expect(store.barrageSummary?.facility).toBe(false)
  })

  it('10.0c：对设施轰炸（空军基地）—— 空军免费、无横移、掷 1 骰、基地降级', () => {
    const store = newStore()
    store.setPhase('movement')
    // B8：C 段的轰炸在**本段的轰炸环节**（段内动作只在对应环节放行）
    goToActionStep(store, 'barrage.declare')
    const plane = place(store, artilleryRecord(), FIRING_HEX, 'axis', 'air-1')
    /*
     * B39 / A-1：宣布「空军基地」须**该格真有基地**（10.0c / 10.0d 由盘面事实校验）⇒
     * 夹具先把基地算子摆上去（印刷基地在初设时也是以算子落盘，见 `placePrintedAirbaseNow`）。
     */
    const baseRecord = unitChoices('axis').find((record) => record.noncombatKind === 'air_base')!
    place(store, baseRecord, TARGET_HEX, 'axis', 'base-1')
    store.battleTarget = { hex: TARGET_HEX, defenderIds: [] }
    store.setBarrageActive(true)
    store.setBarrageKind('air')
    store.setBarrageTargetKind('airBase')
    store.toggleBarrageUnit(plane.instanceId)

    expect(store.beginBarrageNow()).toBe(true)
    expect(store.barrageState?.table.tableId).toBe('barrage-vs-facility')

    // 10.2c：空军轰炸无补给消耗
    expect(store.confirmBarrageSupplyStep()).toBe(true)
    expect(store.barrageState?.supply).toMatchObject({ requiredT: 0, waived: true })

    // 10.0c：对设施没有横移、不需观察员
    expect(store.confirmBarrageShiftsStep()).toBe(true)
    expect(store.barrageState?.shifts?.total).toBe(0)

    // 10.0c：掷一个骰子（1–6）
    store.barrageInputs.die = 5
    expect(store.rollBarrageDiceStep()).toBe(true)
    expect(store.barrageState?.step).toBe('outcome')

    // 结果确认：给出基地等级 ⇒ 由引擎算出降级后的等级
    store.barrageInputs.baseLevel = 3
    expect(store.confirmBarrageOutcomeStep()).toBe(true)
    expect(store.barrageState?.finished).toBe(true)
  })

  it('C7：切方/换阶段即作废进行中的轰炸（避免盘面在流程中途漂移）', () => {
    const store = newStore()
    setupBarrage(store, 'combat')
    expect(store.beginBarrageNow()).toBe(true)
    store.switchSide()
    expect(store.barrageState).toBeNull()
    expect(store.barrageUnitIds).toEqual([])
  })
})

describe('C7 空军：10.2b 短程加成的数据源（14.1a 飞机停在空军基地格）', () => {
  /** 摆一架飞机到 FIRING_HEX（⇒ 其基地格距目标格 1 格）并勾选参炸 */
  function setupAirBarrage(store: ReturnType<typeof newStore>, aircraftType?: string) {
    store.setPhase('movement')
    goToActionStep(store, 'barrage.declare')
    store.battleTarget = { hex: TARGET_HEX, defenderIds: [] }
    store.setBarrageActive(true)
    store.setBarrageKind('air')
    const model = store.airUnitChoices.find((item) =>
      aircraftType === undefined
        ? (item.barrageStrength ?? 0) > 0
        : item.aircraftType === aircraftType,
    )
    if (model === undefined)
      throw new Error(`机型库里没有满足条件的机体（${aircraftType ?? '任意'}）`)
    expect(store.addAirUnit(model.aircraftId, `${FIRING_HEX.col}.${FIRING_HEX.row}`)).toBe(true)
    const air = store.barrageAirCandidates.find((unit) => unit.aircraftId === model.aircraftId)
    if (air === undefined) throw new Error('飞机未进入参炸候选')
    store.toggleBarrageAirUnit(air.instanceId)
    return air
  }

  it('10.2b：基地格距目标格 1 格（≤10）⇒ 引擎给出右移 1 列', () => {
    const store = newStore()
    const air = setupAirBarrage(store)
    // 10.2b 的数据源：距其基地格数 = 所在格（= 空军基地格）到目标格的格距
    const facts = store.barrageAirFacts.find((item) => item.id === air.instanceId)
    expect(facts).toMatchObject({ rangeFromBase: 1 })
    expect(facts?.strategic).toBe(false)

    expect(store.beginBarrageNow()).toBe(true)
    expect(store.confirmBarrageSupplyStep()).toBe(true) // 10.2c：空军免费
    expect(store.confirmBarrageShiftsStep()).toBe(true)
    expect(store.barrageState?.shifts?.shortRange).toBe(1)
  })

  it('14.1e：战略轰炸机（机型 S）参炸 ⇒ 无短程 +1，且无观察员惩罚永久生效', () => {
    const store = newStore()
    // 本作机型库里唯一带 S（战略轰炸机）的是**苏方**的 Ru DB.3 ⇒ 先切到苏方
    store.switchSide()
    const air = setupAirBarrage(store, 'S')
    expect(air.aircraftType).toBe('S')
    expect(store.barrageAirFacts.find((item) => item.id === air.instanceId)?.strategic).toBe(true)

    expect(store.beginBarrageNow()).toBe(true)
    expect(store.confirmBarrageSupplyStep()).toBe(true)
    expect(store.confirmBarrageShiftsStep()).toBe(true)
    expect(store.barrageState?.shifts?.shortRange).toBe(0)
    expect(store.barrageState?.shifts?.spotter).toBe(-3)
  })

  it('10.0e-F：地面与空中同时参炸 ⇒ 混类型被引擎拒绝（事实自动判定，无须玩家勾选）', () => {
    const store = newStore()
    store.setPhase('movement')
    const gun = place(store, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
    const air = setupAirBarrage(store)
    store.toggleBarrageUnit(gun.instanceId)
    expect(store.beginBarrageNow()).toBe(false)
    expect(store.barrageError).toMatchObject({ rule: '10.0e-F', reason: 'mixedBarrageKinds' })
    expect(air.instanceId).toBeTruthy()
  })

  it('14.1a：移除飞机会连带取消其参炸勾选', () => {
    const store = newStore()
    const air = setupAirBarrage(store)
    expect(store.barrageAirIds).toContain(air.instanceId)
    store.removeAirUnit(air.instanceId)
    expect(store.barrageAirIds).not.toContain(air.instanceId)
    expect(store.airUnits.some((unit) => unit.instanceId === air.instanceId)).toBe(false)
  })
})

/**
 * 5.10b-A / 4.2：DG 火炮的轰炸值减半并取整（B1 接线验证）
 *
 * 与战斗侧同理：引擎单测证明 `beginBarrage` 会折算与取整，这里证明**桥接层把 `dg` 传下去了**。
 * 同时验证 4.2 的取整确实发生在**合并之后**（印值为奇数时会出现 .5）。
 */
describe('5.10b-A / 4.2：DG 火炮的轰炸值经状态桥折算', () => {
  it('对照：不标 DG 时按印值参炸', () => {
    const store = newStore()
    setupBarrage(store, 'combat')
    expect(store.beginBarrageNow()).toBe(true)
    const state = store.barrageState!
    expect(state.totalValue).toBeGreaterThan(0)
    expect(state.rawTotalValue).toBe(state.totalValue)
  })

  it('DG ⇒ 合并值减半、总值为其四舍五入；两者都写进状态供明细复核', () => {
    const plainStore = newStore()
    setupBarrage(plainStore, 'combat')
    expect(plainStore.beginBarrageNow()).toBe(true)
    const printed = plainStore.barrageState!.totalValue

    const dgStore = newStore()
    const { artillery } = setupBarrage(dgStore, 'combat')
    artillery.mode.dg = true
    expect(dgStore.beginBarrageNow()).toBe(true)

    const dgState = dgStore.barrageState!
    expect(dgState.rawTotalValue).toBe(printed * 0.5)
    // 4.2：合并后四舍五入（印值为奇数时 half 带 .5 ⇒ 进位）
    expect(dgState.totalValue).toBe(Math.floor(printed * 0.5 + 0.5))
    // 单单位的分配值也已是折算后的值（印值 × ½）
    expect(dgState.units[0]!.assignedValue).toBe(printed * 0.5)
  })
})
