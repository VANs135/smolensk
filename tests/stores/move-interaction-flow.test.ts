import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { areAdjacent, neighbor } from '@/engine/hex-geometry'
import { inEnemyZocAt } from '@/engine/rules'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

/**
 * C5 移动交互的**端到端流程**（store 级）
 *
 * 覆盖用户要求的交互流：选单位/堆叠 → 显示可移动范围 → 点格逐格移动（每格重算范围）
 * → 结束移动；以及路径与消耗预览、模式切换、进入敌方 ZOC 的确认、燃料支付、撤销。
 *
 * 用**真实地图与真实单位库**（不造数）：结论全部来自引擎，故断言的是「流程走通 + 状态写对」。
 */

const START: HexRef = { col: 36, row: 13 }

function newStore() {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 取一个满足条件的单位库记录（找不到即测试失败，避免静默用错夹具） */
function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

/** 摆一个算子并返回它（`face`＝初始朝向：5.0 战斗面 / 移动面，3.1a 机动类型随之而变） */
function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
  face: 'combat' | 'move' = 'combat',
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side, face })
  store.units.push(unit)
  return unit
}

const legCombat = () =>
  pickRecord(
    'axis',
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )

/**
 * 12.5a / 4.5a-A 的"轮式"对象：**朝移动面**的摩托化战斗单位
 *
 * 2026-09-17 用户裁定「摩托化单位战斗面徒步、移动面轮式」⇒ 轴方**已没有战斗面轮式**的战斗单位
 * （`su-*` 的 5 条摩托车团/4 条摩托化师虽两面轮式，但本组夹具要轴方）。所以判据必须落在
 * **朝向面**（3.1a 逐面）：`mobilityByFace.move === 'truck'`，并把它摆成移动面朝向 —— 这正是
 * 12.5a「轮式 MP」与 4.5a-A「轮式进 EZOC」真正发生的场合（摩托化单位在移动态）。
 */
const wheeledMover = () =>
  pickRecord(
    'axis',
    (record) =>
      record.mobilityByFace?.move === 'truck' &&
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.noncombatKind ?? null) === null &&
      /*
       * B40（12.5c-B / 12.5e + 3.2f）：本组有几条用例要走**HQ 法**，而 HQ 法只覆盖**独立单位**
       * ——「任何既不属于多单位编队 (3.1c) 也不属于多军力单位 (3.2d) 的单位都是『独立单位』」。
       * 故夹具取"既无编队、又单军力"的那一枚（编队归属由**数据**定死，见 `units-*.json` 的
       * `formation`；多军力单位看印值军力 `steps.total`）。
       */
      (record.formation ?? null) === null &&
      (record.steps?.total ?? 1) <= 1,
  )

/** 摆一个朝**移动面**的轮式战斗单位（12.5a 的付款对象 / 4.5a-A 的对象） */
const placeWheeled = (
  store: ReturnType<typeof newStore>,
  side: 'axis' | 'soviet' = 'axis',
  instanceId = 'a1',
): ConsoleUnit => place(store, wheeledMover(), START, side, instanceId, 'move')

/**
 * 12.5c-A 的对象：**编队单位**（数据里带 `formation`）
 *
 * 用户 2026-09-17：「**编队单位**有额外的编队加油法」⇒ 编队法只对多单位编队（3.1c）成立；
 * 独立单位走编队法会被引擎的 `fuelMethodAvailability` 拒掉（本组前身正是拿独立单位硬测编队法）。
 */
const placeFormationMover = (
  store: ReturnType<typeof newStore>,
  side: 'axis' | 'soviet' = 'axis',
  instanceId = 'a1',
): ConsoleUnit => {
  const record = pickRecord(
    side,
    (item) =>
      typeof item.formation === 'string' &&
      item.isCombat === true &&
      (item.noncombatKind ?? null) === null,
  )
  const unit = place(store, record, START, side, instanceId, 'move')
  store.setUnitFuelled(unit.instanceId, false)
  return unit
}

/**
 * 12.5c-B 的对象：**指挥部自己**
 *
 * 用户 2026-09-17：「**点击 HQ 时才能加 HQ 法**，因为 HQ 要移动本身也要按自身属性和规则来判断」
 * ⇒ HQ 法的受益单位里必须有指挥部（它才是付款与投递的主体）。
 */
