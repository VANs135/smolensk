import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { markers, rulesConstants } from '@/data'
import type { HexRef } from '@/data'
import { createRngState } from '@/engine/rng'
import {
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useContainersStore,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * 记录轨与容器管理的**端到端流程**（W7 C12，store 级）
 *
 * 逐条走用户点得到的链路：开局摆算子 → 送死亡堆 → 1.6c 抽取返场 → 拆分隔断 → 剧本抽签（可重放）
 * → 空军盒整备 → 边缘盒进出 → 编队收纳；并核对**账本是否落在盘面上**（操作台才是算子的家）。
 *
 * 用真实地图/单位库/标记库（不造数）；规则判据本身在 `tests/engine/containers.test.ts`。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), containers: useContainersStore() }
}

/** 取一个图内格（供摆算子） */
function someHex(): HexRef {
  const hex = markers.turnTrack[0]
  void hex
  return { col: 34, row: 17 }
}

/** 摆一枚算子并返回它 */
function place(
  workbench: ReturnType<typeof useWorkbenchStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  workbench.units.push(unit)
  return unit
}

/** 苏方的 12-2-2 步兵师（1.6c 免费重建的合格型别） */
function eligibleDivisionRecord(): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('soviet').find(
    (record) =>
      record.factors?.combat?.attack === 12 &&
      record.factors?.combat?.ar === 2 &&
      record.factors?.combat?.ma === 2,
  )
  if (found === undefined) throw new Error('单位库里找不到 12-2-2 的苏方师（1.6c 合格池）')
  return found
}

/** 苏方的「其他」类型**多军力**单位（20.0：只有 other 能拆/吸收，且最后一点军力不能拆） */
function otherClassParent(): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('soviet').find(
    (record) =>
      record.isCombat === true &&
      record.classes?.combatClass === 'other' &&
      (record.factors?.combat?.attack ?? 0) >= 3 &&
      (record.factors?.combat?.ar ?? 0) >= 2 &&
      (record.steps?.total ?? 1) >= 2,
  )
  if (found === undefined) throw new Error('单位库里找不到 other 类型的多军力单位')
  return found
}

describe('W7 C12：记录轨（回合 / 天气 / 铁路容量）', () => {
  let workbench: ReturnType<typeof useWorkbenchStore>
  let containers: ReturnType<typeof useContainersStore>

  beforeEach(() => {
    const stores = newStores()
    workbench = stores.workbench
    containers = stores.containers
  })

  it('C12：回合轨 19 格 + 回合标记；推进按 2.2 且不许倒退', () => {
    expect(containers.turnTrack.slots).toHaveLength(markers.turnTrack.length)
    expect(containers.turn).toBe(1)
    expect(containers.advanceTurnMarker()).toBe(true)
    expect(containers.turn).toBe(2) // 无会话时由本 store 持标记
    expect(containers.lastAction?.rule).toBe('2.2')
    expect(workbench.log[0]?.text).toContain('回合标记')
    // 越界即拒（19 格）
    for (let index = 0; index < 30; index += 1) containers.advanceTurnMarker()
    expect(containers.turn).toBeLessThanOrEqual(markers.turnTrack.length)
  })

  it('C12：天气标记（专规 1.5）与铁路容量轨（13.3b / 专规 1.2）', () => {
    containers.setWeatherMarker('limited')
    expect(containers.weather.air).toBe('limited')
    expect(containers.weatherTrack.note).toContain('禁止空军任务')

    // 升级日之前：轴 0 / 苏 2（rules-constants 的 railCapBefore）
    expect(containers.railCapTrack.boosted).toBe(false)
    expect(containers.railCapTrack.sides[0]?.onDate).toBe(
      rulesConstants.smolensk.railCapBefore.axis,
    )
    containers.setRailCapacity('soviet', 3)
    expect(containers.railCapacity.soviet).toBe(3)
    // 轨位非法即拒（主轨 + 副轨之外）
    expect(containers.setRailCapacity('axis', 999)).toBe(false)
    expect(containers.lastAction).toMatchObject({ ok: false, rule: '13.3b' })
    // 按日期重算（剧本 1 首回合 8 July 早于升级日 19 July）
    containers.applyRailCapacityForDate()
    expect(containers.railCapacity.axis).toBe(rulesConstants.smolensk.railCapBefore.axis)
    // 走到升级日之后 ⇒ 容量升格
    for (let index = 0; index < markers.turnTrack.length; index += 1) containers.advanceTurnMarker()
    expect(containers.railCapTrack.boosted).toBe(true)
    expect(containers.railCapTrack.sides[0]?.onDate).toBe(rulesConstants.smolensk.railCapAfter.axis)
  })
})

