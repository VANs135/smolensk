import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import { createMapFacts, holdingsToT, selectMovementTerrain } from '@/engine/rules'
import {
  actionGateOf,
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * B14b：轰炸面板迁移到 `CounterPicker`（用户口径⑪ 后半）
 *
 * 本文件钉三件事（组件是纯投影，真正的风险在**数据是否够**、**灰显原因是否与引擎同源**、
 * **点选是否真的接线到引擎**）：
 *   ① **参炸单位 / 参炸飞机的候选与灰显原因**：候选集与 13.4a / 14.1 的判据都由 store 给
 *      （面板不再自己 `filter(unit.raw.barrage > 0)`，也不再自己算航程）；
 *   ② **付款补给站的点选/取消**：阵列没有"未声明"空档 ⇒ 点同一座站即取消（新动作 `toggleBarrageSupplyDump`），
 *      且点完就走**同一条** 10.1b 付款链——账本**真扣**（否则阵列只是换了层皮）；
 *   ③ **源码守卫**：四处阵列落地、旧下拉删除、面板里不再出现规则判据。
 */

/** B8：把 store 放到**本段里允许做该动作的那个环节**（不写死环节名/序号） */
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

/** 地图事实（判"能不能进"用；与既有轰炸测试同一路） */
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

/** 六邻皆图内的格（目标格） */
const TARGET_HEX: HexRef = (() => {
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

/** 参炸格：目标格的图内邻格（10.0b 观察员也要求相邻；10.1a 射程按格） */
const FIRING_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(TARGET_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)) {
      continue
    }
    if (canEnter('leg', candidate, TARGET_HEX)) return candidate
  }
  throw new Error('目标格没有可进入的图内邻格')
})()

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

/** 有印刷轰炸值的火炮（10.0e-B：不得低于印刷值轰炸） */
function artilleryRecord(side: 'axis' | 'soviet'): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
  )
  if (found === undefined) throw new Error(`${side} 单位库中没有带轰炸值的火炮`)
  return found
}

/** 可轰炸的机（10.0e-F 的空军一类） */
function bomberRecord(side: 'axis' | 'soviet'): ReturnType<typeof aircraftChoices>[number] {
  const found = aircraftChoices(side).find(
    (record) => (record.barrageStrength ?? 0) > 0 && (record.aircraftType ?? '') !== 'F',
  )
  if (found === undefined) throw new Error(`${side} 飞机库中没有可轰炸的机`)
  return found
}

/** 距 TARGET_HEX 最远的图内格（用来造"航程够不到"的飞机） */
const FAR_HEX: HexRef = (() => {
  let best = { hex: TARGET_HEX, distance: 0 }
  for (const hex of mapLayers.hexes) {
    const ref = { col: hex.col, row: hex.row }
    const distance = hexDistance(ref, TARGET_HEX)
    if (distance > best.distance) best = { hex: ref, distance }
  }
  if (best.distance === 0) throw new Error('地图上只有一个格？')
  return best.hex
})()

/** 声明一座本方的补给站（不自动选为来源，供点选测试自己点） */
function putDump(
  store: ReturnType<typeof newStore>,
  id: string,
  holdings: { sp?: number; t?: number } = {},
): string {
  store.spDumps.push({
    id,
    hex: FIRING_HEX,
    side: store.activeSide,
    sp: holdings.sp ?? 0,
    t: holdings.t ?? 0,
  })
  return id
}