const placeHqMover = (
  store: ReturnType<typeof newStore>,
  side: 'axis' | 'soviet' = 'axis',
  instanceId = 'a1',
): ConsoleUnit => {
  const record = pickRecord(side, (item) => (item.specialized ?? []).includes('hq'))
  const unit = place(store, record, START, side, instanceId, 'move')
  store.setUnitFuelled(unit.instanceId, false)
  return unit
}

/** 3.4b：编队单位带 `panzerGroup` 时，付款站须声明**同一归属**（否则付款先被 3.4b 拦下） */
function declareDumpGroup(
  store: ReturnType<typeof newStore>,
  dumpId: string,
  unit: ConsoleUnit,
): void {
  const group = store.groupOfUnit(unit)
  if (group !== null) store.setDumpPanzerGroupNow(dumpId, group)
}

/** 敌方 ZOC 源：需战斗模式 + 可攻击 + 非断补（4.5 投射 ZOC 的判据） */
const zocSource = () => pickRecord('soviet', (record) => record.attackCapable === true)

/**
 * 12.3a：声明一座**该方**的补给站并点选为燃料付款来源
 *
 * 12.3a/12.3b 是仅有的取补途径（用户裁定：补给只能从己方补给站扣）⇒ 燃料付款**必须**有来源；
 * 该站同时也是断言的锚点（账本真的动了才说明付了）。
 *
 * ★ 3.4b 联动：若受益单位属某装甲集群（本夹具体例里那支摩托化团就属），
 *   这座站的 SP 必须声明**同一归属**，否则「错误集群的 SP 不得付燃油」会把它拒掉——
 *   这正是 3.4b 生效的样子，故夹具照做，而不是把规则关掉。
 */
function withFuelDump(
  store: ReturnType<typeof newStore>,
  side: 'axis' | 'soviet',
  input: { sp?: number; t?: number } = {},
): string {
  const id = `fuel-${side}-${store.spDumps.length}`
  store.spDumps.push({ id, hex: START, side, sp: input.sp ?? 0, t: input.t ?? 0 })
  expect(store.pickFuelDump(id)).toBe(true)
  const beneficiary = store.units.find((unit) => unit.side === side) ?? null
  const group = beneficiary === null ? null : store.groupOfUnit(beneficiary)
  if (group !== null) store.setDumpPanzerGroupNow(id, group)
  return id
}

/**
 * 该站**当前**的持仓（★ 必须现读：`setSpDumpHoldings` 是**替换数组**的，
 * 付款前拿到的对象引用在付款后就是旧的）
 */
function holdingsOf(store: ReturnType<typeof newStore>, dumpId: string) {
  const dump = store.spDumps.find((item) => item.id === dumpId)
  if (dump === undefined) throw new Error(`补给站 ${dumpId} 不存在`)
  return { sp: dump.sp, t: dump.t }
}

