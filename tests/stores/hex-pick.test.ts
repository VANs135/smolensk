import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { toConsoleUnit, unitChoices, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * B27：**通用「待点格」**（用户口径 2026-09-16 #9）
 *
 * 「目前 UI 里需要玩家输入格子编号的所有项目全改为在该操作发生时玩家点击地图上格子作为选择，
 *   交互一定要简洁、有效、可靠」。
 *
 * 机制三层，本文件逐层钉住：
 *   ① **动作声明**：`beginXxxHexPickNow(...)` 给出用途名 / 规则号 / 候选 / 写回；
 *   ② **地图消费**：`mapView.onHexClick` 命中候选即写回并收态；点非候选 ⇒ 不写 + 一行提示；
 *      这一击**不再落到常规分派**（不会顺手选中算子或开始移动）；
 *   ③ **取消**：`Esc` / ×（`cancelSession`）先退待点态。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

/** 一枚"终点格"（拿来当落点用） */
const HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => hex.col > 5 && hex.row > 5)
  if (found === undefined) throw new Error('地图上找不到可用格')
  return { col: found.col, row: found.row }
})()

/** 轴方空军基地记录（14.1a；`ownAirBases` 的候选来源） */
const airbaseRecord = () =>
  unitChoices('axis').find((record) => record.noncombatKind === 'air_base') ??
  unitChoices('soviet').find((record) => record.noncombatKind === 'air_base')!

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B27：待点格（机制）', () => {
  it('★ 动作声明 ⇒ 地图点候选格 ⇒ 写回并收态（以 16.0b 工事格为例）', () => {
    const { workbench, mapView } = newStores()
    expect(workbench.hexPickView).toBeNull()
    workbench.beginHedgehogHexPickNow('build')
    // ① 待点态：有用途名、规则号与提示（提示里带"点地图"与 Esc）
    expect(workbench.hexPickView).toMatchObject({ rule: '16.0b', candidates: 'any' })
    expect(workbench.hexPickHint).toContain('16.0b')
    expect(workbench.hexPickHint).toContain('Esc')
    // 地图的提示优先级：待点格在最前（玩家已明确表达"我在选格"）
    expect(mapView.actionHint).toBe(workbench.hexPickHint)

    // ② 点一格 ⇒ 写回那条输入，并收态
    mapView.onHexClick(HEX)
    expect(workbench.hedgehogInputs.hexText).toBe(`${HEX.col}.${HEX.row}`)
    expect(workbench.hexPickView).toBeNull()
    expect(workbench.hexPickHint).toBe('')
  })

  it('★ 13.6 增援落点：声明正确且点格被消费（写回的是"落点覆盖"这一处状态）', () => {
    const { workbench, mapView } = newStores()
    // turn 1 的当日到达卡没有条目 ⇒ 换到 turn 2（候选＝卡面的入场格 1.26）
    workbench.setTurn(2)
    workbench.setPhase('reinforcement')
    expect(workbench.beginArrivalHexPickNow(0)).toBe(true)
    expect(workbench.hexPickView).toMatchObject({ rule: '13.6' })
    // ★ 用户 2026-10-25 BUG①：候选**不再是 'any'**，而是卡面那几格
    const candidates = workbench.hexPickView?.candidates
    expect(candidates).not.toBe('any')
    expect(candidates).toContainEqual({ col: 1, row: 26 })

    mapView.onHexClick({ col: 1, row: 26 })
    expect(workbench.arrivalPlacements[0]?.hex).toMatchObject({ col: 1, row: 26 })
    expect(workbench.hexPickView).toBeNull()
  })

  it('★ 候选受限时（14.1a 摆放飞机）：点非候选格 ⇒ **不写**并给一行提示，待点态保留', () => {
    const { workbench, mapView } = newStores()
    // 场上没有本方空军基地 ⇒ 候选为空
    workbench.beginAirPlacementHexPickNow()
    expect(workbench.hexPickView?.candidates).toEqual([])

    const logBefore = workbench.log.length
    mapView.onHexClick(HEX)
    expect(workbench.airPlacement.hexText).toBe('')
    expect(workbench.log.length).toBeGreaterThan(logBefore)
    expect(workbench.log[0]?.kind).toBe('warning')
    expect(workbench.log[0]?.text).toContain('不是')
    // 待点态仍在（玩家可以改点候选格，或按 Esc 退出）
    expect(workbench.hexPickView).not.toBeNull()
  })

  it('★ 候选＝本方空军基地格时，点基地格即写回（真能预筛的那一类）', () => {
    const { workbench, mapView } = newStores()
    const base = toConsoleUnit({
      record: airbaseRecord(),
      instanceId: 'base-1',
      hex: HEX,
      side: 'axis',
    })
    workbench.units.push(base)

    workbench.beginAirPlacementHexPickNow()
    expect(workbench.hexPickView?.candidates).toEqual([HEX])
    mapView.onHexClick(HEX)
    expect(workbench.airPlacement.hexText).toBe(`${HEX.col}.${HEX.row}`)
    expect(workbench.hexPickView).toBeNull()
  })

  it('★ 待点这一击**不再落到常规分派**（不会顺手选中算子 / 开始移动）', () => {
    const { workbench, mapView } = newStores()
    const unit = toConsoleUnit({
      record: unitChoices('axis')[0]!,
      instanceId: 'u1',
      hex: HEX,
      side: 'axis',
    })
    workbench.units.push(unit)

    workbench.beginSpDumpHexPickNow()
    mapView.onHexClick(HEX, { x: 10, y: 10 })

    // 写回了补给站格；而"选中该格算子并开始移动"（clickHex 的常规分派）没有发生
    expect(workbench.spDumpDraft.hexText).toBe(`${HEX.col}.${HEX.row}`)
    expect(workbench.moveInteraction).toBeNull()
    expect(workbench.selectedId).toBeNull()
    // 待点态吃掉这一击 ⇒ 也不开小窗
    expect(mapView.popup).toBeNull()
  })

  it('★ Esc / ×（`cancelSession`）先退待点态', () => {
    const { workbench, mapView } = newStores()
    workbench.beginHedgehogHexPickNow('build')
    expect(workbench.hexPickView).not.toBeNull()

    expect(mapView.cancelSession()).toBe(true)
    expect(workbench.hexPickView).toBeNull()
    // 再按一次：没有待点态、也没有会话 ⇒ 不吞按键
    expect(mapView.cancelSession()).toBe(false)
  })
})

