import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  actionGateOf,
  needsFuelOf,
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

/**
 * B18b/B18c：**12.5 燃料支付接线**（用户 2026-09-16 指正）与 **12.0 复核**
 *
 * ## 用户的指正（12.5c 原文）
 * 「根据以下的方法，在发生燃料消耗的**任何阶段**，单位都应在**燃料消耗时**支付对应的燃料补给」；
 * 12.5a 又补一句「轮式/履带战斗单位要消耗 MP 的话……**即使就移动一格**」。
 * ⇒ 燃料不是"补给阶段的一步"，而是**每次耗 MP 的当口**当场付。
 *
 * ## 修前的两处死结（本文件钉住它们）
 *   ① `payFuel` 在 `src/` 里的**唯一调用方是 `WorkbenchView`（引擎验证页）**——
 *      对局台上选中一辆没油的坦克、点地图：`beginMove` 被 12.5a 拒（`moveBlocked`），
 *      而**没有任何地方能付油** ⇒ 装甲单位在正式界面上根本开不动（打不完一局）。
 *   ② `toConsoleUnit` 把 `fuelled` 缺省成 `true`（"视为持续到本方清理阶段"）⇒
 *      **燃料这条规则整局都不会触发**：随便动，12.5a 从不发问。
 *
 * ## 12.0 复核（另一条）
 * 12.0「重要提示」：只有战斗单位需要补给；非战斗单位 / 空军 / 海军**永远不会**消耗 SP、
 * 永远不需要追溯补给 ⇒ 受补给单位清单只应列战斗单位（修前面板列的是"当前方全部算子"）。
 */

/** B8：把 store 放到本段里允许做该动作的那个环节（12.5 的支付要在允许它的环节里做） */
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

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

/** 需要燃料才能动的**战斗**单位（12.5a：轮式/履带 MP 的战斗单位） */
function fuelUnitRecord() {
  const found = unitChoices('axis').find(
    (record) =>
      record.isCombat === true &&
      (record.classes?.movementClass === 'truck' || record.classes?.movementClass === 'tracked') &&
      (record.factors?.combat?.ma ?? 0) >= 1,
  )
  if (found === undefined) throw new Error('轴心国单位库中没有轮式/履带战斗单位')
  return found
}

/** 不需要燃料的单位（步行单位；12.5a 明列） */
function legRecord() {
  const found = unitChoices('axis').find(
    (record) => record.classes?.movementClass === 'leg' && record.isCombat === true,
  )
  if (found === undefined) throw new Error('轴心国单位库中没有步行单位')
  return found
}

/** 非战斗单位（12.0：永不需要追溯补给） */
function noncombatRecord() {
  const found = unitChoices('axis').find(
    (record) => record.isCombat !== true && (record.noncombatKind ?? null) === 'sp',
  )
  if (found === undefined) throw new Error('单位库中没有 SP 算子')
  return found
}

const START: HexRef = { col: 36, row: 13 }

/**
 * 12.3a/3.4b：摆一座该方的燃料补给站并选定为付款来源
 *
 * ★ 3.4b 联动：若受益单位属某装甲集群（本作不少摩托化/装甲算子都带 `panzerGroup`），
 *   这座站的 SP 必须声明**同一归属**，否则"错误集群的 SP 不得付油"会把它拒掉——
 *   那不是本文件要考察的东西，故夹具照规则把归属声明上（与既有 `move-interaction-flow` 同一做法）。
 */
/** 12.5c-A 的对象：**编队单位**（用户 2026-09-17：「编队单位有额外的编队加油法」） */
function formationUnitRecord() {
  const found = unitChoices('axis').find(
    (record) =>
      typeof record.formation === 'string' &&
      record.isCombat === true &&
      (record.factors?.combat?.ma ?? 0) >= 1,
  )
  if (found === undefined) throw new Error('轴心国单位库中没有编队单位')
  return found
}

