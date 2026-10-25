import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  actionGateOf,
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

/**
 * B15d/B15e：**空军任务链**与**补给检查链**进会话框（五小批之四、五）
 *
 * 两条链各补一个缺口，做法与 B15b/c 同形——但**多一层分寸**：
 *   ① **空军任务链**（14.2f 宣布与七步）进会话：判据＝工具开着 +（任务在跑 或 已选机待宣布）。
 *      摆放/整备/修建/缩减/夺取这些**事务性动作留在侧栏**（它们不是"某一次行动的收束"，
 *      放进会话框会随任务开合而忽隐忽现 ⇒ 入口反而不可达）——故 `AirPanel` 增 `only` 分段。
 *   ② **补给检查链**（12.6 → 12.3 → 12.6c/d）进会话：判据＝`supplyState !== null`；
 *      账本与事务（账本 / 运输点 / 补给源 / 轨距 / 铁路 / D 段总计划）与**入口**（受补给单位阵列）
 *      留在侧栏——入口必须随时可达，会话只在检查开始后才存在 ⇒ `SupplyPanel` 增 `only` 分段。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

/** B8：把 store 放到本段里允许做该动作的那个环节 */
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

/** 六邻皆图内的格（放基地与飞机） */
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

/** 轴心国空军基地算子（15.0：摆放时按己方决定归属） */
function airBaseRecord() {
  const found = unitChoices('axis').find((record) => record.noncombatKind === 'air_base')
  if (found === undefined) throw new Error('单位库中没有空军基地算子')
  return found
}

function fighterRecord(side: Side) {
  const found = aircraftChoices(side).find((record) => record.aircraftType === 'F')
  if (found === undefined) throw new Error(`${side} 飞机库中没有战斗机`)
  return found
}

function combatRecord(side: Side) {
  const found = unitChoices(side).find(
    (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) >= 1,
  )
  if (found === undefined) throw new Error(`${side} 单位库中没有战斗单位`)
  return found
}

function hqRecord() {
  const found = unitChoices('axis').find((record) => (record.specialized ?? []).includes('hq'))
  if (found === undefined) throw new Error('轴心国单位库中没有指挥部')
  return found
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B15d：空军任务链进会话框', () => {
  it('★ 选入一架待宣布的飞机 ⇒ 出现「空军任务」会话；没选机则不出现', () => {
    const { workbench, mapView } = newStores()
    workbench.setAirActive(true)
    workbench.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
    )
    const plane = toConsoleAirUnit({
      aircraft: fighterRecord('axis'),
      instanceId: 'air-1',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'active',
    })
    workbench.airUnits.push(plane)

    expect(mapView.session).toBeNull()
    workbench.toggleAirMissionUnit(plane.instanceId)
    expect(mapView.session).toMatchObject({ kind: 'air', rule: '14.2f-A' })
    expect(mapView.session?.title).toContain('空军任务')
  })

  it('★ 会话取消 ⇒ 走 `cancelAir`（退掉选机与任务格），会话随之消失', () => {
    const { workbench, mapView } = newStores()
    workbench.setAirActive(true)
    const plane = toConsoleAirUnit({
      aircraft: fighterRecord('axis'),
      instanceId: 'air-1',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'active',
    })
    workbench.airUnits.push(plane)
    workbench.toggleAirMissionUnit(plane.instanceId)
    workbench.setAirTargetFromText(label(CORE_HEX))
    expect(mapView.session?.kind).toBe('air')

    expect(mapView.cancelSession()).toBe(true)
    expect(workbench.airMissionAirIds).toEqual([])
    expect(workbench.airTargetHex).toBeNull()
    expect(mapView.session).toBeNull()
  })

  it('任务起跑后会话仍在（规则号从 14.2f-A 变成 14.2f）', () => {
    const { workbench, mapView } = newStores()
    workbench.setAirActive(true)
    workbench.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
    )
    const plane = toConsoleAirUnit({
      aircraft: fighterRecord('axis'),
      instanceId: 'air-1',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'active',
    })
    workbench.airUnits.push(plane)
    workbench.setAirTargetFromText(label(CORE_HEX))
    workbench.toggleAirMissionUnit(plane.instanceId)

    expect(workbench.beginAirMissionNow()).toBe(true)
    expect(mapView.session).toMatchObject({ kind: 'air', rule: '14.2f' })
  })
})