describe('C5 选子 → 范围 → 逐格 → 结束', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  it('选中己方算子后开始移动并给出可到达范围（6.1）', () => {
    const unit = place(store, legCombat(), START, 'axis', 'a1')
    expect(store.moveInteraction).toBeNull()

    // 条 10（批 M）裁定变更：点格只建取子清单，开拔交由「开始移动」按钮
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)

    expect(store.moveInteraction).not.toBeNull()
    expect(store.moveInteraction!.unitIds).toEqual([unit.instanceId])
    expect(store.moveInteraction!.start).toEqual(START)
    expect(store.groupReachable.units[0]!.ok).toBe(true)
    expect(store.groupReachable.hexes.length).toBeGreaterThan(0)
    // 起点自身不算可到达格
    expect(store.groupReachable.hexes.some((node) => same(node.hex, START))).toBe(false)
  })

  it('点范围内的格逐格移动，且每格之后范围按新位置重算', () => {
    const unit = place(store, legCombat(), START, 'axis', 'a1')
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)
    const first = adjacentReachable(store, START)
    expect(first).toBeDefined()

    const before = store.groupReachable.hexes.length
    store.clickHex(first!.hex)

    // 位置与 MP 都落到单位上
    expect(unit.hex).toEqual(first!.hex)
    expect(unit.mpSpent).toBeCloseTo(first!.mpSpent, 6)
    // 一步一格：历史里只有一步
    expect(store.moveInteraction!.steps).toHaveLength(1)
    // 范围重算：新位置自身不再是可到达格
    const after = store.groupReachable.hexes
    expect(after.some((node) => same(node.hex, first!.hex))).toBe(false)
    expect(before).toBeGreaterThan(0)
  })

  it('点远处的可达格 = 沿预览路径逐格走过去（6.1）', () => {
    const unit = place(store, legCombat(), START, 'axis', 'a1')
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)
    // 取一个需要多步的格
    const far = store.groupReachable.hexes.find((node) => node.path.length >= 3)
    expect(far).toBeDefined()

    store.clickHex(far!.hex)

    expect(unit.hex).toEqual(far!.hex)
    expect(unit.mpSpent).toBeCloseTo(far!.mpSpent, 6)
    // 逐格提交：步数 = 路径格数 - 1
    expect(store.moveInteraction!.steps).toHaveLength(far!.path.length - 1)
    // 每一格的落点都与路径一致
    expect(store.moveInteraction!.steps.map((step) => step.to)).toEqual(far!.path.slice(1))
  })

  it('「结束移动」把单位就地停下，且结束后仍可撤销（6.1 / 6.1g）', () => {
    const unit = place(store, legCombat(), START, 'axis', 'a1')
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)
    const node = adjacentReachable(store, START)!
    store.clickHex(node.hex)
    const hexAfterStep = { ...unit.hex }

    store.finishMove()
    expect(unit.movementEnded).toBe(true)
    expect(store.activeMoveUnits).toHaveLength(0)
    expect(store.moveInteraction!.finished).toBe(true)

    store.undoLastStep()
    expect(unit.hex).toEqual(hexAfterStep)
    expect(unit.movementEnded).toBe(false)
  })

  it('撤销一步还原位置与已耗 MP；取消整次移动还原到起点', () => {
    const unit = place(store, legCombat(), START, 'axis', 'a1')
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)
    const node = adjacentReachable(store, START)!
    store.clickHex(node.hex)
    const spent = unit.mpSpent
    expect(spent).toBeGreaterThan(0)

    store.undoLastStep()
    expect(unit.hex).toEqual(START)
    expect(unit.mpSpent).toBe(0)

    // 再沿多步路径走一次，然后整体取消
    const step1 = adjacentReachable(store, START)!
    store.clickHex(step1.hex)
    const step2 = store.groupReachable.hexes.find((item) => item.mpSpent > step1.mpSpent)!
    store.clickHex(step2.hex)
    expect(store.moveInteraction!.steps.length).toBeGreaterThanOrEqual(2)

    store.cancelWholeMove()
    expect(unit.hex).toEqual(START)
    expect(unit.mpSpent).toBe(0)
    expect(store.moveInteraction!.steps).toHaveLength(0)
  })

  it('整堆叠选择：同格两个单位一起移动（6.1 / 6.1e）', () => {
    const a = place(store, legCombat(), START, 'axis', 'a1')
    const b = place(store, legCombat(), START, 'axis', 'a2')
    store.setStackSelect(true)
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)

    expect(store.moveInteraction!.unitIds.sort()).toEqual([a.instanceId, b.instanceId].sort())
    const node = store.groupReachable.hexes.find((item) => item.mpSpent > 0)!
    store.clickHex(node.hex)
    expect(a.hex).toEqual(node.hex)
    expect(b.hex).toEqual(node.hex)
    expect(store.lastStep!.movedNames).toHaveLength(2)
  })

  it('悬停格给出路径与消耗预览；相邻格另给单步明细（6.1a / 6.2）', () => {
    place(store, legCombat(), START, 'axis', 'a1')
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)

    // 远处的格：给出「路径 + 累计 MP」，单步明细对不相邻的格不适用
    const far = store.groupReachable.hexes.find((item) => item.mpSpent > 1)!
    store.setHoverHex(far.hex)
    expect(store.hoverNode).not.toBeNull()
    expect(store.hoverNode!.path[0]).toEqual(START)
    expect(store.hoverNode!.path.at(-1)).toEqual(far.hex)
    expect(store.hoverNode!.path.length).toBe(far.path.length)
    expect(store.stepPreview!.ok).toBe(false) // 一步走不到 → 不是合法的「单步」

    // 相邻的格：单步明细可用，且总消耗 = 该格的累计 MP
    const near = store.groupReachable.hexes.find((item) => areAdjacent(START, item.hex))!
    store.setHoverHex(near.hex)
    expect(store.stepPreview!.ok).toBe(true)
    expect(store.stepPreview!.moving[0]!.cost).toBeCloseTo(near.mpSpent, 6)

    // 悬停不可到达的格 ⇒ 无预览（且不会误报）
    store.setHoverHex({ col: 1, row: 0 })
    expect(store.hoverNode).toBeNull()
    expect(store.stepPreview).toBeNull()
  })
})

