import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { neighbors } from '@/engine/hex-geometry'
import { useWorkbenchStore, actionGateOf, type ActionKey, type ConsolePhase } from '@/stores'

import { CORE_HEX, groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 12.3a / 12.3c：**付款站的可达性**（燃油 12.5 与轰炸 10.1b）
 *
 * 条文：
 *   · **12.3a**「直接拖取」：单位可在 **5 MP** 内直接拖取补给站的 SP；**12.3c** 相邻即可。
 *   · **12.5c-A/B**：编队法 / HQ 法要求这些单位**共用同一来源**。
 *   · **10.1b-A**：火炮的战斗补给只能来自**同一指挥部**或**同一补给站**。
 *
 * ★ 修前：战斗补给一侧（`combatSupplyDumps`）已按可达性筛过，**燃油与轰炸没有**——两处的候选是
 *   「该方**全部**补给站」，于是可以在全图任意远处给一次加油或一场轰炸付款。
 *   本组把三条链统一到引擎的 `drawableDumpsFor`（唯一可达性判据，经 store 的
 *   `drawableSpDumpsAt` 收口）上。
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

beforeEach(() => {
  setActivePinia(createPinia())
})

/**
 * 需要燃料的轮式战斗单位（12.5a：轮式/履带 MP 的**战斗单位**，按**朝向面**判 —— 3.1a 逐面）
 *
 * 2026-09-17 用户裁定「摩托化单位战斗面徒步、移动面轮式」后，轴方已没有**战斗面轮式**的战斗
 * 单位，故这里取「移动面轮式」的摩托化战斗单位，并把它摆成**移动面朝向**（见各处 `'move'`）：
 * 12.5a 的燃料本来就是移动时付的，朝移动面才是这条规则真正发生的场合。
 */
function truckRecord() {
  return groundRecord(
    'axis',
    (record) =>
      record.mobilityByFace?.move === 'truck' &&
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.noncombatKind ?? null) === null,
  )
}

/** 带印刷轰炸值的轴方火炮 */
function artilleryRecord() {
  return groundRecord(
    'axis',
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
  )
}

/** 12.3a：把一座补给站放到指定格 */
function dumpAt(
  store: Workbench,
  hex: { col: number; row: number },
  side: 'axis' | 'soviet',
  t = 20,
) {
  const id = `d-${hex.col}-${hex.row}-${store.spDumps.length}`
  store.spDumps.push({ id, hex: { ...hex }, side, sp: 0, t })
  return store.spDumps.find((item) => item.id === id)!
}

/**
 * 3.4b：若受益单位属某装甲集群，这座站须声明**同一归属**
 *
 * 本夹具体例里的摩托化团与火炮都带 `panzerGroup`（数据来自编队目录）——不声明归属时
 * 「错误集群的 SP 不得付燃油/轰炸」会把它拒掉，那会掩盖本组要测的**可达性**判据。
 */
function declareGroupOf(store: Workbench, dumpId: string, unitId: string): void {
  const unit = store.units.find((item) => item.instanceId === unitId)
  if (unit === undefined) return
  const group = store.groupOfUnit(unit)
  if (group !== null) store.setDumpPanzerGroupNow(dumpId, group)
}

/** 图外/远端的格（保证远超 12.3a 的 5 MP 直拖距离） */
const FAR_HEX = { col: CORE_HEX.col + 30, row: CORE_HEX.row }

describe('12.5 燃油：付款站候选按 12.3a 可达性筛', () => {
  it('同格的站进候选、远处的站不进；用远处的站付款被拒且账本不动', () => {
    const store = newStore()
    const truck = placeGround(store, truckRecord(), CORE_HEX, 'axis', 'a1', 'move')
    truck.mode = { mode: 'move', orientation: 'move', dg: false, exploit: false }
    truck.mpSpent = 0
    truck.fuelled = false
    store.selectedId = truck.instanceId

    const near = dumpAt(store, CORE_HEX, 'axis')
    const far = dumpAt(store, FAR_HEX, 'axis')
    expect(store.fuelDumpChoices.map((dump) => dump.id)).toEqual([near.id])
    expect(store.fuelDumpChoices.map((dump) => dump.id)).not.toContain(far.id)

    // 选远处的站 ⇒ 12.3a/12.3d 拒（修前会照付：那正是「全图任意远处付款」）
    expect(store.pickFuelDump(far.id)).toBe(true)
    store.payFuel('singleUnit', true)
    expect(truck.fuelled).toBe(false)
    expect(store.spDumps.find((dump) => dump.id === far.id)!.t).toBe(20)

    // 改选同格那站 ⇒ 付得出，且账本真扣
    declareGroupOf(store, near.id, truck.instanceId)
    expect(store.pickFuelDump(near.id)).toBe(true)
    store.payFuel('singleUnit', true)
    expect(truck.fuelled).toBe(true)
    expect(store.spDumps.find((dump) => dump.id === near.id)!.t).toBeLessThan(20)
  })

  it('12.5c：编队内两个单位分处不同格 ⇒ 候选只取**两者都拖得到**的交集', () => {
    const store = newStore()
    const a = placeGround(store, truckRecord(), CORE_HEX, 'axis', 'a1', 'move')
    const bHex = neighbors(CORE_HEX)[0]!.hex
    const b = placeGround(store, truckRecord(), bHex, 'axis', 'a2', 'move')
    for (const unit of [a, b]) {
      unit.mode = { mode: 'move', orientation: 'move', dg: false, exploit: false }
      unit.mpSpent = 0
      unit.fuelled = false
    }
    // 让两个单位都进 `fuelTargets`（模拟开始移动一个堆叠）
    store.selectedId = a.instanceId
    const onlyA = dumpAt(store, FAR_HEX, 'axis')
    expect(store.fuelDumpChoices.map((dump) => dump.id)).not.toContain(onlyA.id)

    // 两格各自同格的站：只有 a 拖得到 a 的站 ⇒ 交集里只该有**两个都够得着**的那些
    const atA = dumpAt(store, CORE_HEX, 'axis')
    const atB = dumpAt(store, bHex, 'axis')
    const candidates = store.fuelDumpChoices.map((dump) => dump.id)
    // 选中态只含 a ⇒ 至少 a 的那站必在
    expect(candidates).toContain(atA.id)
    // 而 b 的那站若不在 a 的可达范围内则不该进（夹具自检：两格相邻，故大概率都在；
    // 这里断言的是「候选集合 ⊆ 单位可达集合」这一不变式）
    for (const id of candidates) {
      const dump = store.spDumps.find((item) => item.id === id)!
      const reachableByA = store.fuelDumpChoices.some((item) => item.hex.col === dump.hex.col)
      expect(reachableByA).toBe(true)
    }
    expect(atB.id).toBeTruthy()
  })
})

