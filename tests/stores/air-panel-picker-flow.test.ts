import { existsSync, readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  aircraftChoices,
  aircraftRecordImageUrlOf,
  spDumpImageUrlOf,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
} from '@/stores'
import { readStoreSource } from '../shared/store-source'
import { counterKeyOf } from '../counter-url-helper'

/**
 * B14a：空军面板迁移到 `CounterPicker`（用户口径⑪ 后半）
 *
 * 「把当前可选的**算子图片**紧凑排出来；算子上信息已经够了，除了环节提示这种外不需要显示额外的文字」。
 *
 * 本文件钉三件事（组件是纯投影，真正的风险在**取图**、**闸门**与**点击是否真的接线**）：
 *   ① **取图链路**：机型/补给站的图 URL 指向的文件**真在 `public/` 里**——图档没同步进来时
 *      阵列会是一排空框，而"空框"不会让任何断言失败，故这里查文件是否存在（B12 的教训）；
 *   ② **参战机的可选性**：四条闸（**14.1a 激活状态** / 14.2f 窗口 / 14.2a 上限 / 14.2e 一阶段一次）
 *      逐机给出原因，且**已选中的恒可点**（否则取消勾选会被自己禁掉）；
 *      ★ H⑤ 起把 14.1a 也纳入（用户 2026-09-18 第 8 条「未激活的飞机应该不可选中」）——
 *      本文件只覆盖前三条闸的既有用例，14.1a 的四条守卫在 `tests/stores/air-mission-active-only.test.ts`；
 *   ③ **15.4 的"被指定单位"真的接线**：点阵列改的是输入清单，而输入清单是引擎结论的必要条件
 *      ——不指定 ⇒ 引擎拒绝；指定 ⇒ 通过（否则那一列图只是装饰）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 六邻皆图内的格（摆基地与飞机都在这里，避免邻格/航程断言受地图形状影响） */
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

function airBaseRecord(level?: number): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('axis').find(
    (record) =>
      record.noncombatKind === 'air_base' &&
      (level === undefined || (record.noncombatDetails?.level ?? 0) === level),
  )
  if (found === undefined)
    throw new Error(`单位库中没有${level === undefined ? '' : ` ${level} 级`}空军基地算子`)
  return found
}

function fighterRecord(side: Side): ReturnType<typeof aircraftChoices>[number] {
  const found = aircraftChoices(side).find((record) => record.aircraftType === 'F')
  if (found === undefined) throw new Error(`${side} 飞机库中没有战斗机`)
  return found
}

/** 15.4 的执行者候选：RE ≥ 1 的战斗单位 */
function combatRecord(side: Side): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(
    (record) => record.isCombat === true && (record.reSize ?? 0) >= 1,
  )
  if (found === undefined) throw new Error(`${side} 单位库中没有 RE ≥ 1 的战斗单位`)
  return found
}

/** 摆一个本方基地 + N 架激活战机（14.1a：飞机停在基地格） */
function setupBaseAndPlanes(store: ReturnType<typeof newStore>, count = 1) {
  const base = toConsoleUnit({
    record: airBaseRecord(),
    instanceId: 'base-1',
    hex: CORE_HEX,
    side: 'axis',
  })
  store.units.push(base)
  const planes = Array.from({ length: count }, (_unused, index) =>
    toConsoleAirUnit({
      aircraft: fighterRecord('axis'),
      instanceId: `air-${String(index + 1)}`,
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'active',
    }),
  )
  for (const plane of planes) store.airUnits.push(plane)
  return { base, planes }
}

/** 把图 URL 还原成 `public/` 下的真实路径（内联 data URI 先反查 `dir/文件名`；静态路径须解码） */
function diskPathOf(url: string): string {
  const key = counterKeyOf(url)
  const rel = key.startsWith('/counters/')
    ? decodeURIComponent(key.slice('/counters/'.length))
    : key
  return `public/counters/${rel}`
}

