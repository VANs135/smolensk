import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers, type HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 条 12（M2）：**点非战斗单位 ⇒ 开对应动作会话**（`MapSessionKind:'unit'`）
 *
 * 按所点单位的类型（`mapView.unitActionFamily`）路由到**既有**面板（经 `UnitPanel` 分派）：
 *   · sp / supply_point / transport_point / organic_truck / supply_extender ⇒ `supply`
 *     （SP 拖取 / 运输点装卸 / 延补队，12.1 / 13.2 / 9.14）
 *   · air_base ⇒ `air`（空军基地：14.1a 落位 / 15.1 整备 / 15.3 简易机场）
 *   · hedgehog ⇒ `fort`（工事，16.0b）
 *
 * 同时落实「右栏只读」：原右栏可写面板（`AirPanel only="admin"` / `SupplyPanel only="ledger"`）
 * 已收进本会话（源码守卫见 air-supply-chain.test.ts）。
 *
 * 用**真实单位库**：点哪一类就路由到哪一族，全看单位数据里的 `noncombatKind`。
 */

const START: HexRef = { col: 36, row: 13 }
const ELSEWHERE: HexRef = { col: 36, row: 12 }

const newStores = () => {
  setActivePinia(createPinia())
  /*
   * ★ 用户 2026-10-25：**初设未收束时不开任何单位动作会话**（初设的摆位 / 飞机落位 / SP 归属
   *   全在「初设与开局」面板与决策队列里做；此时点基地格会按 `activeSide` 摊出**对方**的面板，
   *   实测"给苏方布设却看到德军整备"就是这么来的）。
   *   本文件钉的是**对局中**的路由行为 ⇒ 夹具显式把初设标为已收束。
   */
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  /*
   * ★ 用户 2026-10-25（设施 × 环节）：**能不能对设施操作，要看本环节的闸门**——
   *   补给站只有 12.11a 的"销毁"（移动/反应/进击的**移动环节**）；基地 15.1 在 A 段、
   *   15.3/15.4 在移动阶段；工事 16.0b 在移动阶段。
   *   本文件钉"点枚进操作"的机制 ⇒ 夹具落在 **C 段移动环节**（三类设施在此都有可用操作）。
   */
  workbench.setPhase('movement')
  const stepIndex = workbench.playerSegmentSteps.findIndex(
    (step) => step.id === 'movement.modeAndMovement',
  )
  if (stepIndex >= 0) workbench.setSegmentStepIndex(stepIndex)
  return { workbench, mapView: useMapViewStore() }
}

/** 取一个指定 `noncombatKind` 的轴方记录（找不到即失败，避免静默用错夹具） */
function recordOfKind(kind: string): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('axis').find((record) => record.noncombatKind === kind)
  if (found === undefined) throw new Error(`单位库中没有 noncombatKind='${kind}' 的记录`)
  return found
}

function placeNonCombat(
  workbench: ReturnType<typeof newStores>['workbench'],
  kind: string,
  hex: HexRef,
  instanceId: string,
): void {
  workbench.units.push(toConsoleUnit({ record: recordOfKind(kind), instanceId, hex, side: 'axis' }))
}