describe('C5 进入敌方控制区的确认（4.5a-A）', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  it('轮式单位进入未抵消敌方 ZOC：先弹确认，确认后就地停止', () => {
    const truck = placeWheeled(store, 'axis', 'a1')
    // B18b（12.5c）：`toConsoleUnit` 的缺省已改为「**未加注**燃料」（12.5a 会拦住一切移动），
    // 而本用例考察的是 4.5a-A 的 ZOC 确认 ⇒ 把燃料这一层**显式**摆好。
    // （要考察燃料自身的用例请自己写 `fuelled: false`，见 tests/stores/fuel-payment-chain.test.ts）
    truck.fuelled = true
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)
    // 取一个与起点相邻的可到达格（一步即到，便于只触发一次确认）
    const target = adjacentReachable(store, START)
    expect(target).toBeDefined()

    // 在目标格旁边的另一格里放一个敌方战斗单位 → 目标格落入敌方 ZOC
    const enemyHex = findFreeNeighborOf(store, target!.hex, truck.hex)
    expect(enemyHex).not.toBeNull()
    place(store, zocSource(), enemyHex!, 'soviet', 'e1')

    // 重新选子（让范围带上 ZOC 标记）
    store.clickHex(START)
    expect(store.groupReachable.hexes.find((node) => same(node.hex, target!.hex))!.inEnemyZoc).toBe(
      true,
    )

    store.clickHex(target!.hex)
    // 4.5a-A：必须确认，不能直接搬子
    expect(store.pendingZocConfirm).not.toBeNull()
    expect(truck.hex).toEqual(START)

    store.confirmZocEntry()
    expect(truck.hex).toEqual(target!.hex)
    expect(truck.movementEnded).toBe(true) // 进入后必须就地停止
    expect(store.pendingZocConfirm).toBeNull()
  })

  it('放弃确认则留在原格', () => {
    const truck = placeWheeled(store, 'axis', 'a1')
    truck.fuelled = true // B18b：同上——本用例考察 4.5a-A 的"放弃确认"，燃料显式摆好
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)
    const target = adjacentReachable(store, START)!
    const enemyHex = findFreeNeighborOf(store, target.hex, truck.hex)!
    place(store, zocSource(), enemyHex, 'soviet', 'e1')
    store.clickHex(START)
    store.clickHex(target.hex)

    expect(store.pendingZocConfirm).not.toBeNull()
    store.dismissZocConfirm()
    expect(store.pendingZocConfirm).toBeNull()
    expect(truck.hex).toEqual(START)
    expect(truck.movementEnded).toBe(false)
  })

  it('4.5b：许诺不再消耗 MP 后，其所在格的敌方 ZOC 被抵消', () => {
    const holder = place(store, legCombat(), START, 'axis', 'a1')
    // 敌方战斗单位紧邻 START ⇒ START 处于敌方 ZOC
    place(store, zocSource(), neighbor(START, 'NE'), 'soviet', 'e1')

    expect(inEnemyZocAt(store.moveContext, START, 'axis')).toBe(true)

    store.lockZocNegation(holder.instanceId)
    // 4.5b：代价是「之后不能再消耗 MP 直到当前阶段结束」
    expect(holder.mpLockedThisPhase).toBe(true)
    expect(inEnemyZocAt(store.moveContext, START, 'axis')).toBe(false)

    // 该承诺只对本阶段有效：换阶段即清除
    store.setPhase('reaction')
    expect(holder.mpLockedThisPhase).toBe(false)
  })

  it('4.5b：非战斗单位不能用于抵消 ZOC', () => {
    const nonCombat = place(
      store,
      pickRecord('axis', (record) => record.isCombat === false && record.attackCapable !== true),
      START,
      'axis',
      'a1',
    )
    store.lockZocNegation(nonCombat.instanceId)
    expect(nonCombat.mpLockedThisPhase).toBe(false)
  })
})