describe('B15e：补给检查链进会话框', () => {
  /** 摆一个本单位 + 同格补给站 + 补给源声明，并开始检查 */
  function setupCheck() {
    const stores = newStores()
    const { workbench } = stores
    workbench.setSupplyActive(true)
    const unit = toConsoleUnit({
      record: combatRecord('axis'),
      instanceId: 'u1',
      hex: CORE_HEX,
      side: 'axis',
    })
    workbench.units.push(unit)
    workbench.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    workbench.addSpDump()
    workbench.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'supplySourceHex' }
    workbench.addSupplySource()
    workbench.setPhase('supply')
    goToActionStep(workbench, 'supply.draw')
    return { ...stores, unit }
  }

  it('★ 检查前没有**补给检查**会话；开始对某单位做检查 ⇒ 出现「补给检查」会话', () => {
    const { workbench, mapView, unit } = setupCheck()
    /*
     * B37：D 补给段现在会**自动**弹出「专规动作」窗（1.7 补给缓存的可做时机就在这里）⇒
     * 不能再说"一个会话都没有"；本条要钉的是**还没有补给检查会话**。
     */
    expect(mapView.session?.kind).not.toBe('supply')

    expect(workbench.beginSupplyCheckNow(unit.instanceId)).toBe(true)
    expect(mapView.session).toMatchObject({ kind: 'supply', rule: '12.0' })
    expect(mapView.session?.title).toContain('补给检查')
  })

  it('★ 会话取消 ⇒ 走 `cancelSupply`（清掉本次检查与输入）', () => {
    const { workbench, mapView, unit } = setupCheck()
    expect(workbench.beginSupplyCheckNow(unit.instanceId)).toBe(true)
    expect(mapView.session?.kind).toBe('supply')

    expect(mapView.cancelSession()).toBe(true)
    expect(workbench.supplyState).toBeNull()
    expect(workbench.supplyUnitId).toBeNull()
    /*
     * B37：D 补给段会自动弹出「专规动作」窗（1.7 补给缓存）⇒ 收起补给检查后，
     * 屏幕上剩下的是那个专规窗（不是一个会话都没有）——本条钉的是**补给检查会话已消失**。
     */
    expect(mapView.session?.kind).not.toBe('supply')
  })

  it('★ HQ 投递的付款站仍走既有 12.3b（会话里的链与面板同源）', () => {
    const { workbench } = newStores()
    workbench.setSupplyActive(true)
    workbench.units.push(
      toConsoleUnit({ record: hqRecord(), instanceId: 'hq-1', hex: CORE_HEX, side: 'axis' }),
    )
    const target = toConsoleUnit({
      record: combatRecord('axis'),
      instanceId: 'u1',
      hex: CORE_HEX,
      side: 'axis',
    })
    workbench.units.push(target)
    workbench.spDumpDraft = { hexText: label(CORE_HEX), sp: 2, t: 0 }
    workbench.addSpDump()
    workbench.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'supplySourceHex' }
    workbench.addSupplySource()
    workbench.setPhase('supply')
    goToActionStep(workbench, 'supply.draw')
    expect(workbench.beginSupplyCheckNow(target.instanceId)).toBe(true)

    const throwIndex = workbench.supplySources.findIndex((source) => source.kind === 'hqThrow')
    expect(throwIndex).toBeGreaterThanOrEqual(0)
    expect(workbench.chooseSupplySourceNow(throwIndex)).toBe(true)
    expect(workbench.supplyState?.step).toBe('pickup')
    expect(workbench.supplyPayDumpCandidates.length).toBeGreaterThan(0)
  })
})

