import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { createMapFacts, selectMovementTerrain } from '@/engine/rules'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * B32（步骤 1–2）：**燃料的候选来源按方法分派**（12.5c-B / 12.5e；按 12.0 的取补机制实现）
 *
 * 用户报告 #1 的第一句：「移动阶段时**未能正确从 HQ 获得燃油补给**，未能从满编的编队卡车获取燃油」。
 *
 * 12.0 总纲：「在玩家**任何需要补给**（追溯补给、**燃料**、战斗、建造、补充部队储备、飞机整备）的时候，
 * 都**需要使用直接拖取和指挥部投递中的同一种相同的机制**」；12.3a 是 5 MP 直拖或相邻，
 * 12.3b 是 HQ 按**印刷投递距离**投递，12.5c-B / 12.5e 说 HQ 法就是「**HQ 先拖取、再投给单位**」。
 *
 * ⇒ 候选必须是「**HQ 够得着**的补给站」，而不是「受益单位自己 5 MP 内够得着」的；
 *   判据与补给面板**同一处**（`drawableDumpsFor` / `countSupplyDistanceToAny` / `canThrowViaHQ`），
 *   这里不另造一套 12.3 的走法（第一版夹具正是因为**沿一条直线取格、没过地形**而一直给出空候选）。
 *
 * ★ 一条**测法边界（如实）**：真正体现该分支价值的"HQ 够得着、而受益单位自己够不着"那种差分，
 *   取决于**地形 MP 造价**（同一段路走公路可低到 1/2 MP），塞进合成夹具会随时飘；
 *   故本文件钉「分支确实产出候选」与「单单位法没被放宽」两条，差分场景由
 *   `tests/stores/fuel-payment-chain.test.ts` 的既有链用例覆盖。
 */

const mapFacts = createMapFacts()

/** 12.3a：算补给距离始终用**轮式 MP** ⇒ 夹具按轮式可通行挑格 */
const truckCanEnter = (from: HexRef, to: HexRef): boolean =>
  selectMovementTerrain({
    terrainsPresent: mapFacts.terrainsAt(to),
    mobility: 'truck',
    crossing: mapFacts.crossingBetween(from, to),
    followingRoad: false,
    forOverrun: false,
  }).ok

const onMap = (hex: HexRef): boolean =>
  isOnMap(hex) && mapLayers.hexes.some((item) => item.col === hex.col && item.row === hex.row)

/**
 * 夹具：HQ 在 `hqHex`，坦克在**轮式可逐步走到**的 2 格外，补给站在 HQ 的相邻格
 * （12.3a「相邻即可」⇒ HQ 一定拖得到这一座）
 */
const FIXTURE = (() => {
  for (const hex of mapLayers.hexes) {
    /*
     * ★ 只在内圈搜：地图**角落格**虽然"在图上"，但补给路径的 Dijkstra 在那儿走不通
     * （第一版夹具挑了 (1,1) ⇒ `countSupplyDistanceToAny` 直接返回 `unreachable`，
     * 而同一格里 `drawableDumpsFor` 却是 ok 的 —— 两者对"可走"的口径不同）。
     */
    if (hex.col < 6 || hex.row < 6 || hex.col > 56 || hex.row > 30) continue
    const hqHex: HexRef = { col: hex.col, row: hex.row }
    for (const direction of HEX_DIRECTIONS) {
      const step1 = neighbor(hqHex, direction)
      const step2 = neighbor(step1, direction)
      if (!onMap(step1) || !onMap(step2)) continue
      if (!truckCanEnter(hqHex, step1) || !truckCanEnter(step1, step2)) continue
      for (const dumpDirection of HEX_DIRECTIONS) {
        const dumpHex = neighbor(hqHex, dumpDirection)
        if (!onMap(dumpHex)) continue
        if (dumpHex.col === step1.col && dumpHex.row === step1.row) continue
        return { hqHex, tankHex: step2, dumpHex }
      }
    }
  }
  throw new Error('夹具：地图上找不到「轮式可通行的 2 格链 + HQ 相邻的补给站位」')
})()

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const TANK_RECORD = unitChoices('axis').find(
  (record) =>
    record.isCombat === true &&
    record.attackCapable === true &&
    (record.factors?.combat?.attack ?? 0) >= 1,
)!
const HQ_RECORD = unitChoices('axis').find((record) => record.branch === 'hq')!
/**
 * B40（3.2f）：**编队单位** —— 数据里带 `formation`（3.1c 多单位编队的番号，**由数据定死**）
 *
 * 用户 2026-09-17 裁定：「编队单位肯定是定死的，和独立单位不一样，**编队单位是无法利用 HQ 补给法的**。」
 */
