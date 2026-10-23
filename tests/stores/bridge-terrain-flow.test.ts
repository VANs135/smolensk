import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'

import { HEX_DIRECTIONS, neighbor, sameHex } from '@/engine/hex-geometry'
import { createMapFacts } from '@/engine/rules'
import {
  bridgedHexesBySide,
  createBattleFacts,
  toBattleUnitView,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
} from '@/stores'

/**
 * 13.8b 架桥的**接线**（store 侧）：架桥格从哪来、给到了哪两处判据
 *
 * 修前的病灶：引擎里 `bridgedCrossing` 写好也测好，但 `src/` 内**零调用**（`MoveContext` 没有这个
 * 字段、`createBattleFacts` 也没用）⇒ 规则整局不生效。本文件钉三件事：
 *   ① **谁**提供架桥格：只有**指挥部**且**具有工程能力**（13.8 首段 + 13.8a），
 *      外加专规 3.5 的建造标记「桥」面（仅轴方）；
 *   ② `moveContext` 与 `combatFacts` 拿到的是**同一份**（"能走过去"与"能打过去"必须同源）；
 *   ③ 真实地图上的大河格边：HQ 在场时从"轮式禁入"变为"可进入"（13.8b「没有桥就无法过河/攻击」）。
 *
 * 测法边界：地图用**产品真实产物**（`mapFacts`），故不依赖合成夹具；但"过河后便宜多少"的费率
 * 细节由 `tests/engine/move.test.ts` 的合成地图用例覆盖（本文件只问"能不能进"这一档）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const HQ_RECORD = unitChoices('axis').find((record) => (record.specialized ?? []).includes('hq'))!
/** 轴方 Pioneer（专规/通规 13.8 首段：**不能**架桥） */
const PIONEER_RECORD = unitChoices('axis').find((record) =>
  (record.specialized ?? []).includes('engineer'),
)!
/** 轴方铁路修理单位（13.8 首段：同样**不能**架桥） */
const RR_RECORD = unitChoices('axis').find((record) =>
  (record.specialized ?? []).includes('rail_repair'),
)!

const HEX: HexRef = (() => {
  const found = mapLayers.hexes.find(
    (hex) => hex.col > 8 && hex.row > 8 && hex.col < 54 && hex.row < 28,
  )
  if (found === undefined) throw new Error('地图上找不到内圈格')
  return { col: found.col, row: found.row }
})()

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('13.8b：架桥格从哪来（13.8 首段 / 13.8a / 专规 3.5）', () => {
  it('★ 指挥部（战斗模式）进架桥格；切成移动模式后**不再**具有工程能力', () => {
    const store = newStore()
    store.setPhase('movement')
    const hq = toConsoleUnit({ record: HQ_RECORD, instanceId: 'hq-1', hex: HEX, side: 'axis' })
    store.units.push(hq)

    expect(store.moveContext.bridgedHexesBySide?.axis.some((hex) => sameHex(hex, HEX))).toBe(true)

    // 13.8a：只有战斗模式（或 DG 但朝向战斗面）才算 ⇒ 移到移动模式后该格不再是架桥格
    store.selectedId = hq.instanceId
    store.switchUnitMode('move')
    expect(hq.mode.mode).toBe('move')
    expect(store.moveContext.bridgedHexesBySide?.axis.some((hex) => sameHex(hex, HEX))).toBe(false)
  })

  it('★ 13.8 首段：Pioneer 与铁路修理单位**都不**提供架桥（只有指挥部与 Engineer 可以）', () => {
    const store = newStore()
    store.setPhase('movement')
    store.units.push(
      toConsoleUnit({ record: PIONEER_RECORD, instanceId: 'pio-1', hex: HEX, side: 'axis' }),
      toConsoleUnit({ record: RR_RECORD, instanceId: 'rr-1', hex: HEX, side: 'axis' }),
    )
    // B43（13.8 首段）：Pioneer 与铁路修理**都不是**"具工程能力"的单位 ⇒ 架桥/施工都不沾边
    expect(store.units.every((unit) => unit.engineerCapable)).toBe(false)
    expect(store.moveContext.bridgedHexesBySide).toEqual({ axis: [], soviet: [] })
    // 纯函数口径同一处：给这三类算子，只有 HQ 那一枚进格清单
    const hq = toConsoleUnit({ record: HQ_RECORD, instanceId: 'hq-1', hex: HEX, side: 'axis' })
    expect(bridgedHexesBySide([...store.units, hq])).toEqual({ axis: [HEX], soviet: [] })
  })

  it('★ 专规 3.5：建造标记的「桥」面进架桥格，且**只**归轴方（简易机场面不进）', () => {
    const store = newStore()
    store.setPhase('movement')
    store.setTurn(1)
    // 3.5：须在"单位移动之前"，且该格要有轴方战斗单位（故先摆一枚）
    const guard = unitChoices('axis').find(
      (record) => record.isCombat === true && (record.specialized ?? []).length === 0,
    )!
    store.units.push(toConsoleUnit({ record: guard, instanceId: 'g-1', hex: HEX, side: 'axis' }))

    const hexText = `${HEX.col}.${HEX.row}`
    expect(store.useConstructionMarkerNow('airStrip', hexText)).toBe(true)
    expect(store.moveContext.bridgedHexesBySide?.axis).toEqual([])

    expect(store.useConstructionMarkerNow('bridge', hexText)).toBe(true)
    expect(store.moveContext.bridgedHexesBySide?.axis.some((hex) => sameHex(hex, HEX))).toBe(true)
    expect(store.moveContext.bridgedHexesBySide?.soviet).toEqual([])
  })
})