function tonsOf(store: ReturnType<typeof newStore>, dumpId: string): number {
  const dump = store.spDumps.find((item) => item.id === dumpId)
  if (dump === undefined) throw new Error(`补给站 ${dumpId} 不存在`)
  return holdingsToT({ sp: dump.sp, t: dump.t })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B14b：参炸单位的阵列数据（候选与 13.4a 灰显）', () => {
  it('候选＝当前方且有印刷轰炸值者；敌方的、无轰炸值的都不进来', () => {
    const store = newStore()
    const own = place(store, artilleryRecord('axis'), FIRING_HEX, 'axis', 'art-own')
    place(store, artilleryRecord('soviet'), TARGET_HEX, 'soviet', 'art-enemy')
    const rifle = unitChoices('axis').find(
      (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) === 0,
    )
    expect(rifle, '单位库应有不带轰炸值的战斗单位').toBeDefined()
    place(store, rifle!, FIRING_HEX, 'axis', 'rifle-1')

    const ids = store.barrageUnitChoices.map((choice) => choice.unit.instanceId)
    expect(ids).toEqual([own.instanceId])
    expect(store.barrageUnitChoices[0]).toMatchObject({ selected: false, disabledReason: null })
  })

  it('★ 13.4a：预备/战略模式的火炮**灰显**（判据与引擎请求同源）', () => {
    const store = newStore()
    const gun = place(store, artilleryRecord('axis'), FIRING_HEX, 'axis', 'art-1')
    // ★ 改盘面必须取 **store 里的响应式对象**：`place` 返回的是入栈前那个裸对象，
    //   改它不会触发 computed 重算（阵列会停在第一次读到的结论上）。
    const seen = () => store.units.find((unit) => unit.instanceId === gun.instanceId)!
    expect(store.barrageUnitChoices[0]?.disabledReason).toBeNull()

    seen().mode.mode = 'reserve'
    expect(store.barrageUnitChoices[0]?.disabledReason).toContain('13.4a')

    seen().mode.mode = 'strat'
    expect(store.barrageUnitChoices[0]?.disabledReason).toContain('13.4a')

    // 回战斗模式即可参炸
    seen().mode.mode = 'combat'
    expect(store.barrageUnitChoices[0]?.disabledReason).toBeNull()
  })

  it('点选/取消与 store 的参炸名单一致（阵列的 selected 就是 `barrageUnitIds`）', () => {
    const store = newStore()
    const gun = place(store, artilleryRecord('axis'), FIRING_HEX, 'axis', 'art-1')
    store.toggleBarrageUnit(gun.instanceId)
    expect(store.barrageUnitChoices[0]?.selected).toBe(true)
    store.toggleBarrageUnit(gun.instanceId)
    expect(store.barrageUnitChoices[0]?.selected).toBe(false)
  })
})

describe('B14b：参炸飞机的阵列数据（10.2b / 14.1）', () => {
  it('★ 航程够不到目标格 ⇒ 灰显（14.1）；够得到的可参炸', () => {
    const store = newStore()
    store.setBarrageActive(true)
    /*
     * ★ 契约变更（H②，2026-09-19，**不是放宽**）：参炸机候选现在按**单位类别**收口（10.0e-F）
     *   —— 类别＝炮兵时空军候选为空。本组用例的主语就是**空军**那一套（10.2b 短程/14.1 航程），
     *   故先把类别切成「空军」（修前默认 artillery 也能列出来，那正是用户报的"页面上混着空军"）。
     */
    store.setBarrageKind('air')
    store.battleTarget = { hex: TARGET_HEX, defenderIds: [] }
    const near = toConsoleAirUnit({
      aircraft: bomberRecord('axis'),
      instanceId: 'air-near',
      hex: FIRING_HEX,
      side: 'axis',
      airStatus: 'active',
    })
    const far = toConsoleAirUnit({
      aircraft: bomberRecord('axis'),
      instanceId: 'air-far',
      hex: FAR_HEX,
      side: 'axis',
      airStatus: 'active',
    })
    store.airUnits.push(near, far)
    // 航程压到 1 格 ⇒ 最远那架必然够不到（不依赖地图有多大、机型航程是多少）
    const farSeen = store.airUnits.find((item) => item.instanceId === 'air-far')!
    farSeen.rangeHexes = 1
    expect(hexDistance(FAR_HEX, TARGET_HEX)).toBeGreaterThan(1)

    const choices = store.barrageAirChoices
    const nearChoice = choices.find((choice) => choice.id === 'air-near')
    const farChoice = choices.find((choice) => choice.id === 'air-far')
    expect(nearChoice?.rangeFromBase).toBe(1)
    expect(nearChoice?.disabledReason).toBeNull()
    expect(farChoice?.inRange).toBe(false)
    expect(farChoice?.disabledReason).toContain('14.1')

    // selected 与 store 的参炸飞机名单一致
    store.toggleBarrageAirUnit('air-near')
    expect(store.barrageAirChoices.find((item) => item.id === 'air-near')?.selected).toBe(true)
  })

  it('目标格未定时不给航程结论（`rangeFromBase` 为 null ⇒ 不灰显）', () => {
    const store = newStore()
    store.setBarrageActive(true)
    // 契约变更（H②）：参炸机候选按类别收口 ⇒ 本组要先切成「空军」（见上一条的说明）
    store.setBarrageKind('air')
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: bomberRecord('axis'),
        instanceId: 'air-1',
        hex: FIRING_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    const choice = store.barrageAirChoices[0]
    expect(choice?.rangeFromBase).toBeNull()
    expect(choice?.inRange).toBeNull()
    expect(choice?.disabledReason).toBeNull()
  })
})