describe('条 12（M2）：点非战斗单位开 unit 会话', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('点 SP ⇒ supply 会话（SP 拖取 / 补给账本）', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'sp', START, 'sp-1')
    expect(mapView.session).toBeNull()

    mapView.onHexClick(START, { x: 40, y: 40 })

    expect(mapView.session?.kind).toBe('unit')
    expect(mapView.unitActionFamily).toBe('supply')
    expect(mapView.session?.rule).toBe('12.1')
    // 条 12：单位会话优先于取子/小窗 ⇒ 不开小窗、不建移动取子清单
    expect(mapView.popup).toBeNull()
    expect(workbench.movePick).toBeNull()
  })

  it('点运输点 ⇒ supply 会话（装卸）', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'transport_point', START, 'tp-1')
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).toBe('unit')
    expect(mapView.unitActionFamily).toBe('supply')
  })

  /**
   * 2026-11-26（用户实测）：会话窗**不许再列一份与右键菜单同名的动作清单**
   *   · 铁路运输（13.3）的窗里冒出「修建/改进基地(15.3)」「缩减基地(15.4)」——清单排在
   *     "已选段"之前，把 13.3 的窗顶成了设施菜单；
   *   · 定稿 §4.1：设施动作由右键菜单选段，选段后面板只画那一段。
   * 本用例钉住 store 侧：多段设施照样只报"能做哪些段"，不再提供"从窗里点段"的第二条入口。
   */
  it('多段设施：左键窗只画已选段，选项清单只由 facilityActionKeys 给出', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'transport_point', START, 'tp-1')
    mapView.onHexClick(START, { x: 40, y: 40 })

    const options = mapView.unitActionOptions('tp-1')
    expect(options.length).toBeGreaterThan(1)
    // 窗里没有第二条入口（这两个入口已在 2026-11-26 撤回）
    expect('unitActionMenuAt' in mapView).toBe(false)
    expect('openUnitActionSectionNow' in mapView).toBe(false)
  })

  it('点延补队 ⇒ supply 会话（9.14d）', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'supply_extender', START, 'se-1')
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).toBe('unit')
    expect(mapView.unitActionFamily).toBe('supply')
  })

  it('点空军基地 ⇒ air 会话（14.1a / 15.1 / 15.3）', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'air_base', START, 'base-1')
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).toBe('unit')
    expect(mapView.unitActionFamily).toBe('air')
    // 会话的规则号=**基地格的基础条款**（14.1a 落位）；整备 15.1 / 简易机场 15.3 是格内操作
    expect(mapView.session?.rule).toBe('14.1a')
    expect(mapView.session?.title).toContain('空军基地')
  })

  it('点工事（hedgehog）⇒ 不再开 fort 会话（16.0b 的动作入口在格内单位）', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'hedgehog', START, 'hg-1')
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).not.toBe('unit')
    expect(mapView.unitActionFamily).toBeNull()
    // 2026-11-26：工事格不再给"对它自己"的操作（执行者是单位）
    expect(mapView.unitActionAvailableAt('hg-1')).toBe(false)
  })

  it('点别处（空格）⇒ 收掉单位会话', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'sp', START, 'sp-1')
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).toBe('unit')

    mapView.onHexClick(ELSEWHERE, { x: 40, y: 40 })
    expect(mapView.session).toBeNull()
    expect(mapView.unitActionFamily).toBeNull()
  })

  it('点战斗单位 ⇒ 不开 unit 会话（仍走取子/移动那条链）', () => {
    const { workbench, mapView } = stores
    const record = unitChoices('axis').find(
      (item) =>
        item.classes?.movementClass === 'leg' &&
        item.attackCapable === true &&
        (item.factors?.combat?.ma ?? 0) >= 4,
    )!
    workbench.units.push(toConsoleUnit({ record, instanceId: 'a1', hex: START, side: 'axis' }))
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).not.toBe('unit')
    expect(mapView.unitActionFamily).toBeNull()
    // 战斗单位照旧建立取子清单（条 10）
    expect(workbench.movePick?.ids).toEqual(['a1'])
  })

  it('cancelSession ⇒ 收掉单位会话', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'air_base', START, 'base-1')
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).toBe('unit')

    expect(mapView.cancelSession()).toBe(true)
    expect(mapView.session).toBeNull()
    expect(mapView.unitActionHex).toBeNull()
  })

  it('单位离开盘面 ⇒ 会话自然消失（family 归 null）', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'sp', START, 'sp-1')
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.unitActionFamily).toBe('supply')

    workbench.units = workbench.units.filter((unit) => unit.instanceId !== 'sp-1')
    expect(mapView.unitActionFamily).toBeNull()
    expect(mapView.session).toBeNull()
  })

  it('★ 批 A：点空军基地 ⇒ unit(air) 会话，勾选参战机后路由器切到 air(mission) 会话', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'air_base', START, 'base-1')
    const aircraft = aircraftChoices('axis')[0]!
    workbench.airUnits.push(
      toConsoleAirUnit({
        aircraft,
        instanceId: 'ac-1',
        hex: START,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    /*
     * ★ 用户 2026-10-25（渐进交互）：格里有基地 + 停在基地的飞机 ⇒ 点格**先摊堆叠**，
     *   由玩家在清单里点「操作」才进 unit(air) 会话（不再"点格即开会话"）。
     */
    mapView.onHexClick(START, { x: 40, y: 40 })
    expect(mapView.session?.kind).not.toBe('unit')
    // 基地算子走自己的选择路径（基地不靠"设施动作表"才可点）
    expect(mapView.selectCounterAt(START, 'base-1')).toBe(true)
    expect(mapView.session?.kind).toBe('unit')
    expect(mapView.unitActionFamily).toBe('air')

    // 在会话里勾选这枚参战机 ⇒ airMissionAirIds>0 ⇒ 路由器优先给 air(mission) 会话
    workbench.toggleAirMissionUnit('ac-1')
    expect(workbench.airMissionAirIds).toContain('ac-1')
    expect(mapView.session?.kind).toBe('air')
  })

  it('★ 用户口径：所有主动空军任务从目标右键进；点空格不再开 target-first', () => {
    const { workbench, mapView } = stores
    workbench.setPhase('movement')
    // 进 C 段移动环节（14.7d 低空扫射就在此宣布；该环节允许 air 来源）
    const idx = workbench.playerSegmentSteps.findIndex(
      (step) => step.id === 'movement.modeAndMovement',
    )
    expect(workbench.setSegmentStepIndex(idx)).toBe(true)
    // 空军基地 + 一架**运输机**（空投 14.10 的目标是格，不需要敌方算子）
    placeNonCombat(workbench, 'air_base', START, 'base-1')
    workbench.airUnits.push(
      toConsoleAirUnit({
        aircraft: aircraftChoices('axis').find((a) => a.aircraftId === 'ax-aircraft-ge-ju-52')!,
        instanceId: 'ac-1',
        hex: START,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    const target = HEX_DIRECTIONS.map((direction) => neighbor(START, direction)).find(
      (hex) =>
        isOnMap(hex) &&
        mapLayers.hexes.some((item) => item.col === hex.col && item.row === hex.row) &&
        !workbench.units.some((unit) => unit.hex.col === hex.col && unit.hex.row === hex.row),
    )
    expect(target, '应找到图内的空邻格').toBeDefined()

    // 左键点空格：不再开 target-first 会话（新口径：目标侧右键才是入口）
    mapView.onHexClick(target!, { x: 40, y: 40 })
    expect(mapView.session).toBeNull()

    // 右键该格 ⇒ 目标侧「空军任务」菜单出现「空投」
    mapView.onHexContext(target!, { x: 40, y: 40 }, { x: 10, y: 10 })
    const option = mapView.contextOptions.find((item) =>
      item.actions.some((action) => action.label === '空投'),
    )
    expect(option, '空投应出现在目标格菜单').toBeDefined()
    const action = option!.actions.find((item) => item.label === '空投')!
    expect(mapView.openContextAction(option!.id, action.key)).toBe(true)

    expect(mapView.session?.kind).toBe('air')
    expect(workbench.airTargetHex).toEqual(target)
    expect(mapView.airEntryTarget).toEqual(target)
    expect(workbench.airActive).toBe(true)
    expect(mapView.popup).toBeNull()
  })

  it('★ 批 A：空军引导态在勾到第一架参战机后交棒（airEntryTarget 清空、会话续跑）', () => {
    const { workbench, mapView } = stores
    workbench.setPhase('movement')
    const idx = workbench.playerSegmentSteps.findIndex(
      (step) => step.id === 'movement.modeAndMovement',
    )
    expect(workbench.setSegmentStepIndex(idx)).toBe(true)
    placeNonCombat(workbench, 'air_base', START, 'base-1')
    workbench.airUnits.push(
      toConsoleAirUnit({
        aircraft: aircraftChoices('axis').find((a) => a.aircraftId === 'ax-aircraft-ge-ju-52')!,
        instanceId: 'ac-1',
        hex: START,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    const target = HEX_DIRECTIONS.map((direction) => neighbor(START, direction)).find(
      (hex) =>
        isOnMap(hex) &&
        mapLayers.hexes.some((item) => item.col === hex.col && item.row === hex.row) &&
        !workbench.units.some((unit) => unit.hex.col === hex.col && unit.hex.row === hex.row),
    )!
    mapView.onHexContext(target, { x: 40, y: 40 }, { x: 10, y: 10 })
    const option = mapView.contextOptions.find((item) =>
      item.actions.some((action) => action.label === '空投'),
    )!
    const action = option.actions.find((item) => item.label === '空投')!
    expect(mapView.openContextAction(option.id, action.key)).toBe(true)
    expect(mapView.airEntryTarget).toEqual(target)

    workbench.toggleAirMissionUnit('ac-1')
    expect(mapView.airEntryTarget).toBeNull() // 引导态交棒
    expect(mapView.session?.kind).toBe('air') // 会话续跑（由选机驱动）

    // 取消会话 ⇒ airEntryTarget 仍空、会话消失
    expect(mapView.cancelSession()).toBe(true)
    expect(mapView.session).toBeNull()
    expect(mapView.airEntryTarget).toBeNull()
  })

  it('★ 批 A：按航程列机——任务格在航程内时该机不灰显（14.1 只在超航程时触发）', () => {
    const { workbench } = stores
    workbench.setPhase('movement')
    workbench.airUnits.push(
      toConsoleAirUnit({
        aircraft: aircraftChoices('axis')[0]!,
        instanceId: 'ac-1',
        hex: START,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    // 相邻格在航程内 ⇒ 该机在候选阵列里**不**被 14.1 灰显
    const near = neighbor(START, HEX_DIRECTIONS[0]!)
    workbench.setAirTargetFromText(`${near.col}.${near.row}`)
    expect(
      workbench.airMissionJoinChoices.find((c) => c.air.instanceId === 'ac-1')?.disabledReason,
    ).toBeNull()
    /*
     * 注：本作斯摩棱斯克图上任一格距都在轴方各机航程内（最小航程 41 > 图内最大格距 35），
     * 故"超航程灰显"的 TRUE 分支在此图不可达；逻辑已实现（airMissionJoinChoices 的 14.1 判据），
     * 更大图 / 更短航程机出现时即生效。这里只钉"航程内不误灰显"。
     */
  })

  /**
   * ★ 用户 2026-11-23（UI 泄露）：空军任务结算 → 飞机返航收束后，左键点**别的格子**
   *   不该再弹空军任务窗。
   *
   * 病灶（修前）：`onHexClick` 里「点目标格即定任务格」只问 `airActive && airMissionAirIds.length > 0`；
   *   返航后编组残留没清，点任意格就 `setAirTargetFromText` 把 `finished` 的任务态复位成"未宣布"
   *   （`canReplace()` 在 finished 时返 true），会话当场复活。
   * 两道修法一起钉：① 返航收尾清任务编组；② 该分派只认 `airState === null`（任务尚未宣布）。
   */
  it('★ 低空扫射返航收束后点别的格子不再复现空军任务会话', () => {
    const { workbench, mapView } = stores
    placeNonCombat(workbench, 'air_base', START, 'base-1')
    // 10.0b：低空扫射要「与目标格相邻的友方战斗单位」当正确观察员
    workbench.units.push(
      toConsoleUnit({
        record: unitChoices('axis').find((record) => record.isCombat === true)!,
        instanceId: 'spot-1',
        hex: START,
        side: 'axis',
      }),
    )
    const target = HEX_DIRECTIONS.map((direction) => neighbor(START, direction)).find(
      (hex) =>
        isOnMap(hex) &&
        mapLayers.hexes.some((item) => item.col === hex.col && item.row === hex.row) &&
        !workbench.units.some((unit) => unit.hex.col === hex.col && unit.hex.row === hex.row),
    )
    expect(target, '应找到图内的空邻格当任务格').toBeDefined()
    // 目标格上的苏军战斗单位（10.0a 的损失承受者）
    workbench.units.push(
      toConsoleUnit({
        record: unitChoices('soviet').find((record) => record.isCombat === true)!,
        instanceId: 'def-1',
        hex: target!,
        side: 'soviet',
      }),
    )
    const stuka = aircraftChoices('axis').find(
      (record) => record.aircraftId === 'ax-aircraft-ge-ju-87b',
    )
    expect(stuka, '轴方飞机库里应有 Ju.87b（14.7d 低空扫射机）').toBeDefined()
    workbench.airUnits.push(
      toConsoleAirUnit({
        aircraft: stuka!,
        instanceId: 'stuka-1',
        hex: START,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    workbench.barrageInputs = { ...workbench.barrageInputs, hasSpotter: true }

    expect(workbench.setAirTargetFromText(`${target!.col}.${target!.row}`)).toBe(true)
    workbench.toggleAirMissionUnit('stuka-1')
    expect(mapView.session?.kind).toBe('air') // 已选机待宣布 ⇒ 空军任务会话
    workbench.setAirMissionKind('hip_shoot')
    expect(workbench.runAirMissionNow()).toBe(true)
    expect(workbench.settleAirMissionNow()).toBe(true)
    // 干净扫射全自动到返航（条 13 / 14.1c）⇒ 任务 finished，会话收束
    expect(workbench.airState?.finished).toBe(true)
    expect(mapView.session).toBeNull()

    expect(workbench.airMissionAirIds).toEqual([])
    mapView.onHexClick(ELSEWHERE, { x: 40, y: 40 })

    expect(mapView.session?.kind ?? null).not.toBe('air')
    expect(workbench.airState?.finished).toBe(true)
    expect(workbench.airState?.targetHex).toEqual(target)
  })

  /**
   * ★ 用户 2026-11-23（同一批的第 2 条）：**任务类型只由右键菜单定**，引导不得再框面板里的
   *   只读类型文字（否则读成"在空军任务窗口里再选一次"）。
   */
  it('★ 教学引导不框面板里的只读任务类型（还没定目标时只框地图格）', () => {
    const tutorial = readFileSync('src/stores/tutorial.ts', 'utf8')
    // 三类任务的"未定目标"阶段都不再用类型文字当控件（含「低空扫射 + 机型」这种合写）
    expect(tutorial).not.toContain("texts: ['低空扫射")
    expect(tutorial).not.toContain("texts: ['战机扫荡']")
    expect(tutorial).not.toContain("texts: ['轰炸']")
    // 只框地图格（右键入口），并在提示里交代右键路径
    expect(tutorial).toContain('return { hex: TARGET_HEX }')
    expect(tutorial).toContain('return { hex: BOMB_HEX }')
    expect(tutorial).toContain('右键那格苏军')
  })

  /** 上面那条用例的行为版之外，再钉一道源码闸：泄露链路的两个可燃点都不许回来 */
  it('★ 空军任务收束后不泄露会话（点击分派 + 返航清编组）', () => {
    const mapView = readFileSync('src/stores/map-view.ts', 'utf8')
    const air = readFileSync('src/stores/workbench-air.ts', 'utf8')
    // ① 修前的泄露写法：只看「工具开着 + 编组里有飞机」，没有"任务未宣布"这道闸
    expect(mapView).not.toContain(
      'if (!consumed && workbench.airActive && workbench.airMissionAirIds.length > 0) {',
    )
    // ② 返航完成即清任务编组（残留 id 是会话复活的可燃物）
    expect(air).toContain('const done = airMissionDomain.completeAirReturnNow()')
    expect(air).toContain('airMissionAirIds.value = []')
  })
})