describe('C5 模式切换（5.4）与燃料支付（12.5）', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  it('未开始移动时可切换主动模式，且切换不消耗 MP', () => {
    const unit = place(store, legCombat(), START, 'axis', 'a1')
    store.clickHex(START)
    expect(unit.mode.mode).toBe('combat')

    store.switchUnitMode('move')
    expect(unit.mode.mode).toBe('move')
    expect(unit.mode.orientation).toBe('move')
    expect(unit.mpSpent).toBe(0)
    // 5.4a：印值随朝向刷新
    expect(unit.raw).toEqual(unit.faces.move)
  })

  it('已消耗 MP 之后不能切换模式（5.4 时机 + 6.1g）', () => {
    const unit = place(store, legCombat(), START, 'axis', 'a1')
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)
    const node = store.groupReachable.hexes.find((item) => item.mpSpent > 0)!
    store.clickHex(node.hex)

    store.switchUnitMode('reserve')
    expect(unit.mode.mode).not.toBe('reserve')
    expect(store.log[0]!.text).toContain('不能切换到')
  })

  it('12.5a/12.5c：未加注燃料的轮式战斗单位不能移动，付燃料后即可', () => {
    const truck = placeWheeled(store, 'axis', 'a1')
    store.setUnitFuelled(truck.instanceId, false)
    // 条 10：点格只建取子清单；确认开拔才触发 12.5a 拦下（beginMoveFor 写入 moveBlocked，清单保留供付油后重试）
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveInteraction).toBeNull()
    expect(store.moveBlocked).not.toBeNull()
    expect(store.moveBlocked!.rule).toBe('12.5a')

    // 12.3a：没有声明的补给站就付不出（原先走"演示池"，账本分文不动）
    expect(store.pickFuelDump(null)).toBe(true)
    store.payFuel('singleUnit', true)
    expect(truck.fuelled).toBe(false)

    // 12.5c-C：单单位法每单位 1T；T 不足 ⇒ 仍付不出
    const poor = withFuelDump(store, 'axis', { t: 0 })
    store.payFuel('singleUnit', true)
    expect(holdingsOf(store, poor).t).toBe(0)
    expect(truck.fuelled).toBe(false)

    // 够 1T 即付得出，且**从这座站扣**（账本真的动了）
    const rich = withFuelDump(store, 'axis', { t: 2 })
    store.payFuel('singleUnit', true)
    expect(truck.fuelled).toBe(true)
    expect(holdingsOf(store, rich).t).toBe(1)
    // 付完自动重试开始移动
    expect(store.moveInteraction).not.toBeNull()
    expect(store.groupReachable.hexes.length).toBeGreaterThan(0)
  })

  it('12.3a：付款站必须是**受益方自己**的补给站（用对手的站加油被拒）', () => {
    const truck = placeWheeled(store, 'axis', 'a1')
    store.setUnitFuelled(truck.instanceId, false)
    store.selectedId = truck.instanceId
    const enemyDump = withFuelDump(store, 'soviet', { t: 8 })
    store.payFuel('singleUnit', true)
    expect(truck.fuelled).toBe(false)
    expect(holdingsOf(store, enemyDump).t).toBe(8)
  })

  it('12.5c-A：编队法 1SP（未声明共用来源则拒绝）', () => {
    // 用户 2026-09-17：编队法只对**编队单位**成立（独立单位没有这一法）
    const truck = placeFormationMover(store, 'axis', 'a1')
    store.clickHex(START)
    const dump = withFuelDump(store, 'axis', { sp: 1 })
    declareDumpGroup(store, dump, truck)

    store.payFuel('formation', false)
    expect(truck.fuelled).toBe(false)

    store.payFuel('formation', true)
    expect(truck.fuelled).toBe(true)
    expect(holdingsOf(store, dump).sp).toBe(0)
  })
})

/* ──────────── 12.5c：加油方法的持续期（换阶段 vs 本方清理阶段） ──────────── */

/**
 * 三种加油法的**持续期**不同（12.5c），本组用例把两个时点都钉住：
 *   - 单单位法（12.5c-C）「只在当前阶段有效」⇒ 换阶段即失效；
 *   - 编队法 / HQ 法（12.5c-A/B）「持续到下一个友方清理阶段」⇒ 换阶段照样保留，H 段才摘（12.5d）。
 */
