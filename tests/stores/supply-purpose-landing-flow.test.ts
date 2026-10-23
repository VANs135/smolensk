import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { SP_TO_T } from '@/engine/rules'
import {
  needsFuelOf,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * 批 B 切片 2：**12.3 的用途落地**（用户 2026-09-17 夜六条裁定）
 *
 * 原文依据：
 *   · **12.3 重要提示**：「在玩家任何需要补给（追溯补给、**燃料**、**战斗**、建造、补充部队储备，
 *     或**飞机整备**）的时候，都需要使用直接拖取和指挥部投递中的同一种相同的机制进行补给」
 *     ⇒ **获取与用途是同一个动作的两面**；
 *   · **12.3b-A**：「指挥部只能投递**需要立即被使用**的补给」⇒ 裁定②（不允许预取）有原文支撑；
 *   · **12.4**：攻方每攻击军力 1T / 守方每场 2T（≤1RE 1T）；
 *   · **12.5c-C**：单独单位法每单位 1T，且**只在本阶段有效**；
 *   · **13.2g-B**：编内卡车的 SP 只许**同一多单位编队**内的单位拖取。
 *
 * 病灶：`confirmSupplyPickupNow` 扣完款就结束（既没置 `fuelled`、也没记"该场战斗已付"）
 * ⇒ 玩家看到「扣了 SP 但单位还是不能走」。
 *
 * ## 测法边界（如实交代）
 *   · 用真实地图与真实单位库；"同格"构造（12.3a 相邻即可）⇒ 判据不受地形造价影响；
 *   · **不覆盖** 12.4 战斗会话内的付款链（那条由 `combat-interaction-flow` / `internal-stocks-flow`
 *     等既有套件覆盖；本切片只把"本链不付战斗补给"钉住）；
 *   · **不覆盖**组件渲染（本仓库不挂组件渲染测试）⇒ "面板不再给 T 数输入/勾选框"由源码守卫承担。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 六邻皆图内的格（角落格在补给路径上走不通，见 B32 步骤 2 的教训） */
const HEX: HexRef = (() => {
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

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 轴方**耗油**的战斗单位（12.5a：轮式/履带） */
const tankRecord = () =>
  unitChoices('axis').find(
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.classes?.movementClass === 'tracked' || record.classes?.movementClass === 'truck'),
  )!

function place(instanceId: string, hex: HexRef, record = tankRecord()): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side: 'axis' })
  useWorkbenchStore().units.push(unit)
  return unit
}

/** 摆一座"引擎认的"补给站（12.1b：含 SP 的位置即补给站） */
function putDump(store: ReturnType<typeof newStore>, sp: number, hex: HexRef = HEX): string {
  const id = `dump-${hex.col}-${hex.row}`
  store.spDumpDraft = { hexText: label(hex), sp, t: 0 }
  expect(store.addSpDump()).toBe(true)
  return id
}

/**
 * 把某单位带到「选来源」这一步
 *
 * 12.6a①：同格声明一处基础补给源 ⇒ 该单位**有追溯补给**（否则会走 12.6c/d 的断补分支，
 * 停在 `resolveOos` 而不是 `selectSource`）。
 */
function armSupplyCheck(store: ReturnType<typeof newStore>, unitId: string): number {
  store.supplySourceDraft = { hexText: label(HEX), kind: 'supplySourceHex' }
  expect(store.addSupplySource()).toBe(true)
  expect(store.beginSupplyCheckNow(unitId)).toBe(true)
  const index = store.supplySources.findIndex((source) => source.kind === 'dump')
  expect(index).toBeGreaterThanOrEqual(0)
  return index
}

/** 把 store 放到本段里允许做该动作的那个环节 */
function goToActionStep(store: ReturnType<typeof newStore>, key: 'supply' | 'move'): void {
  const index = store.playerSegmentSteps.findIndex((step) => {
    if (key === 'supply') return step.id === 'supply.traceAndDraw'
    return step.id === 'movement.modeAndMovement'
  })
  if (index < 0) throw new Error(`本段没有 ${key} 的环节`)
  expect(store.setSegmentStepIndex(index)).toBe(true)
}

