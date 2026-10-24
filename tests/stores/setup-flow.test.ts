import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { scenarios } from '@/data'
import { PANZER_GROUP_OPTION_ITEM } from '@/engine/rules'
import {
  useContainersStore,
  useGameSessionStore,
  useSetupStore,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * 初设与开局流程的**端到端流程**（W7 C14，store 级）
 *
 * 六条链路逐条走通（顺序即开局协议）：
 *   ① **剧本选择**：换剧本 ⇒ 初设源与条目随之（剧本 2 走剧本 1 的初设）；
 *   ② **编制抽取**：完成度取自 C12 的剧本抽取盒账本（不另立一份）；
 *   ③ **卡车满载指定**：剧本页「全部满载 / 自选 N 辆 / 全部空载」三态核验；
 *   ④ **SP 归属划分**：12.1d 归属＝带上图的一方；轴方按 3.4b 逐一点名装甲集群；
 *   ⑤ **自动初设**：战斗单位 + 非战斗单位（SP / 运输点 / 空军基地）逐条落位；
 *   ⑥ **玩家自定义初设 + 飞机初设**：自由项落位（IV-A）、飞机按 14.1a 与剧本页激活态摆放。
 *
 * 用真实数据（`scenario-setup.json` 1155 条 + `scenarios.json` + 算子库），不造数。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return {
    setup: useSetupStore(),
    workbench: useWorkbenchStore(),
    containers: useContainersStore(),
  }
}

/**
 * B50（用户 2026-09-17）：3.4b（装甲集群 SP 归属）是专规 4.1a 的**可选项**，默认不启用。
 * 本文件里考"逐一点名 / 默认按分界线填"的用例，须先采纳这条共识才谈得上。
 */
function adoptPanzerGroupOption(): void {
  const session = useGameSessionStore()
  const index = session.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM)
  if (index < 0) throw new Error('开场共识清单里没有 3.4b 这一条')
  session.setAgreedCheck(index, true)
}

/** 某方某一类非战斗算子的枚数 */
function countNoncombat(
  units: readonly ConsoleUnit[],
  side: 'axis' | 'soviet',
  kind: string,
): number {
  return units.filter((unit) => unit.side === side && unit.noncombatKind === kind).length
}

