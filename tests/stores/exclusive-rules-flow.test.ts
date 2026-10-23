import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { mapLayers, scenarios } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { createMapFacts, selectMovementTerrain } from '@/engine/rules'
import {
  TURN_TRACK,
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useWorkbenchStore,
} from '@/stores'

import {
  CORE_HEX,
  NEAR_HEX,
  combatRecord,
  groundRecord,
  label,
  newConsole,
  placeGround,
} from '../flows/sop-harness'

/**
 * W6 B19 的**端到端流程**（store 级）：专规机制 1.2 / 1.7 / 2.1a / 2.2 / 3.3b / 3.4 / 3.5
 *
 * 用**真实地图、真实剧本初设与真实单位库**（不造数）；结论全部来自引擎，
 * 故断言的是「流程走通 + 状态写对 + 阶段闸门生效」。
 */

/** 1941-08-19（3.4 约束失效日）与 1941-08-15（仍生效）对应的回合号，取自工程数据 turnTrack */
const TURN_19_AUG = TURN_TRACK.find((entry) => entry.date === '1941-08-19')?.turn ?? 13
const TURN_15_AUG = TURN_TRACK.find((entry) => entry.date === '1941-08-15')?.turn ?? 12

/**
 * 3.4a 的两侧取样格（取真实地图格）
 *
 * 分界线自 19.19 至 62.23，故**列 ≥ 25 时线不会高于 23 行、也不会低于 19 行**：
 * 行 ≥ 28 的格必在**北**、行 ≤ 6 的格必在**南**——不必复算插值，也不写死坐标。
 */
const NORTH_HEX = (() => {
  const found = mapLayers.hexes.find((hex) => hex.col >= 25 && hex.row >= 28)
  if (found === undefined) throw new Error('地图上找不到「列≥25 且行≥28」的格')
  return { col: found.col, row: found.row }
})()
const SOUTH_HEX = (() => {
  const found = mapLayers.hexes.find((hex) => hex.col >= 25 && hex.row <= 6)
  if (found === undefined) throw new Error('地图上找不到「列≥25 且行≤6」的格')
  return { col: found.col, row: found.row }
})()

/** 首个地图城市格（3.3b 的治安检查对象） */
const CITY_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => hex.city !== undefined)
  if (found === undefined) throw new Error('地图上找不到城市格')
  return { col: found.col, row: found.row }
})()

describe('W6 B19：剧本初设（1.7 补给缓存 / 3.5 建造标记）', () => {
  it('1.7 / 3.5：初值取剧本初设——剧本 1 给 3 枚建造标记、每方 2 枚补给缓存', () => {
    const store = newConsole()
    expect(store.scenarioId).toBe(scenarios.scenarios[0]?.id)
    expect(store.constructionMarkers).toBe(3)
    expect(store.supplyCacheHoldings).toEqual({ axis: 2, soviet: 2 })
  })

  it('3.5：切到剧本 3（其余剧本没有建造标记）⇒ 枚数与补给缓存随剧本初设重取', () => {
    const store = newConsole()
    store.setScenarioId('3')
    expect(store.constructionMarkers).toBe(0)
    expect(store.supplyCacheHoldings).toEqual({ axis: 2, soviet: 2 })
  })
})