describe('W7 C12：死亡堆与 1.6c 特殊补员抽取（与盘面联动）', () => {
  let workbench: ReturnType<typeof useWorkbenchStore>
  let containers: ReturnType<typeof useContainersStore>

  beforeEach(() => {
    const stores = newStores()
    workbench = stores.workbench
    containers = stores.containers
  })

  it('C12：死亡堆名册直接读操作台（C12 不另立一份）', () => {
    const unit = place(workbench, eligibleDivisionRecord(), someHex(), 'soviet', 'd1')
    workbench.sendToDeadPileNow(unit.instanceId)
    expect(workbench.units).toHaveLength(0)
    expect(containers.deadPileUnits.soviet.map((item) => item.id)).toEqual(['d1'])
    const box = containers.boxOf('deadPile', 'soviet')
    expect(box?.holdings[0]?.unitId).toBe('d1')
    expect(box?.rule).toBe('13.5')
  })

  it('C12：1.6c 抽取 —— 师免费重建返场（−1 军力），落点取操作台当前选中格', () => {
    // 让返场有落点：选中一枚图上的算子
    const marker = place(
      workbench,
      unitChoices('soviet').find((record) => record.isCombat === true) ?? eligibleDivisionRecord(),
      someHex(),
      'soviet',
      'marker',
    )
    workbench.setTool('move')
    workbench.clickHex(marker.hex)
    expect(workbench.selectedUnit?.instanceId).toBe('marker')

    const division = place(workbench, eligibleDivisionRecord(), someHex(), 'soviet', 'd1')
    workbench.sendToDeadPileNow(division.instanceId)
    expect(workbench.deadPile).toHaveLength(1)

    // 固定种子：掷骰与抽签都走 rng.ts（可重放）
    workbench.rng = createRngState(19410708)
    const ok = containers.drawSpecialRepl('soviet')
    expect(ok).toBe(true)
    expect(containers.lastAction?.rule).toBe('1.6c')
    // 死亡堆被清空、单位回到图上、军力 −1（规则原文：返场 −1 step）
    expect(workbench.deadPile).toHaveLength(0)
    const returned = workbench.units.find((unit) => unit.instanceId === 'd1')
    expect(returned).toBeDefined()
    expect(returned?.steps).toBe((returned?.printedSteps ?? 2) - 1)
    expect(workbench.log.some((entry) => entry.text.includes('返场'))).toBe(true)
  })

  it('C12：掷骰可重放 —— 同种子两次抽取给出同一结果', () => {
    const division = place(workbench, eligibleDivisionRecord(), someHex(), 'soviet', 'd1')
    workbench.setTool('move')
    workbench.clickHex(division.hex)
    workbench.sendToDeadPileNow('d1')

    workbench.rng = createRngState(4242)
    containers.drawSpecialRepl('soviet')
    const first = containers.lastAction?.detail ?? ''

    // 复原：重新摆回死亡堆，重置种子
    workbench.units = []
    workbench.deadPile = []
    const again = place(workbench, eligibleDivisionRecord(), someHex(), 'soviet', 'd1')
    workbench.clickHex(again.hex)
    workbench.sendToDeadPileNow('d1')
    workbench.rng = createRngState(4242)
    containers.drawSpecialRepl('soviet')
    expect(containers.lastAction?.detail ?? '').toBe(first)
  })

  it('C12：无合格师时如实说明（1.6 表 1-6：dead pile 无单位即无重建）', () => {
    workbench.rng = createRngState(7)
    const ok = containers.drawSpecialRepl('soviet')
    expect(ok).toBe(true)
    expect(containers.lastAction?.detail ?? '').toContain('无合格师')
  })
})

