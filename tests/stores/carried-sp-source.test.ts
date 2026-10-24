import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { SP_TO_T } from '@/engine/rules'
import { needsFuelOf, toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * B32 步骤 5：**装载在运输点数上的 SP 也是补给站**（12.1b + 13.2f）
 *
 * 原文：
 *   · **12.1b**：「任何含有 SP 的位置，无论是地面上未装载的补给，**还是装载在运输点数上的补给**，
 *     都被称为补给站。**SP 使用前并不需要被卸载**。」
 *   · **13.2f**：「将装载的 SP 算子置于运输点数算子上」（装载形态）；
 *   · **13.2b**：「运输点数**永远不需要燃料补给**」；
 *   · **13.2g / 13.2h**（编内卡车恒 1 SP、满载符号）只影响运力，不影响"能否当来源"。
 *
 * 用户报告 #1 的第二句正是这里：「**未能从满编的编队卡车获取燃油**」。
 *
 * 真实数据下"运输点数"由 `loadedSpT` 记账（13.2f 的装载量），故本文件钉四件事：
 *   ① 一条 `loadedSpT > 0` 的算子**出现在 `allSpDumps`**（含 SP 的位置），并进 `supplyFacts` 的 dumps；
 *   ② 它能成为**燃料来源候选**（与它同格的受益单位拖得到）；
 *   ③ **付款真的扣它的 `loadedSpT`**（12.1a 的 SP↔T 换算），而不是去动 SP 账本；
 *   ④ 13.2b：承运算子**自己不需要燃料**（不因"它装着油"而被要求加注）。
 *
 * ★ 一条**测法边界**：本文件用"同格"构造（受益单位与承运车同格 ⇒ 12.3a 的相邻即可成立），
 *   故与地形造价无关；"跨格拖取"的地形敏感性由 B32 步骤 2 的用例覆盖。
 */

/** 内圈的一格（角落格在补给路径上走不通，见 B32 步骤 2 的教训） */
const HEX: HexRef = (() => {
  const found = mapLayers.hexes.find(
    (hex) => hex.col > 8 && hex.row > 8 && hex.col < 54 && hex.row < 28,
  )
  if (found === undefined) throw new Error('地图上找不到内圈格')
  return { col: found.col, row: found.row }
})()

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 要加油的装甲单位（轮式/履带战斗单位才需要燃料） */
const TANK_RECORD = unitChoices('axis').find(
  (record) =>
    record.isCombat === true &&
    record.attackCapable === true &&
    (record.classes?.movementClass === 'tracked' || record.classes?.movementClass === 'truck') &&
    /*
     * B40（12.5c-B / 3.2f）：HQ 法只覆盖**独立单位**——既不属于多单位编队（3.1c）、
     * 也不是多军力单位（3.2d）。故夹具要的是"单车、无编队"的那一枚
     * （§5-D 之后补员算子已从 `unitChoices` 滤掉，不会再被误取）。
     */
    (record.formation ?? null) === null &&
    (record.steps?.total ?? 1) <= 1,
)!
/**
 * 承运算子（13.2f：运输点数算子）
 *
 * ★ B42（13.2g-B）：这里**取常规运输点数**，不取编内卡车 —— 编内卡车的 SP 只许**同一多单位编队**内的
 *   单位拖取（那条由本文件末尾的 13.2g-B 用例专门覆盖）；本文件前半段问的是 12.1b「任何含 SP 的位置
 *   都是补给站」这条**共性**，用常规运输点数才不会被 13.2g 的例外挡住。
 */
const CARRIER_RECORD = unitChoices('axis').find(
  (record) => record.noncombatKind === 'transport_point',
)!
/** 轴方指挥部（12.5c-B：HQ 法的投递者） */
const HQ_RECORD = unitChoices('axis').find((record) => record.branch === 'hq')!

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B32 步骤 5：装载在运输点数上的 SP（12.1b / 13.2f）', () => {
  it('★ 含 SP 的位置：承运车进 allSpDumps 与 supplyFacts 的 dumps（与账本条目同一口径）', () => {
    const store = newStore()
    store.setPhase('movement')
    const carrier = toConsoleUnit({
      record: CARRIER_RECORD,
      instanceId: 'tr-1',
      hex: HEX,
      side: 'axis',
    })
    carrier.loadedSpT = SP_TO_T // 满载 1 SP（13.2g：编内卡车恒 1 SP）
    store.units.push(carrier)

    // ① 12.1b：它是一条"含 SP 的位置"
    expect(store.carriedSpDumps).toHaveLength(1)
    expect(store.carriedSpDumps[0]).toMatchObject({
      id: 'unit:tr-1',
      hex: HEX,
      side: 'axis',
      sp: 1,
      t: 0,
      carriedBy: 'tr-1',
    })
    expect(store.allSpDumps.map((dump) => dump.id)).toEqual(['unit:tr-1'])
    // ② 引擎的事实里也有它（12.3a/12.3b 的取补机制据此认得它）
    expect(store.supplyFacts.dumpsFor('axis')).toEqual([HEX])
  })

  it('★ 它可作**燃料来源**：同格的受益单位拖得到 ⇒ 进候选', () => {
    const store = newStore()
    store.setPhase('movement')
    const carrier = toConsoleUnit({
      record: CARRIER_RECORD,
      instanceId: 'tr-1',
      hex: HEX,
      side: 'axis',
    })
    carrier.loadedSpT = SP_TO_T
    const tank = toConsoleUnit({ record: TANK_RECORD, instanceId: 'tk-1', hex: HEX, side: 'axis' })
    store.units.push(carrier, tank)
    store.selectedId = 'tk-1'
    store.fuelMethod = 'singleUnit'

    expect(store.fuelTargets.map((unit) => unit.instanceId)).toEqual(['tk-1'])
    expect(store.fuelDumpChoices.map((dump) => dump.id)).toContain('unit:tr-1')
  })

  it('★ 付款**扣的是承运车的装载量**（12.1a 的 SP↔T 换算），不是 SP 账本', () => {
    const store = newStore()
    store.setPhase('movement')
    const carrier = toConsoleUnit({
      record: CARRIER_RECORD,
      instanceId: 'tr-1',
      hex: HEX,
      side: 'axis',
    })
    carrier.loadedSpT = SP_TO_T
    const tank = toConsoleUnit({ record: TANK_RECORD, instanceId: 'tk-1', hex: HEX, side: 'axis' })
    store.units.push(carrier, tank)
    store.selectedId = 'tk-1'
    store.fuelMethod = 'singleUnit'
    store.pickFuelDump('unit:tr-1')
    expect(store.fuelDump?.id).toBe('unit:tr-1')

    const dumpCountBefore = store.spDumps.length
    store.payFuel()

    // 坦克加了油（12.5c-C：单单位法本阶段有效）
    const after = store.units.find((unit) => unit.instanceId === 'tk-1')!
    expect(after.fuelled).toBe(true)
    expect(after.fuelMethod).toBe('singleUnit')
    // 承运车少了 1 T（12.5c-C：单独单位法每枚 1T）
    expect(carrier.loadedSpT).toBe(SP_TO_T - 1)
    // 没有在 SP 账本里凭空多出/少掉条目
    expect(store.spDumps.length).toBe(dumpCountBefore)
    // 用尽后即从"含 SP 的位置"里消失
    carrier.loadedSpT = 0
    expect(store.carriedSpDumps).toEqual([])
  })

  it('★ 13.2b：承运算子**自己不需要燃料**（不因"它装着油"而被要求加注）', () => {
    const store = newStore()
    const carrier = toConsoleUnit({
      record: CARRIER_RECORD,
      instanceId: 'tr-1',
      hex: HEX,
      side: 'axis',
    })
    carrier.loadedSpT = SP_TO_T
    // 12.5a/13.2b：非战斗的运输点数永不需燃料
    expect(needsFuelOf(carrier)).toBe(false)
    void store
  })

  it('★ 12.5c-B：HQ 法的候选也要含「装在运输点数上的 SP」（修前那一支只在 SP 账本里找）', () => {
    const store = newStore()
    store.setPhase('movement')
    // 承运车、指挥部、受益坦克**同格**：12.3a 同格 ⇒ HQ 一定拖得到；12.3b 投递距离 0
    const carrier = toConsoleUnit({
      record: CARRIER_RECORD,
      instanceId: 'tr-1',
      hex: HEX,
      side: 'axis',
    })
    carrier.loadedSpT = SP_TO_T
    store.units.push(
      carrier,
      toConsoleUnit({ record: HQ_RECORD, instanceId: 'hq-1', hex: HEX, side: 'axis' }),
      toConsoleUnit({ record: TANK_RECORD, instanceId: 'tk-1', hex: HEX, side: 'axis' }),
    )
    store.selectedId = 'tk-1'
    store.fuelMethod = 'hq'

    expect(store.fuelTargets.map((unit) => unit.instanceId)).toEqual(['tk-1'])
    // 12.1b：「任何含 SP 的位置（未装载或装在运输点数上）都是补给站」⇒ HQ 法这一支也得认得它
    expect(store.fuelDumpChoices.map((dump) => dump.id)).toEqual(['unit:tr-1'])
    // 12.5c-B：付得出，且扣的是承运车的装载量（12.1a 的 SP↔T 换算）
    expect(store.pickFuelDump('unit:tr-1')).toBe(true)
    store.payFuel()
    expect(store.units.find((unit) => unit.instanceId === 'tk-1')!.fuelled).toBe(true)
    expect(carrier.loadedSpT).toBeLessThan(SP_TO_T)
  })

  it('★ 13.2g-B：编内卡车的 SP 只许**同一多单位编队**内的单位拖取（同编队可拖 / 异编队为空）', () => {
    const store = newStore()
    store.setPhase('movement')

    /* 承运算子取一枚**轴方编内卡车**（数据里带编队号，如 3PZ） */
    const truckRecord = unitChoices('axis').find(
      (record) => record.noncombatKind === 'organic_truck' && typeof record.formation === 'string',
    )!
    const truck = toConsoleUnit({ record: truckRecord, instanceId: 'tr-1', hex: HEX, side: 'axis' })
    truck.loadedSpT = SP_TO_T // 满载 1 SP（编内卡车恒 1 点运力）

    /* 同编队的拖取方：数据里**同一编队号**的另一枚战斗单位 */
    const sameFormation = unitChoices('axis').find(
      (record) =>
        record.formation === truckRecord.formation &&
        record.isCombat === true &&
        record.id !== truckRecord.id,
    )!
    const mate = toConsoleUnit({
      record: sameFormation,
      instanceId: 'mate-1',
      hex: HEX,
      side: 'axis',
    })
    /* 异编队的拖取方：编队号不同（若单位库里找不到就跳过本半段） */
    const otherFormation = unitChoices('axis').find(
      (record) =>
        typeof record.formation === 'string' &&
        record.formation !== truckRecord.formation &&
        record.isCombat === true,
    )

    store.units.push(truck, mate)
    store.selectedId = 'mate-1'
    store.fuelMethod = 'singleUnit'
    // 同编队 ⇒ 这辆车在候选里（12.1b 的"含 SP 的位置" + 13.2g-B 的资格）
    expect(store.fuelDumpChoices.map((dump) => dump.id)).toContain('unit:tr-1')

    if (otherFormation !== undefined) {
      const stranger = toConsoleUnit({
        record: otherFormation,
        instanceId: 'str-1',
        hex: HEX,
        side: 'axis',
      })
      store.units.push(stranger)
      store.selectedId = 'str-1'
      // 异编队 ⇒ 这辆车**不在**候选里（13.2g-B）
      expect(store.fuelDumpChoices.map((dump) => dump.id)).not.toContain('unit:tr-1')
    }
  })
  it('★ 源码守卫：facts / 候选 / 扣款三处都接了"装载来源"，且 id 前缀是 unit:', () => {
    const store = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(store).toContain('const carriedSpDumps = computed')
    expect(store).toContain('allSpDumps.value.map((dump) => ({ hex: dump.hex, side: dump.side }))')
    /*
     * ★ 契约变更（G②，2026-09-19，**判据没放宽**）：战斗与炮击的来源候选**合并成一处**
     *   （`deliverableDumpsFor`：12.3a 直拖交集 ∪ 12.3b HQ 投递）—— 修前战斗侧那份 `sideDumps`
     *   只服务战斗、炮击侧另有一套"直拖交集"，于是 10.1b-A 的"同一指挥部"那半在炮击里根本不存在。
     *   断言随之改写：那一支仍要**按算子**过 13.2g-B（`carrierIsOrganicTruck` + `canDrawFromCarrier`）。
     */
    expect(store).toContain(
      'function deliverableDumpsFor(side: Side, beneficiaries: readonly ConsoleUnit[])',
    )
    expect(store).toContain('dump.carrierIsOrganicTruck !== true ||')
    expect(store).toContain('carrierIsOrganicTruck: true,')
    expect(store).toContain("if (id.startsWith('unit:'))")
    // 12.5c-B：**HQ 法那一支**也必须从"含 SP 的位置"里取（修前只遍历 `spDumps` ⇒ 装在车上的油取不到）
    expect(store).toContain('for (const dump of allSpDumps.value) {')
    const panel = readFileSync('src/components/move/MovePanel.vue', 'utf8')
    expect(panel).toContain('dump.carriedBy')
    expect(panel).toContain('装载在')
  })
})