describe('W6 B19：3.5 建造标记', () => {
  it('3.5：任一轴方移动阶段、单位移动前、目标格有轴方战斗单位 ⇒ 放置成功且枚数 −1', () => {
    const store = newConsole()
    store.setPhase('movement')
    placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    expect(store.constructionMarkers).toBe(3)
    expect(store.useConstructionMarkerNow('bridge', label(CORE_HEX))).toBe(true)
    expect(store.constructionMarkers).toBe(2)
  })

  it('3.5：目标格没有轴方战斗单位 / 非轴方 / 非移动阶段 / 已用完 ⇒ 一律拒', () => {
    const store = newConsole()
    store.setPhase('movement')
    expect(store.useConstructionMarkerNow('airStrip', label(CORE_HEX))).toBe(false)

    placeGround(store, combatRecord('soviet'), CORE_HEX, 'soviet', 's1')
    expect(store.useConstructionMarkerNow('airStrip', label(CORE_HEX))).toBe(false)
    expect(store.exclusiveError?.rule).toBe('专规 3.5')

    placeGround(store, combatRecord('axis'), NEAR_HEX, 'axis', 'a1')
    store.setPhase('combat')
    expect(store.useConstructionMarkerNow('bridge', label(NEAR_HEX))).toBe(false)

    store.setPhase('movement')
    store.setConstructionMarkersNow(0)
    expect(store.useConstructionMarkerNow('bridge', label(NEAR_HEX))).toBe(false)
  })

  it('3.5：「单位移动之前」——本阶段已有单位耗过 MP ⇒ 拒', () => {
    const store = newConsole()
    store.setPhase('movement')
    const unit = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    unit.mpSpent = 1
    expect(store.useConstructionMarkerNow('bridge', label(CORE_HEX))).toBe(false)
  })

  /**
   * B34 余项③a：标记**落盘**（原来只减枚数、标记本身没记住）与**被苏方战斗单位进入即毁**
   *
   * 规则原文（rules.json）：`destroyed_by: "Soviet combat unit entering the hex"`；
   * 「桥与简易机场**不能移动**」「**不可重建**」（毁掉即毁掉，枚数不退）。
   *
   * ★ 一条**测法边界（如实）**：本文件只钉"真走一步 ⇒ 那一枚被毁、另一枚不动、枚数不回补"，
   *   以及四处"单位进入某格"的写点**都挂了同一个判定**（源码守卫）。判定本身的真假（苏方 +
   *   战斗单位才算）已由 `tests/engine/construction.test.ts` 的 `isConstructionMarkerDestroyed` 覆盖，
   *   此处**不重复**造四种进入方式的夹具 —— 空投 / 战斗后推进 / 死亡堆返场那三条路各自需要
   *   一整套空军/战斗/重建夹具，收益是同一行调用的重复验证（写清边界，不假装覆盖）。
   */
  describe('B34 ③a：标记落盘与"苏方战斗单位进入即毁"', () => {
    /** 步行可走的相邻两格（`selectMovementTerrain` 判；与引擎同一判据，免得夹具挑到禁入格边） */
    const STEP = (() => {
      const facts = createMapFacts()
      for (const hex of mapLayers.hexes) {
        if (hex.col < 6 || hex.row < 6 || hex.col > 56 || hex.row > 30) continue
        const from: HexRef = { col: hex.col, row: hex.row }
        for (const direction of HEX_DIRECTIONS) {
          const to = neighbor(from, direction)
          if (!isOnMap(to)) continue
          const ok = selectMovementTerrain({
            terrainsPresent: facts.terrainsAt(to),
            mobility: 'leg',
            crossing: facts.crossingBetween(from, to),
            followingRoad: false,
            forOverrun: false,
          }).ok
          if (ok) return { from, to }
        }
      }
      throw new Error('夹具：地图上找不到「步行可走的相邻两格」')
    })()

    /** 一枚苏方**步行**战斗单位（不需要燃料即可移动；12.5c 只管机械化那类） */
    const sovietLeg = () =>
      groundRecord(
        'soviet',
        (record) =>
          record.classes?.movementClass === 'leg' &&
          record.isCombat === true &&
          record.attackCapable === true,
      )

    it('放置成功 ⇒ 盘面上真的多一枚（kind/格都对）；第二枚互不影响', () => {
      const store = newConsole()
      store.setPhase('movement')
      placeGround(store, combatRecord('axis'), STEP.to, 'axis', 'a1')
      placeGround(store, combatRecord('axis'), NEAR_HEX, 'axis', 'a2')
      expect(store.constructionMarkerPieces).toEqual([])

      expect(store.useConstructionMarkerNow('bridge', label(STEP.to))).toBe(true)
      expect(store.useConstructionMarkerNow('airStrip', label(NEAR_HEX))).toBe(true)
      expect(store.constructionMarkers).toBe(1)
      expect(store.constructionMarkerPieces.map((piece) => piece.kind)).toEqual([
        'bridge',
        'airStrip',
      ])
      expect(store.constructionMarkerPieces[0]?.hex).toEqual(STEP.to)
    })

    it('★ 苏方战斗单位走进去 ⇒ **那一枚**被毁、另一枚不动、枚数**不回补**（不可重建）', () => {
      const store = newConsole()
      store.setPhase('movement')
      placeGround(store, combatRecord('axis'), STEP.to, 'axis', 'a1')
      placeGround(store, combatRecord('axis'), NEAR_HEX, 'axis', 'a2')
      expect(store.useConstructionMarkerNow('bridge', label(STEP.to))).toBe(true)
      expect(store.useConstructionMarkerNow('airStrip', label(NEAR_HEX))).toBe(true)
      // 放桥的那支轴方单位离开该格（标记本身不随它移动 —— 3.5「不能移动」）
      store.units = store.units.filter((unit) => unit.instanceId !== 'a1')

      placeGround(store, sovietLeg(), STEP.from, 'soviet', 's1')
      const markersBefore = store.constructionMarkers
      // 6.3a：只有当前阶段玩家能移动自己的单位 ⇒ 把行动方切到苏方
      store.setActiveSide('soviet')
      // 条 10（批 M）：点格建取子清单，确认后开拔，再点目标格走入
      store.clickHex(STEP.from)
      expect(store.confirmMovePick()).toBe(true)
      store.clickHex(STEP.to)
      expect(store.units.find((unit) => unit.instanceId === 's1')?.hex).toEqual(STEP.to)

      // 桥被毁、机场还在、枚数不回补
      expect(store.constructionMarkerPieces.map((piece) => piece.kind)).toEqual(['airStrip'])
      expect(store.constructionMarkers).toBe(markersBefore)
      // 日志是**追加**的（最新在末尾）⇒ 找那一条，不假定位置
      const destroyed = store.log.filter((entry) => entry.text.includes('被摧毁'))
      expect(destroyed).toHaveLength(1)
      expect(destroyed[0]?.text).toContain('不可重建')
    })

    it('★ 放置格＝点地图（候选＝有轴方战斗单位的格）', () => {
      const { workbench, mapView } = (() => {
        setActivePinia(createPinia())
        return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
      })()
      workbench.setPhase('movement')
      placeGround(workbench, combatRecord('axis'), STEP.to, 'axis', 'a1')
      workbench.beginConstructionMarkerHexPickNow()
      expect(workbench.hexPickView).toMatchObject({ rule: '专规 3.5', candidates: [STEP.to] })
      mapView.onHexClick(STEP.to)
      expect(workbench.constructionMarkerHexText).toBe(label(STEP.to))
      expect(workbench.hexPickView).toBeNull()
    })

    it('★ 四处"单位进入某格"的写点都挂了同一个判定；面板绑 store 字段（源码守卫）', () => {
      const store = readFileSync('src/stores/workbench.ts', 'utf8')
      // 判定交给引擎，调用点覆盖四条进入路径
      expect(store).toContain('isConstructionMarkerDestroyed({ enteredBySovietCombatUnit: true })')
      // 命中数 - 定义本身 = 调用点数（`function noteUnitEnteredHex(` 那条不算调用）
      const all = store.match(/noteUnitEnteredHex\(/gu) ?? []
      const defs = store.match(/function noteUnitEnteredHex\(/gu) ?? []
      expect(defs).toHaveLength(1)
      expect(all.length - defs.length).toBe(4)
      /*
       * 逐调用点**回看上游代码**，认它长在哪条路径里（不能按"离某个名字多远"往后找：
       * `applyMovePatches` 另有调用点，会先被撞上）。四个标记必须**都**出现 —— 少一个即说明
       * 某条进入路径没挂判定。
       */
      const markers = [
        'function applyMovePatches', // 地面移动落盘
        'function applyCombatPatches', // 战斗后推进/撤退
        `item.fate === 'placed'`, // 空投落地
        'function returnFromDeadPileNow', // 死亡堆返场
      ]
      const seen = new Set<string>()
      let from = 0
      for (let i = 0; i < all.length; i += 1) {
        const at = store.indexOf('noteUnitEnteredHex(', from)
        from = at + 1
        // 跳过定义那一处（它前面紧跟 `function `）
        if (store.slice(Math.max(0, at - 12), at).includes('function ')) continue
        const window = store.slice(Math.max(0, at - 5000), at)
        for (const marker of markers) if (window.includes(marker)) seen.add(marker)
      }
      expect([...seen].sort()).toEqual([...markers].sort())
      // 面板：点地图选格 + 已放置清单都来自 store（不再留局部 ref）
      const panel = readFileSync('src/components/exclusive/ExclusiveRulesPanel.vue', 'utf8')
      expect(panel).toContain('workbench.beginConstructionMarkerHexPickNow()')
      expect(panel).toContain('workbench.constructionMarkerPieces')
      expect(panel).not.toContain('const markerHexText = ref')
    })
  })
})

describe('W6 B19：3.3b 治安需求', () => {
  it('3.3b：轴控城市无驻兵、无 ZOC ⇒ 检查即放置 Trainbusting；驻兵后须等到 H 段才移除', () => {
    const store = newConsole()
    store.toggleAxisCityControlNow(label(CITY_HEX))
    expect(store.axisControlledCityKeys).toContain(label(CITY_HEX))
    expect(store.securityNeeds?.placeAt).toEqual([CITY_HEX])

    expect(store.applySecurityNeedsNow()).toBe(true)
    expect(store.trainbustingMarks.length).toBe(1)
    expect(store.hasTrainbustingAt(CITY_HEX)).toBe(true)

    // 驻一个可攻击单位 ⇒ 需求满足（后续检查应给出「需移除」）
    placeGround(store, combatRecord('axis'), CITY_HEX, 'axis', 'u1')
    store.setPhase('movement')
    expect(store.securityNeeds?.removeAt).toEqual([CITY_HEX])
    store.applySecurityNeedsNow()
    // 3.3b：移除只在 Clean Up Phase ⇒ 移动段不移除
    expect(store.trainbustingMarks.length).toBe(1)

    store.setPhase('cleanUp')
    expect(store.applySecurityNeedsNow()).toBe(true)
    expect(store.trainbustingMarks.length).toBe(0)
  })

  it('3.3b：未被声明为轴控的城市不参与治安需求', () => {
    const store = newConsole()
    expect(store.securityNeeds?.placeAt).toEqual([])
    expect(store.applySecurityNeedsNow()).toBe(true)
    expect(store.trainbustingMarks.length).toBe(0)
  })

  it('3.3b：城市转为苏控 ⇒ 其标记在 H 段被移除', () => {
    const store = newConsole()
    store.toggleAxisCityControlNow(label(CITY_HEX))
    store.applySecurityNeedsNow()
    expect(store.trainbustingMarks.length).toBe(1)

    store.toggleAxisCityControlNow(label(CITY_HEX)) // 撤销轴控声明（= 转苏控）
    store.setPhase('cleanUp')
    store.applySecurityNeedsNow()
    expect(store.trainbustingMarks.length).toBe(0)
  })
})

describe('2.2 末段：H 段通用清理（DG / 进击 / 燃料 / 对手的运输破坏标记）', () => {
  it('非 H 段拒绝清理；H 段摘本人单位的三种标记，对手单位原样不动', () => {
    const store = newConsole()
    const mine = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'a1')
    const theirs = placeGround(store, combatRecord('soviet'), NEAR_HEX, 'soviet', 's1')
    mine.mode.dg = true
    mine.mode.exploit = true
    mine.fuelled = true
    theirs.mode.dg = true
    theirs.mode.exploit = true
    theirs.fuelled = true

    // 段闸：2.2 的清理只属 H 段
    store.setPhase('movement')
    expect(store.runCleanUpNow()).toBe(false)
    expect(store.log[0]!.rule).toBe('2.2')
    expect(mine.mode.dg).toBe(true)

    store.setPhase('cleanUp')
    expect(store.runCleanUpNow()).toBe(true)
    // 本人单位：三种标记都摘掉（朝向按 5.9/5.10 不变 ⇒ 只动标记位）
    expect(mine.mode.dg).toBe(false)
    expect(mine.mode.exploit).toBe(false)
    expect(mine.fuelled).toBe(false)
    // 对手单位：轮到他自己清理时才摘
    expect(theirs.mode.dg).toBe(true)
    expect(theirs.mode.exploit).toBe(true)
    expect(theirs.fuelled).toBe(true)
  })

  it('2.2 / 10.0c-C：H 段移除**对手**放下的运输破坏标记（本人放的不动）', () => {
    const store = newConsole()
    // 3.3b 的路径放一枚**苏军**标记（轴控城市无驻兵 ⇒ 需求未满足）
    store.toggleAxisCityControlNow(label(CITY_HEX))
    expect(store.applySecurityNeedsNow()).toBe(true)
    expect(store.trainbustingMarks.length).toBe(1)
    expect(store.trainbustingMarks[0]!.side).toBe('soviet')

    // 轮到轴心方清理 ⇒ 苏军放的标记应被移除（10.0c-C：下一个敌方的清理阶段）
    store.setPhase('cleanUp')
    expect(store.runCleanUpNow()).toBe(true)
    expect(store.trainbustingMarks.length).toBe(0)

    // 再放一枚，轮到苏方清理时**不该**移除（那是它自己放的）
    store.applySecurityNeedsNow()
    expect(store.trainbustingMarks.length).toBe(1)
    store.switchSide()
    store.setPhase('cleanUp')
    expect(store.runCleanUpNow()).toBe(true)
    expect(store.trainbustingMarks.length).toBe(1)
  })
})

describe('W6 B19：3.4 装甲集群分界线', () => {
  it('3.4a①：两个集群的多单位编队同堆叠 / 相邻 ⇒ 相位末各给一个 DG 义务', () => {
    const store = newConsole()
    store.setPhase('movement')
    placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'g1')
    placeGround(store, combatRecord('axis'), NEAR_HEX, 'axis', 'h1')
    store.setMultiUnitFormationNow('g1', true)
    store.setMultiUnitFormationNow('h1', true)
    store.setPanzerGroupNow('g1', 'guderian')
    store.setPanzerGroupNow('h1', 'hoth')

    expect(store.panzerGroupBoundary).not.toBeNull()
    const obligations = store.panzerGroupObligations
    expect(obligations.map((item) => item.reason)).toEqual([
      'crossGroupStackedOrAdjacent',
      'crossGroupStackedOrAdjacent',
    ])
    expect(obligations.map((item) => item.rule)).toEqual(['3.4a', '3.4a'])
  })

  it('3.4a②：Guderian 在北、Hoth 在南（错误一侧且 Orsha 以东）⇒ 各给一个 DG 义务', () => {
    const store = newConsole()
    store.setPhase('movement')
    placeGround(store, combatRecord('axis'), NORTH_HEX, 'axis', 'g1')
    placeGround(store, combatRecord('axis'), SOUTH_HEX, 'axis', 'h1')
    store.setMultiUnitFormationNow('g1', true)
    store.setPanzerGroupNow('g1', 'guderian')
    store.setMultiUnitFormationNow('h1', true)
    store.setPanzerGroupNow('h1', 'hoth')

    const obligations = store.panzerGroupObligations
    expect(obligations.map((item) => item.reason)).toEqual([
      'wrongSideOfLineEastOfOrsha',
      'wrongSideOfLineEastOfOrsha',
    ])
  })

  it('3.4：非多单位编队 / 未声明归属 ⇒ 不受约束；19 August 起约束整体失效', () => {
    const store = newConsole()
    store.setPhase('movement')
    placeGround(store, combatRecord('axis'), NORTH_HEX, 'axis', 'g1')
    placeGround(store, combatRecord('axis'), SOUTH_HEX, 'axis', 'h1')
    // 未声明归属
    expect(store.panzerGroupObligations).toEqual([])

    store.setPanzerGroupNow('g1', 'guderian')
    store.setMultiUnitFormationNow('g1', true)
    store.setPanzerGroupNow('h1', 'hoth')
    // h1 未声明为多单位编队 ⇒ 只有 g1 有义务
    expect(store.panzerGroupObligations.map((item) => item.group)).toEqual(['guderian'])

    store.setTurn(TURN_15_AUG)
    expect(store.panzerGroupObligations.length).toBe(1)
    store.setTurn(TURN_19_AUG)
    expect(store.panzerGroupObligations).toEqual([])
  })

  it('3.4b：Supply Table 均分（奇数点归 Guderian），由引擎给出', () => {
    const store = newConsole()
    store.supplyTableSpInput = 7
    expect(store.panzerGroupSpSplit).toEqual({ hoth: 3, guderian: 4 })
    store.supplyTableSpInput = 8
    expect(store.panzerGroupSpSplit).toEqual({ hoth: 4, guderian: 4 })
  })
})

