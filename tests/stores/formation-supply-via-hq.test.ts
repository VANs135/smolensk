import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { hexDistance } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * G②（P0）：**编队单位的炮击可以经 HQ 投递取得补给**（10.1b-A / 12.3b / 13.2g-B）
 *
 * ## 原文（先读再动）
 *   · **10.1b-A**：「多个单位同时轰炸时，补给必须来自**同一个指挥部**。如果不使用指挥部，则需要来自**同一个补给站**。」
 *   · **12.4**：「**直接拖取 (12.3a) 和指挥部投递 (12.3b) 都可用于**接收及分配战斗补给 (9.5)。」
 *   · **12.3b**：「能够从补给站拖取 SP 的指挥部（根据 12.3a），可以将其他单位所需补给**传递至更远处**，
 *     距离以它**印刷的投递距离**为准……或也可投递到与指挥部**相邻**（12.3c）的单位处。」
 *   · **13.2g-B**：「（编内卡车）**只允许同一多单位编队内的单位拖取**它们的 SP」＋末句「玩家**可以使用指挥部**，
 *     将装载于编内卡车的补给，投递给**同一多单位编队内**的单位。」
 *
 * ## 修前的病灶
 *   `barrageSupplyDumpChoices` 只取"每门炮都**自己**拖得到的补给站"的**交集** ⇒ 多门炮分散时（同一次火炮
 *   轰炸的常态）根本选不出来源 —— 10.1b-A 那句"来自同一个指挥部"成了一句空话（用户报的"编队单位不能
 *   正常从 HQ 获得补给"）。战斗侧虽有 HQ 投递支，但锚点取"防御格及其邻格"而不是受益单位各自的格，
 *   且编内卡车的资格是按"堆叠里有没有同编队单位"（`some`）判的，与 13.2g-B 的**按算子**口径不符。
 *
 * ## 测法边界（如实交代）
 *   · 现场**由用例自己搜**（`buildScenario`）：先用纯几何预筛（内陆格 + 距离约束），再用**引擎自己的判据**
 *     逐个试，直到找到"**没有 HQ 就没有合法来源、有 HQ 就有**"的那一组 —— 它证明"缺的正是 HQ 这一支"，
 *     而不是某个写死的坐标；找不到就抛错（不会静默退化成一个不测 HQ 的用例）；
 *   · 用真实地图与真实单位库（德 10 装甲师的炮兵与编内卡车、军级 HQ）；
 *   · 只钉**候选与付款**（10.1b-A / 12.3b）；轰炸本身的结算由既有用例覆盖；
 *   · **不覆盖界面**（仓库无组件渲染测试）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 只用**内陆格**（六邻皆图内）：地图边缘的边角地形与图外缺口会把补给路径卡死 */
const mapHexes: readonly HexRef[] = (() => {
  const all = mapLayers.hexes.map((hex) => ({ col: hex.col, row: hex.row }))
  const inside = new Set(all.map((hex) => `${hex.col}.${hex.row}`))
  return all.filter((hex) =>
    [
      { col: hex.col + 1, row: hex.row },
      { col: hex.col + 1, row: hex.row - 1 },
      { col: hex.col, row: hex.row - 1 },
      { col: hex.col - 1, row: hex.row },
      { col: hex.col - 1, row: hex.row + 1 },
      { col: hex.col, row: hex.row + 1 },
    ].every((neighbor) => inside.has(`${neighbor.col}.${neighbor.row}`)),
  )
})()