describe('12.5c：单单位法只本阶段 / 编队·HQ 法到本方清理阶段', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  /** 摆一个需要燃料的己方单位、取消其便利燃料、并选中它 */
  function fuelledTarget(instanceId = 'a1', side: 'axis' | 'soviet' = 'axis'): ConsoleUnit {
    const unit = placeWheeled(store, side, instanceId)
    store.setUnitFuelled(unit.instanceId, false)
    store.selectedId = unit.instanceId
    return unit
  }

  it('单单位法：换阶段即失效——移动段加的油到了下一段就没有了（12.5c-C）', () => {
    const truck = fuelledTarget()
    withFuelDump(store, 'axis', { t: 2 })
    store.payFuel('singleUnit', true)
    expect(truck.fuelled).toBe(true)
    expect(truck.fuelMethod).toBe('singleUnit')

    store.setPhase('supply')
    expect(truck.fuelled).toBe(false)
    expect(truck.fuelMethod).toBeNull()
  })

  it('12.5b 组合：移动段用单单位法加油 ⇒ 本段能走；进击段再动必须重新加油', () => {
    const truck = fuelledTarget()
    withFuelDump(store, 'axis', { t: 6 })
    store.payFuel('singleUnit', true)
    // 本段（移动）可用
    expect(store.moveInteraction).not.toBeNull()

    // 战斗后拿到进击标记 → 进击段：燃料已随换段失效，未加注
    store.setPhase('combat')
    truck.mode = { ...truck.mode, exploit: true }
    store.setPhase('exploitation')
    expect(truck.fuelled).toBe(false)

    // 点自己所在格尝试开拔 ⇒ 被 12.5a 拦下（突袭/移动都要燃料，12.5b）
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveInteraction).toBeNull()
    expect(store.moveBlocked?.rule).toBe('12.5a')

    // 重新加油后即可（12.5c 三法皆可）
    store.payFuel('singleUnit', true)
    expect(truck.fuelled).toBe(true)
    expect(store.moveInteraction).not.toBeNull()
  })

  it('编队法：换阶段照样保留，直到本方的 H 清理段才摘掉（12.5d）', () => {
    // 12.5c-A 的对象是**编队单位**（独立单位没有编队法）
    const truck = placeFormationMover(store)
    store.selectedId = truck.instanceId
    withFuelDump(store, 'axis', { sp: 2 })
    store.payFuel('formation', true)
    expect(truck.fuelled).toBe(true)
    expect(truck.fuelMethod).toBe('formation')

    for (const phase of ['reaction', 'combat', 'exploitation'] as const) {
      store.setPhase(phase)
      expect(truck.fuelled, `${phase} 段不该清掉编队法的燃料`).toBe(true)
    }

    store.setPhase('cleanUp')
    expect(store.runCleanUpNow()).toBe(true)
    expect(truck.fuelled).toBe(false)
    expect(truck.fuelMethod).toBeNull()
  })

  it('编队法可跨敌方回合保留：反应段为预备队加油 → 撑到本方回合的移动 / 进击段', () => {
    // 敌方（axis）回合的反应段：本方（soviet）的预备队在移动前用编队法加油
    store.setPhase('reaction')
    const unit = placeFormationMover(store, 'soviet', 'su-1')
    unit.mode = { mode: 'reserve', orientation: 'combat', dg: false, exploit: false }
    store.selectedId = unit.instanceId
    // ★ 12.3a：行动方此时是轴方，但油钱由**受益单位自己一方（苏军）**出
    const dump = withFuelDump(store, 'soviet', { sp: 3 })
    declareDumpGroup(store, dump, unit)
    store.payFuel('formation', true)
    expect(unit.fuelled).toBe(true)

    // 敌方回合走完 F/G/H —— H 段只清**阶段玩家（axis）**的燃料，苏军那份不受影响
    store.setPhase('combat')
    store.setPhase('exploitation')
    store.setPhase('cleanUp')
    expect(store.runCleanUpNow()).toBe(true)
    expect(unit.fuelled).toBe(true)

    // 换方进入本方（soviet）回合：移动段与进击段都仍有油（5.7b + 12.5c-A）
    store.switchSide()
    expect(store.activeSide).toBe('soviet')
    store.setPhase('movement')
    expect(unit.fuelled).toBe(true)
    store.setPhase('exploitation')
    expect(unit.fuelled).toBe(true)

    // 到**本方**的 H 清理段才摘掉
    store.setPhase('cleanUp')
    expect(store.runCleanUpNow()).toBe(true)
    expect(unit.fuelled).toBe(false)
  })

  it('HQ 法与编队法同持续期：换阶段保留', () => {
    // 用户 2026-09-17：「点击 HQ 时才能加 HQ 法」⇒ 受益单位里须有指挥部（本例即 HQ 自己）
    const truck = placeHqMover(store)
    store.selectedId = truck.instanceId
    const dump = withFuelDump(store, 'axis', { sp: 2 })
    declareDumpGroup(store, dump, truck)
    store.payFuel('hq', true)
    expect(truck.fuelMethod).toBe('hq')
    store.setPhase('exploitation')
    expect(truck.fuelled).toBe(true)
  })

  it('调试开关不计方法 ⇒ 按持续到清理阶段处理（不凭空多出「只本阶段」的语义）', () => {
    const truck = fuelledTarget()
    store.setUnitFuelled(truck.instanceId, true)
    expect(truck.fuelled).toBe(true)
    expect(truck.fuelMethod).toBeNull()
    store.setPhase('exploitation')
    expect(truck.fuelled).toBe(true)
  })
})