describe('W6 B19：1.7 补给缓存', () => {
  /** B37：走到 D 补给段的某个环节（1.7 补给缓存的闸门在补给段） */
  function goToSupplyStep(store: ReturnType<typeof newConsole>): void {
    store.setPhase('supply')
    const index = store.playerSegmentSteps.findIndex((step) => step.id.startsWith('supply.'))
    if (index < 0) throw new Error('D 段没有玩家环节？')
    expect(store.setSegmentStepIndex(index)).toBe(true)
  }

  it('1.7 / 21.10 Shells：在友方 HQ 处花掉一枚，抵付 2T 且存量 −1', () => {
    const store = newConsole()
    goToSupplyStep(store)
    store.supplyCacheInputs.use = 'shells'
    store.supplyCacheInputs.hexText = label(CORE_HEX)
    store.supplyCacheInputs.barrageCostT = 6
    expect(store.spendSupplyCacheNow()).toBe(true)
    expect(store.supplyCacheHoldings.axis).toBe(1)
    expect(store.lastSupplyCacheUse).toContain('抵付 2 T')
  })

  it('21.10 Forage：只在补给阶段（D 段）可用 ⇒ 移动段被**闸门**拒（带规则号）', () => {
    const store = newConsole()
    store.setPhase('movement')
    store.supplyCacheInputs.use = 'forage'
    store.supplyCacheInputs.hexText = label(CORE_HEX)
    expect(store.spendSupplyCacheNow()).toBe(false)
    /*
     * B37：闸门是**第一道**（界面根本不该在别的段给出入口）——
     * 故此处断的是闸门的拒绝（规则号走 1.7 / 21.10），而不是引擎那条 `forageOnlyInSupplyPhase`；
     * 引擎自身的同口径判定仍由 `tests/engine/supply-cache.test.ts` 覆盖（两道都在）。
     */
    expect(store.actionRefusal?.key).toBe('exclusive.forage')
    expect(store.supplyCacheHoldings.axis).toBe(2)

    goToSupplyStep(store)
    /*
     * ★ 契约变更（批 F 切片 5，**不是放宽**）：21.10 的「被切断的第一个回合」修前由裁判在面板勾选，
     *   现已删除 ⇒ `spendSupplyCacheNow` 按**盘面事实**判（`cutSinceTurn`，与 12.8e 同源）：
     *   该格要有本方 HQ，且它处于**连续断补的第一个回合**。故这里先摆 HQ、再重判一次追溯补给。
     */
    const hqRecord = unitChoices('axis').find((item) => (item.specialized ?? []).includes('hq'))
    if (hqRecord === undefined) throw new Error('轴方单位库里没有指挥部')
    store.units.push(
      toConsoleUnit({ record: hqRecord, instanceId: 'hq-1', hex: CORE_HEX, side: 'axis' }),
    )
    store.evaluateTraceSupplyNow()
    expect(store.spendSupplyCacheNow()).toBe(true)
    expect(store.supplyCacheHoldings.axis).toBe(1)
  })

  it('1.7：HQ 格格式非法 / 存量耗尽 ⇒ 拒，且不扣枚数', () => {
    const store = newConsole()
    goToSupplyStep(store)
    store.supplyCacheInputs.use = 'shells'
    store.supplyCacheInputs.hexText = '不是格号'
    expect(store.spendSupplyCacheNow()).toBe(false)

    store.supplyCacheInputs.hexText = label(CORE_HEX)
    store.supplyCacheHoldings = { axis: 0, soviet: 0 }
    expect(store.spendSupplyCacheNow()).toBe(false)
    expect(store.exclusiveError?.reason).toBe('noSupplyCacheLeft:axis')
  })

  it('1.7：经 1.6c 特殊补员追加一枚（只加指定一方）', () => {
    const store = newConsole()
    store.addSupplyCacheNow('soviet')
    expect(store.supplyCacheHoldings).toEqual({ axis: 2, soviet: 3 })
  })
})