/**
 * B47（12.8e）：走到移动阶段的**「模式与移动」环节**
 *
 * 突围环节是该段的**首环节**（"before any other movement"）—— 场上有断补单位时它会占住当前环节，
 * 故这些用例在 `setPhase('movement')
  goToMovementStep(store)` 之后要先按流程走一环，再调各自的动作。
 */
function goToMovementStep(store: {
  playerSegmentSteps: readonly { id: string }[]
  setSegmentStepIndex(index: number): boolean
}): void {
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement')
  if (index >= 0) store.setSegmentStepIndex(index)
}
describe('B14a：机型与补给站的取图（图上真的取得到）', () => {
  it('★ 机型记录 → 图 URL 指向**该阵营的图档目录**，且文件真实存在（全库逐条查）', () => {
    for (const side of ['axis', 'soviet'] as const) {
      const records = aircraftChoices(side)
      expect(records.length, `${side} 飞机库不应为空`).toBeGreaterThan(0)
      for (const record of records) {
        const url = aircraftRecordImageUrlOf(record, side)
        expect(url, `${record.aircraftId} 取不到图`).not.toBeNull()
        const key = counterKeyOf(url!)
        expect(key.startsWith(`${side}/`), `${record.aircraftId} 取错阵营目录：${key}`).toBe(true)
        expect(key).toContain(record.images?.front ?? '')
        expect(existsSync(diskPathOf(url!)), `图档缺失：${url}`).toBe(true)
      }
    }
  })

  it('★ 补给站 → **当前点数的 SP 算子图**（点数不同图不同；文件真实存在）', () => {
    const three = spDumpImageUrlOf({ side: 'axis', sp: 3 })
    const five = spDumpImageUrlOf({ side: 'axis', sp: 5 })
    expect(three).not.toBeNull()
    expect(five).not.toBeNull()
    expect(three).not.toBe(five)
    expect(counterKeyOf(three!)).toContain('Neutral_SP_3_F.png')
    expect(counterKeyOf(five!)).toContain('Neutral_SP_5.png')
    expect(existsSync(diskPathOf(three!))).toBe(true)
    expect(existsSync(diskPathOf(five!))).toBe(true)
    // 0 点 ⇒ 取不到图：界面退回空框（不臆造文件名）
    expect(spDumpImageUrlOf({ side: 'axis', sp: 0 })).toBeNull()
  })
})