describe('B14b：付款补给站的点选/取消（阵列里没有"未声明"空档）', () => {
  it('点一座即声明；再点同一座即取消；点另一座即改选', () => {
    const store = newStore()
    putDump(store, 'd-1', { sp: 0, t: 20 })
    putDump(store, 'd-2', { sp: 0, t: 20 })

    expect(store.barrageSupplyDumpId).toBeNull()
    expect(store.barrageSupplyDump).toBeNull()

    store.toggleBarrageSupplyDump('d-1')
    expect(store.barrageSupplyDumpId).toBe('d-1')
    expect(store.barrageSupplyDump?.id).toBe('d-1')

    // 阵列没有「（未声明）」空档 ⇒ 再点同一座即取消（10.1b 要求"必须先有来源"，故这条退路要留着）
    store.toggleBarrageSupplyDump('d-1')
    expect(store.barrageSupplyDumpId).toBeNull()
    expect(store.barrageSupplyDump).toBeNull()

    store.toggleBarrageSupplyDump('d-1')
    store.toggleBarrageSupplyDump('d-2')
    expect(store.barrageSupplyDumpId).toBe('d-2')
  })

  it('★ 点选之后走**同一条** 10.1b 付款链：账本真扣（不是换了层皮）', () => {
    const store = newStore()
    store.setPhase('combat')
    goToActionStep(store, 'barrage.declare')
    const gun = place(store, artilleryRecord('axis'), FIRING_HEX, 'axis', 'art-1')
    const defender = place(store, artilleryRecord('soviet'), TARGET_HEX, 'soviet', 'def-1')
    store.battleTarget = { hex: TARGET_HEX, defenderIds: [defender.instanceId] }
    store.setBarrageActive(true)
    store.toggleBarrageUnit(gun.instanceId)
    expect(store.beginBarrageNow()).toBe(true)
    expect(store.barrageState?.step).toBe('supply')

    const required = store.barrageState!.table.costT
    expect(required).toBeGreaterThan(0)
    putDump(store, 'd-pay', { sp: 0, t: required + 5 })
    // 该站确实是**阵列会显示出来**的那一批（10.1b-A：每个参炸单位都拖得到）
    expect(store.barrageSupplyDumpChoices.map((dump) => dump.id)).toContain('d-pay')
    const before = tonsOf(store, 'd-pay')
    // 3.4b：受益编队若属某装甲集群，这座站须声明同一归属（否则受限用途会被拒）
    const group = store.groupOfUnit(gun)
    if (group !== null) store.setDumpPanzerGroupNow('d-pay', group)

    store.toggleBarrageSupplyDump('d-pay')
    expect(store.barrageSupplyDumpId).toBe('d-pay')
    expect(store.confirmBarrageSupplyStep()).toBe(true)
    expect(store.barrageState?.step).toBe('shifts')
    expect(tonsOf(store, 'd-pay')).toBe(before - required)
  })
})

describe('B14b：轰炸面板的替换（源码守卫）', () => {
  const panel = readFileSync('src/components/barrage/BarragePanel.vue', 'utf8')

  it('四处「选算子」都改走 `CounterPicker`，旧控件已删（不留两套）', () => {
    expect(panel.match(/<CounterPicker/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(panel).not.toContain('pickBarrageDumpFromView')
    expect(panel).not.toContain('<select v-model="workbench.airPlacement.aircraftId"')
    expect(panel).not.toContain('v-for="unit in candidates"')
    expect(panel).not.toContain('v-for="air in workbench.barrageAirFacts"')
    // 点选直连 store 的动作
    expect(panel).toContain('@pick="workbench.toggleBarrageUnit($event)"')
    expect(panel).toContain('@pick="workbench.toggleBarrageAirUnit($event)"')
    expect(panel).toContain('@pick="workbench.toggleBarrageSupplyDump($event)"')
  })

  it('面板不做规则判断：候选与灰显原因全部取自 store', () => {
    expect(panel).toContain('workbench.barrageUnitChoices')
    expect(panel).toContain('workbench.barrageAirChoices')
    // 面板不再自己筛候选（10.0e-B 的印值判据只在 store 里）
    expect(panel).not.toContain('unit.raw.barrage > 0')
    expect(panel).not.toContain('unit.side === workbench.activeSide')
  })

  it('悬停同步地图高亮：三类对象都走既有的 `setHoverHex`', () => {
    expect(panel).toContain('workbench.setHoverHex')
    expect(panel).toContain('@hover="hoverUnit"')
    expect(panel).toContain('@hover="hoverAir"')
    expect(panel).toContain('@hover="hoverDump"')
  })
})