describe('W6 B19：1.2 / 2.1a 容量与补给源时点', () => {
  it('1.2：铁路容量在 19 July 提升（轴 0→1、苏 2→3）', () => {
    const store = newConsole()
    store.setTurn(TURN_TRACK.find((entry) => entry.date === '1941-07-15')?.turn ?? 3)
    expect(store.railCapToday).toEqual({ axis: 0, soviet: 2 })
    store.setTurn(TURN_TRACK.find((entry) => entry.date === '1941-07-19')?.turn ?? 4)
    expect(store.railCapToday).toEqual({ axis: 1, soviet: 3 })
  })

  it('时点日历：当日生效条目与日历条数（供界面提示）', () => {
    const store = newConsole()
    expect(store.exclusiveTimings.length).toBeGreaterThan(0)
    store.setTurn(TURN_TRACK.find((entry) => entry.date === '1941-07-19')?.turn ?? 4)
    const kinds = store.todaysTimings.map((item) => item.kind)
    expect(kinds).toContain('railCapBoost')
    expect(kinds).toContain('supplyShutdownEntryL')
    expect(kinds).toContain('randomEventStart')
  })
})

describe('W6 B19：2.2 苏军空军限制（界面预检）', () => {
  it('2.2d：苏军在反应 / 进击阶段不能出击（预检给出否决）', () => {
    const store = newConsole()
    store.switchSide() // 切到苏方
    store.setAirMissionKind('barrage')
    store.setPhase('movement')
    expect(store.redAirForceAdvisory?.ok).toBe(true)

    store.setPhase('reaction')
    const advisory = store.redAirForceAdvisory
    expect(advisory?.ok).toBe(false)
    if (advisory !== null && !advisory.ok) expect(advisory.rule).toBe('2.2d')
  })

  it('2.2a：苏军低空扫射一律被限制；轴方天气正常时允许（3.2a）', () => {
    const store = newConsole()
    store.switchSide()
    store.setAirMissionKind('hip_shoot')
    store.setPhase('movement')
    const soviet = store.redAirForceAdvisory
    expect(soviet?.ok).toBe(false)
    if (soviet !== null && !soviet.ok) expect(soviet.rule).toBe('2.2a')

    store.switchSide() // 回到轴方
    store.setAirMissionKind('hip_shoot')
    const axis = store.redAirForceAdvisory
    expect(axis?.ok).toBe(true)
  })

  it('2.2d / 14.1g：非移动环节（A/B/D/F/H）不宣布空军任务 ⇒ 无预检', () => {
    const store = newConsole()
    for (const phase of [
      'aircraftRefit',
      'reinforcement',
      'supply',
      'combat',
      'cleanUp',
    ] as const) {
      store.setPhase(phase)
      expect(store.redAirForceAdvisory).toBeNull()
    }
  })
})