describe('B14a：参战机的可选性（三条闸逐机给出原因）', () => {
  it('初始可加；**选中的恒可点**（否则取消勾选会被自己的上限禁掉）', () => {
    const store = newStore()
    store.setAirActive(true)
    const { planes } = setupBaseAndPlanes(store, 1)
    const plane = planes[0]!

    let choice = store.airMissionJoinChoices.find(
      (item) => item.air.instanceId === plane.instanceId,
    )
    expect(choice).toMatchObject({ selected: false, disabledReason: null })

    store.toggleAirMissionUnit(plane.instanceId)
    choice = store.airMissionJoinChoices.find((item) => item.air.instanceId === plane.instanceId)
    expect(choice).toMatchObject({ selected: true, disabledReason: null })
  })

  it('14.2e：本机本阶段已执行过一次任务 ⇒ 该枚不可点（原因含规则号）', () => {
    const store = newStore()
    store.setAirActive(true)
    const { planes } = setupBaseAndPlanes(store, 2)
    planes[1]!.missionsFlownThisPhase = 1

    const choices = store.airMissionJoinChoices
    expect(choices.find((item) => item.air.instanceId === 'air-1')?.disabledReason).toBeNull()
    expect(choices.find((item) => item.air.instanceId === 'air-2')?.disabledReason).toContain(
      '14.2e',
    )
  })

  it('14.2a：选满 4 架 ⇒ 其余各枚不可点（原因含上限）', () => {
    const store = newStore()
    store.setAirActive(true)
    const { planes } = setupBaseAndPlanes(store, 5)
    for (const plane of planes.slice(0, 4)) store.toggleAirMissionUnit(plane.instanceId)
    expect(store.airMissionAirIds).toHaveLength(4)
    expect(store.airJoinRemaining).toBe(0)

    const fifth = store.airMissionJoinChoices.find((item) => item.air.instanceId === 'air-5')
    expect(fifth?.selected).toBe(false)
    expect(fifth?.disabledReason).toContain('14.2a')
    // 已选中的四枚仍可点（取消勾选不受 14.2a 限制）
    for (const id of store.airMissionAirIds) {
      const choice = store.airMissionJoinChoices.find((item) => item.air.instanceId === id)
      expect(choice).toMatchObject({ selected: true, disabledReason: null })
    }
  })

  it('14.2f：任务已过移动步 ⇒ 不能再加机（窗口闸）', () => {
    const store = newStore()
    store.setAirActive(true)
    // 14.2e：本用例走 C 移动环节，任务类型取战机扫荡（14.6：目标须有敌方激活飞机）
    store.setAirMissionKind('fighter_sweep')
    const { planes } = setupBaseAndPlanes(store, 2)
    const enemyHex = neighbor(CORE_HEX, HEX_DIRECTIONS[0]!)
    const enemyBaseRecord = unitChoices('soviet').find(
      (record) => record.noncombatKind === 'air_base',
    )
    if (enemyBaseRecord === undefined) throw new Error('苏军单位库中没有空军基地')
    store.units.push(
      toConsoleUnit({
        record: enemyBaseRecord,
        instanceId: 'base-enemy',
        hex: enemyHex,
        side: 'soviet',
      }),
    )
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: fighterRecord('soviet'),
        instanceId: 'air-enemy',
        hex: enemyHex,
        side: 'soviet',
        airStatus: 'active',
      }),
    )
    expect(store.setAirTargetFromText(label(enemyHex))).toBe(true)
    store.toggleAirMissionUnit('air-1')
    expect(store.beginAirMissionNow()).toBe(true)
    // 14.2f：此时已走到 C 步（空战）⇒ 加机窗口关闭
    expect(store.airState?.step).toBe('airCombat')

    const second = store.airMissionJoinChoices.find((item) => item.air.instanceId === 'air-2')
    expect(second?.disabledReason).toContain('14.2f')
    // 已参战那一架仍可点（取消勾选）
    expect(
      store.airMissionJoinChoices.find((item) => item.air.instanceId === 'air-1')?.disabledReason,
    ).toBeNull()

    // 点击确实被拒（原因与闸门同源：14.2f 的窗口判定）
    store.toggleAirMissionUnit('air-2')
    expect(store.airState).not.toBeNull()
    expect(store.airMissionAirIds).toEqual(['air-1'])
    expect(store.airError?.rule).toBe('14.2f')
    void planes
  })
})