describe('W7 C14：开局流程进度与剧本选择', () => {
  let setup: ReturnType<typeof newStores>['setup']
  let workbench: ReturnType<typeof newStores>['workbench']
  let containers: ReturnType<typeof newStores>['containers']

  beforeEach(() => {
    const stores = newStores()
    setup = stores.setup
    workbench = stores.workbench
    containers = stores.containers
  })

  it('C14：开局流程步骤清单按剧本给（不适用即不列待办）', () => {
    setup.selectScenario('1')
    expect(setup.flow.map((step) => step.id)).toEqual([
      'scenario',
      'formationDraw',
      'truckLoad',
      'spOwnership',
      'autoSetup',
      'airSetup',
      'selfSetup',
    ])
    expect(setup.stepDone['scenario']).toBe(true)
    // ★ 用户口径：选剧本即**自动初设**固定项 ⇒ 该步在选剧本时已打勾
    expect(setup.stepDone['autoSetup']).toBe(true)
    expect(setup.applied).toBe(true)
    /*
     * ★ 契约变更（批 B 切片 1，**不是放宽**）：剧本 1 的剧本页明示「德军全部满载」⇒ 13.2h 的装载
     *   已在初设时**自动落账**（IV-D：「只有剧本页明说才满载」——明说了就不再问玩家）⇒
     *   `truckLoad` 这一步**不再是待办**。修前它恒为 false（等玩家去点那个按钮）。
     */
    expect(setup.truckLoadMode).toBe('all_loaded')
    expect(setup.stepDone['truckLoad']).toBe(true)
    expect(setup.allDone).toBe(false)
    // 仍待玩家处理的是 SP 归属 / 飞机 / 自定义初设；**玩家自选满载**的剧本（3）才把卡车满载留着
    setup.selectScenario('3')
    expect(setup.truckLoadMode).toBe('choose_loaded')
    expect(setup.stepDone['truckLoad']).toBe(false)
    // 剧本 7 的剧本页没有编队抽签 ⇒ 该步视为已完成；其卡车页明示"全部空载" ⇒ 同样自动落账
    setup.selectScenario('7')
    expect(setup.stepDone['formationDraw']).toBe(true)
    expect(setup.truckLoadMode).toBe('all_unloaded')
    expect(setup.stepDone['truckLoad']).toBe(true)
  })

  it('C14：换剧本 ⇒ 操作台的剧本旋钮同步，且玩家输入重置', () => {
    setup.selectScenario('3')
    expect(setup.scenarioId).toBe('3')
    expect(workbench.scenarioId).toBe('3')
    expect(setup.entries.length).toBe(314)
    setup.selectScenario('1')
    expect(setup.entries.length).toBe(197)
  })

  it('C14：剧本 2 的初设条目与飞机政策都随初设源（剧本 1）', () => {
    setup.selectScenario('2')
    expect(setup.entries.length).toBe(197)
    expect(setup.flow.find((step) => step.id === 'scenario')?.detail).toContain('8 Jul 41')
  })

  it('C14：编制抽取的完成度取自 C12 的剧本抽取盒（★ §6-A：抽签在初设自动跑完 ⇒ 选剧本即打勾）', () => {
    setup.selectScenario('1')
    const groups =
      scenarios.scenarios.find((item) => item.id === '1')?.setup.formationDraw?.groups ?? []
    expect(groups.length).toBeGreaterThan(0)
    // ch10 / ch11 是**开局前**的剧本随机化 ⇒ 初设时自动抽完，不必等玩家去点「抽签」
    expect(setup.stepDone['formationDraw']).toBe(true)
    for (const group of groups) {
      expect(containers.drawnOf(group).length).toBe(group.count)
    }
    // 完成度仍读的是 C12 抽取盒那本账（换剧本 ⇒ 该剧本名下没有抽取 ⇒ 重新抽）
    setup.selectScenario('3')
    expect(setup.stepDone['formationDraw']).toBe(true)
  })
})

describe('W7 C14：自动初设（战斗单位 + 非战斗单位）', () => {
  let setup: ReturnType<typeof newStores>['setup']
  let workbench: ReturnType<typeof newStores>['workbench']

  beforeEach(() => {
    const stores = newStores()
    setup = stores.setup
    workbench = stores.workbench
    setup.selectScenario('1')
  })

  it('C14：一次落盘把剧本页清单摆上盘面（棋子 / 计数算子 / 死亡堆），自由项留待玩家', () => {
    const before = workbench.units.length
    expect(setup.runAutoSetup()).toBe(true)
    expect(setup.lastAction?.ok).toBe(true)
    expect(setup.applied).toBe(true)
    const placed = workbench.units.length - before
    expect(placed).toBeGreaterThan(100)
    // 非战斗单位也在盘上：SP / 运输点 / 空军基地三类的算子都出现了
    expect(countNoncombat(workbench.units, 'axis', 'sp')).toBeGreaterThan(0)
    expect(countNoncombat(workbench.units, 'axis', 'transport_point')).toBeGreaterThan(0)
    expect(countNoncombat(workbench.units, 'axis', 'air_base')).toBeGreaterThan(0)
    expect(countNoncombat(workbench.units, 'soviet', 'sp')).toBeGreaterThan(0)
    // 死亡堆（13.5）落盘
    expect(workbench.deadPile.length).toBeGreaterThan(0)
    // SP dump 台账（12.1d 归属＝带上图的一方）
    expect(setup.spDumps.length).toBeGreaterThan(0)
    expect(setup.spDumps.every((dump) => dump.points > 0)).toBe(true)
    expect(setup.stepDone['autoSetup']).toBe(true)
    // 自由项还没落（要玩家自己填）
    expect(setup.stepDone['selfSetup']).toBe(false)
    expect(setup.plan?.choices.length).toBeGreaterThan(0)
  })

  it('C14：剧本页明文减损的单位以「印值 − 减损」落盘（IV-G 的例外）', () => {
    setup.runAutoSetup()
    const view = setup.entries.find((entry) => entry.stepPenalty === 1)
    expect(view).toBeDefined()
    if (view === undefined) return
    const unitId = view.unitId
    const placed = workbench.units.filter((unit) => unit.unitId === unitId)
    expect(placed.length).toBeGreaterThan(0)
    for (const unit of placed) expect(unit.steps).toBeLessThan(unit.printedSteps)
  })

  it('C14：重新落盘不静默重复（每次调用都留日志，算子按次叠加）', () => {
    setup.runAutoSetup()
    const once = workbench.units.length
    setup.runAutoSetup()
    expect(workbench.units.length).toBeGreaterThan(once)
    expect(setup.lastAction?.ok).toBe(true)
  })
})

