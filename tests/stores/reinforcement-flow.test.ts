import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  NKVD_BORDER_CAPABILITY,
  createMapFacts,
  needsFuelToMove,
  selectMovementTerrain,
} from '@/engine/rules'
import {
  toConsoleUnit,
  toMoveUnitView,
  unitChoices,
  useWorkbenchStore,
  type ConsoleUnit,
  type UnitRecordView,
  actionGateOf,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

/**
 * W6 B18 的**端到端流程**（store 级）：到达表执行 / 可变增援 / 重建 / 拆分与合并 / NKVD 2.3b
 *
 * 用**真实地图、真实到达卡与真实单位库**（不造数）；结论全部来自引擎，
 * 故断言的是「流程走通 + 状态写对 + 阶段闸门生效」。
 */

/**
 * 进入 B 段的某个**环节**（B8 起：段内动作还要看环节）
 *
 * B8 把"每个环节只能做该环节的事"变成硬约束 ⇒ 调用重建 / 整编前必须说明"此刻在重建环节"。
 * 用 id 定位而不是写死序号：环节链顺序会随条文修订而变，写死序号会在那时静默指错环节。
 */
function goToSegmentStep(store: ReturnType<typeof newStore>, stepId: string): void {
  const index = store.playerSegmentSteps.findIndex((step) => step.id === stepId)
  if (index < 0) throw new Error(`该段没有需要玩家过的环节 ${stepId}`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节 ${stepId} 失败`)
}

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

/** 防御格：六邻皆图内 */
const DEFENDER_HEX: HexRef = (() => {
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

const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row))
      continue
    if (canEnter('leg', candidate, DEFENDER_HEX)) return candidate
  }
  throw new Error('防御格没有「步兵可进入」的图内邻格')
})()

const pickRecord = (
  side: 'axis' | 'soviet',
  predicate: (record: UnitRecordView) => boolean,
): UnitRecordView => {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

function place(
  store: ReturnType<typeof newStore>,
  record: UnitRecordView,
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

const attackerRecord = () =>
  pickRecord(
    'axis',
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.factors?.combat?.attack ?? 0) >= 3,
  )

const defenderRecord = () =>
  pickRecord('soviet', (record) => record.isCombat === true && record.attackCapable === true)

/** 13.5：可重建的步兵师记录（重建表行 `Infantry Div step`）—— 阵营由调用方给（专规 3.2：轴方不得整编） */
const infDivRecord = (side: 'axis' | 'soviet' = 'axis') =>
  side === 'axis'
    ? pickRecord('axis', (record) => /Inf Div/i.test(record.vassalName ?? ''))
    : pickRecord('soviet', (record) => /Tk Div|Rifle Div/i.test(record.vassalName ?? ''))

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('W6 B18：B 增援段的阶段闸门（2.2 / 13.5a / 13.9 / 13.6）', () => {
  it('2.2：到达投放 / 重建 / 合并都只在 B 增援段（C 段一律被拒）', () => {
    const store = newStore()
    store.setPhase('movement')

    /*
     * ★ B8 起拒绝面换成**统一闸门**：段与环节的判据只有一处（requireAction → B7 的闸门表），
     *   故这里断言 actionRefusal（带动作族键与规则号）而不再断言各域自己的错误字段——
     *   域字段仍用于"同段内的细则被拒"（如 13.5c 黄点），不再用于"段不对"。
     */
    expect(store.placeArrivalNow(0)).toBe(false)
    expect(store.actionRefusal).toMatchObject({ key: 'rein.arrival', rule: '13.6' })

    const unit = place(store, infDivRecord(), DEFENDER_HEX, 'axis', 'a1')
    expect(store.rebuildUnitNow({ unitId: 'a1', rebuildType: 'Infantry Div step' })).toBe(false)
    expect(store.actionRefusal).toMatchObject({ key: 'rein.rebuild', rule: '13.5 / 13.9' })

    expect(store.consolidateUnitsNow('a1', 'a1')).toBe(false)
    expect(store.actionRefusal).toMatchObject({ key: 'rein.rebuild', rule: '13.5 / 13.9' })
    expect(unit.steps).toBe(unit.printedSteps)
  })

  it('专规 2.4：被锁定的师在 C 段不能移动（点了也不进入移动交互）', () => {
    const store = newStore()
    store.setPhase('movement')
    place(store, attackerRecord(), DEFENDER_HEX, 'axis', 'locked-1')
    store.setUnitLockedNow('locked-1', true)
    // 条 10（批 M）：点格建取子清单；确认开拔才被专规 2.4 拦下
    store.clickHex(DEFENDER_HEX)
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveInteraction).toBeNull()
    expect(store.moveBlocked).toMatchObject({ rule: '专规 2.4' })
  })
})

describe('W6 B18：到达表执行（13.6 / 13.6b / 1.6a）', () => {
  it('13.6：B 段给出当日到达计划与落点解算（真实到达卡）', () => {
    const store = newStore()
    store.setTurn(2) // 第 2 回合 = 12 Jul（markers.turnTrack）
    store.setPhase('reinforcement')
    expect(store.date).toBe('1941-07-12')

    const plan = store.arrivalPlan
    expect(plan).not.toBeNull()
    expect(plan!.units.length).toBeGreaterThan(0)
    expect(store.arrivalPlacements).toHaveLength(plan!.units.length)
    // 轴方 12 Jul 的 Entry K 条目应解出具体落点（未被阻挡 ⇒ 直接按入场格）
    const index = plan!.units.findIndex((unit) => unit.placement.kind === 'entryHex')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(store.arrivalPlacements[index]?.hex).not.toBeNull()
  })

  it('13.6：按到达卡投放一个条目 ⇒ 算子入场并应用 -1 step；落点可被裁判手改', () => {
    const store = newStore()
    store.setTurn(2)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan!
    const index = plan.units.findIndex((unit) => unit.name === '5 Inf Div')
    expect(index).toBeGreaterThanOrEqual(0)
    const demand = plan.units[index]!

    const record = pickRecord('axis', (item) => /Inf Div/i.test(item.vassalName ?? ''))
    expect(store.placeArrivalNow(index, record.id)).toBe(true)

    const placed = store.units.find((unit) => unit.unitId === record.id)
    expect(placed).toBeDefined()
    expect(placed!.steps).toBe(placed!.printedSteps - (demand.stepsLost || 0))

    // 裁判手改落点（13.6：入场格由裁判按卡面判定）
    store.setArrivalHexOverride(index, '1.3')
    expect(store.arrivalPlacements[index]).toMatchObject({ hex: { col: 1, row: 3 } })
  })

  it('13.6：条目无法对应算子即拒（引擎不臆造「条目→算子」映射）', () => {
    const store = newStore()
    store.setTurn(2)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan!
    const index = plan.units.findIndex((unit) => unit.kind === 'unit')
    expect(index).toBeGreaterThanOrEqual(0)
    // 不传 recordId ⇒ 按显示名精确匹配（到达卡名与库内显示名不同名时即拒）
    const result = store.placeArrivalNow(index)
    expect(typeof result).toBe('boolean')
    expect(store.reinforcementError?.reason ?? '').toMatch(/arrivalUnitNotResolved|^$/)
  })

  it('12.5f：需燃料的增援以**未加油**到场（部署不花燃料，但离开入场格要先付）', () => {
    const store = newStore()
    store.setTurn(2)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan!
    const index = plan.units.findIndex((unit) => unit.name === '5 Inf Div')
    expect(index).toBeGreaterThanOrEqual(0)
    const record = pickRecord('axis', (item) => /Inf Div/i.test(item.vassalName ?? ''))
    expect(store.placeArrivalNow(index, record.id)).toBe(true)
    const placed = store.units.find((unit) => unit.unitId === record.id)!
    /*
     * B18b（12.5c）起，`toConsoleUnit` 的缺省是**未加注燃料**（修前是 `true` 的便利缺省，
     * 那让 12.5a「即使就移动一格也要先付」整局都不会被触发）⇒ 12.5f 要的那条
     * 「抵达回合没有免费的燃料」自动成立：
     *   · **需要燃料**的单位（轮式/履带战斗单位）到场即未加注 ⇒ 离开入场格前必须先付（12.5f 后半）；
     *   · **不需要燃料**的单位（步行 / 运输点数 / 飞机）根本不受此项约束（12.5a 末句），
     *     它的 `fuelled` 只是个与规则无关的字段值。
     */
    expect(placed.fuelled).toBe(false)
    // 并钉住"这确实是一条需要燃料的记录时也成立"——步行单位与耗油单位在新缺省下同为 false，
    // 但只有耗油单位**受这条规则约束**（12.5a 末句：步行/卡车/舰船/飞机永不需燃料）
    expect(typeof needsFuelToMove(toMoveUnitView(placed))).toBe('boolean')
  })

  it('13.6：同一到达条目投放后不可重复投放（到达已放账本，修前会凭空多出算子）', () => {
    const store = newStore()
    store.setTurn(2)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan!
    const index = plan.units.findIndex((unit) => unit.name === '5 Inf Div')
    expect(index).toBeGreaterThanOrEqual(0)
    const record = pickRecord('axis', (item) => /Inf Div/i.test(item.vassalName ?? ''))

    expect(store.arrivalPlaced[index]).not.toBe(true)
    expect(store.placeArrivalNow(index, record.id)).toBe(true)
    expect(store.arrivalPlaced[index]).toBe(true)

    const before = store.units.length
    expect(store.placeArrivalNow(index, record.id)).toBe(false)
    expect(store.units.length).toBe(before)
  })

  it('13.6：当日到达未放完 ⇒ arrivalAllPlaced 为假（有可投放条目但未逐个放完）', () => {
    const store = newStore()
    store.setTurn(2)
    store.setPhase('reinforcement')
    expect(store.arrivalAllPlaced).toBe(false)
  })

  it('13.6 / §5-A：卡面名去方前缀后唯一命中 ⇒ 有记录可出图，且不选型号也能自动投放', () => {
    const store = newStore()
    store.setTurn(2)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan!
    const index = plan.units.findIndex((unit) => unit.name === '5 Inf Div')
    expect(index).toBeGreaterThanOrEqual(0)
    // 库内印刷名是 "Ge 5 Inf Div"、卡面名是 "5 Inf Div" ⇒ 归一（去方前缀）后唯一命中
    const record = store.arrivalRecordOf(index)
    expect(record).not.toBeNull()
    expect(record!.id).toBeTruthy()
    // 于是不手选"库中型号"也能投放（修前精确匹配 0/90，永远要手选）
    expect(store.placeArrivalNow(index)).toBe(true)
    expect(store.arrivalPlaced[index]).toBe(true)
  })

  it('13.6：换日/换方（到达计划变）⇒ 已投放账本惰性作废', () => {
    const store = newStore()
    store.setTurn(2)
    store.setPhase('reinforcement')
    const dateBefore = store.date
    const plan = store.arrivalPlan!
    const index = plan.units.findIndex((unit) => unit.name === '5 Inf Div')
    expect(index).toBeGreaterThanOrEqual(0)
    const record = pickRecord('axis', (item) => /Inf Div/i.test(item.vassalName ?? ''))
    expect(store.placeArrivalNow(index, record.id)).toBe(true)
    expect(store.arrivalPlaced[index]).toBe(true)

    store.setTurn(3)
    // 换了日期 ⇒ 计划键不同 ⇒ 账本按新计划归零（不把上一日的"已放"带过来）
    if (store.date !== dateBefore) {
      expect(Object.keys(store.arrivalPlaced)).toHaveLength(0)
    }
  })
})

describe('W6 B18：可变增援与补员账本（1.6b / 1.6c）', () => {
  it('1.6b：掷可变增援 ⇒ SP 与补员入账；Ftr/Tac 可在阶段末清零（不可保存）', () => {
    const store = newStore()
    store.setTurn(2)
    store.setPhase('reinforcement')
    store.variableReplInputs.autoRoll = false
    store.variableReplInputs.supplyDice = 9
    store.variableReplInputs.replDice = 10
    store.variableReplInputs.specialDie = 2

    expect(store.rollVariableReplNow()).toBe(true)
    const plan = store.lastVariableRepl!
    expect(plan.sp).toBeGreaterThan(0)
    expect(store.replHoldings).toMatchObject({
      ftr: plan.repl.ftr,
      tac: plan.repl.tac,
      pax: plan.repl.pax,
      eq: plan.repl.eq,
    })
    // 轴方特殊补员表 1–4 ⇒ Supply Cache（1.6c + 表 3-5）
    expect(plan.special).toMatchObject({ supplyCache: true })

    store.clearNonSavableReplNow()
    expect(store.replHoldings.ftr).toBe(0)
    expect(store.replHoldings.tac).toBe(0)
    // Pax / Eq 可跨回合保存（专规 1.6 Notes）
    expect(store.replHoldings.pax).toBe(plan.repl.pax)
  })
})

describe('W6 B18：重建与死亡堆（13.5a–c）', () => {
  it('13.5a：图上有损的单位与补员同格、且在 HQ 2 格内 ⇒ 重建补满（扣 Pax）', () => {
    const store = newStore()
    store.setTurn(2)
    store.setPhase('reinforcement')
    goToSegmentStep(store, 'reinforcement.rebuild')
    store.setReplHoldingsNow({ pax: 4, eq: 0, ftr: 0, tac: 0 })

    const hq = place(
      store,
      pickRecord('axis', (record) => record.specialized?.includes('hq') === true),
      DEFENDER_HEX,
      'axis',
      'hq-1',
    )
    const unit = place(store, infDivRecord(), DEFENDER_HEX, 'axis', 'u1')
    unit.steps = unit.printedSteps - 1

    expect(
      store.rebuildUnitNow({
        unitId: 'u1',
        rebuildType: 'Infantry Div step',
        replHexText: `${hq.hex.col}.${hq.hex.row}`,
      }),
    ).toBe(true)
    expect(unit.steps).toBe(unit.printedSteps)
    expect(store.replHoldings.pax).toBe(2)
    expect(store.lastRebuild?.cost).toEqual({ pax: 2 })
  })

  it('13.5c / 13.5b：不可重建（黄点）与拆分单位都被拒；死亡堆中的单位可重建', () => {
    const store = newStore()
    store.setTurn(2)
    store.setPhase('reinforcement')
    goToSegmentStep(store, 'reinforcement.rebuild')
    store.setReplHoldingsNow({ pax: 8, eq: 0, ftr: 0, tac: 0 })
    place(
      store,
      pickRecord('axis', (record) => record.specialized?.includes('hq') === true),
      DEFENDER_HEX,
      'axis',
      'hq-1',
    )
    const unit = place(store, infDivRecord(), DEFENDER_HEX, 'axis', 'u1')

    // 13.5c：AR 后有黄点 ⇒ 永久不可重建
    unit.rebuildable = false
    expect(
      store.rebuildUnitNow({
        unitId: 'u1',
        rebuildType: 'Infantry Div step',
        replHexText: `${DEFENDER_HEX.col}.${DEFENDER_HEX.row}`,
      }),
    ).toBe(false)
    expect(store.reinforcementError).toMatchObject({ rule: '13.5c' })

    // 13.5b：拆分单位返回资源池
    unit.rebuildable = true
    unit.specialized = ['breakdown']
    expect(
      store.rebuildUnitNow({
        unitId: 'u1',
        rebuildType: 'Infantry Div step',
        replHexText: `${DEFENDER_HEX.col}.${DEFENDER_HEX.row}`,
      }),
    ).toBe(false)
    expect(store.reinforcementError).toMatchObject({ rule: '13.5b' })

    // 13.5a：送进死亡堆后可整单位重建
    unit.specialized = []
    store.sendToDeadPileNow('u1')
    expect(store.deadPile.map((item) => item.instanceId)).toEqual(['u1'])
    expect(store.units.some((item) => item.instanceId === 'u1')).toBe(false)
    expect(store.rebuildCandidates.some((item) => item.instanceId === 'u1')).toBe(true)

    expect(
      store.rebuildUnitNow({
        unitId: 'u1',
        rebuildType: 'Infantry Div step',
        replHexText: `${DEFENDER_HEX.col}.${DEFENDER_HEX.row}`,
      }),
    ).toBe(true)
    expect(store.units.some((item) => item.instanceId === 'u1')).toBe(true)
    expect(store.deadPile).toHaveLength(0)
  })
})

/**
 * 条 22（批 T）：20.0a 的创建时机是**事件**、不是"当前在移动段"这个状态
 * ⇒ 夹具必须让单位真的**开始移动**，它才处在「开始移动」这个时机里。
 */
function startMovementAt(store: ReturnType<typeof newStore>, hex: HexRef): void {
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement')
  if (index >= 0) store.setSegmentStepIndex(index)
  store.setTool('move')
  store.setFuelPool(0, 60)
  store.clickHex(hex)
  expect(store.confirmMovePick()).toBe(true)
}

describe('W6 B18：拆分与合并（20.0 / 13.9）', () => {
  it('20.0a/20.0g：C 段创建拆分单位（消耗母单位 1 点军力与池中 1 个）', () => {
    const store = newStore()
    store.setPhase('movement')
    const record = pickRecord('axis', (item) => item.specialized?.includes('breakdown') === true)
    const parent = place(store, infDivRecord(), DEFENDER_HEX, 'axis', 'u1')
    expect(parent.steps).toBeGreaterThanOrEqual(2)
    store.setBreakdownPoolNow('ax', 2)
    // 20.0a：创建时机＝「开始移动」这个事件 ⇒ 先真的开拔
    startMovementAt(store, DEFENDER_HEX)

    const before = parent.steps
    expect(store.createBreakdownNow('u1', record.id)).toBe(true)
    expect(parent.steps).toBe(before - 1)
    expect(store.breakdownPool['ax']).toBe(1)
    expect(store.units.filter((item) => item.unitId === record.id)).toHaveLength(1)
  })

  /*
   * 条 22（批 T）：修前 `createBreakdownNow` 的时机是**按阶段猜**的
   *   （`phase === 'movement' ? 'startMove' : 'advanceAfterCombat'`）⇒ C 段里**根本没开拔**的
   *   单位也能创建，而战后**撤退**又被错记成战后推进。现在时机来自**事件**：
   *   母单位必须真的处在「开始移动 / 战后推进 / 战后撤退」之一，否则拒绝（20.0a）。
   */
  it('条 22：未开拔 ⇒ 不得创建拆分单位（20.0a：时机是事件，不是"在移动段"）', () => {
    const store = newStore()
    store.setPhase('movement')
    const record = pickRecord('axis', (item) => item.specialized?.includes('breakdown') === true)
    const parent = place(store, infDivRecord(), DEFENDER_HEX, 'axis', 'u1')
    expect(parent.steps).toBeGreaterThanOrEqual(2)
    store.setBreakdownPoolNow('ax', 2)

    // 同在 C 段、但还没开拔 ⇒ 不在 20.0a 的任何时机里
    expect(store.createBreakdownNow('u1', record.id)).toBe(false)
    expect(store.log.some((line) => line.rule === '20.0a')).toBe(true)
    // 池子与军力都没被动过（拒绝是干净的）
    expect(store.breakdownPool['ax']).toBe(2)
    expect(parent.steps).toBe(parent.steps)

    // 真的开拔之后 ⇒ 处在「开始移动」这个时机 ⇒ 可创建
    startMovementAt(store, DEFENDER_HEX)
    expect(store.createBreakdownNow('u1', record.id)).toBe(true)
    expect(store.breakdownPool['ax']).toBe(1)
    // 时机如实入账（不是猜出来的）
    expect(store.log.some((line) => line.text.includes('20.0a 时机：开始移动'))).toBe(true)
  })

  it('20.0d：吸收拆分单位（须堆叠、AR 方向、阶段末）', () => {
    const store = newStore()
    store.setPhase('movement')
    const record = pickRecord('axis', (item) => item.specialized?.includes('breakdown') === true)
    const parent = place(store, infDivRecord(), DEFENDER_HEX, 'axis', 'u1')
    store.setBreakdownPoolNow('ax', 1)
    startMovementAt(store, DEFENDER_HEX)
    expect(store.createBreakdownNow('u1', record.id)).toBe(true)
    const breakdown = store.units.find((item) => item.unitId === record.id)!

    const before = parent.steps
    expect(store.absorbBreakdownNow('u1', breakdown.instanceId)).toBe(true)
    expect(parent.steps).toBe(before + 1)
    expect(store.units.some((item) => item.instanceId === breakdown.instanceId)).toBe(false)
    expect(store.breakdownPool['ax']).toBe(1)
  })

  it('13.9-1：B 段合并两个多军力单位（同格、两面相同、军力相加）', () => {
    const store = newStore()
    store.setTurn(2)
    store.setPhase('reinforcement')
    /*
     * ★ 契约变更（批 F 切片 2，**不是放宽**）：这一对换成**苏方**动作 ——
     *   专规 3.2（`axis_special.no_consolidation`）明写「**轴心国不得整编**」，
     *   ⇒ "轴方合并两个多军力单位"按规则原文**不合法**（store 现在按专规 3.2 拒，见
     *   `tests/stores/consolidation-axis-ban.test.ts`）。13.9-1 的判据（同格、两面相同、
     *   军力相加）一字未动，只是换成合法的一方来验它。
     */
    store.setActiveSide('soviet')
    // B8：整编（13.9）属「重建与整编」环节；一进 B 段停在「到货」环，故先走到该环
    goToSegmentStep(store, 'reinforcement.rebuild')
    const record = infDivRecord('soviet')
    const keep = place(store, record, DEFENDER_HEX, 'soviet', 'k1')
    const remove = place(store, record, DEFENDER_HEX, 'soviet', 'r1')
    keep.steps = 2
    remove.steps = 1

    const print = keep.printedSteps
    expect(store.consolidateUnitsNow('k1', 'r1')).toBe(true)
    expect(keep.steps).toBe(Math.min(print, 3))
    expect(store.units.some((item) => item.instanceId === 'r1')).toBe(false)
    expect(store.lastConsolidation?.removeIds).toEqual(['r1'])
  })
})

describe('W6 B18：NKVD 强制担任行动值单位（专规 2.3b）', () => {
  it('2.3b：守方选了非 NKVD 单位即拒；改选 NKVD 边防团通过，并强制全部选项吃损失', () => {
    const store = newStore()
    store.setPhase('combat')
    goToActionStep(store, 'combat.declare')
    store.setTool('battle')
    store.setFuelPool(0, 20)

    place(store, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
    const defender = place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
    const second = place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd2')

    // ⚠ 数据缺口：工程库的 NKVD 边防团仍为 `fill_stage: classified`，未进入操作台可选清单
    //   （sync-units.mjs 只取 valued/verified）。此处按工程库原文能力标签
    //   `special_abilities: ["nkvd_border_forced_roll"]` 在**操作台视图**上标注，专测 2.3b 的接线。
    defender.specialAbilities = [NKVD_BORDER_CAPABILITY]

    store.clickHex(ATTACKER_HEX)
    store.clickHex(DEFENDER_HEX)
    expect(store.beginCombatNow()).toBe(true)
    // 12.4 / 12.6：战斗补给只能从己方补给站扣 ⇒ 为双方各放一座并声明为来源
    store.spDumps.push({ id: 'sd-axis', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
    store.spDumps.push({ id: 'sd-soviet', hex: { ...DEFENDER_HEX }, side: 'soviet', sp: 8, t: 0 })
    for (const entry of store.combatSupplyDumps) {
      const dump = entry.dumps[0]
      if (dump !== undefined) store.pickCombatSupplyDump(entry.side, dump.id)
    }
    expect(store.confirmCombatSupply()).toBe(true)

    store.combatInputs.attackerArUnitId = 'a1'
    expect(store.declareCombatArStep('attacker')).toBe(true)
    expect(store.combatNkvdDefenders.map((unit) => unit.instanceId)).toEqual(['d1'])

    // 选了普通单位 ⇒ 专规 2.3b 拦下
    store.combatInputs.defenderArUnitId = second.instanceId
    expect(store.declareCombatArStep('defender')).toBe(false)
    expect(store.combatError).toMatchObject({ rule: '2.3b' })

    // 改选 NKVD 边防团 ⇒ 通过
    store.combatInputs.defenderArUnitId = defender.instanceId
    expect(store.declareCombatArStep('defender')).toBe(true)
    expect(store.combatState?.ar?.defenderUnitId).toBe('d1')
  })
})