function withFuelDump(
  store: ReturnType<typeof newStore>,
  beneficiary: ReturnType<typeof place>,
  holdings: { sp?: number; t?: number } = {},
): string {
  const id = `d-fuel-${store.spDumps.length}`
  store.spDumps.push({
    id,
    hex: { ...beneficiary.hex },
    side: beneficiary.side,
    sp: holdings.sp ?? 0,
    t: holdings.t ?? 0,
  })
  const group = store.groupOfUnit(beneficiary)
  if (group !== null) store.setDumpPanzerGroupNow(id, group)
  return id
}

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  instanceId: string,
) {
  const unit = toConsoleUnit({ record, instanceId, hex, side: 'axis' })
  store.units.push(unit)
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B18b（12.5c）：燃料要能在"耗 MP 的当口"付，而不是只在补给段', () => {
  it('★ 选中一辆未加注的耗油单位 ⇒ 出现「移动 / 燃料」会话（这才有地方付油）', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('movement')
    const tank = place(workbench, fuelUnitRecord(), START, 't1')
    expect(needsFuelOf(tank)).toBe(true)
    expect(tank.fuelled).toBe(false)

    // 修前：没有 `moveInteraction` ⇒ 会话为 null ⇒ payFuel 无处可调
    expect(mapView.session).toBeNull()
    workbench.clickHex(START)
    expect(mapView.session).toMatchObject({ kind: 'move', rule: '12.5c' })
    expect(mapView.session?.title).toContain('燃料')
  })

  it('★ 步行单位（不需燃料）不会因此冒出燃料会话（12.5a：步行永不需燃料）', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('movement')
    const foot = place(workbench, legRecord(), START, 'l1')
    expect(needsFuelOf(foot)).toBe(false)
    workbench.clickHex(START)
    // 步行单位点得动 ⇒ 直接开始移动，会话是"移动结算"那条，不是燃料
    expect(mapView.session?.rule).not.toBe('12.5c')
  })

  it('★ 增援段点开一个"含未加油装甲"的堆叠，不得把增援会话顶成「移动 / 燃料」', () => {
    /*
     * 回执（2026-10-30）：`expandStackAt` 在任何环节摊开堆叠都会 `beginMovePick`，而
     * `fuelTargets` 会取这个清单 ⇒ `fuelPaymentDue` 在 B 段也为真；地图会话里那一支
     * "缺油也要能付"的分支原先**没有环节门**，于是增援面板被「移动 / 燃料」顶掉
     * （而 12.5 的付款时机只在 C/E/G 的移动环节，那里点了也被闸门拒）。
     */
    const { workbench, mapView } = newStores()
    workbench.setTurn(2)
    workbench.setPhase('reinforcement')
    place(workbench, fuelUnitRecord(), START, 't1')
    place(workbench, fuelUnitRecord(), START, 't2')

    mapView.expandStackAt(START)
    // 摊开确实建立了取子清单 ⇒ 欠油事实成立（否则本用例测不到那一支）
    expect(workbench.fuelPaymentDue).toBe(true)
    expect(mapView.session?.kind).toBe('reinforce')
  })

  it('★ 缺燃料被 12.5a 挡下 ⇒ 在**移动阶段**当场付油 ⇒ 账本真扣（12.5c「消耗时支付」）', () => {
    const { workbench } = newStores()
    workbench.setPhase('movement')
    // 12.5 的支付只在允许它的环节里做（C 段的首环是突围，付油属"模式与移动"环节）
    goToActionStep(workbench, 'supply.fuel')
    const tank = place(workbench, fuelUnitRecord(), START, 't1')
    const dumpId = withFuelDump(workbench, tank, { t: 4 })

    // 12.5a：未加注 ⇒ 开拔被拒（这就是玩家遇到的那一步）
    workbench.clickHex(START)
    expect(workbench.moveInteraction).toBeNull()
    expect(workbench.fuelPaymentDue).toBe(true)
    expect(workbench.fuelPendingUnits.map((unit) => unit.instanceId)).toEqual([tank.instanceId])

    // 12.3a：来源必须是受益单位拖得到的站
    expect(workbench.fuelDumpChoices.map((dump) => dump.id)).toEqual([dumpId])
    expect(workbench.pickFuelDump(dumpId)).toBe(true)

    // 12.5c-C：单独单位法逐枚 1T ⇒ 付完坦克已加注、账本少 1T
    const before = workbench.spDumps.find((dump) => dump.id === dumpId)!.t
    workbench.payFuel('singleUnit', false)
    expect(tank.fuelled).toBe(true)
    expect(tank.fuelMethod).toBe('singleUnit')
    const after = workbench.spDumps.find((dump) => dump.id === dumpId)!.t
    expect(after).toBe(before - 1)
    // 付完不再"欠油"，燃料会话随之让位给正常的移动流程
    expect(workbench.fuelPaymentDue).toBe(false)
  })

  it('★ 12.5c-C 的加注只在本阶段有效（换阶段即失效）——换阶段后重新欠油', () => {
    const { workbench } = newStores()
    workbench.setPhase('movement')
    goToActionStep(workbench, 'supply.fuel')
    const tank = place(workbench, fuelUnitRecord(), START, 't1')
    const dumpId = withFuelDump(workbench, tank, { t: 4 })
    workbench.clickHex(START)
    workbench.pickFuelDump(dumpId)
    workbench.payFuel('singleUnit', false)
    expect(tank.fuelled).toBe(true)
    workbench.setPhase('reaction')
    expect(tank.fuelled).toBe(false)
  })

  it('★ 12.5c-A/B 的加注持续到本方清理阶段（12.5d 才移除）', () => {
    const { workbench } = newStores()
    workbench.setPhase('movement')
    goToActionStep(workbench, 'supply.fuel')
    // 用户 2026-09-17：「**编队单位**有额外的编队加油法」⇒ 编队法的受益单位须属某多单位编队
    const tank = place(workbench, formationUnitRecord(), START, 't1')
    const dumpId = withFuelDump(workbench, tank, { sp: 2 })
    workbench.clickHex(START)
    workbench.pickFuelDump(dumpId)
    // 12.5c-A：编队法 1SP（共用同一来源）；持续期由引擎 `fuelExpiresOnPhaseChange` 决定
    workbench.payFuel('formation', true)
    expect(tank.fuelled).toBe(true)
    expect(tank.fuelMethod).toBe('formation')
    workbench.setPhase('reaction')
    expect(tank.fuelled).toBe(true)
  })

  it('受益集＝**取子清单**（B18b 补的那一段）：整堆叠开拔失败时不给"一枚一枚付"的坑', () => {
    const { workbench } = newStores()
    workbench.setPhase('movement')
    const a = place(workbench, fuelUnitRecord(), START, 't1')
    const b = place(workbench, fuelUnitRecord(), START, 't2')
    withFuelDump(workbench, a, { sp: 3 })
    // 点堆叠 ⇒ 打开取子清单（6.1f），默认只勾最后一枚
    workbench.clickHex(START)
    expect(workbench.movePickHex).toEqual(START)
    workbench.setMovePickIds([a.instanceId, b.instanceId])
    expect(workbench.fuelTargets.map((unit) => unit.instanceId).sort()).toEqual(
      [a.instanceId, b.instanceId].sort(),
    )
    expect(workbench.fuelPendingUnits).toHaveLength(2)
  })
})