describe('B14a：15.4「被指定单位」的指定真的接线', () => {
  /** 基地（2 级：15.0c 永不降到 1 级以下，1 级基地会先被 15.0c 挡下）+ 一名 RE≥1 的战斗单位同格；进入移动阶段 */
  function setupReduction() {
    const store = newStore()
    store.setAirActive(true)
    const base = toConsoleUnit({
      record: airBaseRecord(2),
      instanceId: 'base-1',
      hex: CORE_HEX,
      side: 'axis',
    })
    const worker = toConsoleUnit({
      record: combatRecord('axis'),
      instanceId: 'worker-1',
      hex: CORE_HEX,
      side: 'axis',
    })
    store.units.push(base, worker)
    store.setPhase('movement')
    goToMovementStep(store)
    return { store, base, worker }
  }

  it('★ 不指定任何单位 ⇒ 引擎按 15.4 拒绝（阵列不是装饰）', () => {
    const { store, base } = setupReduction()
    expect(store.airInputs.reductionUnitIds).toEqual([])
    const levelBefore = base.noncombatLevel
    expect(store.reduceBaseNow('base-1')).toBe(false)
    expect(store.airError).toMatchObject({ rule: '15.4', reason: 'reducingUnitNotEligible' })
    expect(base.noncombatLevel).toBe(levelBefore)
  })

  it('★ 点一枚即指定 ⇒ 通过；再点一枚即取消 ⇒ 又回到被拒', () => {
    const { store, base, worker } = setupReduction()
    const levelBefore = base.noncombatLevel

    store.toggleAirReductionUnit(worker.instanceId)
    expect(store.airInputs.reductionUnitIds).toEqual(['worker-1'])
    expect(store.reduceBaseNow('base-1')).toBe(true)
    expect(base.noncombatLevel).toBe(levelBefore - 1)
    expect(worker.movementEnded).toBe(true)

    // 取消指定 ⇒ 清单空 ⇒ 下一座基地同样被拒（15.4 必要条件）
    store.toggleAirReductionUnit(worker.instanceId)
    expect(store.airInputs.reductionUnitIds).toEqual([])
    const second = toConsoleUnit({
      record: airBaseRecord(2),
      instanceId: 'base-2',
      hex: CORE_HEX,
      side: 'axis',
    })
    store.units.push(second)
    expect(store.reduceBaseNow('base-2')).toBe(false)
    expect(store.airError).toMatchObject({ rule: '15.4', reason: 'reducingUnitNotEligible' })
  })
})