describe('W7 C14：卡车满载指定', () => {
  let setup: ReturnType<typeof newStores>['setup']

  beforeEach(() => {
    const stores = newStores()
    setup = stores.setup
  })

  it('C14：剧本 3「玩家自选 4 辆满载」⇒ 14 辆建制内卡车里点 4 辆；点错即拒', () => {
    setup.selectScenario('3')
    expect(setup.setupTrucks).toHaveLength(14)
    for (const truck of setup.setupTrucks.slice(0, 3)) setup.toggleTruckFull(truck.instanceId, true)
    expect(setup.designateTrucks()).toBe(false)
    expect(setup.lastAction).toMatchObject({ ok: false, rule: 'IV-C' })
    setup.toggleTruckFull(setup.setupTrucks[3]!.instanceId, true)
    expect(setup.designateTrucks()).toBe(true)
    expect(setup.lastAction?.detail).toContain('1F')
    expect(setup.stepDone['truckLoad']).toBe(true)
  })

  it('★ C14（B38 口径）：剧本 1「全部满载」⇒ **不勾也算对**（12 辆自动满载）；剧本 7「全部空载」⇒ 全空', () => {
    setup.selectScenario('1')
    expect(setup.setupTrucks).toHaveLength(12)
    /*
     * B38（用户口径 #8）：脚本明示全满载/全空载时，**玩家的勾选不参与**（也没被问过）⇒
     * 直接核验即通过，且 `loadedSpT` 按脚本落盘；`.full`/空载**不使用** `truckFullIds`。
     */
    expect(setup.truckLoadMode).toBe('all_loaded')
    expect(setup.effectiveFullTruckIds).toHaveLength(12)
    expect(setup.designateTrucks()).toBe(true)
    for (const truck of setup.setupTrucks) {
      const unit = setup.setupTrucks.length > 0 ? truck : truck
      expect(setup.effectiveFullTruckIds).toContain(unit.instanceId)
    }

    setup.selectScenario('7')
    expect(setup.setupTrucks).toHaveLength(2)
    expect(setup.truckLoadMode).toBe('all_unloaded')
    expect(setup.effectiveFullTruckIds).toEqual([])
    expect(setup.designateTrucks()).toBe(true) // 全空载：不点即正确
  })
})

