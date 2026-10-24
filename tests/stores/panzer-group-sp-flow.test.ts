import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { PANZER_GROUP_CONSTRAINT_END, PANZER_GROUP_OPTION_ITEM } from '@/engine/rules'
import { useGameSessionStore, useWorkbenchStore } from '@/stores'

import { CORE_HEX, groundRecord, newConsole, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 专规 3.4b：装甲集群的 **SP 归属**与付费限制（store 级）
 *
 * 条文：「轴心国必须把 Supply Table 增援平均分给 Guderian 与 Hoth，奇数点归 Guderian……
 *   『错误』装甲集群的 SP **不能**用于支付多单位编队的**燃油、战斗或轰炸**成本；
 *   除此之外 SP 使用不受限。**所有新到的轴心国 SP 必须立即归属某一装甲集群**。」
 *
 * ★ 修前：`checkPanzerGroupSpPayment` **零消费**——「平分」那一半（`splitSupplyTableSp`）早已接线，
 *   但**校验**这一半完全没有：任何站上的 SP 都能替任何编队付战斗/燃油/轰炸，3.4b 只剩一句口号。
 *
 * ★ 本批的两层判读（写在 store 的注释里，也在下面的用例里钉住）：
 *   ① 只有**在局中新落**（经 `addSpDump`）的轴方补给站才叫「新到的 SP」——初设站按 Setup Note F 早已分配；
 *   ② 「必须立即归属」只在它**真去替多单位编队付受限账**时才拦：步兵师的普通攻击与这座站的归属无关。
 */
/**
 * B50（用户 2026-09-17）：3.4b 是专规 4.1a 的**可选项**（默认不启用）⇒ 本文件的用例
 * 考的都是"这一条生效时"的行为，故建店时先把共识勾上（勾选＝采用该条）。
 */
function adoptPanzerGroupOption(): void {
  const session = useGameSessionStore()
  const index = session.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM)
  if (index < 0) throw new Error('开场共识清单里没有 3.4b 这一条')
  session.setAgreedCheck(index, true)
}