describe('B14a：空军面板的替换（源码守卫）', () => {
  const panel = readFileSync('src/components/air/AirPanel.vue', 'utf8')

  it('「选算子」都改走 `CounterPicker`，付款站改地图点选（不留两套控件）', () => {
    expect(panel.match(/<CounterPicker/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(panel).not.toContain('<select v-model="workbench.airPlacement.aircraftId"')
    expect(panel).not.toContain('<select v-model="workbench.airInputs.interceptorId"')
    expect(panel).not.toContain('<select v-model="workbench.constructionInputs.engineerId"')
    expect(panel).not.toContain('<select v-model="workbench.constructionInputs.payDumpId"')
    // 用户 2026-11-12：付款站不再在面板选，改为地图高亮 + 点选
    expect(panel).not.toContain(':items="dumpItems"')
    expect(panel).toContain('workbench.toggleConstructionPayPick()')
    // 被指定单位：点击直连 store 的动作（不是只改本地显示）
    expect(panel).toContain('@pick="workbench.toggleAirReductionUnit($event)"')
    /*
     * 用户 2026-11-13：选飞机只出现一次 —— 选机并入面板 1（编组卡），
     * ops 面板不再另列一列；AirPanel 内不再按任务类型隐藏选机（`showsMissionRoster` 已删）。
     */
    expect(panel).not.toContain('showsMissionRoster')
    expect(panel).toContain('workbench.toggleAirMissionUnit(')
  })

  it('悬停同步地图高亮：其余三类对象都走既有的 `setHoverHex`（不另立通道）', () => {
    expect(panel).toContain('workbench.setHoverHex')
    expect(panel).toContain('@hover="hoverAir"')
    expect(panel).toContain('@hover="hoverUnit"')
  })

  it('★ 14.3e-B：逐轮点名在面板上（攻方非括号机 / 守方任选），可选性仍由 store 给', () => {
    // 每轮两个阵列（攻 / 守），行数取 store 的轮数上界
    expect(panel).toContain('workbench.airCombatRoundBudget')
    expect(panel).toContain('attackerPickItems(round - 1)')
    expect(panel).toContain('defenderPickItems(round - 1)')
    expect(panel).toContain("setAirCombatPick(round - 1, 'attackerAircraftId', $event)")
    expect(panel).toContain("setAirCombatPick(round - 1, 'defenderAircraftId', $event)")
    // 候选来自 store 投影（组件不自己筛机队）
    expect(panel).toContain('workbench.airCombatAttackerPlanes')
    expect(panel).toContain('workbench.airCombatDefenderPlanes')
    // 写回落在 airInputs 上（组件不另立状态）
    const store = readStoreSource()
    expect(store).toContain(
      'airCombatPicks: { attackerAircraftId: string | null; defenderAircraftId: string | null }[]',
    )
    expect(store).toContain('function airCombatPicksPayload()')
  })

  it('★ 2026-11-23：守方由 AI / 脚本接管时，玩家不代点，但对方派了哪一架看得见（只读）', () => {
    // 面板：守方阵营 = AI / 脚本 ⇒ 可点的那列收掉（不给玩家代对手选机）
    expect(panel).toContain('aiChoosesDefenderPlanes')
    expect(panel).toContain('v-if="!aiChoosesDefenderPlanes"')
    expect(panel).toContain('守方点名：由')
    /*
     * 同一条口径的另一半（用户 2026-11-23：「空战时是能看到对方单位的，对方选不代表看不到」）：
     * 对手自选时**照铺阵列**（`readonly` + `defenderDisplayItems`），选中金框＝对手派的那一架。
     */
    expect(panel).toContain('defenderDisplayItems(round - 1)')
    expect(panel).toContain(':title="`守方点名（第 ${round} 轮：${defenderSideLabel}已选，只读）`"')
    expect(panel).toContain('readonly')
    const picker = readFileSync('src/components/game/CounterPicker.vue', 'utf8')
    expect(picker).toContain('readonly?: boolean')
    expect(picker).toContain('picker__cell--readonly')
    // 飞机只有空战值（ACV），没有行动值（AR）——这里不许写成「行动值最高」
    expect(panel).toContain('按空战值（ACV）最高的那一架迎战')
    expect(panel).not.toContain('按行动值最高的那一架')
    // 脚本：苏军那一半由脚本按 ACV 最高替它点名（不点＝引擎缺省同口径）
    const tutorial = readFileSync('src/stores/tutorial.ts', 'utf8')
    expect(tutorial).toContain("air.side === 'soviet'")
    expect(tutorial).toContain('workbench.airInputs.airCombatPicks = rows')
  })

  it('★ 14.9 / 14.10：载货区按任务类型门控，输入直连 airInputs', () => {
    // 空运：SP 与单位货物（14.9）；空投：SP 与计划/执行回合（14.10b）
    expect(panel).toContain("workbench.airMissionKind === 'air_transport'")
    expect(panel).toContain("workbench.airMissionKind === 'air_drop'")
    expect(panel).toContain('workbench.airInputs.cargoSpT')
    expect(panel).toContain('workbench.airInputs.airdropPlannedTurn')
    expect(panel).toContain('workbench.airInputs.airdropScheduledTurn')
    // P0（R6）：人员空投 N/A，不再画「声明 Para 资格」开关
    expect(panel).not.toContain('cargoUnitsParaCapable')
    // 单位货物＝算子图阵列，点一枚直连 store 的勾选动作（仅空运分支）
    expect(panel).toContain('workbench.airCargoUnitChoices')
    expect(panel).toContain('@pick="workbench.toggleAirCargoUnit($event)"')
  })

  it('面板不做规则判断：可选性/原因全部取自 store（不自己算闸门）', () => {
    // 用户 2026-11-13：任务类型只读显示（类型由右键菜单定），取自 store 的选项投影
    expect(panel).toContain('workbench.airMissionKindChoices')
    expect(panel).toContain('workbench.airInterceptorCandidates')
    expect(panel).toContain('workbench.engineerChoices')
    // 14.2f/14.2a/14.2e 的原因串只应出现在 store 里
    expect(panel).not.toContain('canJoinMission')
    expect(panel).not.toContain('canAddAircraftAtStep')
  })
})