describe('W7 C14：SP 归属划分（12.1d + Setup Note F + 3.4b）', () => {
  let setup: ReturnType<typeof newStores>['setup']

  beforeEach(() => {
    const stores = newStores()
    setup = stores.setup
    setup.selectScenario('1')
    // B50：采纳「装甲集群 SP 归属约束」（可选项）。
    // ★ 次序要放在**选剧本之后**：换剧本会重置共识勾选（专规 4.0，见 `setScenarioId`）
    adoptPanzerGroupOption()
    setup.runAutoSetup()
  })

  it('C14：剧本 1 轴方 dump 的装甲集群**默认已按分界线填好**（玩家不用逐个点名）；清空即拒', () => {
    const axisDumps = setup.spDumpsOf('axis')
    expect(axisDumps.length).toBeGreaterThan(0)
    // ★ 用户口径：编队归属不用玩家设置 ⇒ 自动初设时已按分界线给每个 dump 填好
    expect(axisDumps.every((dump) => setup.spAssignments[dump.id] !== undefined)).toBe(true)
    expect(setup.confirmSpOwnership()).toBe(true)
    expect(setup.stepDone['spOwnership']).toBe(true)

    // 手工清掉一个 ⇒ 3.4b 仍要求逐一点名，故被拒（默认只是默认，不是不可改）
    setup.setSpAssignment(axisDumps[0]!.id, null)
    expect(setup.confirmSpOwnership()).toBe(false)
    expect(setup.lastAction).toMatchObject({ ok: false, rule: '3.4b' })
    // 再填回去即通过
    setup.setSpAssignment(axisDumps[0]!.id, 'guderian')
    expect(setup.confirmSpOwnership()).toBe(true)
  })

  it('B50：**先选剧本、后勾共识** ⇒ 确认归属划分时自动补上默认归属（可选项的迟到采纳）', () => {
    const late = newStores().setup
    late.selectScenario('1')
    late.runAutoSetup()
    // 此刻共识尚未勾选 ⇒ 不填默认、也不要求点名（3.4b 不生效）
    expect(Object.keys(late.spAssignments).length).toBe(0)
    expect(late.confirmSpOwnership()).toBe(true)
    // 3.4b 未生效时：不填默认归属、也不要求点名（detail 里明说"不适用"）
    expect(late.lastAction).toMatchObject({ ok: true, rule: '12.1d' })
    expect(late.lastAction?.detail).toContain('不适用 3.4b')

    // 玩家这时才勾上可选项 ⇒ 下一次确认前应自动补默认归属并逐条点名通过
    adoptPanzerGroupOption()
    expect(late.confirmSpOwnership()).toBe(true)
    expect(Object.keys(late.spAssignments).length).toBeGreaterThan(0)
    // 生效后：detail 里应出现"3.4b 适用"与已点名计数
    // （外层 rule 仍是 12.1d —— `planSupplyOwnership` 的 succeed 标签；条件那半在 detail/data 里）
    expect(late.lastAction?.detail).toContain('3.4b 适用')
    expect(late.lastAction?.detail).toContain('轴方已点名装甲集群 5 处')
  })

  it('C14：苏方 dump 无需（也不得）点名装甲集群', () => {
    const sovietDumps = setup.spDumpsOf('soviet')
    expect(sovietDumps.length).toBeGreaterThan(0)
    for (const dump of setup.spDumpsOf('axis')) setup.setSpAssignment(dump.id, 'hoth')
    expect(setup.confirmSpOwnership()).toBe(true)
    setup.setSpAssignment(sovietDumps[0]!.id, 'hoth')
    expect(setup.confirmSpOwnership()).toBe(false)
    expect(setup.lastAction?.detail).toContain('spOwnershipSovietGroupForbidden')
  })

  it('C14：剧本 7（26 Aug 首回合）不适用 3.4b ⇒ 点名反而被拒（数据驱动）', () => {
    setup.selectScenario('7')
    setup.runAutoSetup()
    expect(setup.spDumpsOf('axis').length).toBeGreaterThan(0)
    expect(setup.confirmSpOwnership()).toBe(true)
    expect(setup.lastAction?.detail).toContain('不适用 3.4b')
    setup.setSpAssignment(setup.spDumpsOf('axis')[0]!.id, 'guderian')
    expect(setup.confirmSpOwnership()).toBe(false)
  })
})