describe('B18c（12.0）：受补给单位只列战斗单位', () => {
  it('★ 非战斗单位（SP 算子）不进候选；战斗单位进（12.0 的重要提示）', () => {
    const store = newStore()
    const tank = place(store, fuelUnitRecord(), START, 't1')
    const spam = place(store, noncombatRecord(), START, 'sp1')

    const ids = store.supplyCheckCandidates.map((unit) => unit.instanceId)
    expect(ids).toContain(tank.instanceId)
    expect(ids).not.toContain(spam.instanceId)
    // 敌方单位当然也不进（补给按方归属）
    const enemy = toConsoleUnit({
      record: fuelUnitRecord(),
      instanceId: 'e1',
      hex: START,
      side: 'soviet',
    })
    store.units.push(enemy)
    expect(store.supplyCheckCandidates.map((unit) => unit.instanceId)).not.toContain('e1')
  })

  it('面板不再自己筛候选（用 store 的那份，判据只有一处）', () => {
    const panel = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')
    expect(panel).toContain('workbench.supplyCheckCandidates')
    expect(panel).not.toContain(
      'workbench.units.filter((unit) => unit.side === workbench.activeSide)',
    )
  })
})

describe('B18：复核出的另外两条"只在验证页有入口"的动作（同燃料那处的病）', () => {
  it('★ 5.7b 释放预备：对局台现在也能做（本批把它接进移动链）', () => {
    const store = newStore()
    store.setPhase('reaction')
    const unit = place(store, fuelUnitRecord(), START, 't1')
    unit.mode = { ...unit.mode, mode: 'reserve' }
    store.selectedId = unit.instanceId

    // 引擎判据在 store 里（反应段本方单位才可释放）；本处只钉"这条链在正式界面可达"
    const ok = store.releaseReserveNow()
    expect(typeof ok).toBe('boolean')
    const panel = readFileSync('src/components/move/MovePanel.vue', 'utf8')
    expect(panel).toContain('workbench.releaseReserveNow()')
  })

  it('★ 4.5b 垫人承诺：按钮就在移动链里，落盘的是 `mpLockedThisPhase`', () => {
    const store = newStore()
    store.setPhase('movement')
    const unit = place(store, fuelUnitRecord(), START, 't1')
    expect(unit.mpLockedThisPhase).toBe(false)
    store.lockZocNegation(unit.instanceId)
    expect(unit.mpLockedThisPhase).toBe(true)
    const panel = readFileSync('src/components/move/MovePanel.vue', 'utf8')
    expect(panel).toContain('workbench.lockZocNegation(selected.instanceId)')
  })
})