describe('B15d/B15e：分段渲染与视图接线（源码守卫）', () => {
  it('两个面板各支持 `only` 分段，且默认全渲染（引擎验证页不受影响）', () => {
    const air = readFileSync('src/components/air/AirPanel.vue', 'utf8')
    /*
     * ★ 用户 2026-10-25「一个操作一个面板」：`only` 从两段（mission/admin）扩到
     * mission + admin + place/refit/airstrip/reduce/capture 五个**基地操作**小节
     * （15.1 整备 / 15.3 修建 / 15.4 缩减 / 9.14f 夺取 / 14.1a 摆放）。
     */
    expect(air).toContain("'mission'")
    expect(air).toContain("'admin'")
    for (const only of ["'place'", "'refit'", "'airstrip'", "'reduce'", "'capture'"]) {
      expect(air, `AirPanel 缺 ${only} 分段`).toContain(only)
    }
    expect(air).toContain('showsMission')
    expect(air).toContain('showsBaseOps')

    const supply = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')
    expect(supply).toContain("only?: 'check' | 'ledger' | null")
    expect(supply).toContain('showsCheck')
    expect(supply).toContain('showsLedger')
  })

  it('★ 条 12（M2）：右栏只读——事务段收进 `unit` 会话，地图会话只画动作段', () => {
    const view = readFileSync('src/views/GameTableView.vue', 'utf8')
    // 右栏（aside）不再有可写入口：admin / ledger 已移出（B15d/B15e 的"侧栏常驻"被条 12 取代）
    expect(view).not.toContain('<AirPanel only="admin" />')
    expect(view).not.toContain('<SupplyPanel only="ledger" />')
    // 点非战斗单位 ⇒ `unit` 会话，按类型分派到 UnitPanel
    expect(view).toContain('<UnitPanel v-else-if="session.kind === \'unit\'" />')
    // 空军任务 / 补给检查仍各按"动作段"进会话
    expect(view).toContain("session.kind === 'air'")
    expect(view).toContain("session.kind === 'supply'")
    expect(view).toContain('<AirPanel v-else-if="session.kind === \'air\'" only="mission" />')
    expect(view).toContain('<SupplyPanel v-else-if="session.kind === \'supply\'" only="check" />')

    // UnitPanel 把右栏原可写面板按单位类型收进会话（sp/运输点/延补队⇒ledger；基地⇒操作菜单+分段；工事⇒actions）
    const unit = readFileSync('src/components/game/UnitPanel.vue', 'utf8')
    expect(unit).toContain("mapView.unitActionFamily === 'supply'")
    expect(unit).toContain("mapView.unitActionFamily === 'air'")
    expect(unit).toContain("mapView.unitActionFamily === 'fort'")
    expect(unit).toContain('only="ledger"')
    expect(unit).toContain('only="actions"')
    /*
     * ★ 用户 2026-10-25「一个操作一个面板」：点基地**不再**一次铺开整块 AirPanel，
     *   而是先给"这个基地此刻能做的事"（判据＝设施动作族 ∩ 本环节闸门），挑定一项才展开那一段。
     */
    expect(unit).toContain('unitActionOptions')
    expect(unit).toContain(':only="airOnly"')
  })

  it('入口必须随时可达：受补给单位阵列留在**账本段**（会话只在检查开始后存在）', () => {
    const supply = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')
    const ledgerStart = supply.indexOf('v-if="showsLedger"')
    const checkStart = supply.indexOf('v-if="showsCheck"')
    const pickerAt = supply.indexOf('workbench.beginSupplyCheckNow($event)')
    expect(ledgerStart).toBeGreaterThan(0)
    expect(pickerAt).toBeGreaterThan(ledgerStart)
    expect(pickerAt).toBeLessThan(checkStart)
  })

  it('空军事务段（摆放/整备/修建/缩减/夺取）留在 admin 段', () => {
    const air = readFileSync('src/components/air/AirPanel.vue', 'utf8')
    const adminStart = air.indexOf('v-if="showsAdmin"')
    const missionStart = air.indexOf('v-if="showsMission"')
    for (const marker of [
      'workbench.addAirUnit(',
      'workbench.beginRefitNow(',
      'workbench.buildAirBaseNow(',
      'workbench.reduceBaseNow(',
      'workbench.captureAirBaseNow(',
    ]) {
      const at = air.indexOf(marker)
      expect(at, `${marker} 应在 admin 段`).toBeGreaterThan(adminStart)
      // 事务动作不在 mission 段里（mission 段在 admin 段之后）
      expect(at < missionStart || at > adminStart).toBe(true)
    }
  })
})