describe('W7 C14：飞机初设（14.1a + IV-E + 剧本页明文）', () => {
  let setup: ReturnType<typeof newStores>['setup']
  let workbench: ReturnType<typeof newStores>['workbench']

  beforeEach(() => {
    const stores = newStores()
    setup = stores.setup
    workbench = stores.workbench
    setup.selectScenario('1')
    setup.runAutoSetup() // 空军基地算子先落盘，飞机才有基地格可选
  })

  it('C14：剧本 1 德方全部非激活；未选基地格即不落位（不猜位置）', () => {
    const plan = setup.airPlanOf('axis')
    expect(plan).not.toBeNull()
    if (plan === null) return
    expect(plan.placements.length).toBeGreaterThan(0)
    expect(setup.runAirSetup('axis')).toBe(true)
    // 一架都没指定基地格 ⇒ 全部未落位，且如实记缺口
    expect(setup.airPlacedCount('axis')).toBe(0)
    expect(setup.airDone('axis')).toBe(false)
    expect(setup.notes.join('｜')).toContain('尚未指定空军基地格')
  })

  it('C14：逐型指定本方空军基地格后落位；激活态与 `*` 减损按剧本页', () => {
    const axisPlan = setup.airPlanOf('axis')
    if (axisPlan === null) throw new Error('应当有计划')
    const base = axisPlan.placements[0]?.candidates[0]
    expect(base).toBeDefined()
    if (base === undefined) return
    for (const row of axisPlan.placements) {
      setup.setAirChoice(row.entryIndex, `${base.col}.${base.row}`)
    }
    expect(setup.runAirSetup('axis')).toBe(true)
    const required = axisPlan.placements.reduce((sum, row) => sum + row.count, 0)
    expect(setup.airPlacedCount('axis')).toBe(required)
    expect(setup.airDone('axis')).toBe(true)
    // 剧本 1 德军：All planes must begin Inactive.
    expect(workbench.airUnits.every((air) => air.airStatus === 'inactive')).toBe(true)
    // 位置＝其空军基地格（14.1a）
    expect(
      workbench.airUnits.every((air) => air.hex.col === base.col && air.hex.row === base.row),
    ).toBe(true)
  })

  it('C14：苏方「每型半数非激活（小数向上取整）」+ `*` 机型减损（Pe.2 军力 1）', () => {
    const suPlan = setup.airPlanOf('soviet')
    if (suPlan === null) throw new Error('应当有计划')
    const base = suPlan.placements[0]?.candidates[0]
    if (base === undefined) return
    for (const row of suPlan.placements)
      setup.setAirChoice(row.entryIndex, `${base.col}.${base.row}`)
    expect(setup.runAirSetup('soviet')).toBe(true)
    const pe2 = workbench.airUnits.filter((air) => air.aircraftId === 'su-aircraft-ru-pe-2')
    expect(pe2).toHaveLength(1)
    expect(pe2[0]?.steps).toBe(1)
    // 半数非激活：苏方非激活数应等于各型 ⌈n/2⌉ 之和
    const expectedInactive = suPlan.placements.reduce(
      (sum, row) => sum + Math.ceil(row.count / 2),
      0,
    )
    expect(
      workbench.airUnits.filter((air) => air.side === 'soviet' && air.airStatus === 'inactive'),
    ).toHaveLength(expectedInactive)
  })

  it('C14：选了非空军基地格 ⇒ 拒绝落位（14.1a）', () => {
    const axisPlan = setup.airPlanOf('axis')
    if (axisPlan === null) throw new Error('应当有计划')
    const row = axisPlan.placements[0]
    if (row === undefined) return
    setup.setAirChoice(row.entryIndex, '62.34') // 图上但非本方空军基地格
    expect(setup.runAirSetup('axis')).toBe(true)
    expect(setup.airPlacedCount('axis')).toBe(0)
    expect(setup.notes.join('｜')).toContain('不是本方空军基地格')
  })
})