describe('B27：接线（源码守卫）', () => {
  it('★ 地图侧：overlay 有候选字段、点击分派有模态分支、渲染层会画', () => {
    const mapView = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(mapView).toContain('pickCandidates: pickCandidateHexes.value')
    expect(mapView).toContain('if (workbench.pickHexFor(hex))')
    expect(mapView).toContain('workbench.cancelHexPick()')
    const layer = readFileSync('src/render/token-layer.ts', 'utf8')
    expect(layer).toContain('pickCandidates?: readonly HexRef[] | null')
    expect(layer).toContain('visible.pickCandidates')
  })

  it('★ 各面板都给出了"点地图选格"入口（B27a 的 11 处）', () => {
    const files: [string, string[]][] = [
      [
        'src/components/reinforcement/ReinforcementPanel.vue',
        ['beginArrivalHexPickNow(index)', 'beginFrontalReservesHexPickNow()'],
      ],
      [
        'src/components/exclusive/ExclusiveRulesPanel.vue',
        ['beginHedgehogHexPickNow(', 'beginSupplyCacheHexPickNow()'],
      ],
      [
        'src/components/supply/SupplyPanel.vue',
        ['beginSpDumpHexPickNow()', 'beginSupplySourceHexPickNow()', 'beginRailMoveHexPickNow()'],
      ],
      [
        'src/components/air/AirPanel.vue',
        [
          'beginAirPlacementHexPickNow()',
          'beginAirTransferHexPickNow()',
          'beginAirReturnHexPickNow(origin.aircraftId)',
          'beginAirBaseHexPickNow()',
        ],
      ],
    ]
    for (const [file, calls] of files) {
      const text = readFileSync(file, 'utf8')
      for (const call of calls) expect(text, `${file} 缺少 ${call}`).toContain(call)
    }
  })

  it('★ 旧文本路径**保留**（退路：格号仍可手打，两条路写的是同一处状态）', () => {
    const panel = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')
    expect(panel).toContain('v-model="workbench.spDumpDraft.hexText"')
  })
})