describe('W7 C12：拆分单位盒（1.8a / 20.0）与编队抽签', () => {
  let workbench: ReturnType<typeof useWorkbenchStore>
  let containers: ReturnType<typeof useContainersStore>

  beforeEach(() => {
    const stores = newStores()
    workbench = stores.workbench
    containers = stores.containers
  })

  it('C12：从盒取用一枚拆分单位 → 母单位 −1 军力、盒内存量 −1，且**算子真的落到盘面上**', () => {
    workbench.setPhase('movement')
    const parent = place(workbench, otherClassParent(), someHex(), 'soviet', 'p1')
    const beforePool = workbench.breakdownPool.su ?? 0
    const beforeSteps = parent.steps
    const beforeUnits = workbench.units.length
    const ok = containers.takeBreakdown({
      parentInstanceId: parent.instanceId,
      breakdownAr: 2, // 苏方池：6× AR2 + 2× AR3（1.8a）
      timing: 'startMove',
    })
    expect(ok, containers.lastAction?.detail).toBe(true)
    expect(parent.steps).toBe(beforeSteps - 1)
    expect(workbench.breakdownPool.su).toBe(beforePool - 1)
    expect(containers.lastAction?.rule).toBe('20.0')

    // 账本闭合（B0④）：取用 = 从盒里拿一枚算子摆到母单位所在格。
    // 原先只做「母单位 −1、池 −1」并打日志，盘面 `units` 不变 —— 账扣了、子没出。
    expect(workbench.units).toHaveLength(beforeUnits + 1)
    const placed = workbench.units.find((unit) => unit.instanceId !== parent.instanceId)
    expect(placed).toBeDefined()
    expect(placed!.specialized).toContain('breakdown')
    expect(placed!.hex).toEqual(parent.hex)
    expect(placed!.side).toBe('soviet')
    expect(placed!.steps).toBe(1)
  })

  it('C12：算子库里没有该 AR 的拆分单位时**不扣账**（避免「账已扣、子落不下」的半截状态）', () => {
    workbench.setPhase('movement')
    const parent = place(workbench, otherClassParent(), someHex(), 'soviet', 'p1')
    const beforePool = workbench.breakdownPool.su ?? 0
    const beforeSteps = parent.steps
    const beforeUnits = workbench.units.length
    // 苏方池只有 AR2 / AR3（1.8a）⇒ AR4 不在库中
    const ok = containers.takeBreakdown({
      parentInstanceId: parent.instanceId,
      breakdownAr: 4,
      timing: 'startMove',
    })
    expect(ok).toBe(false)
    expect(parent.steps).toBe(beforeSteps)
    expect(workbench.breakdownPool.su).toBe(beforePool)
    expect(workbench.units).toHaveLength(beforeUnits)
  })

  it('20.0d：吸收拆分单位须给**图上算子的实例 id**，成功后回池、母单位 +1 军力', () => {
    workbench.setPhase('movement')
    const parent = place(workbench, otherClassParent(), someHex(), 'soviet', 'p1')
    expect(
      containers.takeBreakdown({
        parentInstanceId: parent.instanceId,
        breakdownAr: 2,
        timing: 'startMove',
      }),
    ).toBe(true)

    const breakdown = workbench.units.find((unit) => unit.specialized.includes('breakdown'))!
    const poolAfterTake = workbench.breakdownPool.su ?? 0
    const stepsAfterTake = parent.steps

    expect(workbench.absorbBreakdownNow(parent.instanceId, breakdown.instanceId)).toBe(true)
    expect(parent.steps).toBe(stepsAfterTake + 1)
    expect(workbench.breakdownPool.su).toBe(poolAfterTake + 1)
    expect(workbench.units.some((unit) => unit.instanceId === breakdown.instanceId)).toBe(false)
  })

  it('20.0d：传单位库的**记录 id**（旧界面的口径）不再静默失败，而是给出可见反馈', () => {
    workbench.setPhase('movement')
    const parent = place(workbench, otherClassParent(), someHex(), 'soviet', 'p1')
    const beforeUnits = workbench.units.length
    const recordId = unitChoices('soviet').find((item) => item.branch === 'breakdown')!.id

    expect(workbench.absorbBreakdownNow(parent.instanceId, recordId)).toBe(false)
    // 原先这里只 `return false`，无日志无 error ⇒ 玩家点了没有任何反应
    expect(workbench.reinforcementError).toMatchObject({ rule: '20.0d' })
    expect(workbench.units).toHaveLength(beforeUnits)
    expect(workbench.log.some((entry) => entry.text.includes('吸收被拒'))).toBe(true)
  })

  it('C12：装甲母单位不能拆解（20.0）—— 由引擎拒绝', () => {
    const armor = unitChoices('soviet').find(
      (record) => record.classes?.combatClass === 'armor' && record.isCombat === true,
    )
    if (armor === undefined) return
    const parent = place(workbench, armor, someHex(), 'soviet', 'p-armor')
    expect(
      containers.takeBreakdown({
        parentInstanceId: parent.instanceId,
        breakdownAr: 2,
        timing: 'startMove',
      }),
    ).toBe(false)
    expect(containers.lastAction).toMatchObject({ ok: false, rule: '20.0' })
  })

  it('14.1b：飞机军力归零后与地面单位**共用死亡堆**，并出现在死亡堆盒里', () => {
    const choice = workbench.airUnitChoices[0]
    expect(choice).toBeDefined()
    // 基地格即飞机所在格（14.1a）
    expect(workbench.addAirUnit(choice!.aircraftId, '36.13')).toBe(true)
    const air = workbench.airUnits[0]!
    const beforeDead = workbench.deadPile.length
    const steps = air.steps

    // 14.1b：每机多点军力，损失最后一点才摧毁
    for (let index = 0; index < steps - 1; index += 1) workbench.applyAirStepLoss(air.instanceId)
    expect(workbench.airUnits.some((item) => item.instanceId === air.instanceId)).toBe(true)
    expect(workbench.deadPile).toHaveLength(beforeDead)

    workbench.applyAirStepLoss(air.instanceId)
    expect(workbench.airUnits.some((item) => item.instanceId === air.instanceId)).toBe(false)
    expect(workbench.deadPile).toHaveLength(beforeDead + 1)
    // 判别字段是 `aircraftId`（与地面条目的 `unitId` 区分）
    expect(
      workbench.deadPile.some(
        (entry) => 'aircraftId' in entry && entry.instanceId === air.instanceId,
      ),
    ).toBe(true)
    // 死亡堆盒（C12）也必须能显示它——原先 toBoxUnit 会按地面算子读它的字段
    expect(containers.deadPileUnits[air.side].some((item) => item.id === air.instanceId)).toBe(true)
  })

  it('14.1b：空军条目不会被误当成地面单位返场（显式拒绝并给出理由）', () => {
    const choice = workbench.airUnitChoices[0]!
    expect(workbench.addAirUnit(choice.aircraftId, '36.13')).toBe(true)
    const air = workbench.airUnits[0]!
    // ★ 必须先把初值取出来：applyAirStepLoss 会递减 air.steps，
    //   若把 `index < air.steps` 直接当循环条件，上界会随之下缩而只扣 1 点（飞机没死）。
    const steps = air.steps
    for (let index = 0; index < steps; index += 1) workbench.applyAirStepLoss(air.instanceId)
    expect(workbench.deadPile.some((entry) => entry.instanceId === air.instanceId)).toBe(true)

    expect(workbench.returnFromDeadPileNow({ instanceId: air.instanceId, hexText: '36.13' })).toBe(
      false,
    )
    // 拒绝的可见效果：飞机既不落回盘面、也没被从死亡堆里取走
    expect(workbench.units.some((unit) => unit.instanceId === air.instanceId)).toBe(false)
    expect(workbench.deadPile.some((entry) => entry.instanceId === air.instanceId)).toBe(true)
    expect(workbench.log.some((entry) => entry.text.includes('只做地面返场'))).toBe(true)
  })

  it('C12：剧本抽签在池内抽定，且同种子可重放（剧本 1 抽 4 个）', () => {
    containers.setScenario('1')
    const box = containers.scenarioDrawBox
    expect(box).not.toBeNull()
    const group = box?.groups[0]
    expect(group).toBeDefined()
    if (group === undefined) return

    workbench.rng = createRngState(19410708)
    const first = containers.drawFormations(group)
    expect(first).toHaveLength(group.count)
    expect(new Set(first).size).toBe(group.count) // 不重复
    for (const formationId of first) {
      expect(box?.pool.map((item) => item.formationId)).toContain(formationId)
    }

    workbench.rng = createRngState(19410708)
    const again = containers.drawFormations(group)
    expect(again).toEqual(first)
  })

  it('C12：抽签落盘 —— S1 的 B 组互换（Mtr 进死亡堆、Aufk 返场）', () => {
    containers.setScenario('1')
    const group = containers.scenarioDrawBox?.groups.find((item) => item.kind === 'mtrAufkSwap')
    if (group === undefined) return
    // 抽签（用默认 rng）
    const drawn = containers.drawFormations(group)
    expect(drawn.length).toBe(group.count)

    // 摆两个算子代表抽中编队的 Mtr 团 / Aufk 营
    const mtr = place(workbench, otherClassParent(), someHex(), 'axis', 'mtr')
    const aufk = place(
      workbench,
      unitChoices('axis').find((record) => record.branch === 'arm_rec') ?? otherClassParent(),
      someHex(),
      'axis',
      'aufk',
    )
    workbench.setTool('move')
    workbench.clickHex(mtr.hex)
    workbench.sendToDeadPileNow(aufk.instanceId)
    expect(workbench.deadPile.map((unit) => unit.instanceId)).toEqual(['aufk'])

    const facts = Object.fromEntries(
      drawn.map((formationId) => [
        formationId,
        { mtrRegimentUnitId: mtr.instanceId, aufkBattalionUnitId: aufk.instanceId },
      ]),
    )
    expect(containers.applyDraw(group, facts)).toBe(true)
    // Mtr 进死亡堆、Aufk 返场（Mtr 死、Aufk 活）
    expect(workbench.deadPile.map((unit) => unit.instanceId)).toContain('mtr')
    expect(workbench.deadPile.map((unit) => unit.instanceId)).not.toContain('aufk')
    expect(workbench.units.map((unit) => unit.instanceId)).toContain('aufk')
  })

  it('C12：未抽签就落盘 ⇒ 拒绝', () => {
    containers.setScenario('1')
    const group = containers.scenarioDrawBox?.groups[0]
    if (group === undefined) return
    expect(containers.applyDraw(group, {})).toBe(false)
    expect(containers.lastAction?.detail).toContain('尚未抽签')
  })
})