describe('W7 C14：玩家自定义初设（IV-A / IV-I）', () => {
  let setup: ReturnType<typeof newStores>['setup']
  let workbench: ReturnType<typeof newStores>['workbench']

  beforeEach(() => {
    const stores = newStores()
    setup = stores.setup
    workbench = stores.workbench
    setup.selectScenario('1')
    setup.runAutoSetup()
  })

  it('C14：`w/i 3 hexes of 34.17 or 34.18` ⇒ 玩家在第 6 格也能放；范围外则拒', () => {
    const entry = setup.choicesOf('soviet').find((view) => view.placement === 'radius')
    expect(entry).toBeDefined()
    if (entry === undefined) return
    const before = workbench.units.length
    // 锚格本身在范围内（IV-A 含边界）
    setup.setSelfChoice(entry.index, '34.17')
    expect(setup.placeSelfEntry(entry.index)).toBe(true)
    expect(workbench.units.length).toBeGreaterThan(before)
    expect(workbench.units.some((unit) => unit.hex.col === 34 && unit.hex.row === 17)).toBe(true)

    // 另一条同类条目：范围外即拒
    const other = setup.choicesOf('soviet').filter((view) => view.placement === 'radius')[1]
    if (other !== undefined) {
      setup.setSelfChoice(other.index, '62.34')
      expect(setup.placeSelfEntry(other.index)).toBe(false)
      expect(setup.lastAction).toMatchObject({ ok: false, rule: 'IV-A' })
    }
  })

  it('C14：`任一指挥部同格` 的条目须落在本方 HQ 格（HQ 由自动初设落盘）', () => {
    const entry = setup.choicesOf('soviet').find((view) => view.placement === 'anyHq')
    expect(entry).toBeDefined()
    if (entry === undefined) return
    const hq = workbench.units.find(
      (unit) => unit.side === 'soviet' && unit.specialized.includes('hq'),
    )
    expect(hq).toBeDefined()
    if (hq === undefined) return
    setup.setSelfChoice(entry.index, `${hq.hex.col}.${hq.hex.row}`)
    expect(setup.placeSelfEntry(entry.index)).toBe(true)
    // 非 HQ 格即拒
    const another = setup.choicesOf('soviet').filter((view) => view.placement === 'anyHq')[1]
    if (another !== undefined) {
      setup.setSelfChoice(another.index, '1.01')
      expect(setup.placeSelfEntry(another.index)).toBe(false)
    }
  })

  it('C14：格号非法 ⇒ 拒并提示（不猜格）', () => {
    const entry = setup.choicesOf('soviet')[0]
    if (entry === undefined) return
    setup.setSelfChoice(entry.index, '不是格号')
    expect(setup.placeSelfEntry(entry.index)).toBe(false)
    expect(setup.lastAction?.detail).toContain('合法格号')
  })

  it('C14：全部自由项落完后 `selfSetup` 打勾；重置清空账本与盘面', () => {
    for (const entry of setup.choicesOf('soviet')) {
      if (entry.placement === 'radius' && entry.anchors[0] !== undefined) {
        setup.setSelfChoice(entry.index, `${entry.anchors[0].col}.${entry.anchors[0].row}`)
        setup.placeSelfEntry(entry.index)
      }
    }
    expect(setup.stepDone['selfSetup']).toBe(false) // 轴方自由项还没做
    setup.resetAll()
    expect(workbench.units).toHaveLength(0)
    expect(workbench.deadPile).toHaveLength(0)
    expect(setup.applied).toBe(false)
    expect(setup.spDumps).toHaveLength(0)
  })
})