/**
 * B27b：**剩下 6 处**"格子编号"接上同一套机制
 *
 * 用户口径 #9 的要求是"**所有**需要玩家输入格子编号的项目"，B27a 只接了 11 处，
 * 剩下这 6 处的值原来躺在**组件局部 `ref`** 里（待点格写不回去）⇒ 本轮统一搬进 store：
 *   ① 13.5 重建的"补员所在格"；② 12.7a 转换格；③ 13.3f 换轨格；
 *   ④ 3.3b 城市控制声明格；⑤ 13.7 编队标记格；⑥ 1.6c 死亡堆返场落点。
 *
 * ★ 一条**测法边界（如实）**：候选口径分两类 ——
 *   **store 有明确投影的**（①②③④⑤）在这里断言候选内容；**条件在引擎侧的**（①⑥ 用 `'any'`）
 *   只断言"这一击被消费、值写回了 store 字段"，合法与否的用例在各自引擎文件里
 *   （`tests/engine/rebuild.test.ts` / `tests/stores/containers-flow.test.ts` …）——此处**不重复**判规则。
 */
describe('B27b：剩下 6 处格子编号 → 点地图', () => {
  /** 一枚本方运输点数（12.7a 转换格的候选来源） */
  function withTransportPoint(store: ReturnType<typeof newStores>['workbench']): void {
    const record =
      unitChoices('axis').find((item) => item.noncombatKind === 'transport_point') ??
      unitChoices('soviet').find((item) => item.noncombatKind === 'transport_point')!
    store.units.push(toConsoleUnit({ record, instanceId: 'tp-1', hex: HEX, side: 'axis' }))
  }

  it('★ 13.5 补员所在格：候选＝13.5 投影的合法落点（R2：不再 `any`）', () => {
    const { workbench, mapView } = newStores()
    const side = workbench.activeSide
    // 清掉场景自带单位，保证 HEX 不在敌 ZOC 内（候选口径只受本方 HQ 与 ZOC 影响）
    workbench.units.splice(0, workbench.units.length)
    // 摆一枚本方 HQ（directDrawHqHexes 的来源，使 HEX 落在 HQ 2 格内）
    const hqRecord = unitChoices(side).find((item) => (item.specialized ?? []).includes('hq'))!
    workbench.units.push(toConsoleUnit({ record: hqRecord, instanceId: 'hq-1', hex: HEX, side }))
    // 一枚**地面**死亡堆单位作为待重建对象
    const groundRecord = unitChoices(side).find((item) => item.classes?.movementClass === 'leg')!
    const dead = toConsoleUnit({ record: groundRecord, instanceId: 'dead-1', hex: HEX, side })
    workbench.deadPile.push(dead)
    workbench.beginRebuildReplHexPickNow('dead-1')

    // R2：候选是**显式格列表**（含 HQ 所在格），不再是 'any'
    const candidates = workbench.hexPickView?.candidates
    expect(Array.isArray(candidates)).toBe(true)
    expect(candidates).not.toBe('any')
    expect(candidates).toContainEqual(HEX)

    mapView.onHexClick(HEX)
    expect(workbench.rebuildReplHexText).toBe(`${HEX.col}.${HEX.row}`)
    expect(workbench.hexPickView).toBeNull()
  })

  it('★ 12.7a 转换格：候选＝图上本方运输点数格（点它写回，点别处不写）', () => {
    const { workbench, mapView } = newStores()
    withTransportPoint(workbench)
    workbench.beginConvertTargetHexPickNow()
    expect(workbench.hexPickView?.candidates).toEqual([HEX])

    // 先点一个**不在候选**里的格：不写、给提示、待点态保留
    const other = mapLayers.hexes.find((hex) => hex.col !== HEX.col || hex.row !== HEX.row)!
    mapView.onHexClick({ col: other.col, row: other.row })
    expect(workbench.convertTargetHexText).toBe('')
    expect(workbench.hexPickView).not.toBeNull()
    // 再点候选格 ⇒ 写回
    mapView.onHexClick(HEX)
    expect(workbench.convertTargetHexText).toBe(`${HEX.col}.${HEX.row}`)
  })

  it('★ 13.3f 换轨格：候选＝**该单位所在格**（13.3f-B「移动进入一个铁路格即可转换该格」）', () => {
    const { workbench, mapView } = newStores()
    const record = unitChoices('axis')[0]!
    workbench.units.push(toConsoleUnit({ record, instanceId: 'rr-1', hex: HEX, side: 'axis' }))

    workbench.beginRailGaugeTargetHexPickNow('rr-1')
    expect(workbench.hexPickView).toMatchObject({ rule: '13.3f', candidates: [HEX] })
    mapView.onHexClick(HEX)
    expect(workbench.railGaugeTargetHexText).toBe(`${HEX.col}.${HEX.row}`)

    // 单位实例不存在 ⇒ 不进入待点态（并留一行 warning）
    workbench.beginRailGaugeTargetHexPickNow('不存在')
    expect(workbench.hexPickView).toBeNull()
    expect(workbench.log[0]?.kind).toBe('warning')
  })

  it('★ 3.3b 城市格：候选＝地图城市格；13.7 标记格：候选＝图上本方单位格', () => {
    const { workbench } = newStores()
    // 地图城市（`mapCityHexes` 是地图数据投影，与算子无关）
    workbench.beginCityControlHexPickNow()
    expect(workbench.hexPickView?.candidates).toEqual(workbench.mapCityHexes)
    expect(workbench.mapCityHexes.length).toBeGreaterThan(0)

    // 13.7：本方单位格作候选（13.7 要求"至少一个所属单位须与标记同格"）
    const enemy = toConsoleUnit({
      record: unitChoices('soviet')[0]!,
      instanceId: 'e-1',
      hex: HEX,
      side: 'soviet',
    })
    workbench.units.push(enemy)
    workbench.beginFormationMarkerHexPickNow()
    expect(workbench.hexPickView?.candidates).toEqual([])
    workbench.units.push(
      toConsoleUnit({ record: unitChoices('axis')[0]!, instanceId: 'f-1', hex: HEX, side: 'axis' }),
    )
    workbench.beginFormationMarkerHexPickNow()
    expect(workbench.hexPickView?.candidates).toEqual([HEX])
  })

  it('★ 1.6c 返场落点：候选任意 ⇒ 点一格即写回', () => {
    const { workbench, mapView } = newStores()
    workbench.beginDeadPileReturnHexPickNow()
    expect(workbench.hexPickView).toMatchObject({ rule: '1.6c', candidates: 'any' })
    mapView.onHexClick(HEX)
    expect(workbench.deadPileReturnHexText).toBe(`${HEX.col}.${HEX.row}`)
  })

  it('★ 面板 6 处都给了按钮，且**值只有 store 一处**（组件不再各留局部 ref）', () => {
    const files: [string, string[]][] = [
      [
        'src/components/reinforcement/ReinforcementPanel.vue',
        ['beginRebuildReplHexPickNow(rebuildUnitId)', 'workbench.rebuildReplHexText'],
      ],
      [
        'src/components/supply/SupplyPanel.vue',
        ['beginConvertTargetHexPickNow()', 'beginRailGaugeTargetHexPickNow(gaugeUnitId)'],
      ],
      [
        'src/components/exclusive/ExclusiveRulesPanel.vue',
        ['beginCityControlHexPickNow()', 'workbench.cityControlHexText'],
      ],
      [
        'src/components/containers/ContainersPanel.vue',
        ['beginFormationMarkerHexPickNow()', 'beginDeadPileReturnHexPickNow()'],
      ],
    ]
    for (const [file, calls] of files) {
      const text = readFileSync(file, 'utf8')
      for (const call of calls) expect(text, `${file} 缺少 ${call}`).toContain(call)
    }
    // 局部 ref 已删（否则两份状态会走散）——只按**名字**查，别用 `ref<string>('')` 这种泛型写法当判据：
    // 面板里还有别的同类局部 ref（gaugeUnitId / destroyDumpId…），那是"选单位/选账本条目"，不是格子编号。
    for (const dead of [
      'const convertHexText = ref',
      'const gaugeHexText = ref',
      'const cityHexText = ref',
      'const formationMarkerHex = ref',
      'const returnHexText = ref',
    ]) {
      expect(
        readFileSync('src/components/supply/SupplyPanel.vue', 'utf8') +
          readFileSync('src/components/exclusive/ExclusiveRulesPanel.vue', 'utf8') +
          readFileSync('src/components/containers/ContainersPanel.vue', 'utf8'),
      ).not.toContain(dead)
    }
  })
})