/* ──────────── C5：堆叠取子（6.1f / 8.1g / 8.1h） ──────────── */

describe('C5 点堆叠可分开选取（6.1f：想分别移动就不要整堆叠开拔）', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  /** 在同格摆两枚己方算子（都合格可动） */
  function placeStack(): ConsoleUnit[] {
    return [
      place(store, legCombat(), START, 'axis', 'a1'),
      place(store, legCombat(), START, 'axis', 'a2'),
    ]
  }

  it('点两枚堆叠 ⇒ 不立刻开拔，而是给出取子清单（默认勾最后一枚）', () => {
    const [first, second] = placeStack()
    store.clickHex(START)

    // 6.1f：开拔前先让玩家决定谁动，故此刻不应已开始移动
    expect(store.moveInteraction).toBeNull()
    expect(store.movePickHex).toEqual(START)
    expect(store.movePickChoices.map((unit) => unit.instanceId)).toEqual([
      first!.instanceId,
      second!.instanceId,
    ])
    expect(store.movePick!.ids).toEqual([second!.instanceId])
  })

  it('勾选两枚后确认 ⇒ 只有勾选者进入移动交互；未勾选者留在格内且不耗 MP（8.1h）', () => {
    const [first, second] = placeStack()
    store.clickHex(START)
    // 默认只勾了第二枚 ⇒ 再勾上第一枚
    store.toggleMovePick(first!.instanceId)
    expect(store.confirmMovePick()).toBe(true)

    expect(store.movePick).toBeNull()
    expect(store.moveInteraction!.unitIds).toEqual([first!.instanceId, second!.instanceId])
    expect(store.moveInteraction!.start).toEqual(START)
  })

  it('「只动这一枚」⇒ 同格另一枚完全不参与（位置与 MP 都不动）', () => {
    const [first, second] = placeStack()
    store.clickHex(START)
    store.setMovePickOnly(first!.instanceId)
    expect(store.confirmMovePick()).toBe(true)

    expect(store.moveInteraction!.unitIds).toEqual([first!.instanceId])
    // 走一步：只有被选中的那枚移动
    const node = store.groupReachable.hexes.find((item) => areAdjacent(START, item.hex))!
    store.clickHex(node.hex)

    expect(first!.hex).toEqual(node.hex)
    expect(first!.mpSpent).toBeGreaterThan(0)
    // 8.1h：留驻者不受影响
    expect(second!.hex).toEqual(START)
    expect(second!.mpSpent).toBe(0)
  })

  it('已开「整堆叠」栏 ⇒ 保持原快捷方式：整堆叠一次选齐、确认即开拔（条 10）', () => {
    const [first, second] = placeStack()
    store.setStackSelect(true)
    store.clickHex(START)

    // 条 10：整堆叠栏把两枚一次选进取子清单（无需逐枚勾），确认后开拔
    expect(store.movePick!.ids.sort()).toEqual([first!.instanceId, second!.instanceId].sort())
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction!.unitIds).toEqual([first!.instanceId, second!.instanceId])
  })

  it('取消取子 ⇒ 谁都不动（不开拔）', () => {
    placeStack()
    store.clickHex(START)
    expect(store.movePick).not.toBeNull()

    store.cancelMovePick()
    expect(store.movePick).toBeNull()
    expect(store.moveInteraction).toBeNull()
  })

  it('单枚格：点格即选中、确认即开拔（条 10：点格不再直接开拔）', () => {
    const only = place(store, legCombat(), START, 'axis', 'a1')
    store.clickHex(START)
    // 条 10：单枚也先入取子清单（默认勾它），点「开始移动」才开拔
    expect(store.movePick!.ids).toEqual([only.instanceId])
    expect(store.moveInteraction).toBeNull()
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction!.unitIds).toEqual([only.instanceId])
  })
})