const FORMATION_RECORD = unitChoices('axis').find(
  (record) =>
    typeof record.formation === 'string' &&
    record.isCombat === true &&
    record.attackCapable === true,
)!
/** B40（3.2d）：**多军力单位**（印值军力 > 1）—— 同样不是独立单位 */
const MULTI_STEP_RECORD = unitChoices('axis').find(
  (record) =>
    (record.formation ?? null) === null &&
    (record.steps?.total ?? 1) > 1 &&
    record.isCombat === true &&
    record.attackCapable === true,
)!

/** 摆好「补给站 + HQ + 坦克」，并让坦克成为本次燃料的受益单位 */
function setup(store: ReturnType<typeof newStore>): string {
  store.setPhase('movement')
  store.spDumpDraft = { hexText: `${FIXTURE.dumpHex.col}.${FIXTURE.dumpHex.row}`, sp: 5, t: 0 }
  store.addSpDump()
  const dumpId = store.spDumps[0]!.id
  store.units.push(
    toConsoleUnit({ record: HQ_RECORD, instanceId: 'hq-1', hex: FIXTURE.hqHex, side: 'axis' }),
    toConsoleUnit({ record: TANK_RECORD, instanceId: 'tk-1', hex: FIXTURE.tankHex, side: 'axis' }),
  )
  store.selectedId = 'tk-1'
  return dumpId
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B32：方法选择在 store（步骤 1）', () => {
  it('★ 方法是 store 字段，缺省单单位法；`payFuel()` 缺省即用它', () => {
    const store = newStore()
    expect(store.fuelMethod).toBe('singleUnit')
    // B32 步骤 4：`fuelCommonSource` 已删（改由 fuelSourcePartition 的**盘面事实**给出）
    expect(store.fuelSourcePartition.shared).toBe(false)
    store.fuelMethod = 'hq'
    expect(store.fuelMethod).toBe('hq')
  })
})

describe('B32：候选来源按方法分派（步骤 2，按 12.3 的走法）', () => {
  it('★ 步骤 4（13.7a）：单个受益单位 ⇒ 天然同源；无受益单位 ⇒ 空划分', () => {
    const store = newStore()
    setup(store)
    // 只有那辆坦克要油 ⇒ 它自己的来源就是"共用来源"
    expect(store.fuelTargets.map((unit) => unit.instanceId)).toEqual(['tk-1'])
    expect(store.fuelSourcePartition.shared).toBe(true)
    expect(store.fuelSourcePartition.commonUnitIds).toEqual(['tk-1'])
    expect(store.fuelSourcePartition.singleUnitIds).toEqual([])

    // 没有受益单位时给空划分（不臆造）
    store.selectedId = null
    expect(store.fuelSourcePartition).toMatchObject({
      shared: false,
      commonKey: null,
      commonUnitIds: [],
      singleUnitIds: [],
    })
  })

  it('★ 步骤 4（13.7a）：两个受益单位、来源不相交 ⇒ 拆组（能共用的那组 + 需单独付的其余）', () => {
    const store = newStore()
    setup(store)
    /*
     * 再摆一辆坦克：HQ 的投递距离（印值 8 MP）够不到它 ⇒ 两辆车没有公共来源。
     * 用 `selectMovementTerrain` 找不到"8 MP 之外"的确定几何，故这里直接用
     * **地图另一端**的格（距离远大于投递距离），并断言划分**不是同源**。
     */
    const far = mapLayers.hexes.find(
      (hex) => Math.abs(hex.col - FIXTURE.hqHex.col) + Math.abs(hex.row - FIXTURE.hqHex.row) > 20,
    )!
    store.units.push(
      toConsoleUnit({
        record: TANK_RECORD,
        instanceId: 'tk-2',
        hex: { col: far.col, row: far.row },
        side: 'axis',
      }),
    )
    store.selectedId = 'tk-1'
    store.movePick = { hex: FIXTURE.tankHex, ids: ['tk-1', 'tk-2'] }

    const partition = store.fuelSourcePartition
    expect(store.fuelTargets.map((unit) => unit.instanceId)).toEqual(['tk-1', 'tk-2'])
    expect(partition.shared).toBe(false)
    // 拆组后两组之和＝全部受益单位（不能漏人）
    expect([...partition.commonUnitIds, ...partition.singleUnitIds].sort()).toEqual([
      'tk-1',
      'tk-2',
    ])
    expect(partition.commonUnitIds.length).toBeGreaterThan(0)
  })

  it('★ 步骤 3：拒付话术**按方法**给（三种方法的可达性口径不同，出处 12.5c-A/B/C）', () => {
    const store = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(store).toContain('12.5c-B/12.5e：HQ 法要求')
    expect(store).toContain('12.5c-A/13.7a：编队法要求')
    expect(store).toContain('12.5c-C：单独单位法要求')
    // 13.7a 的"拆分"口径也写进了话术（同源的那部分走编队法、其余改单独单位法）
    expect(store).toContain('其余按 13.7a 改用单独单位法')
  })

  it('★ HQ 法：HQ 拖得到（相邻）且投递距离覆盖坦克 ⇒ 这一座**进候选**', () => {
    const store = newStore()
    const dumpId = setup(store)
    // 受益单位＝那辆坦克（`fuelTargets` 走 moveUnits → movePick.ids → selectedUnit）
    expect(store.fuelTargets.map((unit) => unit.instanceId)).toEqual(['tk-1'])

    store.fuelMethod = 'hq'
    expect(store.fuelDumpChoices.map((dump) => dump.id)).toContain(dumpId)
  })

  it('★ 场上没有 HQ ⇒ HQ 法**为空**（不凭空给出候选）', () => {
    const store = newStore()
    setup(store)
    store.units = store.units.filter((unit) => unit.instanceId !== 'hq-1')

    store.fuelMethod = 'hq'
    expect(store.fuelDumpChoices).toEqual([])

    /*
     * 单单位法给不给这一座，由引擎按 12.3a 的 5 MP/相邻判（本夹具里坦克离它 3 格，
     * 地形便宜时**合法可拖**）⇒ 这里只断言"候选只可能来自 12.3a"，不把两法写成相等。
     */
    store.fuelMethod = 'singleUnit'
    for (const dump of store.fuelDumpChoices) {
      expect(dump.side).toBe('axis')
    }
  })
})