describe('批 B 切片 2：12.3 的用途落地（燃料 ⇒ 真的能走了）', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
    store.setSupplyActive(true)
  })

  it('★ 燃料用途**落到状态**：拖取后置 fuelled（12.5c-C），账本扣 1 T（费率而非手填）', () => {
    const tank = place('t1', HEX)
    const dumpId = putDump(store, 1)
    store.setPhase('supply')
    const dumpIndex = armSupplyCheck(store, 't1')
    expect(store.chooseSupplySourceNow(dumpIndex)).toBe(true)

    // 修前：`fuelled` 一直是 false（扣完款就结束）⇒ 12.5a 仍然拦着"耗 MP"
    expect(tank.fuelled).toBe(false)
    expect(needsFuelOf(tank)).toBe(true)
    store.supplyInputs.purpose = 'fuel'
    store.supplyInputs.amountT = 99 // 手填值不生效（费率说了算）
    expect(store.supplyPickupRequirement).toMatchObject({ t: 1, rule: '12.5c-C', manual: false })
    expect(store.confirmSupplyPickupNow()).toBe(true)

    expect(tank.fuelled).toBe(true)
    expect(tank.fuelMethod).toBe('singleUnit') // 12.5c-C：只在本阶段有效
    expect(store.spDumps[0]).toMatchObject({ sp: 0, t: 3 })
    expect(dumpId).toContain('dump') // 夹具自证：摆的确实是那一座站
    expect(store.log.some((entry) => entry.text.includes('已加注'))).toBe(true)
  })

  it('★★ 可玩通：同一套费率下加油后**立刻能开拔**（12.5c-C 在本阶段内有效）', () => {
    place('t1', HEX)
    // ★ 为什么在**移动段**做这件事：12.3 的拖取/投递链（`supply.draw`）只在 **D 段**放行
    //   （B8 闸门表），而 12.5c-C 的单单位法**只在本阶段有效** ⇒ "取完就走"只能在同一个阶段里成立。
    //   移动段的加油走 12.5c 三法（`payFuel`，与 12.3 链共用同一份费率）。
    store.setPhase('movement')
    goToActionStep(store, 'move')
    putDump(store, 1)

    // 12.5a：未加注 ⇒ 开拔被拒（用户的"单位动不了"）
    store.beginMovePick(HEX, ['t1'])
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveBlocked?.rule).toBe('12.5a')

    // 12.5c-C：当场付 1 T ⇒ 立刻开拔（不必再点第二次）
    const fuelDumpId = store.fuelDumpChoices[0]?.id
    expect(fuelDumpId).toBeDefined()
    expect(store.pickFuelDump(fuelDumpId!)).toBe(true)
    store.payFuel('singleUnit', false)
    expect(store.units.find((unit) => unit.instanceId === 't1')!.fuelled).toBe(true)
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction).not.toBeNull()
    expect(store.moveInteraction!.unitIds).toEqual(['t1'])
  })

  it('★ 12.5c-C 的时限：D 段付的油**过不了阶段**（这是规则，不是缺陷）', () => {
    const tank = place('t1', HEX)
    putDump(store, 1)
    store.setPhase('supply')
    const dumpIndex = armSupplyCheck(store, 't1')
    expect(store.chooseSupplySourceNow(dumpIndex)).toBe(true)
    store.supplyInputs.purpose = 'fuel'
    expect(store.confirmSupplyPickupNow()).toBe(true)
    expect(tank.fuelled).toBe(true)

    // 12.5c-C「只在本阶段有效」+ 12.5d（单单位法不进编队标记）⇒ 换阶段即失效。
    // 想让单位在**下一个移动段**开拔，规则上应走 12.5c-A/B（编队法 / HQ 法，持续到本方清理阶段）。
    store.setPhase('movement')
    expect(tank.fuelled).toBe(false)
  })

  it('★ 裁定⑥：本链选「战斗补给」被拒并给 12.4，账本分毫不动', () => {
    const tank = place('t1', HEX)
    putDump(store, 1)
    store.setPhase('supply')
    const dumpIndex = armSupplyCheck(store, 't1')
    expect(store.chooseSupplySourceNow(dumpIndex)).toBe(true)
    store.supplyInputs.purpose = 'combat'
    expect(store.supplyPickupRequirement).toBeNull()
    expect(store.confirmSupplyPickupNow()).toBe(false)
    expect(store.spDumps[0]).toMatchObject({ sp: 1, t: 0 })
    expect(tank.fuelled).toBe(false)
  })

  it('★ 裁定③（13.2g-B）：编内卡车**同编队**可拖、异编队被标成因', () => {
    const truckRecord = unitChoices('axis').find(
      (record) => record.noncombatKind === 'organic_truck' && typeof record.formation === 'string',
    )!
    const formation = truckRecord.formation as string
    const truck = toConsoleUnit({ record: truckRecord, instanceId: 'tr-1', hex: HEX, side: 'axis' })
    truck.loadedSpT = SP_TO_T // 13.2h 满载 1 SP
    store.units.push(truck)

    // 同编队的拖取者（12.1b + 13.2g-B）
    const mateRecord = unitChoices('axis').find(
      (record) =>
        record.formation === formation &&
        record.isCombat === true &&
        record.id !== truckRecord.id &&
        (record.classes?.movementClass === 'tracked' || record.classes?.movementClass === 'truck'),
    )
    if (mateRecord === undefined) throw new Error('数据里找不到同编队的战斗单位')
    const mate = toConsoleUnit({ record: mateRecord, instanceId: 'mate-1', hex: HEX, side: 'axis' })
    store.units.push(mate)

    store.setPhase('supply')
    store.supplySourceDraft = { hexText: label(HEX), kind: 'supplySourceHex' }
    expect(store.addSupplySource()).toBe(true)
    expect(store.beginSupplyCheckNow('mate-1')).toBe(true)
    const mateSources = store.supplySources.filter((source) => source.kind === 'dump')
    expect(mateSources.length).toBeGreaterThan(0)
    // 同编队 ⇒ 这辆卡车是**可用来源**（12.1b：含 SP 的位置即补给站）
    expect(mateSources.some((source) => source.ok)).toBe(true)

    // 异编队：同一辆卡车对它是 **ok: false** 且写明 13.2g-B（不是静默消失）
    const strangerRecord = unitChoices('axis').find(
      (record) =>
        record.isCombat === true &&
        typeof record.formation === 'string' &&
        record.formation !== formation,
    )
    if (strangerRecord === undefined) throw new Error('数据里找不到异编队的战斗单位')
    const stranger = toConsoleUnit({
      record: strangerRecord,
      instanceId: 'str-1',
      hex: HEX,
      side: 'axis',
    })
    store.units.push(stranger)
    expect(store.beginSupplyCheckNow('str-1')).toBe(true)
    const blocked = store.supplySources.filter((source) => source.kind === 'dump')
    expect(blocked.length).toBeGreaterThan(0)
    expect(blocked.every((source) => source.ok === false)).toBe(true)
    expect(blocked[0]!.rule).toBe('13.2g-B')
    expect(store.chooseSupplySourceNow(store.supplySources.indexOf(blocked[0]!))).toBe(false)
  })

  it('源码守卫（裁定⑤）：T 数输入只在"数量即内容"的用途上出现，费率来自引擎', () => {
    const panel = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')
    // 用途清单里没有"战斗补给"这一项（裁定⑥：只在战斗会话内付）
    expect(panel).not.toContain("{ key: 'combat',")
    // T 数手填框只在 `pickupRequirement.manual` 时渲染
    expect(panel).toContain('pickupRequirement.manual')
    const engineSource = readFileSync('src/stores/workbench.ts', 'utf8')
    // 费率取自引擎的 12.5c 计价（不在 store 里写死 1T）
    expect(engineSource).toContain("computeFuelCost({ method: 'singleUnit', unitsNeedingFuel: 1 })")
  })
})