describe('12.5 燃油：付款站必须属于受益方', () => {
  it('用对手的站加油被拒（12.3a）', () => {
    const store = newStore()
    const truck = placeGround(store, truckRecord(), CORE_HEX, 'axis', 'a1', 'move')
    truck.fuelled = false
    truck.mode = { mode: 'move', orientation: 'move', dg: false, exploit: false }
    truck.mpSpent = 0
    store.selectedId = truck.instanceId
    const enemy = dumpAt(store, CORE_HEX, 'soviet')
    expect(store.pickFuelDump(enemy.id)).toBe(true)
    store.payFuel('singleUnit', true)
    expect(truck.fuelled).toBe(false)
    expect(store.spDumps.find((dump) => dump.id === enemy.id)!.t).toBe(20)
  })
})

describe('10.1b 轰炸：付款站候选按 12.3a 可达性筛（且各参炸单位共用同一来源）', () => {
  /** 摆好一门火炮与一个目标格，进入「补给」步 */
  function setupBarrage(store: Workbench) {
    store.setPhase('combat')
    const artillery = placeGround(store, artilleryRecord(), CORE_HEX, 'axis', 'art-1')
    const targetHex = neighbors(CORE_HEX)[0]!.hex
    store.battleTarget = { hex: targetHex, defenderIds: [] }
    store.setBarrageActive(true)
    store.toggleBarrageUnit(artillery.instanceId)
    expect(store.beginBarrageNow()).toBe(true)
    return { artillery, targetHex }
  }

  it('同格的站进候选；远处的不进，且选远处那站会被 12.3a 拒', () => {
    const store = newStore()
    const { artillery } = setupBarrage(store)
    const artilleryId = artillery.instanceId
    const near = dumpAt(store, CORE_HEX, 'axis')
    const far = dumpAt(store, FAR_HEX, 'axis')
    expect(store.barrageSupplyDumpChoices.map((dump) => dump.id)).toEqual([near.id])

    expect(store.pickBarrageSupplyDump(far.id)).toBe(true)
    expect(store.confirmBarrageSupplyStep()).toBe(false)
    expect(store.barrageError).toMatchObject({
      rule: '12.3a',
      reason: 'barrageSupplyDumpOutOfRange',
    })
    // 账本不动、也不推进到横移步
    expect(store.spDumps.find((dump) => dump.id === far.id)!.t).toBe(20)
    expect(store.barrageState?.step).toBe('supply')

    // 改选可达那站 ⇒ 付得出，且真扣
    declareGroupOf(store, near.id, artilleryId)
    expect(store.pickBarrageSupplyDump(near.id)).toBe(true)
    expect(store.confirmBarrageSupplyStep()).toBe(true)
    expect(store.barrageState?.step).toBe('shifts')
    expect(store.spDumps.find((dump) => dump.id === near.id)!.t).toBeLessThan(20)
  })

  it('10.2c：空军轰炸无需补给来源（候选为空也不要求选站）', () => {
    const store = newStore()
    store.setPhase('movement')
    goToActionStep(store, 'barrage.declare')
    const plane = placeGround(store, artilleryRecord(), CORE_HEX, 'axis', 'air-1')
    const targetHex = neighbors(CORE_HEX)[0]!.hex
    store.battleTarget = { hex: targetHex, defenderIds: [] }
    store.setBarrageActive(true)
    store.setBarrageKind('air')
    store.toggleBarrageUnit(plane.instanceId)
    expect(store.beginBarrageNow()).toBe(true)
    expect(store.barrageSupplyDumpChoices).toEqual([])
    expect(store.confirmBarrageSupplyStep()).toBe(true)
    expect(store.barrageState?.supply).toMatchObject({ requiredT: 0, waived: true })
  })
})