describe('W7 C12：地图外空军盒 / 边缘盒 / 编队收纳盒', () => {
  let workbench: ReturnType<typeof useWorkbenchStore>
  let containers: ReturnType<typeof useContainersStore>

  beforeEach(() => {
    const stores = newStores()
    workbench = stores.workbench
    containers = stores.containers
  })

  it('C12：空军盒成员为叠加账本；盒内免费整备把 Inactive 翻 Active（1.4a）', () => {
    const record = aircraftChoices('axis')[0] ?? aircraftChoices('soviet')[0]
    if (record === undefined) return
    const plane = toConsoleAirUnit({
      aircraft: record,
      instanceId: 'air-1',
      hex: someHex(),
      side: 'axis',
      airStatus: 'inactive',
    })
    workbench.airUnits.push(plane)

    // 移入盒
    containers.setAirInBox('air-1', true)
    const box = containers.boxOf('airBox', 'axis')
    expect(box?.holdings.map((holding) => holding.sectionId)).toEqual(['inactive'])
    // 1.4a：盒内免费整备
    expect(containers.activateAirBox('axis')).toBe(true)
    expect(plane.airStatus).toBe('active')
    expect(containers.boxOf('airBox', 'axis')?.holdings[0]?.sectionId).toBe('active')
    // 移出盒
    containers.setAirInBox('air-1', false)
    expect(containers.aircraftInBox.axis).toHaveLength(0)
  })

  it('C12：边缘盒 —— 仅苏方地面单位、仅移动阶段；进出与盘面同步（1.4b）', () => {
    const soviet = place(workbench, otherClassParent(), someHex(), 'soviet', 'ru-1')
    // 阶段不对：拒绝
    workbench.setPhase('reaction')
    expect(
      containers.moveEdgeBox({
        box: 'southeast',
        instanceId: soviet.instanceId,
        direction: 'enter',
        fromSupplySourceHex: true,
      }),
    ).toBe(false)
    expect(containers.lastAction).toMatchObject({ ok: false, rule: '1.4b' })

    // 移动阶段：进入盒（离开盘面）
    workbench.setPhase('movement')
    expect(
      containers.moveEdgeBox({
        box: 'southeast',
        instanceId: soviet.instanceId,
        direction: 'enter',
        fromSupplySourceHex: true,
      }),
    ).toBe(true)
    expect(workbench.units).toHaveLength(0)
    expect(containers.edgeBoxUnits.southeast.map((item) => item.id)).toEqual(['ru-1'])

    // 离开盒（回到图上，1.4b：离箱免费供油）
    expect(
      containers.moveEdgeBox({
        box: 'southeast',
        instanceId: soviet.instanceId,
        direction: 'exit',
        fromSupplySourceHex: true,
      }),
    ).toBe(true)
    expect(workbench.units.map((unit) => unit.instanceId)).toEqual(['ru-1'])
    expect(containers.edgeBoxUnits.southeast).toHaveLength(0)
  })

  it('C12：轴心国单位不得使用边缘盒（1.4b）', () => {
    const axis = place(workbench, otherClassParent(), someHex(), 'axis', 'ge-1')
    workbench.setPhase('movement')
    expect(
      containers.moveEdgeBox({
        box: 'northeast',
        instanceId: axis.instanceId,
        direction: 'enter',
        fromSupplySourceHex: true,
      }),
    ).toBe(false)
    expect(containers.lastAction?.detail).toBe('edgeBoxSovietOnly')
  })

  it('C12：编队收纳盒 —— 至少一个所属单位须与标记同格（13.7 硬约束）', () => {
    const member = place(workbench, otherClassParent(), someHex(), 'soviet', 'm1')
    const hidden = place(workbench, otherClassParent(), someHex(), 'soviet', 'm2')
    // 图上成员不在标记格 ⇒ 拒绝
    expect(
      containers.hideInFormationBox({
        formationId: '1 Mtr Div',
        side: 'soviet',
        memberIds: [member.instanceId, hidden.instanceId],
        onMapIds: [member.instanceId, hidden.instanceId],
        markerHexText: '99.99',
        hideUnitIds: [hidden.instanceId],
      }),
    ).toBe(false)
    expect(containers.lastAction?.detail).toBe('atLeastOneUnitMustStackWithMarker')
  })
})
