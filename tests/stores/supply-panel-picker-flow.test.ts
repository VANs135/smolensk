import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

/**
 * B14d：补给面板迁移到 `CounterPicker`（用户口径⑪ 后半，四小批之四）
 *
 * 本文件钉三件事（组件是纯投影，真正的风险在**数据是否够**、**分组是否成立**、**点选是否接线**）：
 *   ① **合并/拆分的点选真的接线**：阵列里点两枚 ⇒ 走 13.2c 的合并、真出 5 点算子；
 *   ② **付款补给站的点选/取消**：阵列没有"（自动）"空档 ⇒ 点同一座即回到自动（新动作 `toggleSupplyPayDump`），
 *      且点完仍走**同一条** 12.3b 付款链（账本真扣）；
 *   ③ **来源清单的分组**：12.3a/b/c/d 的五类来源各成一组（用户④"页面太多就加下拉切换"），
 *      组键＝引擎给的 `kind`，组名走 store 的 `supplySourceKindLabel`；不可用者带规则号灰显。
 * 另钉 **12.11a 的"每阶段每站一次"**——它是阵列里唯一会灰显的补给站原因，必须有账本支撑。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 六邻皆图内的格：单位与补给站同格 ⇒ 距离 0，断言不受地形影响 */
const CORE_HEX: HexRef = (() => {
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

function combatRecord(side: Side): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(
    (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) >= 1,
  )
  if (found === undefined) throw new Error(`${side} 单位库中没有战斗单位`)
  return found
}

function hqRecord(): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('axis').find((record) => (record.specialized ?? []).includes('hq'))
  if (found === undefined) throw new Error('轴心国单位库中没有指挥部')
  return found
}

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

/** 摆一枚运输点数算子（按型号与规模取真实记录） */
function placeTransportPoint(
  store: ReturnType<typeof newStore>,
  kind: 'truck' | 'wagon',
  size: number,
  id: string,
): ConsoleUnit {
  const record = unitChoices('axis').find(
    (item) =>
      item.noncombatDetails?.transport === size &&
      (item.noncombatDetails?.transportKind ?? null) === kind,
  )
  if (record === undefined) throw new Error(`单位库没有 ${kind} ${size} 运输点数算子`)
  return place(store, record, CORE_HEX, 'axis', id)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B14d：运输点数阵列（13.2c 合并 / 拆分）', () => {
  it('★ 阵列里点两枚 ⇒ 走 13.2c 的合并，真出 5 点算子（点选不是装饰）', () => {
    const store = newStore()
    store.setPhase('movement')
    const a = placeTransportPoint(store, 'truck', 2, 'tp-2')
    const b = placeTransportPoint(store, 'truck', 3, 'tp-3')

    // 面板的合并阵列：selected 跟 `transportPointInputs.mergeIds` 走，pick 直连 `toggleTransportMerge`
    store.toggleTransportMerge(a.instanceId)
    store.toggleTransportMerge(b.instanceId)
    expect(store.transportPointInputs.mergeIds).toEqual([a.instanceId, b.instanceId])

    expect(store.mergeTransportPointsNow()).toBe(true)
    const merged = store.transportPointsOfSide
    expect(merged).toHaveLength(1)
    expect(merged[0]!.noncombatTransport).toBe(5)
  })

  it('拆分对象：点一枚即写进 `splitId`，且该枚确实按份数被拆开', () => {
    const store = newStore()
    store.setPhase('movement')
    const point = placeTransportPoint(store, 'truck', 5, 'tp-5')

    // 面板的拆分阵列：pick ⇒ `transportPointInputs.splitId = id`
    store.transportPointInputs = {
      ...store.transportPointInputs,
      splitId: point.instanceId,
      splitSizesText: '2 3',
    }
    expect(store.splitTransportPointNow()).toBe(true)
    const sizes = store.transportPointsOfSide.map((unit) => unit.noncombatTransport).sort()
    expect(sizes).toEqual([2, 3])
  })
})

describe('B14d：付款补给站的点选/取消（12.3b）', () => {
  /** 摆出「HQ + 目标单位 + 同格补给站 + 补给源声明」，走到 12.3b 的 pickup 步 */
  function setupThrow() {
    const store = newStore()
    store.setSupplyActive(true)
    place(store, hqRecord(), CORE_HEX, 'axis', 'hq-1')
    const target = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    store.addSpDump()
    store.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'supplySourceHex' }
    store.addSupplySource()
    store.setPhase('supply')
    expect(store.beginSupplyCheckNow(target.instanceId)).toBe(true)
    const throwIndex = store.supplySources.findIndex((source) => source.kind === 'hqThrow')
    expect(throwIndex).toBeGreaterThanOrEqual(0)
    expect(store.chooseSupplySourceNow(throwIndex)).toBe(true)
    expect(store.supplyState?.step).toBe('pickup')
    return { store, target }
  }

  it('点一座即指定；再点同一座即回到「自动」（`payFromDumpId: null`）', () => {
    const { store } = setupThrow()
    const candidates = store.supplyPayDumpCandidates
    expect(candidates.length).toBeGreaterThan(0)
    const id = candidates[0]!.id

    expect(store.supplyInputs.payFromDumpId).toBeNull()
    store.toggleSupplyPayDump(id)
    expect(store.supplyInputs.payFromDumpId).toBe(id)
    store.toggleSupplyPayDump(id)
    expect(store.supplyInputs.payFromDumpId).toBeNull()
  })

  it('★ 点选之后走**同一条** 12.3b 付款链：账本从该站扣（不是换了层皮）', () => {
    const { store } = setupThrow()
    const dumpId = store.supplyPayDumpCandidates[0]!.id
    store.toggleSupplyPayDump(dumpId)
    /*
     * ★ 契约变更（批 B 切片 2，裁定⑤「获取即付款」）：燃料的 T 数由 12.5c-C 的费率给（1 T），
     *   玩家填的 2 不再生效 ⇒ 断言随之改为"扣 1 T"。判据不是放宽：费率投影本身也被断言。
     */
    store.supplyInputs.amountT = 2
    store.supplyInputs.purpose = 'fuel'
    expect(store.supplyPickupRequirement).toMatchObject({ t: 1, manual: false })
    expect(store.confirmSupplyPickupNow()).toBe(true)
    // 1 SP = 4 T 起始、按费率付 1 T ⇒ 站上剩 3 T（12.1a 的规范化会把它记成 t=3）
    expect(store.spDumps[0]).toMatchObject({ id: dumpId, sp: 0, t: 3 })
  })
})

