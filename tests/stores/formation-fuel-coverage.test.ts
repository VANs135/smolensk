import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { formationFuelCovers, holdingsToT } from '@/engine/rules'
import { needsFuelOf, useWorkbenchStore } from '@/stores'

import { CORE_HEX, groundRecord, placeGround } from '../flows/sop-harness'

/**
 * I①（用户 2026-09-18 报告第 7 条）：**编队加油的覆盖集**
 *
 * 用户原话：「玩家再点击某个编队单位进行编队加油后，**该次选择的补给来源范围内的该编队其余单位也应该
 *   按编队加油规则自动加油**，如果是徒步模式摩托化单位，那么后续选取该单位进入移动模式时**油也应该是
 *   加好的**，如果是**不在补给来源范围内**的同编队机械化单位则**不视为参与编队加油**，后续要进行轮式、
 *   履带移动时必须用**单独单位法**加油」。
 *
 * 原文
 *   · **12.5c-A**：「为一整个多单位编队支付 1SP，便可为**整个**多单位编队提供燃料补给。……在需要燃料
 *     补给的编队中，检查每个单位使用了哪个指挥部或补给站进行补给的**投递或拖取**。如果为其中一些单位
 *     投递补给的不是同一个指挥部，或者一些单位直接拖取补给的来源不是同一个补给站，那么**这些使用不同
 *     来源的单位只能按单独单位燃料补给法**来获得燃料补给。」
 *   · **12.3a/12.3c**：直接拖取＝该单位在补给站 5 MP 内或与补给站相邻。
 *   · **12.5d**：编队标记（燃料已补给一面）在本方**清理阶段**翻回。
 *
 * 病灶：`payFuel` 的编队法分支只把 `plan.data.unitIds`（**玩家点选的那几枚**）置 `fuelled` ⇒
 *   付了 1SP 却只给 1 枚打了标记，同编队、同来源范围内的其余单位**没油**；玩家随后把它们拖去开拔时，
 *   12.5a 会拦（"要消耗 MP 必须先付燃料"），于是同一份编队油得**反复付**。
 *
 * 本文件钉四件事：① 覆盖＝同编队 ∩ 本次来源范围内（**含未被点选**的、也含"徒步面摩托化"的）；
 * ② 范围外的同编队单位**不覆盖**（后续必须单独单位法）；③ 同阶段对同一编队的**第二次编队法付款被拒**
 * （整编队每阶段一次；剩余成员走 12.5c-C）；④ 12.5d：进入本方清理阶段 ⇒ 台账清空、可再付。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 走到 C 段「模式与移动」环节（燃料的闸门在该环节放行；12.5a/12.5f） */
function goToMovementStep(store: {
  setPhase(phase: 'movement'): void
  playerSegmentSteps: readonly { id: string }[]
  setSegmentStepIndex(index: number): boolean
}): void {
  store.setPhase('movement')
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement')
  if (index < 0) throw new Error('C 段没有「模式与移动」环节')
  if (!store.setSegmentStepIndex(index)) throw new Error('进入模式与移动环节失败')
}

/** 3PZ 编队的一枚「徒步面摩托化」单位（战斗面 leg / 移动面 truck）——用户说的正是这一类 */
function motRecord(): ReturnType<typeof groundRecord> {
  return groundRecord(
    'axis',
    (record) =>
      record.formation === '3PZ' &&
      record.mobilityByFace?.combat === 'leg' &&
      record.mobilityByFace?.move === 'truck',
  )
}

/** 同编队的另一枚（用来当"范围外的机械化单位"：两面都是履带） */
function armorRecord(): ReturnType<typeof groundRecord> {
  return groundRecord(
    'axis',
    (record) =>
      record.formation === '3PZ' &&
      record.mobilityByFace?.combat === 'tracked' &&
      record.mobilityByFace?.move === 'tracked',
  )
}