/* ────────── B40：HQ 法只覆盖**独立单位**（3.2f / 12.5c-B / 12.5e） ────────── */

/**
 * 原文（12.5c-B）「支付 1SP，为**指挥部自己**，及它投递距离内的**所有独立单位**提供燃料补给。」
 * 原文（12.5e）「……可『免费』为其投递距离内的**所有独立单位（定义见 3.2f）**提供燃料补给（从而避免
 *   单独单位使用燃料补给法每单位每阶段消耗 1T 的燃料）。」
 * 原文（3.2f）「任何既**不属于多单位编队 (3.1c)** 也**不属于多军力单位 (3.2d)** 的单位都是『独立单位』。」
 * 原文（12.5c-C）「**任何单位都可以使用此方法**，无论其 RE 规模或军力多少，也无论它是独立单位、
 *   多军力单位，还是多单位编队中的单位。」
 *
 * 用户 2026-09-17 裁定与本条一致：「编队单位肯定是定死的……**编队单位是无法利用 HQ 补给法的**」。
 *
 * 测法边界：本组钉"**资格**"（谁被 HQ 法覆盖）与"**另两法不受限**"；"投递距离覆盖全部受益单位"
 * 那一半由上面 `B32：候选来源按方法分派` 组覆盖。
 */
describe('B40：HQ 法只覆盖独立单位（编队单位 / 多军力单位被拒）', () => {
  /** 把一枚指定记录换成受益单位（其余照 `setup`） */
  const setupWith = (
    store: ReturnType<typeof newStore>,
    record: ReturnType<typeof unitChoices>[number],
  ): void => {
    setup(store)
    store.units = store.units.filter((unit) => unit.instanceId !== 'tk-1')
    store.units.push(
      toConsoleUnit({ record, instanceId: 'x-1', hex: FIXTURE.tankHex, side: 'axis' }),
    )
    store.selectedId = 'x-1'
  }

  it('★ 编队单位（3.1c，`formation` 非空）⇒ HQ 法**候选为空**，且 `payFuel` 当场被拒并给 12.5c-B', () => {
    const store = newStore()
    setupWith(store, FORMATION_RECORD)
    expect(FORMATION_RECORD.formation).toBeTruthy()

    store.fuelMethod = 'hq'
    expect(store.fuelDumpChoices).toEqual([])

    store.payFuel('hq')
    const target = store.units.find((unit) => unit.instanceId === 'x-1')!
    expect(target.fuelled).toBe(false)
    expect(target.fuelMethod).toBeNull()
    expect(store.log.some((line) => line.text.includes('12.5c-B'))).toBe(true)
  })

  it('★ 多军力单位（3.2d，印值军力 > 1）⇒ 同样不是独立单位，HQ 法候选为空', () => {
    const store = newStore()
    setupWith(store, MULTI_STEP_RECORD)
    expect(MULTI_STEP_RECORD.steps?.total ?? 1).toBeGreaterThan(1)

    store.fuelMethod = 'hq'
    expect(store.fuelDumpChoices).toEqual([])
  })

  it('★ 独立单位（无编队 + 单军力）⇒ HQ 法照旧可用（现状不变）', () => {
    const store = newStore()
    const dumpId = setup(store)
    expect((TANK_RECORD.formation ?? null) === null && (TANK_RECORD.steps?.total ?? 1) <= 1).toBe(
      true,
    )
    store.fuelMethod = 'hq'
    expect(store.fuelDumpChoices.map((dump) => dump.id)).toContain(dumpId)
  })

  it('★ 12.5c（用户 2026-09-17）：**点谁决定能点哪一法** —— 三种方法的可用性随受益单位而变', () => {
    const store = newStore()

    // ① 没选单位 ⇒ 三种都不可用
    expect(store.fuelTargets).toEqual([])
    expect(store.fuelMethodChoices.map((item) => item.available)).toEqual([false, false, false])

    // ② 选中一枚**独立单位** ⇒ 只有单独单位法可用（它既无编队、又不是 HQ）
    const loner = unitChoices('axis').find(
      (record) =>
        record.isCombat === true &&
        (record.formation ?? null) === null &&
        (record.steps?.total ?? 1) <= 1,
    )!
    store.units = [
      toConsoleUnit({ record: loner, instanceId: 'L', hex: FIXTURE.tankHex, side: 'axis' }),
    ]
    store.selectedId = 'L'
    expect(store.fuelMethodChoices).toMatchObject([
      { method: 'singleUnit', available: true },
      { method: 'formation', available: false },
      { method: 'hq', available: false },
    ])

    // ③ 选中一枚**编队单位** ⇒ 多出编队法；HQ 法仍不可用（选中里没有指挥部）
    store.units = [
      toConsoleUnit({
        record: FORMATION_RECORD,
        instanceId: 'F',
        hex: FIXTURE.tankHex,
        side: 'axis',
      }),
    ]
    store.selectedId = 'F'
    expect(store.fuelMethodChoices).toMatchObject([
      { method: 'singleUnit', available: true },
      { method: 'formation', available: true },
      { method: 'hq', available: false },
    ])

    // ④ 选中**指挥部自己** ⇒ 才有 HQ 法（用户：「点击 HQ 时才能加 HQ 法」）
    store.units = [
      toConsoleUnit({ record: HQ_RECORD, instanceId: 'H', hex: FIXTURE.hqHex, side: 'axis' }),
    ]
    store.selectedId = 'H'
    const hqChoices = store.fuelMethodChoices
    expect(hqChoices.find((item) => item.method === 'hq')?.available).toBe(true)
    expect(hqChoices.find((item) => item.method === 'singleUnit')?.available).toBe(true)
    // 指挥部自己不是"多单位编队" ⇒ 编队法仍不可用
    expect(hqChoices.find((item) => item.method === 'formation')?.available).toBe(false)

    // ⑤ 选了不可用的那一法 ⇒ **实际生效**的退回单独单位法（12.5c-C 恒可用），不把人卡在点不动的按钮上
    store.fuelMethod = 'formation'
    expect(store.fuelMethodEffective).toBe('singleUnit')
  })

  it('★ 12.5c-C：编队单位走**单独单位法**不受此限（该条明写"任何单位都可以使用此方法"）', () => {
    const store = newStore()
    setupWith(store, FORMATION_RECORD)
    store.fuelMethod = 'singleUnit'
    expect(store.fuelDumpChoices.length).toBeGreaterThan(0)

    const dump = store.fuelDumpChoices[0]!
    /*
     * 3.4b 的前置：本夹具的编队单位带 `panzerGroup`（数据来自编队目录）⇒ 付款站须声明**同一归属**，
     * 否则会先被「错误集群的 SP 不得付燃油」拒掉（那与 12.5c-C 无关，会掩盖本条要测的资格判据）。
     */
    const group = store.groupOfUnit(store.units.find((unit) => unit.instanceId === 'x-1')!)
    if (group !== null) store.setDumpPanzerGroupNow(dump.id, group)

    store.pickFuelDump(dump.id)
    store.payFuel('singleUnit')
    const target = store.units.find((unit) => unit.instanceId === 'x-1')!
    expect(target.fuelled, store.log.map((line) => line.text).join(' | ')).toBe(true)
    expect(target.fuelMethod).toBe('singleUnit')
  })
})