describe('B14d：来源清单的分组（12.3a/b/c/d）', () => {
  it('★ 组键＝引擎给的 `kind`，组名各有其人（这就是"加下拉切换"的依据）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    place(store, hqRecord(), CORE_HEX, 'axis', 'hq-1')
    const target = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    store.addSpDump()
    store.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'supplySourceHex' }
    store.addSupplySource()
    store.setPhase('supply')
    expect(store.beginSupplyCheckNow(target.instanceId)).toBe(true)

    const kinds = [...new Set(store.supplySources.map((source) => source.kind))]
    // 本夹具体例下至少同时有"直接拖取"与"指挥部投递"两类 ⇒ 面板会出现分组下拉
    expect(kinds).toContain('dump')
    expect(kinds).toContain('hqThrow')
    const labels = kinds.map((kind) => store.supplySourceKindLabel(kind))
    expect(labels.every((text) => text !== '')).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('不可用来源带规则号与原因（阵列里灰显的那一类）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    // 既没有补给站、也没有 HQ ⇒ 只剩"吃图上补给"之类不可用的来源
    const target = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    store.setPhase('supply')
    expect(store.beginSupplyCheckNow(target.instanceId)).toBe(true)
    const bad = store.supplySources.filter((source) => !source.ok)
    expect(bad.length).toBeGreaterThan(0)
    for (const source of bad) {
      expect(source.rule).not.toBe('')
      expect(source.reason ?? source.detail).not.toBe('')
    }
  })
})

describe('B14d：12.11a 的"每阶段每站一次"有账本支撑（阵列灰显的依据）', () => {
  it('★ 销毁一次后账本记 1；再试同一座被拒（灰显不是凭空写的）', () => {
    const store = newStore()
    store.setPhase('movement')
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 2, t: 0 }
    store.addSpDump()
    const dumpId = store.spDumps[0]!.id

    expect(store.dumpDestructionAttempts[dumpId] ?? 0).toBe(0)
    store.destructDumpNow(dumpId, 4, 6)
    expect(store.dumpDestructionAttempts[dumpId] ?? 0).toBeGreaterThan(0)
    // 12.11a：每阶段每站一次 ⇒ 第二次被拒（面板据此灰显）
    expect(store.destructDumpNow(dumpId, 4, 6)).toBe(false)
  })
})

describe('B14d：补给面板的替换（源码守卫）', () => {
  const panel = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')

  it('七处「选算子」都改走 `CounterPicker`，旧的下拉 / 文字复选框已删', () => {
    expect(panel.match(/<CounterPicker/g)?.length ?? 0).toBeGreaterThanOrEqual(7)
    expect(panel).not.toContain('<select v-model="destroyDumpId"')
    expect(panel).not.toContain('<select v-model="workbench.transportLoadInputs.pointId"')
    expect(panel).not.toContain('<select v-model="convertExtenderId"')
    expect(panel).not.toContain('<select v-model="gaugeUnitId"')
    expect(panel).not.toContain('<select v-model="workbench.railMoveInputs.fromDumpId"')
    expect(panel).not.toContain('<select v-model="workbench.supplyInputs.payFromDumpId"')
    expect(panel).not.toContain('v-for="unit in checkCandidates"')
    expect(panel).not.toContain('v-for="unit in workbench.transportPointsOfSide"')
    expect(panel).not.toContain('v-for="(source, index) in workbench.supplySources"')
    // 点选直连 store 的动作
    expect(panel).toContain('@pick="workbench.toggleSupplyPayDump($event)"')
    expect(panel).toContain('@pick="workbench.chooseSupplySourceNow(Number($event))"')
    expect(panel).toContain('@pick="workbench.toggleTransportMerge($event)"')
  })

  it('★ 来源清单带**分组下拉**（组键＝引擎的 kind，组名走 store 的标签）', () => {
    expect(panel).toContain('groupKey: source.kind')
    expect(panel).toContain('workbench.supplySourceKindLabel(source.kind)')
  })

  it('悬停走既有通道：算子/补给站走 `setHoverHex`，来源走 `setSupplyPreview`（12.3d 的地图预览）', () => {
    expect(panel).toContain('workbench.setHoverHex')
    expect(panel).toContain('workbench.setSupplyPreview')
    expect(panel.match(/@hover="hoverUnit"/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })
})