describe('13.8b：真实地图上的大河 —— 架桥把"轮式禁入"变成"可攻击/可进入"', () => {
  /** 需要燃料的轮式战斗单位（12.5a），用来问"能不能过河去攻击" */
  const truckRecord = unitChoices('axis').find(
    (record) =>
      record.mobilityByFace?.move === 'truck' &&
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.noncombatKind ?? null) === null,
  )!

  /**
   * 地图上第一条**真正"没桥过不去"**的大河格边（`river === 'Major River'` 且**无道路**）
   *
   * 自检式夹具：逐个候选**用引擎自己判一次**——"无桥 ⇒ 轮式进不去"且"有桥 ⇒ 进得去"的那一对才采纳，
   * 否则（例如该边本就带路/对岸地形对轮式禁入）继续找。找不到即抛错，避免用合成地图糊过去。
   */
  const MAJOR_EDGE = (() => {
    const map = createMapFacts()
    for (const hex of mapLayers.hexes) {
      const from: HexRef = { col: hex.col, row: hex.row }
      for (const direction of HEX_DIRECTIONS) {
        const to = neighbor(from, direction)
        if (!mapLayers.hexes.some((item) => item.col === to.col && item.row === to.row)) continue
        const crossing = map.crossingBetween(from, to)
        if (crossing?.river !== 'Major River') continue
        if ((crossing.routes ?? []).length > 0) continue // 本就带路（过河桥）的那条不算
        const truck = toConsoleUnit({
          record: truckRecord,
          instanceId: 'probe',
          hex: from,
          side: 'axis',
          face: 'move',
        })
        const view = toBattleUnitView(truck)
        const plain = createBattleFacts({ units: [truck], defenderSide: 'soviet' })
        const bridged = createBattleFacts({
          units: [truck],
          defenderSide: 'soviet',
          bridgedHexesBySide: { axis: [from], soviet: [] },
        })
        if (!plain.canEnterForAttack(view, from, to) && bridged.canEnterForAttack(view, from, to)) {
          return { from, to }
        }
      }
    }
    throw new Error('产品地图上找不到"无桥进不去、架桥进得去"的大河格边')
  })()

  it('★ 无 HQ ⇒ 轮式不得跨该格边攻击；同格有 HQ（战斗模式）⇒ 允许（13.8b 后半句）', () => {
    const truck = toConsoleUnit({
      record: truckRecord,
      instanceId: 'tk-1',
      hex: MAJOR_EDGE.from,
      side: 'axis',
      face: 'move',
    })
    const view = toBattleUnitView(truck)

    const withoutHq = createBattleFacts({ units: [truck], defenderSide: 'soviet' })
    expect(withoutHq.canEnterForAttack(view, MAJOR_EDGE.from, MAJOR_EDGE.to)).toBe(false)

    const hq = toConsoleUnit({
      record: HQ_RECORD,
      instanceId: 'hq-1',
      hex: MAJOR_EDGE.from,
      side: 'axis',
    })
    const withHq = createBattleFacts({
      units: [truck, hq],
      defenderSide: 'soviet',
      // 与 store 同一处产出：`moveContext` 用的就是这一份
      bridgedHexesBySide: bridgedHexesBySide([truck, hq]),
    })
    expect(withHq.canEnterForAttack(view, MAJOR_EDGE.from, MAJOR_EDGE.to)).toBe(true)

    // 对手（苏方）没有 HQ ⇒ 该格边对苏方仍是大河
    const sovietTruck = toConsoleUnit({
      record: truckRecord,
      instanceId: 'tk-2',
      hex: MAJOR_EDGE.from,
      side: 'soviet',
      face: 'move',
    })
    const forSoviet = createBattleFacts({
      units: [sovietTruck, hq],
      defenderSide: 'axis',
      bridgedHexesBySide: bridgedHexesBySide([sovietTruck, hq]),
    })
    expect(
      forSoviet.canEnterForAttack(toBattleUnitView(sovietTruck), MAJOR_EDGE.from, MAJOR_EDGE.to),
    ).toBe(false)
  })

  it('★ 源码守卫：store 把**同一份**架桥格同时给了 `moveContext` 与 `combatFacts`', () => {
    const store = readFileSync('src/stores/workbench.ts', 'utf8')
    // 架桥格只由 `bridgedHexesBySide` 产出（同一处判据），并注入两处
    expect(store).toContain('const bridgedHexes = computed')
    expect(store).toContain('bridgedHexesBySide: bridgedHexes.value')
    expect((store.match(/bridgedHexesBySide: bridgedHexes\.value/g) ?? []).length).toBe(2)
  })
})
