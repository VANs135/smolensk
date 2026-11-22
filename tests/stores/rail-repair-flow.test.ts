import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useWorkbenchStore } from '@/stores'

import { combatRecord, groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 铁路修理单位（13.3f / 13.3g）——**数据入库后的运行期行为**
 *
 * 条文：
 *   · **13.3f-A**「铁路**不能**在敌方 ZOC 内转换轨距（**无法被抵消**）。」
 *   · **13.3f-B**「一个铁路修理单位只需**移动进入**一个铁路格，就可转换该铁路格的轨距。
 *     轨距转换不消耗 SP，也不消耗额外的移动点数。」
 *   · **13.3g-B**「铁路修理单位在使用铁路移动之后，可以用它们的**完整 MA** 移动（要减去登车前的移动）。」
 *   · **13.3g-C** 铁路修理单位可在**任意**铁路格登车／卸货（不受 13.3c「可火车卸货格」限制）。
 *   · **13.3g-D**「在移动阶段最多可转换 4 格（当前 MA 更小则取 MA）；须处于战斗模式，或 DG 但朝向战斗面。」
 *   · **5.6a** 铁路运输须移动模式，13.3g 的铁路修理单位例外（战斗模式亦可）。
 *
 * ★ 三支铁路修理单位（苏 West RR Rgt、德 I-2 / II-2 RR Bn）2026-09-15 才入库并推进到 `valued`；
 *   在此之前 `isRailRepairUnit` 恒为 false ⇒ 13.3f 与 13.3g 的例外**全部不可达**（本组用例即其可达性证据）。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** Mogilev（15.10）→ Orsha（18.18）→ 19.19：整段是铁路（15.10→18.18 为多轨干线） */
const RUN: HexRef[] = [
  { col: 15, row: 10 },
  { col: 15, row: 11 },
  { col: 15, row: 12 },
  { col: 15, row: 13 },
  { col: 16, row: 13 },
  { col: 16, row: 14 },
  { col: 16, row: 15 },
  { col: 17, row: 16 },
  { col: 17, row: 17 },
  { col: 18, row: 17 },
  { col: 18, row: 18 },
  { col: 19, row: 19 },
]

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`
const FROM = RUN[0]! // Mogilev（Minor City）⇒ 可火车卸货格
const TO = RUN[RUN.length - 1]! // 19.19 是 Y 字路口，**不是**聚落 ⇒ 非可火车卸货格

const isRailRepair = (record: { specialized?: readonly string[] }): boolean =>
  (record.specialized ?? []).includes('rail_repair')

/** 走**真实单位库**的苏方铁路修理单位（West RR Rgt）；战斗面 (1)-0-3 / 移动面 (0)-0-9（轮式） */
function rrUnit(
  store: Workbench,
  hex: HexRef,
  instanceId: string,
  face: 'combat' | 'move' = 'move',
) {
  const record = groundRecord('soviet', (item) => isRailRepair(item))
  const unit = placeGround(store, record, hex, 'soviet', instanceId, face)
  unit.mode = { mode: face, orientation: face, dg: false, exploit: false }
  // 5.4a：一切数值以朝向那一面为基准 —— 与 store 的 `switchUnitMode` 同一行口径
  unit.raw = unit.faces[face]
  unit.mpSpent = 0
  unit.movementEnded = false
  return unit
}

/**
 * 把这段铁路置成**苏方可用**并声明起点为补给源格（13.3c）
 *
 * 2026-11-12 口径：铁路本身没有归属/控制/占领 ⇒ 不再沿线摆苏军单位来"控住"；
 * 13.3e-2 的「未控制」改读作「该格被敌方单位占据」。
 */
function prepareRun(store: Workbench): void {
  // 13.3c：声明起点为补给源格 ⇒ 起点成为可火车卸货格
  store.supplySourceDraft = { hexText: label(FROM), kind: 'supplySourceHex' }
  expect(store.addSupplySource()).toBe(true)
}

/** 沿铁路起点/下一格（13.3f-B：换轨必须是"移动进入"的副产品，故用例要先真走一步） */
const NEXT = RUN[1]!

/** 出错时把拒绝理由带进断言信息（否则只看 false 无法定位） */
const why = (store: Workbench): string =>
  `${store.railMoveError?.rule ?? '-'}/${store.railMoveError?.reason ?? '-'}`

/**
 * 13.3f-B：让某单位**真的走一格**（地面逐格）
 *
 * `clickHex` 第一下建取子清单 → `setMovePickOnly` 只选它 → 确认开拔 → `clickHex(目标)` 落这一步。
 * 这样"刚移动进入"的记账（`migration` / `moveInteraction.steps`）才成立。
 */
function walkInto(store: Workbench, unitId: string, from: HexRef, to: HexRef): void {
  const active = store.moveInteraction?.unitIds.includes(unitId) === true
  if (!active || store.moveInteraction?.finished === true) {
    store.clickHex(from)
    if (store.movePickHex !== null) {
      store.setMovePickOnly(unitId)
      expect(
        store.confirmMovePick(),
        `${store.moveBlocked?.rule ?? '-'}/${store.moveBlocked?.reason ?? '-'}`,
      ).toBe(true)
    }
  }
  store.clickHex(to)
  expect(store.units.find((unit) => unit.instanceId === unitId)?.hex).toEqual(to)
}

describe('13.3g-C：铁路修理单位可在任意铁路格登车/卸货（不受 13.3c 可卸货格限制）', () => {
  it('同一段路上：普通单位在非聚落格卸货被 13.3e 拒，铁路修理单位放行', () => {
    // ① 把 rail_repair 抹掉的单位：19.19 不是聚落 ⇒ detrainHexNotDetrainable
    const plain = newStore()
    plain.switchSide()
    plain.setPhase('movement')
    plain.setTurn(5)
    prepareRun(plain)
    const normal = rrUnit(plain, FROM, 'normal-1')
    normal.specialized = normal.specialized.filter((tag) => tag !== 'rail_repair')
    plain.selectedId = normal.instanceId
    plain.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }

    expect(plain.railMoveNow('unit'), why(plain)).toBe(false)
    expect(plain.railMoveError?.reason ?? '').toContain('detrainHexNotDetrainable')
    expect(normal.hex).toEqual(FROM)

    // ② 真实库记录的铁路修理单位：13.3g-C 放行
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    const rr = rrUnit(store, FROM, 'rr-1')
    expect(rr.specialized).toContain('rail_repair')
    store.selectedId = rr.instanceId
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }

    expect(store.railMoveNow('unit'), why(store)).toBe(true)
    expect(rr.hex).toEqual(TO)
  })

  it('13.3g-B：卸货后可用「完整 MA − 登车前移动」（13.3e 的 4.7d 例外）', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    const rr = rrUnit(store, FROM, 'rr-1')
    rr.mpSpent = 1
    store.selectedId = rr.instanceId
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }

    expect(store.railMoveNow('unit'), why(store)).toBe(true)
    expect(store.lastRailMove!.detail).toContain('13.3g-B')
    // 完整 MA（9，移动面）− 登车前移动 1 = 8 ⇒ 仍可继续移动
    expect(store.lastRailMove!.detail).toContain('可用 MA 8')
    expect(rr.movementEnded).toBe(false)
  })

  it('5.6a：铁路修理单位可**在战斗模式下**铁路移动（普通单位被 5.6a 拒）', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    const rr = rrUnit(store, FROM, 'rr-1', 'combat')
    store.selectedId = rr.instanceId
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }

    expect(store.railMoveNow('unit'), why(store)).toBe(true)
    // 战斗面 MA 3 全部可用（未登车前移动）
    expect(store.lastRailMove!.detail).toContain('可用 MA 3')
  })
})

describe('13.3g-A：不得「接力」（用铁路移动进入本阶段刚换过轨的格后再换轨）', () => {
  /* 原文：「一个铁路修理单位可在移动阶段将铁路移动与轨距转换结合起来。
   *        （例外：如果**用于铁路移动的格**刚刚在**当前阶段内**进行了轨距转换，则不能这样做。**不能接力！**）」
   * 游戏说明：「『不能接力』是一种**狭义**的限制，即不得让第二个修理单位在**新转换的轨道**上
   *          使用铁路移动来移动铁路端头标记。」⇒ ① 只有铁路修理单位受此限；
   *          ② 被禁的是"两者结合"（铁路移动完再换轨），**不是**铁路移动本身。
   * 判据在引擎 `validateGaugeConversion` 的 `usedNewlyConvertedRailThisPhase`（`rail.ts`）；
   * 本组用例钉的是 store 的**阶段账本**（哪些格本阶段被换过轨、哪个单位走过它们）与这条例外真的会拦人。 */

  it('★ 按格记的阶段账本：本阶段换过的格进账本（不重复）、换阶段即清空', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    const rr = rrUnit(store, FROM, 'rr-1', 'combat')

    expect(store.convertedHexesThisPhase).toEqual([])
    // 13.3f-B：先真的走进该格，再换轨（换轨是"移动进入"的副产品）
    walkInto(store, rr.instanceId, FROM, NEXT)
    expect(store.convertRailGaugeNow(rr.instanceId, label(NEXT))).toBe(true)
    expect(store.convertedHexesThisPhase).toEqual([label(NEXT)])
    // 同一格再换一次（幂等）不重复记账
    expect(store.convertRailGaugeNow(rr.instanceId, label(NEXT))).toBe(true)
    expect(store.convertedHexesThisPhase).toEqual([label(NEXT)])

    // 13.3g-A 的"刚刚在当前阶段内"⇒ 换阶段后这批格不再算数
    store.setPhase('supply')
    expect(store.convertedHexesThisPhase).toEqual([])
  })

  it('★ 用铁路移动进入"本阶段刚换过轨的格"，该单位此后再换轨 ⇒ 13.3g-A 拒（noLeapfrogging）', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)

    // ① 一号修理单位走进起点旁的 NEXT（本阶段）并把它换轨
    const first = rrUnit(store, FROM, 'rr-1', 'combat')
    walkInto(store, first.instanceId, FROM, NEXT)
    expect(store.convertRailGaugeNow(first.instanceId, label(NEXT))).toBe(true)

    // ② 二号修理单位沿铁路移动 FROM → TO：路径含本阶段换过轨的 NEXT
    const second = rrUnit(store, FROM, 'rr-2', 'combat')
    store.selectedId = second.instanceId
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }
    // 狭义解释（游戏说明）：被禁的是"结合"，铁路移动本身仍然合法
    expect(store.railMoveNow('unit'), why(store)).toBe(true)
    expect(second.hex).toEqual(TO)
    expect(store.railMovedNewTrackThisPhase).toEqual([{ instanceId: 'rr-2', hexes: [label(NEXT)] }])
    // ③ 该单位此后再换轨 ⇒ 13.3g-A 拒
    expect(store.convertRailGaugeNow(second.instanceId, label(TO))).toBe(false)
    expect(store.log.some((entry) => entry.text.includes('noLeapfrogging'))).toBe(true)
    // 账本没有因此改动：TO 仍未换轨
    expect(store.convertedHexesThisPhase).toEqual([label(NEXT)])
  })

  it('★ 对照组：本阶段没换过任何轨 ⇒ 走完铁路的修理单位照常换轨', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    const rr = rrUnit(store, FROM, 'rr-1', 'combat')
    store.selectedId = rr.instanceId
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }
    expect(store.railMoveNow('unit'), why(store)).toBe(true)

    expect(store.convertedHexesThisPhase).toEqual([])
    expect(store.railMovedNewTrackThisPhase).toEqual([])
    // 没走过"刚换过轨的格" ⇒ 这条例外不成立，换轨照常
    expect(store.convertRailGaugeNow(rr.instanceId, label(TO))).toBe(true)
  })

  it('★ 只对**铁路修理单位**记这笔账（普通单位走铁路不算数）', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    const rr = rrUnit(store, FROM, 'rr-1', 'combat')
    walkInto(store, rr.instanceId, FROM, NEXT)
    expect(store.convertRailGaugeNow(rr.instanceId, label(NEXT))).toBe(true)

    /*
     * 普通单位（把 rail_repair 抹掉）走同一条铁路的**前半段**：不进 13.3g-A 的账。
     * ★ 目的地必须是 13.3c 的可卸货格（13.3g-C 的例外只给铁路修理单位）⇒ 取沿途的 Orsha（18.18）。
     */
    const ORSHA = RUN.find((hex) => hex.col === 18 && hex.row === 18)
    expect(ORSHA).toBeDefined()
    const normal = rrUnit(store, FROM, 'plain-1', 'move')
    normal.specialized = normal.specialized.filter((tag) => tag !== 'rail_repair')
    store.selectedId = normal.instanceId
    store.railMoveInputs = { toHexText: label(ORSHA!), spAmount: 1, fromDumpId: null }
    expect(store.railMoveNow('unit'), why(store)).toBe(true)
    expect(store.railMovedNewTrackThisPhase).toEqual([])

    // 对照：铁路修理单位走同一段路仍会记账（差别在单位，不在路径）
    const rr2 = rrUnit(store, FROM, 'rr-2', 'combat')
    store.selectedId = rr2.instanceId
    store.railMoveInputs = { toHexText: label(TO), spAmount: 1, fromDumpId: null }
    expect(store.railMoveNow('unit'), why(store)).toBe(true)
    expect(store.railMovedNewTrackThisPhase).toEqual([{ instanceId: 'rr-2', hexes: [label(NEXT)] }])
  })
})

describe('13.3f：轨距转换（13.3g 的铁路修理单位专属动作）', () => {
  it('战斗模式 + 铁路格 ⇒ 成功；账本按**本方轨距**出账', () => {
    const store = newStore()
    store.switchSide() // 苏方（专规 1.2：印刷宽轨 = 苏方可用）
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    const rr = rrUnit(store, FROM, 'rr-1', 'combat')

    expect(store.isRailGaugeUsableAt(NEXT, 'soviet')).toBe(true)
    walkInto(store, rr.instanceId, FROM, NEXT)
    expect(store.convertRailGaugeNow(rr.instanceId, label(NEXT))).toBe(true)
    // 苏方转换 = 出账（把轴方换过去的轨换回来）⇒ 账本不含该格，且仍供本方使用
    expect(store.convertedRailHexes).not.toContain(label(NEXT))
    expect(store.isRailGaugeUsableAt(NEXT, 'soviet')).toBe(true)
    // 13.3g-D 的每阶段额度记在账上
    expect(store.gaugeConversionsThisPhase.find((x) => x.instanceId === rr.instanceId)?.count).toBe(
      1,
    )
  })

  it('★ 用户 2026-11-22 口径：走过即自动换轨——走进铁路格就换，不需要再点确认', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    const rr = rrUnit(store, FROM, 'rr-1', 'combat')
    rr.fuelled = true

    walkInto(store, rr.instanceId, FROM, NEXT)
    // 没有调用 `convertRailGaugeNow`，13.3g-D 的额度已自动落账
    //（苏方转换 = 换回宽轨 ⇒ 出账，故不入 `convertedRailHexes`；入账方向由轴方用例覆盖）
    expect(store.convertedRailHexes).not.toContain(label(NEXT))
    expect(store.gaugeConversionsThisPhase.find((x) => x.instanceId === rr.instanceId)?.count).toBe(
      1,
    )
    expect(store.log.some((entry) => entry.text.includes('走过即换轨（自动）'))).toBe(true)

    // 手动入口只作裁判补录：对同一格再点一次是幂等，不重复记账
    expect(store.convertRailGaugeNow(rr.instanceId, label(NEXT))).toBe(true)
    expect(store.gaugeConversionsThisPhase.find((x) => x.instanceId === rr.instanceId)?.count).toBe(
      1,
    )
  })

  it('13.3g-D：移动模式不可转换（须战斗模式，或 DG 但朝向战斗面）', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    /*
     * 用户 2026-11-22：换轨已改为「走过即自动」。所以直接以**移动面**进场，
     * 才能验证 13.3g-D 的模式判据——以战斗面进场的话自动换轨已经完成，再点只是幂等。
     */
    const rr = rrUnit(store, FROM, 'rr-1', 'move')
    // 12.5a：开拔要耗 MP ⇒ 测试夹具显式给「已加注」（workbench-model 的注释就指这条）
    rr.fuelled = true
    walkInto(store, rr.instanceId, FROM, NEXT)
    expect(store.convertRailGaugeNow(rr.instanceId, label(NEXT))).toBe(false)
    expect(store.convertedRailHexes).not.toContain(label(NEXT))
    expect(store.log.some((entry) => entry.text.includes('mustBeCombatMode'))).toBe(true)
  })

  it('13.3g：非铁路修理单位一律拒（notRailRepairUnit）', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    const rr = rrUnit(store, FROM, 'rr-1', 'combat')
    rr.specialized = rr.specialized.filter((tag) => tag !== 'rail_repair')

    walkInto(store, rr.instanceId, FROM, NEXT)
    expect(store.convertRailGaugeNow(rr.instanceId, label(NEXT))).toBe(false)
    expect(store.log.some((entry) => entry.text.includes('notRailRepairUnit'))).toBe(true)
  })

  it('13.3f-A：敌方 ZOC 内不可转换（且不可抵消）', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    const rr = rrUnit(store, FROM, 'rr-1', 'combat')

    // 敌方战斗单位放在 16.10 ⇒ 与它相邻的 NEXT（15.11）落入敌方 ZOC
    const enemy = groundRecord('axis', (item) => item.isCombat === true)
    placeGround(store, enemy, { col: 16, row: 10 }, 'axis', 'enemy-adj')

    walkInto(store, rr.instanceId, FROM, NEXT)
    expect(store.convertRailGaugeNow(rr.instanceId, label(NEXT))).toBe(false)
    expect(store.log.some((entry) => entry.text.includes('enemyZocCannotConvert'))).toBe(true)
  })

  it('13.3f-A：有本方战斗单位也不能抵消轨距转换的敌方 ZOC', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    // 目标 FROM 内有本方战斗单位；敌人在 16.10 仍让 FROM 处于敌方 ZOC
    placeGround(store, combatRecord('soviet'), FROM, 'soviet', 'own-combat')
    const rr = rrUnit(store, NEXT, 'rr-1', 'combat')
    const enemy = groundRecord('axis', (item) => item.isCombat === true)
    placeGround(store, enemy, { col: 16, row: 10 }, 'axis', 'enemy-adj')

    // 4.5a-E / 13.3f-A 明确规定轨距转换不能抵消 ZOC。
    walkInto(store, rr.instanceId, NEXT, FROM)
    expect(store.convertRailGaugeNow(rr.instanceId, label(FROM))).toBe(false)
    expect(store.log.some((entry) => entry.text.includes('enemyZocCannotConvert'))).toBe(true)
  })

  it('13.3g-D：每阶段至多 min(4, 当前 MA) 格，超出即拒', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    const rr = rrUnit(store, FROM, 'rr-1', 'combat')
    /*
     * 战斗面原 MA=3：走 3 格就把 MP 用光，额度满后**走不到第 4 格**，无法验证「超出即拒」。
     * 这里把 MA 抬到 8（额度仍是 min(4, 8) = 4）——构造的是「MP 够走、额度不够换」的场景。
     */
    rr.raw = { ...rr.faces.combat, ma: 8 }
    const quota = Math.min(4, rr.raw.ma)
    // 13.3f-B：逐格走进、逐格换轨（换轨不是远程动作）
    const hexes = RUN.slice(1, quota + 1)
    expect(hexes.length).toBe(quota)

    for (const hex of hexes) {
      const previous = RUN[RUN.indexOf(hex) - 1]!
      walkInto(store, rr.instanceId, previous, hex)
      expect(store.convertRailGaugeNow(rr.instanceId, label(hex))).toBe(true)
    }
    expect(store.gaugeConversionsThisPhase.find((x) => x.instanceId === rr.instanceId)?.count).toBe(
      hexes.length,
    )
    // 同一格再点一次不重复记账、也不再占额度（13.3g-A 的幂等；自动换轨后玩家再点就是这个场景）
    const last = hexes[hexes.length - 1]!
    expect(store.convertRailGaugeNow(rr.instanceId, label(last))).toBe(true)
    expect(store.gaugeConversionsThisPhase.find((x) => x.instanceId === rr.instanceId)?.count).toBe(
      hexes.length,
    )
    // 额度已满 ⇒ 走进**下一格**再换（新格）被拒（13.3g-D）
    const beyond = RUN[quota + 1]!
    walkInto(store, rr.instanceId, RUN[quota]!, beyond)
    expect(store.convertRailGaugeNow(rr.instanceId, label(beyond))).toBe(false)
    expect(store.log.some((entry) => entry.text.includes('conversionLimitReached'))).toBe(true)
  })

  /* ── 13.3f-B：换轨必须是"移动进入"的副产品 ── */

  it('13.3f-B：远程指定未走进的铁路格 ⇒ 拒绝并给出可读原因', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    const rr = rrUnit(store, FROM, 'rr-1', 'combat')
    const before = [...store.convertedRailHexes]

    expect(store.convertRailGaugeNow(rr.instanceId, label(TO))).toBe(false)
    expect(store.convertedRailHexes).toEqual(before)
    const refused = store.log.filter((entry) => entry.text.includes('轨距转换被拒'))
    expect(refused).toHaveLength(1)
    expect(refused[0]?.text).toContain('13.3f-B')
    expect(refused[0]?.text).toContain('不能远程换轨')
  })

  it('13.3f-B：原地不动（未移动进入）⇒ 拒绝，账本不动', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    const rr = rrUnit(store, FROM, 'rr-1', 'combat')

    expect(store.convertRailGaugeNow(rr.instanceId, label(FROM))).toBe(false)
    expect(store.convertedHexesThisPhase).toEqual([])
    expect(store.log.some((entry) => entry.text.includes('本阶段尚未移动进入任何格'))).toBe(true)
  })

  it('13.3f-B：真的走进该格 ⇒ 成功；进入的 MP 已由那一步支付（换轨不耗额外 MP）', () => {
    const store = newStore()
    store.switchSide()
    store.setPhase('movement')
    store.setTurn(5)
    prepareRun(store)
    const rr = rrUnit(store, FROM, 'rr-1', 'combat')

    walkInto(store, rr.instanceId, FROM, NEXT)
    // 进入 NEXT 的地形成本已由移动步骤扣掉
    const spentAfterStep = rr.mpSpent
    expect(spentAfterStep).toBeGreaterThan(0)
    // 13.3f-B：换轨本身只付 0 额外 MP
    expect(store.convertRailGaugeNow(rr.instanceId, label(NEXT))).toBe(true)
    expect(rr.mpSpent).toBe(spentAfterStep)
    expect(store.convertedHexesThisPhase).toEqual([label(NEXT)])
  })
})