function record(
  side: 'axis' | 'soviet',
  predicate: (item: ReturnType<typeof unitChoices>[number]) => boolean,
) {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库里没有满足条件的 ${side} 记录`)
  return found
}

/** 10 装甲师的炮兵（编队单位） */
const pzArty = () => record('axis', (item) => item.vassalName === 'Ge 10.Pz 90 Arty')
/** 10 装甲师的编内卡车（13.2g：编内卡车一定属某个多单位编队） */
const pzTruck = () =>
  record('axis', (item) => item.noncombatKind === 'organic_truck' && item.formation === '10PZ')
/** 军级 HQ（12.3b：投递距离印在算子上） */
const corpsHq = () => record('axis', (item) => (item.specialized ?? []).includes('hq'))
/** 目标格上的苏军战斗单位（10.0a 的损失承受者） */
const sovietDefender = () => record('soviet', (item) => item.isCombat === true)

interface Geometry {
  dump: HexRef
  hq: HexRef
  guns: readonly [HexRef, HexRef]
  target: HexRef
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 走到 F 段（战斗段）的**炮击环节**（10.0e-D），摆好两门 10PZ 炮兵、目标格上的苏军与（可选）HQ/补给站 */
function armBarrage(
  store: ReturnType<typeof newStore>,
  geometry: { guns: readonly [HexRef, HexRef]; target: HexRef; hq?: HexRef; dump?: HexRef },
  withHq: boolean,
): void {
  store.setPhase('combat')
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'combat.barrage')
  expect(index).toBeGreaterThanOrEqual(0)
  expect(store.setSegmentStepIndex(index)).toBe(true)
  store.setBarrageActive(true)
  store.setBarrageKind('artillery')

  const gunA = toConsoleUnit({
    record: pzArty(),
    instanceId: 'gun-a',
    hex: geometry.guns[0],
    side: 'axis',
  })
  const gunB = toConsoleUnit({
    record: pzArty(),
    instanceId: 'gun-b',
    hex: geometry.guns[1],
    side: 'axis',
  })
  const defender = toConsoleUnit({
    record: sovietDefender(),
    instanceId: 'def-1',
    hex: geometry.target,
    side: 'soviet',
  })
  store.units.push(gunA, gunB, defender)
  if (withHq && geometry.hq !== undefined)
    store.units.push(
      toConsoleUnit({ record: corpsHq(), instanceId: 'hq-1', hex: geometry.hq, side: 'axis' }),
    )
  store.toggleBarrageUnit('gun-a')
  store.toggleBarrageUnit('gun-b')
  // 10.0d：轰炸目标格（与既有轰炸用例同一口径：战斗目标即轰炸目标）
  store.battleTarget = { hex: geometry.target, defenderIds: [defender.instanceId] }
  if (geometry.dump !== undefined) {
    store.spDumpDraft = { hexText: label(geometry.dump), sp: 4, t: 0 }
    store.addSpDump()
  }
  store.beginBarrageNow()
}

/** 用**引擎自己的判据**找出「HQ 投递是唯一来源」的现场（见文件头的"测法边界"） */
function buildScenario(): Geometry {
  const candidates: Geometry[] = []
  for (const dump of mapHexes) {
    for (const hq of mapHexes) {
      const hqToDump = hexDistance(hq, dump)
      if (hqToDump === 0 || hqToDump > 4) continue
      const guns = mapHexes.filter(
        (hex) => hexDistance(dump, hex) >= 6 && hexDistance(hq, hex) <= 3,
      )
      if (guns.length < 2) continue
      const first = guns[0]!
      const second = guns.find(
        (hex) => hexDistance(first, hex) === 1 && hexDistance(dump, hex) >= 6,
      )
      if (second === undefined) continue
      const target = mapHexes.find(
        (hex) =>
          hexDistance(first, hex) === 1 &&
          hexDistance(second, hex) <= 1 &&
          hexDistance(hex, hq) >= 4,
      )
      if (target === undefined) continue
      candidates.push({ dump, hq, guns: [first, second], target })
      if (candidates.length >= 40) break
    }
    if (candidates.length >= 40) break
  }
  for (const geometry of candidates) {
    const withoutHq = newStore()
    armBarrage(withoutHq, geometry, false)
    if (withoutHq.barrageSupplyDumpChoices.length !== 0) continue
    const withHq = newStore()
    armBarrage(withHq, geometry, true)
    if (withHq.barrageSupplyDumpChoices.length === 0) continue
    return geometry
  }
  throw new Error('地图上找不到「HQ 投递是唯一合法来源」的现场（用例几何前提不成立）')
}

describe('G②：炮击经 HQ 投递取补给（10.1b-A / 12.3b）', () => {
  it('★ 多门炮分散时，同一指挥部可作共同来源（修前候选为空 ⇒ 无法付补给）', () => {
    const scenario = buildScenario()
    // 几何前提（写死断言 ⇒ 地图数据改了会立刻红）
    expect(hexDistance(scenario.dump, scenario.guns[0])).toBeGreaterThanOrEqual(6)
    expect(hexDistance(scenario.dump, scenario.guns[1])).toBeGreaterThanOrEqual(6)
    expect(hexDistance(scenario.hq, scenario.guns[0])).toBeLessThanOrEqual(3)
    expect(hexDistance(scenario.hq, scenario.guns[1])).toBeLessThanOrEqual(3)
    expect(hexDistance(scenario.hq, scenario.dump)).toBeLessThanOrEqual(4)

    const store = newStore()
    armBarrage(store, scenario, true)
    // 10.1b-A：这一座站经**同一个指挥部**投递到达两门炮 ⇒ 是合法来源（`buildScenario` 已证"没有 HQ 就没有"）
    expect(store.barrageSupplyDumpChoices.map((item) => label(item.hex))).toContain(
      label(scenario.dump),
    )
    const chosen = store.barrageSupplyDumpChoices.find(
      (item) => label(item.hex) === label(scenario.dump),
    )!
    expect(store.pickBarrageSupplyDump(chosen.id)).toBe(true)
    // 付款时声明的是"来自**同一个指挥部**"（不是"同一补给站"）
    expect(store.barrageInputs.fromSameHq).toBe(true)
    expect(store.confirmBarrageSupplyStep()).toBe(true)
  })

  it('★ 对照组：同一现场**不摆 HQ** ⇒ 候选为空、付不出（不许凭空付款，12.3a）', () => {
    const scenario = buildScenario()
    const store = newStore()
    armBarrage(store, scenario, false)
    expect(store.barrageSupplyDumpChoices.length).toBe(0)
    // 没有来源 ⇒ 这一步付不出（10.1b：付不出则取消整次轰炸）
    expect(store.confirmBarrageSupplyStep()).toBe(false)
  })

  it('★ 13.2g-B：编内卡车上的 SP 只许**同一编队**的单位使用（按受益单位逐个判）', () => {
    const scenario = buildScenario()
    const store = newStore()
    armBarrage(store, { guns: scenario.guns, target: scenario.target, hq: scenario.hq }, true)
    // 编内卡车与两门炮**同编队**（10PZ）⇒ 13.2g 末句允许 HQ 把它的 SP 投递给同编队单位
    const truck = toConsoleUnit({
      record: pzTruck(),
      instanceId: 'truck-1',
      hex: scenario.hq,
      side: 'axis',
    })
    store.units.push(truck)
    store.spDumps.push({
      id: 'carrier-1',
      hex: { ...scenario.hq },
      side: 'axis',
      sp: 4,
      t: 0,
      carrierIsOrganicTruck: true,
      carrierFormation: '10PZ',
      carriedBy: truck.instanceId,
    })
    expect(store.beginBarrageNow()).toBe(true)
    expect(store.barrageSupplyDumpChoices.map((item) => item.id)).toContain('carrier-1')

    // 把卡车改成**另一个**编队（3PZ）⇒ 受益单位（10PZ 的两门炮）不全在其编队内 ⇒ 不许用
    const carrier = store.spDumps.find((item) => item.id === 'carrier-1')!
    carrier.carrierFormation = '3PZ'
    store.spDumps = [...store.spDumps]
    expect(store.barrageSupplyDumpChoices.map((item) => item.id)).not.toContain('carrier-1')
  })
})