describe('W7 C14：初设单位 box（地图点选放置）与开始游戏', () => {
  let setup: ReturnType<typeof newStores>['setup']
  let workbench: ReturnType<typeof newStores>['workbench']
  let session: ReturnType<typeof useGameSessionStore>

  beforeEach(() => {
    const stores = newStores()
    setup = stores.setup
    workbench = stores.workbench
    session = useGameSessionStore()
    // 选剧本即自动初设（固定格号 / 死亡堆 / 多点位 / 计数类算子）
    setup.selectScenario('1')
  })

  it('C14：box 按三类列出待落位项（地面 / SP 与运输点 / 飞机），候选格由引擎给', () => {
    const categories = new Set(setup.pendingPlacement.map((item) => item.category))
    expect(categories.has('ground')).toBe(true)
    expect(categories.has('air')).toBe(true)
    for (const item of setup.pendingPlacement) {
      expect(item.category).toBe(item.kind === 'air' ? 'air' : item.category)
      expect(Array.isArray(item.candidates)).toBe(true)
    }
  })

  it('C14：点一项 ⇒ 进入放置态并铺出候选格；点候选格即落位并从 box 移除', () => {
    const item = setup.pendingPlacement.find(
      (row) => row.kind === 'self' && row.candidates.length > 0,
    )
    expect(item).toBeDefined()
    if (item === undefined) return
    const before = workbench.units.length
    expect(setup.beginSelfPlacement(item.entryIndex)).toBe(true)
    expect(setup.placing?.entryIndex).toBe(item.entryIndex)
    expect(setup.placing?.candidates.length).toBeGreaterThan(0)
    const target = setup.placing!.candidates[0]!
    expect(setup.placeAtHex(target)).toBe(true)
    expect(setup.placing).toBeNull()
    expect(workbench.units.length).toBeGreaterThan(before)
    expect(
      setup.pendingPlacement.some(
        (row) => row.kind === 'self' && row.entryIndex === item.entryIndex,
      ),
    ).toBe(false)
  })

  it('C14：点非候选格 ⇒ 拒绝且仍留在放置态（不静默吞掉）', () => {
    const item = setup.pendingPlacement.find(
      (row) => row.kind === 'self' && row.candidates.length > 0,
    )
    if (item === undefined) return
    setup.beginSelfPlacement(item.entryIndex)
    const outside = setup.placing!.candidates.some((hex) => hex.col === 1 && hex.row === 1)
      ? { col: 1, row: 2 }
      : { col: 1, row: 1 }
    expect(setup.placeAtHex(outside)).toBe(true)
    expect(setup.placing).not.toBeNull()
    expect(setup.lastAction).toMatchObject({ ok: false })
  })

  it('C14：飞机一类 ⇒ 候选＝本方空军基地格；落位后进 airUnits（14.1a）', () => {
    const air = setup.pendingPlacement.find(
      (row) => row.category === 'air' && row.candidates.length > 0,
    )
    expect(air).toBeDefined()
    if (air === undefined) return
    expect(setup.beginAirPlacement(air.side, air.entryIndex)).toBe(true)
    const target = setup.placing!.candidates[0]!
    expect(setup.placeAtHex(target)).toBe(true)
    expect(workbench.airUnits.filter((unit) => unit.side === air.side).length).toBeGreaterThan(0)
    // 位置＝其空军基地格
    expect(
      workbench.airUnits.every(
        (unit) => unit.hex.col === target.col && unit.hex.row === target.row,
      ),
    ).toBe(true)
  })

  it('C14：box 里未落位的项 ⇒ finishSetup 记为「本局移除，不存在」', () => {
    expect(setup.pendingPlacement.length).toBeGreaterThan(0)
    expect(setup.finishSetup()).toBe(true)
    expect(setup.finished).toBe(true)
    expect(setup.pendingPlacement).toHaveLength(0)
    expect(setup.notes.join('｜')).toContain('本局移除')
  })

  it('C14：开始游戏 ⇒ 收束初设 + 建会话 + 共识按默认（全不用）写日志 + 进入第一阶段', () => {
    expect(setup.startGameNow()).toBe(true)
    expect(setup.finished).toBe(true)
    expect(session.session).not.toBeNull()
    // ★ 用户口径：默认全部不勾 ⇒ 可选规则一条都不用，但仍写入日志（4.0）
    expect(session.agreedCheckedCount).toBe(0)
    expect(session.agreedRecorded).toBe(true)
    expect(session.session?.log.length ?? 0).toBeGreaterThan(0)
    expect(setup.lastAction?.ok).toBe(true)
  })

  it('C14：未经「开始游戏」时共识勾选默认全不勾（专规 4.0：勾 = 用这条）', () => {
    expect(session.agreedCheckedCount).toBe(0)
    expect(session.agreedChecklistRows.every((row) => !row.checked)).toBe(true)
  })
})