/* ──────────── 6.1f：移动中把堆叠里的某一枚就地放下 ──────────── */

describe('6.1f：移动中可把堆叠里的单位就地放下（其余继续走）', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  /** 两枚同格开拔，走一步后返回 [甲, 乙] */
  function movingStack(): ConsoleUnit[] {
    const first = place(store, legCombat(), START, 'axis', 'a1')
    const second = place(store, legCombat(), START, 'axis', 'a2')
    store.setStackSelect(true)
    // 条 10：点格建取子清单，确认后开拔
    store.clickHex(START)
    expect(store.confirmMovePick()).toBe(true)
    const node = store.groupReachable.hexes.find((item) => areAdjacent(START, item.hex))!
    store.clickHex(node.hex)
    return [first, second]
  }

  it('放下其中一枚 ⇒ 它就地停住（本次移动结束），另一枚仍在走', () => {
    const [first, second] = movingStack()
    expect(store.activeMoveUnits).toHaveLength(2)

    expect(store.dropUnitFromMove(first!.instanceId)).toBe(true)
    // 6.1f：离开堆叠即不得再移动 ⇒ 只有另一枚还在走
    expect(first!.movementEnded).toBe(true)
    expect(second!.movementEnded).toBe(false)
    expect(store.activeMoveUnits.map((unit) => unit.instanceId)).toEqual([second!.instanceId])
    // 本次移动没有结束（还有人能走）
    expect(store.moveInteraction!.finished).toBe(false)
  })

  it('放下的单位不再贡献可到达格（引擎按 movementEnded 过滤）', () => {
    const [first, second] = movingStack()
    expect(store.groupReachable.hexes.length).toBeGreaterThan(0)

    store.dropUnitFromMove(first!.instanceId)
    // 仍在走的只有 a2 ⇒「能走到某格」的名单里不再有 a1
    const contributors = new Set(
      store.groupReachable.hexes.flatMap((hex) => hex.byUnit.map((item) => item.unitId)),
    )
    expect(contributors.has(first!.instanceId)).toBe(false)
    expect(contributors.has(second!.instanceId)).toBe(true)
  })

  it('全部放下 ⇒ 本次移动就地收束（不必再点结束移动）', () => {
    const [first, second] = movingStack()
    store.dropUnitFromMove(first!.instanceId)
    store.dropUnitFromMove(second!.instanceId)
    expect(store.activeMoveUnits).toHaveLength(0)
    expect(store.moveInteraction!.finished).toBe(true)
  })

  it('不在本次移动中的单位 / 没有移动时 ⇒ 拒绝并提示', () => {
    expect(store.dropUnitFromMove('nobody')).toBe(false)
    expect(store.log[0]!.text).toContain('没有正在进行的移动')

    const [, second] = movingStack()
    expect(store.dropUnitFromMove('nobody')).toBe(false)
    expect(store.log[0]!.text).toContain('不在本次移动中')
    expect(second!.movementEnded).toBe(false)
  })

  it('重复放下同一枚 ⇒ 提示已结束（不重复记账）', () => {
    const [first] = movingStack()
    expect(store.dropUnitFromMove(first!.instanceId)).toBe(true)
    expect(store.dropUnitFromMove(first!.instanceId)).toBe(false)
    expect(store.log[0]!.text).toContain('已经结束')
  })
})

/* ── 夹具辅助 ── */

function same(a: HexRef, b: HexRef): boolean {
  return a.col === b.col && a.row === b.row
}

/** 与起点相邻的可到达格（一步即到；用于触发一次 4.5a-A 确认） */
function adjacentReachable(
  store: ReturnType<typeof newStore>,
  start: HexRef,
): { hex: HexRef; mpSpent: number } | undefined {
  return store.groupReachable.hexes.find((node) => areAdjacent(start, node.hex))
}

/** 找 target 的一个相邻格：在图内、且不是 avoid（用于摆敌方 ZOC 源） */
function findFreeNeighborOf(
  store: ReturnType<typeof newStore>,
  target: HexRef,
  avoid: HexRef,
): HexRef | null {
  const occupied = new Set(store.units.map((unit) => `${unit.hex.col}.${unit.hex.row}`))
  for (const direction of ['N', 'NE', 'SE', 'S', 'SW', 'NW'] as const) {
    const candidate = neighbor(target, direction)
    if (same(candidate, avoid)) continue
    if (occupied.has(`${candidate.col}.${candidate.row}`)) continue
    return candidate
  }
  return null
}
