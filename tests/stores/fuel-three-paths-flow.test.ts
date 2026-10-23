import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { SP_TO_T, createMapFacts, selectMovementTerrain } from '@/engine/rules'
import {
  actionGateOf,
  needsFuelOf,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * 批 B 切片 3：**三条取油路径都能让单位开拔** ＋ **12.5e 的两条约束**
 *
 * 规则原文：
 *   · **12.5a**：「使用轮式 MP 或履带 MP 的战斗单位要消耗 MP 的话，玩家必须消耗燃料补给，
 *     否则不能消耗任何 MP」⇒ 未加注的单位**开拔会被拒**（本文件的第一条断言就是它）；
 *   · **12.5c-A/B/C**：编队法 1SP（整编队）/ 指挥部法 1SP（指挥部自己 + 投递距离内的独立单位）/
 *     单独单位法 1T（任何单位）；
 *   · **12.5e**：「一个指挥部在支付 12.5c(B)的消耗后，可『免费』为其投递距离内的**所有独立单位**
 *     （定义见 3.2f）提供燃料补给」「**投递距离在所有的独立单位移动开始前计算**」
 *     「燃料已补给的指挥部在**每个阶段**中，只能在**单独一个位置**上投递燃料补给」；
 *   · **12.3a/b**：这三条路径都是"直接拖取 / 指挥部投递"的同一套机制（12.3 重要提示）。
 *
 * ## 测法边界（如实交代）
 *   · 用**真实地图与真实单位库**；只在内圈挑格（角落格在补给路径上走不通 —— B32 步骤 2 的教训），
 *     并按**轮式**逐步验可通行（12.3a：算补给距离始终用轮式 MP）；
 *   · **不覆盖**"移动中的指挥部必须选起始格或结束格之一"的细分：本作只保证
 *     「**每阶段一个投递基点 + 距离在付款那一刻算定**」；起点/终点二选一需要移动交互的起点快照，
 *     登记为待办（见回执的如实边界）；
 *   · **不覆盖**界面灰显与文案（本仓库不挂组件渲染测试）⇒ 可用性由 `fuelMethodChoices` 的投影断言钉住。
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
 * 夹具（内圈）：HQ 在 `hqHex`；`step1Hex` 与 `tankHex` 是轮式可逐步走到的相邻两格；
 * `dumpHex` 是 HQ 的另一个相邻格（12.3c「相邻即可」⇒ HQ 一定拖得到它）。
 */
const FIXTURE = (() => {
  for (const hex of mapLayers.hexes) {
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
        return { hqHex, step1Hex: step1, tankHex: step2, dumpHex }
      }
    }
  }
  throw new Error('夹具：地图上找不到「轮式可通行的 2 格链 + HQ 相邻的补给站位」')
})()

/** HQ 的另一个相邻格（用于"换位置再投递"那一条） */
const OTHER_ORIGIN_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(FIXTURE.hqHex, direction)
    if (!onMap(candidate)) continue
    if (candidate.col === FIXTURE.dumpHex.col && candidate.row === FIXTURE.dumpHex.row) continue
    if (candidate.col === FIXTURE.step1Hex.col && candidate.row === FIXTURE.step1Hex.row) continue
    return candidate
  }
  throw new Error('夹具：HQ 找不到第二个相邻格')
})()

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

const HQ_RECORD = unitChoices('axis').find((record) => record.branch === 'hq')!
/** 3.2f：**独立单位**（无编队 + 单军力）且耗油（轮式/履带战斗单位） */
const INDEPENDENT_TANK = unitChoices('axis').find(
  (record) =>
    record.isCombat === true &&
    record.attackCapable === true &&
    (record.formation ?? null) === null &&
    (record.steps?.total ?? 1) <= 1 &&
    (record.classes?.movementClass === 'tracked' || record.classes?.movementClass === 'truck'),
)!
/** 3.1c：**编队单位**（有番号）且耗油 —— HQ 法覆盖不到它 */
const FORMATION_TANK = unitChoices('axis').find(
  (record) =>
    typeof record.formation === 'string' &&
    record.isCombat === true &&
    record.attackCapable === true &&
    (record.classes?.movementClass === 'tracked' || record.classes?.movementClass === 'truck'),
)!
/** 13.2g/13.2h：**编内卡车**（带编队号，满载面＝1 SP） */
const ORGANIC_TRUCK = unitChoices('axis').find(
  (record) => record.noncombatKind === 'organic_truck' && typeof record.formation === 'string',
)!

/** B8：把 store 放到本段里允许加油的环节 */
function goToFuelStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey = 'supply.fuel',
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