/**
 * 摆一队 3PZ：`mine`（点选的那一枚）在补给站格、`mate`（**徒步面摩托化**）在相邻格（5 MP 内，
 * 但**没被点选**）、`far`（履带）在 8 格外的远处（**超出 5 MP 且本盘无 HQ ⇒ 不在来源范围内**）。
 */
function setupFormation(store: ReturnType<typeof newStore>) {
  const mine = placeGround(store, motRecord(), CORE_HEX, 'axis', 'mine', 'move')
  const mate = placeGround(
    store,
    motRecord(),
    { col: CORE_HEX.col + 1, row: CORE_HEX.row },
    'axis',
    'mate',
  )
  const farHex = { col: CORE_HEX.col + 8, row: CORE_HEX.row }
  const far = placeGround(store, armorRecord(), farHex, 'axis', 'far')
  store.spDumps.push({ id: 'd1', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 0 })
  expect(mine.formation, '夹具应取到同一编队').toBe(mate.formation)
  expect(far.formation).toBe(mine.formation)
  // 夹具自检：`mate` 当前是战斗面（leg）而移动面是 truck ⇒ 正是"徒步面摩托化单位"
  expect(mate.faces.combat.mobility).toBe('leg')
  expect(mate.faces.move.mobility).toBe('truck')
  return { mine, mate, far }
}

/** 付一次编队法油（点选 `mine`、选编队法、指定付款站） */
function payFormationFuel(store: ReturnType<typeof newStore>): void {
  goToMovementStep(store)
  store.beginMovePick(CORE_HEX, ['mine'])
  store.fuelMethod = 'formation'
  expect(store.fuelMethodChoices.find((item) => item.method === 'formation')?.available).toBe(true)
  expect(store.pickFuelDump('d1')).toBe(true)
  store.payFuel()
}