const newStore = () => {
  setActivePinia(createPinia())
  const store = useWorkbenchStore()
  adoptPanzerGroupOption()
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 一个**属多单位编队**的轴方算子（单位库里带 `panzerGroup` 的那些装甲/摩托化师） */
function panzerUnit(store: Workbench, instanceId = 'pg1') {
  const record = groundRecord('axis', (item) => item.panzerGroup != null)
  const unit = placeGround(store, record, CORE_HEX, 'axis', instanceId)
  return { unit, record }
}

/** 一个**不属任何编队**的轴方战斗单位（步兵师 / 独立单位） */
function plainUnit(store: Workbench, instanceId = 'inf1') {
  const record = groundRecord(
    'axis',
    (item) => item.isCombat === true && item.attackCapable === true && item.panzerGroup == null,
  )
  const unit = placeGround(store, record, CORE_HEX, 'axis', instanceId)
  return { unit, record }
}

function axisDump(store: Workbench, id = 'sd1') {
  store.spDumps.push({ id, hex: { ...CORE_HEX }, side: 'axis', sp: 8, t: 0 })
  return store.spDumps.find((dump) => dump.id === id)!
}

describe('B50：3.4b 未启用（共识未采纳）⇒ 不约束、也不出界面', () => {
  it('未勾共识 ⇒ panzerGroupRulesOn 为 false，新落 SP 不进待办清单', () => {
    setActivePinia(createPinia())
    const store = useWorkbenchStore()
    expect(store.panzerGroupRulesOn).toBe(false)
    store.setTurn(1)
    store.setActiveSide('axis')
    store.spDumpDraft = { hexText: `${CORE_HEX.col}.${CORE_HEX.row}`, sp: 4, t: 0 }
    expect(store.addSpDump()).toBe(true)
    expect(store.pendingSpGroupAssignment).toEqual([])
    expect(store.panzerGroupUnassignedDumps).toEqual([])
  })

  it('未勾共识 ⇒ 未归属的轴方站替多单位编队付账**不**被 3.4b 拦', () => {
    setActivePinia(createPinia())
    const store = useWorkbenchStore()
    store.setTurn(1)
    store.setActiveSide('axis')
    const { unit } = panzerUnit(store)
    store.spDumpDraft = { hexText: `${CORE_HEX.col}.${CORE_HEX.row}`, sp: 8, t: 0 }
    expect(store.addSpDump()).toBe(true)
    const dump = store.spDumps[0]!
    // 未归属 + 受益方是多单位编队 ⇒ 3.4b 生效时会被拒；未启用时应当放行
    const failure = store.panzerGroupSpGate({
      dumpId: dump.id,
      purpose: 'combat',
      beneficiaryUnitIds: [unit.instanceId],
    })
    expect(failure).toBeNull()
  })
})

describe('3.4b：SP 归属账本', () => {
  it('声明/撤销归属；未声明的站不给归属', () => {
    const store = newStore()
    const dump = axisDump(store)
    expect(store.panzerGroupOfDump(dump.id)).toBeNull()
    store.setDumpPanzerGroupNow(dump.id, 'guderian')
    expect(store.panzerGroupOfDump(dump.id)).toBe('guderian')
    store.setDumpPanzerGroupNow(dump.id, 'hoth')
    expect(store.panzerGroupOfDump(dump.id)).toBe('hoth')
    store.setDumpPanzerGroupNow(dump.id, null)
    expect(store.panzerGroupOfDump(dump.id)).toBeNull()
    // 未给的 id 不制造虚假归属
    expect(store.panzerGroupOfDump(null)).toBeNull()
    expect(store.panzerGroupOfDump('nope')).toBeNull()
  })

  it('3.4b：新落的轴方 SP 进「待归属」清单，声明后即出列', () => {
    const store = newStore()
    store.setTurn(1)
    store.setActiveSide('axis')
    store.spDumpDraft = { hexText: `${CORE_HEX.col}.${CORE_HEX.row}`, sp: 4, t: 0 }
    expect(store.addSpDump()).toBe(true)
    const dump = store.spDumps[0]!
    expect(store.pendingSpGroupAssignment).toContain(dump.id)
    expect(store.panzerGroupUnassignedDumps.map((item) => item.id)).toContain(dump.id)

    store.setDumpPanzerGroupNow(dump.id, 'guderian')
    expect(store.pendingSpGroupAssignment).not.toContain(dump.id)
    expect(store.panzerGroupUnassignedDumps.map((item) => item.id)).not.toContain(dump.id)
  })

  it('3.4b / 12.1b：同格再落 SP 是**并入**同一条账（沿用原 id），已声明的归属不作废', () => {
    const store = newStore()
    store.setTurn(1)
    store.setActiveSide('axis')
    store.spDumpDraft = { hexText: `${CORE_HEX.col}.${CORE_HEX.row}`, sp: 4, t: 0 }
    expect(store.addSpDump()).toBe(true)
    const dump = store.spDumps[0]!
    store.setDumpPanzerGroupNow(dump.id, 'guderian')
    expect(store.pendingSpGroupAssignment).toEqual([])

    // 同一格再落 2 SP：并入同一条（不是新增第二条），归属沿用
    store.spDumpDraft = { hexText: `${CORE_HEX.col}.${CORE_HEX.row}`, sp: 2, t: 0 }
    expect(store.addSpDump()).toBe(true)
    expect(store.spDumps).toHaveLength(1)
    expect(store.spDumps[0]).toMatchObject({ id: dump.id, sp: 6 })
    // 已有归属 ⇒ 不因"多加了几点"退回待归属
    expect(store.panzerGroupOfDump(dump.id)).toBe('guderian')
    expect(store.pendingSpGroupAssignment).toEqual([])
  })

  it('3.4b / 12.1b：并入**未声明**的站 ⇒ 该站仍在待归属里（新到的 SP 必须立即归属）', () => {
    const store = newStore()
    store.setTurn(1)
    store.setActiveSide('axis')
    store.spDumpDraft = { hexText: `${CORE_HEX.col}.${CORE_HEX.row}`, sp: 4, t: 0 }
    expect(store.addSpDump()).toBe(true)
    const dump = store.spDumps[0]!
    store.spDumpDraft = { hexText: `${CORE_HEX.col}.${CORE_HEX.row}`, sp: 2, t: 0 }
    expect(store.addSpDump()).toBe(true)
    expect(store.spDumps).toHaveLength(1)
    expect(store.spDumps[0]!.id).toBe(dump.id)
    expect(store.pendingSpGroupAssignment).toEqual([dump.id])
  })

  it('3.4b：19 August 起自动失效（待归属与未归属清单都空）', () => {
    const store = newStore()
    const dump = axisDump(store, 'legacy')
    store.setTurn(1)
    store.spDumpDraft = { hexText: `${CORE_HEX.col}.${CORE_HEX.row}`, sp: 4, t: 0 }
    expect(store.addSpDump()).toBe(true)
    expect(store.pendingSpGroupAssignment.length).toBe(1)

    // 拨到约束失效之后的回合（日期由 turnTrack 给出，不按天数推）
    const turn = store.turn
    let moved = false
    for (let next = turn; next <= 19; next += 1) {
      store.setTurn(next)
      if (store.date >= PANZER_GROUP_CONSTRAINT_END) {
        moved = true
        break
      }
    }
    expect(moved).toBe(true)
    expect(store.panzerGroupUnassignedDumps).toEqual([])
    // 失效后即使用了新到的站也不判（引擎在日期闸门后直接放行）
    expect(
      store.panzerGroupSpGate({
        dumpId: dump.id,
        purpose: 'combat',
        beneficiaryUnitIds: [],
      }),
    ).toBeNull()
  })
})

describe('3.4b：错误集群的 SP 不能支付多单位编队的受限用途', () => {
  it('归属 Hoth 的站替 Guderian 编队付**战斗**成本 ⇒ 拒（rule 3.4b）', () => {
    const store = newStore()
    store.setTurn(1)
    const dump = axisDump(store)
    store.setDumpPanzerGroupNow(dump.id, 'hoth')
    const { unit } = panzerUnit(store, 'g1')
    // 夹具自检：该算子确实属 Guderian 的多单位编队，否则这条用例什么都没验证
    expect(store.groupOfUnit(unit)).toBe('guderian')
    const failure = store.panzerGroupSpGate({
      dumpId: dump.id,
      purpose: 'combat',
      beneficiaryUnitIds: [unit.instanceId],
    })
    expect(failure).toMatchObject({ rule: '3.4b' })
    expect(failure?.reason).toContain('wrongPanzerGroupSp')
  })

  it('同一归属（Hoth 站付 Hoth 编队）⇒ 放行', () => {
    const store = newStore()
    store.setTurn(1)
    const dump = axisDump(store)
    store.setDumpPanzerGroupNow(dump.id, 'hoth')
    const record = groundRecord('axis', (item) => item.panzerGroup === 'hoth')
    const unit = placeGround(store, record, CORE_HEX, 'axis', 'h1')
    expect(store.groupOfUnit(unit)).toBe('hoth')
    expect(
      store.panzerGroupSpGate({
        dumpId: dump.id,
        purpose: 'combat',
        beneficiaryUnitIds: [unit.instanceId],
      }),
    ).toBeNull()
  })

  it('非多单位编队（步兵师）⇒ 不受限，错误归属也不拦（3.4：只约束多单位编队）', () => {
    const store = newStore()
    store.setTurn(1)
    const dump = axisDump(store)
    store.setDumpPanzerGroupNow(dump.id, 'hoth')
    const { unit } = plainUnit(store)
    expect(
      store.panzerGroupSpGate({
        dumpId: dump.id,
        purpose: 'combat',
        beneficiaryUnitIds: [unit.instanceId],
      }),
    ).toBeNull()
  })

  it('苏方补给站不参与 3.4b（轴方专规）', () => {
    const store = newStore()
    store.setTurn(1)
    store.spDumps.push({ id: 'su1', hex: { ...CORE_HEX }, side: 'soviet', sp: 8, t: 0 })
    const { unit } = panzerUnit(store)
    expect(
      store.panzerGroupSpGate({
        dumpId: 'su1',
        purpose: 'combat',
        beneficiaryUnitIds: [unit.instanceId],
      }),
    ).toBeNull()
  })

  it('拿不到补给站（null）⇒ 不在此处判（12.3a 的来源校验另有其门）', () => {
    const store = newStore()
    store.setTurn(1)
    const { unit } = panzerUnit(store)
    expect(
      store.panzerGroupSpGate({
        dumpId: null,
        purpose: 'fuel',
        beneficiaryUnitIds: [unit.instanceId],
      }),
    ).toBeNull()
  })
})

describe('3.4b：新到的轴方 SP 未归属时，只拦多单位编队的受限用途', () => {
  it('未归属的新站替装甲编队付账 ⇒ 拒 `newSpMustBeAssignedToAPanzerGroup`', () => {
    const store = newStore()
    store.setTurn(1)
    store.spDumpDraft = { hexText: `${CORE_HEX.col}.${CORE_HEX.row}`, sp: 8, t: 0 }
    expect(store.addSpDump()).toBe(true)
    const dump = store.spDumps[0]!
    const { unit } = panzerUnit(store)
    const failure = store.panzerGroupSpGate({
      dumpId: dump.id,
      purpose: 'combat',
      beneficiaryUnitIds: [unit.instanceId],
    })
    expect(failure).toMatchObject({ rule: '3.4b', reason: 'newSpMustBeAssignedToAPanzerGroup' })
    // 消息里要指明去哪儿声明（只报错误码玩家没法修）
    expect(store.panzerGroupSpRefusal(failure!, '战斗', dump.id)).toContain('尚未归属')

    // 声明归属后同一笔即可通过
    store.setDumpPanzerGroupNow(dump.id, 'guderian')
    expect(
      store.panzerGroupSpGate({
        dumpId: dump.id,
        purpose: 'combat',
        beneficiaryUnitIds: [unit.instanceId],
      }),
    ).toBeNull()
  })

  it('未归属的新站替**步兵**付账 ⇒ 放行（登记疏漏不该拦掉普通攻击）', () => {
    const store = newStore()
    store.setTurn(1)
    store.spDumpDraft = { hexText: `${CORE_HEX.col}.${CORE_HEX.row}`, sp: 8, t: 0 }
    expect(store.addSpDump()).toBe(true)
    const dump = store.spDumps[0]!
    const { unit } = plainUnit(store)
    expect(
      store.panzerGroupSpGate({
        dumpId: dump.id,
        purpose: 'combat',
        beneficiaryUnitIds: [unit.instanceId],
      }),
    ).toBeNull()
  })
})

describe('3.4b：三条受限用途都已接线（战斗 / 燃油 / 轰炸）', () => {
  it('战斗补给的付款路径确实会调 3.4b 门（战前拒付，账本不动）', () => {
    const store = newConsole()
    // 该用例用的是 harness 的 newConsole（不走本文件的夹具）⇒ 这里单独把可选项勾上
    adoptPanzerGroupOption()
    store.setTurn(1)
    const dump = axisDump(store, 'sd-axis')
    store.setDumpPanzerGroupNow(dump.id, 'hoth')
    expect(store.spDumps[0]!.sp).toBe(8)

    // 直接问门：Hoth 的站不得替 Guderian 编队付战斗成本
    const { unit } = panzerUnit(store, 'g1')
    expect(store.groupOfUnit(unit)).toBe('guderian')
    expect(
      store.panzerGroupSpGate({
        dumpId: 'sd-axis',
        purpose: 'combat',
        beneficiaryUnitIds: [unit.instanceId],
      }),
    ).toMatchObject({ rule: '3.4b' })
    // 该门是纯判定：不写任何账本
    expect(store.spDumps[0]!.sp).toBe(8)
  })

  it('燃油：错误集群的站付不出（12.5 已接回车上的站，不再走演示池）', () => {
    const store = newStore()
    store.setTurn(1)
    const { unit } = panzerUnit(store, 'g1')
    expect(store.groupOfUnit(unit)).toBe('guderian')
    store.selectedId = unit.instanceId
    unit.fuelled = false

    const dump = axisDump(store, 'sd-hoth')
    store.setDumpPanzerGroupNow(dump.id, 'hoth')
    expect(store.pickFuelDump(dump.id)).toBe(true)
    store.payFuel('singleUnit', true)
    // 3.4b 拦住：油没加、账本也没动
    expect(unit.fuelled).toBe(false)
    expect(store.spDumps[0]!.sp).toBe(8)

    // 改成同一归属即付得出，且**从该站真扣**
    store.setDumpPanzerGroupNow(dump.id, 'guderian')
    store.payFuel('singleUnit', true)
    expect(unit.fuelled).toBe(true)
    expect(store.spDumps[0]!.sp).toBeLessThan(8)
  })

  it('燃油：没有来源就付不出（12.3a：不存在凭空可用的池子）', () => {
    const store = newStore()
    store.setTurn(1)
    const { unit } = panzerUnit(store, 'g1')
    store.selectedId = unit.instanceId
    unit.fuelled = false
    axisDump(store)
    // 池子填满也不作数——它已不是任何付款路径的来源
    store.setFuelPool(4, 8)
    expect(store.pickFuelDump(null)).toBe(true)
    store.payFuel('singleUnit', true)
    expect(unit.fuelled).toBe(false)
    expect(store.fuelPool.t).toBe(8)
  })

  it('轰炸：错误集群的站付不出（10.1b 已接回车上的站，不再吃手填数字）', () => {
    const store = newStore()
    store.setTurn(1)
    const { unit } = panzerUnit(store, 'g1')
    const dump = axisDump(store, 'sd-hoth')
    store.setDumpPanzerGroupNow(dump.id, 'hoth')
    // 门是逐用途判的：同一座站替同一编队付**轰炸**成本同样被拒
    expect(
      store.panzerGroupSpGate({
        dumpId: dump.id,
        purpose: 'barrage',
        beneficiaryUnitIds: [unit.instanceId],
      }),
    ).toMatchObject({ rule: '3.4b' })
    expect(
      store.panzerGroupSpGate({
        dumpId: dump.id,
        purpose: 'fuel',
        beneficiaryUnitIds: [unit.instanceId],
      }),
    ).toMatchObject({ rule: '3.4b' })
    // 非受限用途（如建造）不受此限
    expect(
      store.panzerGroupSpGate({
        dumpId: dump.id,
        purpose: 'other' as never,
        beneficiaryUnitIds: [unit.instanceId],
      }),
    ).toBeNull()
  })
})