/** 摆一座补给站并返回它的账本 id */
function putDump(
  store: ReturnType<typeof newStore>,
  hex: HexRef,
  sp: number,
): { id: string; hex: HexRef } {
  store.spDumpDraft = { hexText: label(hex), sp, t: 0 }
  expect(store.addSpDump()).toBe(true)
  const dump = store.spDumps.find((item) => label(item.hex) === label(hex))
  if (dump === undefined) throw new Error(`补给站 ${label(hex)} 没落账`)
  return { id: dump.id, hex: dump.hex }
}

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  instanceId: string,
  hex: HexRef,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side: 'axis' })
  store.units.push(unit)
  return unit
}

describe('批 B 切片 3：三条取油路径都能让单位开拔（12.3/12.5）', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  it('前提自检：夹具的 HQ 是"需燃料"的（truck）、独立坦克与编队坦克都需燃料', () => {
    expect(HQ_RECORD.branch).toBe('hq')
    expect(HQ_RECORD.classes?.movementClass).toBe('truck')
    for (const record of [INDEPENDENT_TANK, FORMATION_TANK]) {
      expect(
        needsFuelOf(toConsoleUnit({ record, instanceId: 'x', hex: FIXTURE.tankHex, side: 'axis' })),
      ).toBe(true)
    }
  })

  it('★ 路径一（站点·12.5c-C）：付 1T ⇒ 立刻开拔', () => {
    store.setPhase('movement')
    goToFuelStep(store)
    place(store, INDEPENDENT_TANK, 'tk-1', FIXTURE.tankHex)
    const dump = putDump(store, FIXTURE.tankHex, 5)

    // 12.5a：未加注 ⇒ 开拔被拒
    store.beginMovePick(FIXTURE.tankHex, ['tk-1'])
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveBlocked?.rule).toBe('12.5a')

    store.selectedId = 'tk-1'
    store.fuelMethod = 'singleUnit'
    expect(store.fuelDumpChoices.map((item) => item.id)).toContain(dump.id)
    expect(store.pickFuelDump(dump.id)).toBe(true)
    store.payFuel('singleUnit')
    expect(store.units.find((unit) => unit.instanceId === 'tk-1')!.fuelled).toBe(true)

    // 取完就能走（12.5c「在燃料消耗时支付」）
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction?.unitIds).toEqual(['tk-1'])
  })

  it('★ 路径二（HQ·12.5c-B + 12.5e）：付 1SP ⇒ 指挥部自己与**投递距离内的所有独立单位**一起加注', () => {
    store.setPhase('movement')
    goToFuelStep(store)
    place(store, HQ_RECORD, 'hq-1', FIXTURE.hqHex)
    place(store, INDEPENDENT_TANK, 'tk-1', FIXTURE.tankHex)
    // 第二枚独立单位（**不会被点选**）与一枚编队单位（3.2f 上不是独立单位）
    place(store, INDEPENDENT_TANK, 'tk-2', FIXTURE.step1Hex)
    place(store, FORMATION_TANK, 'fm-1', FIXTURE.step1Hex)
    const dump = putDump(store, FIXTURE.dumpHex, 5)

    store.selectedId = 'hq-1'
    store.fuelMethod = 'hq'
    // 12.5c-B：HQ 法由指挥部付款并投递 ⇒ 选中 HQ 时该方法可用
    expect(store.fuelMethodChoices.find((item) => item.method === 'hq')?.available).toBe(true)
    expect(store.fuelDumpChoices.map((item) => item.id)).toContain(dump.id)
    expect(store.pickFuelDump(dump.id)).toBe(true)

    // 付之前：谁都没油
    expect(store.units.filter((unit) => unit.fuelled).map((unit) => unit.instanceId)).toEqual([])
    store.payFuel('hq')

    // 12.5e：指挥部自己 + 投递距离内的**所有独立单位**（含未被点选的 tk-1/tk-2）都加注
    const fuelled = store.units
      .filter((unit) => unit.fuelled)
      .map((unit) => unit.instanceId)
      .sort()
    expect(fuelled).toEqual(['hq-1', 'tk-1', 'tk-2'])
    // 编队单位（3.2f：有番号）**不在** HQ 法覆盖内 ⇒ 仍欠油
    expect(store.units.find((unit) => unit.instanceId === 'fm-1')!.fuelled).toBe(false)
    // 投递基点记在本阶段台账上（12.5e：每阶段一个位置）
    expect(store.hqFuelThrowOriginOf('hq-1')).toEqual(FIXTURE.hqHex)
  })

  it('★ 路径三（编队卡车·13.2g-B）：同编队单位从编队卡车取油 ⇒ 立刻开拔', () => {
    store.setPhase('movement')
    goToFuelStep(store)
    const truck = place(store, ORGANIC_TRUCK, 'tr-1', FIXTURE.tankHex)
    truck.loadedSpT = SP_TO_T // 13.2h：满载面＝1 SP
    const mateRecord = unitChoices('axis').find(
      (record) =>
        record.formation === ORGANIC_TRUCK.formation &&
        record.isCombat === true &&
        (record.classes?.movementClass === 'tracked' || record.classes?.movementClass === 'truck'),
    )
    if (mateRecord === undefined) throw new Error('数据里找不到与该编内卡车同编队的战斗单位')
    place(store, mateRecord, 'mate-1', FIXTURE.tankHex)

    store.selectedId = 'mate-1'
    store.fuelMethod = 'singleUnit'
    const carrier = store.fuelDumpChoices.find((item) => item.id === 'unit:tr-1')
    expect(carrier).toBeDefined()
    expect(store.pickFuelDump('unit:tr-1')).toBe(true)
    store.payFuel('singleUnit')

    expect(store.units.find((unit) => unit.instanceId === 'mate-1')!.fuelled).toBe(true)
    // 12.1a：1 SP = 4 T ⇒ 单单位法付 1T 后车上剩 3T
    expect(store.units.find((unit) => unit.instanceId === 'tr-1')!.loadedSpT).toBe(SP_TO_T - 1)

    // 取完就能走
    store.beginMovePick(FIXTURE.tankHex, ['mate-1'])
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction?.unitIds).toEqual(['mate-1'])
  })

  it('★ 12.5e：已补给的指挥部**每阶段只能在一个位置投递** ⇒ 换位置再投递被拒、账本不动', () => {
    store.setPhase('movement')
    goToFuelStep(store)
    place(store, HQ_RECORD, 'hq-1', FIXTURE.hqHex)
    place(store, INDEPENDENT_TANK, 'tk-1', FIXTURE.tankHex)
    const dumpA = putDump(store, FIXTURE.dumpHex, 8)
    // 换位置后要够得着的另一座站（摆在新的投递基点旁边）
    const dumpB = putDump(store, OTHER_ORIGIN_HEX, 8)

    store.selectedId = 'hq-1'
    store.fuelMethod = 'hq'
    expect(store.pickFuelDump(dumpA.id)).toBe(true)
    store.payFuel('hq')
    const afterFirst = { ...store.spDumps.find((item) => item.id === dumpA.id)! }

    // 12.5e：指挥部移动到别处（起始格或结束格二选一 ⇒ 一旦选定就不许再改）
    const hq = store.units.find((unit) => unit.instanceId === 'hq-1')!
    hq.hex = { ...OTHER_ORIGIN_HEX }
    expect(store.pickFuelDump(dumpB.id)).toBe(true)
    store.payFuel('hq')

    expect(store.log.some((entry) => entry.rule === '12.5e')).toBe(true)
    // 被拒 ⇒ **不改动任何账本**（第一笔也不该被动）
    expect(store.spDumps.find((item) => item.id === dumpA.id)).toMatchObject({
      sp: afterFirst.sp,
      t: afterFirst.t,
    })
    expect(store.spDumps.find((item) => item.id === dumpB.id)).toMatchObject({ sp: 8, t: 0 })
    // 台账仍记着原来的基点
    expect(store.hqFuelThrowOriginOf('hq-1')).toEqual(FIXTURE.hqHex)

    /*
     * 12.5d：**本方清理阶段**（标记真正被移除的那一刻）⇒ 台账清空 ⇒ 新窗口可在新位置投递。
     * ★ 契约变更（2026-09-20 用户裁定，**不是放宽**）：原先这里断言"一进 cleanUp 段就清"，
     *   现在按 12.5d 的原文把清零点落在**清理动作**里（`runCleanUpNow`）——这正是"燃料窗口持续到
     *   本方清理阶段结束"的实现：`setPhase('cleanUp')` 本身不再是清零时点（否则在敌方半场付的油
     *   会被**下一次**段切换提前作废，见 `tests/stores/fuel-window-persistence.test.ts`）。
     */
    store.setPhase('cleanUp')
    expect(store.hqFuelThrowOriginOf('hq-1')).toEqual(FIXTURE.hqHex) // 还没清 ⇒ 台账仍在
    expect(store.runCleanUpNow()).toBe(true)
    expect(store.hqFuelThrowOriginOf('hq-1')).toBeNull()
  })
})