describe('I①（12.5c-A）：编队加油的覆盖集', () => {
  it('★ 付 1SP ⇒ **同编队、在来源范围内**的未点选单位也一并加注（含徒步面摩托化单位）', () => {
    const store = newStore()
    const { mine, mate } = setupFormation(store)
    const before = holdingsToT(store.spDumps[0]!)
    payFormationFuel(store)

    expect(mine.fuelled).toBe(true)
    // ★ 用户第 7 条的正面：没被点选、但在同一来源 5 MP 内的同编队单位 —— 也要加好油
    expect(mate.fuelled).toBe(true)
    expect(mate.fuelMethod).toBe('formation')
    // 12.5c-A：整编队 1SP（不是每单位 1T）
    expect(holdingsToT(store.spDumps[0]!)).toBe(before - 4)
  })

  it('★ 徒步面摩托化单位：日后**转移动面**开拔时，油已经加好（12.5a 不会再要一次）', () => {
    const store = newStore()
    const { mate } = setupFormation(store)
    payFormationFuel(store)
    expect(mate.fuelled).toBe(true)
    // 付完油后 `retryBeginMove` 会把**被点选**的那几枚推进移动态 ⇒ 先收掉它，才能对另一枚切模式
    store.abortMoveNow()

    // 把 `mate` 切到移动模式（5.4：移动模式＝按移动面数值移动；用 store 的真实入口）
    store.selectedId = mate.instanceId
    store.switchUnitMode('move')
    expect(mate.mode.mode).toBe('move')
    expect(mate.mode.orientation).toBe('move')
    // 此刻它按 12.5a 需要燃料 —— 而油已经付过（这正是用户要的那半句）
    expect(needsFuelOf(mate)).toBe(true)
    expect(mate.fuelled).toBe(true)
  })

  it('★ **范围外**的同编队机械化单位**不覆盖**（后续只能单独单位法）', () => {
    const store = newStore()
    const { far } = setupFormation(store)
    payFormationFuel(store)

    expect(far.fuelled).toBe(false)
    // 覆盖集如实列出"没被覆盖的那些"（界面据此说清"日后开拔要单独付"）
    const coverage = store.fuelFormationCoverage
    expect(coverage).not.toBeNull()
    expect(coverage?.coveredIds).toContain('mate')
    expect(coverage?.leftOutIds).toContain('far')
  })

  it('★ 12.5c-A：同阶段对同一编队**第二次**编队法付款被拒（剩余成员走 12.5c-C）', () => {
    const store = newStore()
    const { far } = setupFormation(store)
    payFormationFuel(store)
    const before = holdingsToT(store.spDumps[0]!)
    // 给"范围外"那一枚也摆一座站（它自成一处的补给），用来证明拒的是**编队法**而不是"没站可付"
    store.spDumps.push({ id: 'd2', hex: { ...far.hex }, side: 'axis', sp: 4, t: 0 })

    // 再点那一枚"范围外"的单位，仍想用编队法 ⇒ 拒（整编队每阶段一次）
    store.abortMoveNow()
    store.beginMovePick(far.hex, ['far'])
    store.fuelMethod = 'formation'
    expect(store.pickFuelDump('d2')).toBe(true)
    store.payFuel()
    expect(far.fuelled).toBe(false)
    expect(holdingsToT(store.spDumps[0]!)).toBe(before) // 账本一字未动
    expect(holdingsToT(store.spDumps[1]!)).toBe(16) // 第二座站也没动

    // 改单独单位法 ⇒ 付得出去（12.5c-C：每个单位 **1T** ⇒ 4SP 里拆出 1T，余 15T）
    store.abortMoveNow()
    store.fuelMethod = 'singleUnit'
    expect(store.pickFuelDump('d2')).toBe(true)
    store.payFuel()
    expect(far.fuelled).toBe(true)
    expect(far.fuelMethod).toBe('singleUnit')
    expect(holdingsToT(store.spDumps[1]!)).toBe(16 - 1)
  })

  it('★ 12.5d/12.5c-A（用户 2026-09-20 裁定）：**本方清理阶段结束**才清台账（换阶段/换回合都不清）', () => {
    const store = newStore()
    setupFormation(store)
    payFormationFuel(store)
    store.abortMoveNow()
    expect(store.formationFuelThrowOf('3PZ')).not.toBeNull()

    /*
     * ★ 契约变更（2026-09-20 用户裁定，**不是放宽**）：原先这里断言"换到 cleanUp 段即清"。
     *   现在按 12.5c-A/12.5d 的原文（「持续到**下一个友方清理阶段**」）把清零点落在**清理动作**里；
     *   换阶段、换回合都不再清（完整例见 `tests/stores/fuel-window-persistence.test.ts`）。
     */
    store.setPhase('cleanUp')
    expect(store.formationFuelThrowOf('3PZ')).not.toBeNull() // 只是换段 ⇒ 窗口还在
    expect(store.runCleanUpNow()).toBe(true)
    expect(store.formationFuelThrowOf('3PZ')).toBeNull()
  })

  it('★ 判据只有一处：`formationFuelCovers`（12.5c-A）的真值表', () => {
    expect(formationFuelCovers({ unitFormation: '3PZ', fuelFormation: '3PZ' })).toBe(true)
    expect(formationFuelCovers({ unitFormation: '10PZ', fuelFormation: '3PZ' })).toBe(false)
    expect(formationFuelCovers({ unitFormation: null, fuelFormation: '3PZ' })).toBe(false)
    expect(formationFuelCovers({ unitFormation: '3PZ', fuelFormation: null })).toBe(false)
  })

  it('★ 反空转：同一份盘面上，**不是**该编队的单位不被顺手加注', () => {
    const store = newStore()
    const { mate } = setupFormation(store)
    // 摆一枚**别的编队**的单位，同样在来源 5 MP 内
    const other = placeGround(
      store,
      groundRecord('axis', (record) => record.formation === '10PZ'),
      mate.hex,
      'axis',
      'other',
    )
    payFormationFuel(store)
    expect(mate.fuelled).toBe(true)
    expect(other.fuelled).toBe(false) // 12.5c-A：编队法只覆盖**该编队**
  })
})