describe('B18b：燃料段的接线（源码守卫）', () => {
  const panel = readFileSync('src/components/move/MovePanel.vue', 'utf8')

  it('会话里的燃料段用 store 的事实与动作（面板不自己判耗油）', () => {
    expect(panel).toContain('workbench.fuelPaymentDue')
    expect(panel).toContain('workbench.fuelPendingUnits')
    expect(panel).toContain('workbench.fuelDumpChoices')
    /*
     * ★ B32：方法与"来源是否共用"已从组件局部 ref 搬进 store（候选集与校验都在 store），
     *   故面板改成绑 store 字段、并且**不传参**调用（缺省即 store 的选择）。
     */
    expect(panel).toContain('workbench.payFuel()')
    expect(panel).toContain('v-model="workbench.fuelMethod"')
    // ★ B32 步骤 4：来源的"共用性"不再由玩家勾（13.7a 要求按盘面算出同源组）
    expect(panel).toContain('workbench.fuelSourcePartition.shared')
    expect(panel).not.toContain('fuelCommonSource')
    expect(panel).not.toContain('const fuelMethod = ref(')
    expect(panel).toContain('workbench.pickFuelDump($event)')
    // 三种方法都在界面上（12.5c-A/B/C）
    for (const key of ['singleUnit', 'hq', 'formation']) expect(panel).toContain(`'${key}'`)
  })

  it('面板不导入引擎（规则判断仍在 store/引擎）', () => {
    expect(panel).not.toContain("from '@/engine")
  })

  it('地图会话在"缺燃料"时也开（判据是 store 的 `fuelPaymentDue`）', () => {
    const store = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(store).toContain('workbench.fuelPaymentDue')
    expect(store).toContain("rule: '12.5c'")
  })
})
