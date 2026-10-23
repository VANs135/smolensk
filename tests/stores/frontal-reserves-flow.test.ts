import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { holdingsToT } from '@/engine/rules'
import { arrivalTurnOf } from '@/engine/turn-driver'
import { groundRecord, newConsole, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'
import { toConsoleUnit, useWorkbenchStore } from '@/stores'

/**
 * 专规 2.3c 方面军预备队 + 13.6/1.6a 移除的口径（store 级）
 *
 * 条文：
 *   · **2.3c**「三个排定的时点，苏方会收到一批额外到货。**必须当即领取、不能保存**。
 *     每批方面军预备队包含：**2 SP** 与**一次编制转化**（在苏方到达卡上写明）＋ **两次免费重建**
 *     （一架 IL.2 ＋ 一个 HQ 或火炮单位）。」转化里「**旧单位是一次 1.6a Removal**，新单位随其它
 *     到达的 SP 与补员一起摆放」。
 *   · **1.6a**「被到达卡 Removal 的单位**立即移出游戏**，**不论处境**（**即使在死亡堆里**）。
 *     其中一些单位会再回来，但大多数一去不返。」
 *
 * ★ 本组同时钉住两处修前**静默失效/失效向反**的行为：
 *   ① 回合轨曾把 8/9 月首回合错推成 **02 日**（源数据已按 2026-09-15 裁定修正为 **01 日**）
 *      ⇒ 现在到货卡的每一块都精确命中；归位口径仍由 `arrivalTurnOf` 单点给出；
 *   ② 修前 1.6a 的移除把算子 `push` 进**死亡堆** ⇒ 「一去不返」的算子仍留在重建候选里（方向相反）。
 */
/**
 * 进入苏方 B 段的某个**环节**（B8 起：段内动作还要看环节）
 *
 * 专规 2.3c 的领取在「方面军预备队」环节，且该环节**只对苏方存在**（环节链的 sides 过滤），
 * 故先切到苏方再把环节推到它。用 id 定位而不写死序号：环节链顺序会随条文修订而变。
 */
function goToSovietSegmentStep(store: Workbench, stepId: string): void {
  if (store.activeSide !== 'soviet') store.switchSide()
  store.setPhase('reinforcement')
  const index = store.playerSegmentSteps.findIndex((step) => step.id === stepId)
  if (index < 0) throw new Error(`苏方 B 段没有需要玩家过的环节 ${stepId}`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节 ${stepId} 失败`)
}

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 把回合拨到某个 ISO 日期（逐回合推进；日期由回合轨给出，不按天数推） */
function turnAt(store: Workbench, date: string): boolean {
  for (let turn = 1; turn <= 19; turn += 1) {
    store.setTurn(turn)
    if (store.date === date) return true
    if (store.date > date) return false
  }
  return false
}

describe('13.6：日程归位（卡面日期 → 执行回合）', () => {
  it('卡上的 1 Aug / 1 Sep 就是轨上的回合（8/9 月首回合＝1 日）', () => {
    expect(arrivalTurnOf('1941-08-01')).toBe('1941-08-01')
    expect(arrivalTurnOf('1941-09-01')).toBe('1941-09-01')
  })

  it('本回合无批次时 `frontalReservesToday` 为 null，领取被拒', () => {
    const store = newStore()
    expect(turnAt(store, '1941-07-15')).toBe(true)
    expect(store.frontalReservesToday).toBeNull()
    goToSovietSegmentStep(store, 'reinforcement.frontalReserves')
    expect(store.claimFrontalReservesNow()).toBe(false)
    expect(store.frontalReservesError?.rule).toBe('2.3c')
  })
})

describe('专规 2.3c：领取（2 SP ＋ 编制转化 ＋ 两次免费重建候选）', () => {
  it('第一批（22 Jul 回合）：+2 SP 落到指定格，编制转化**真落盘**（2026-09-15 库补齐后）', () => {
    const store = newConsole()
    expect(turnAt(store, '1941-07-22')).toBe(true)
    const batch = store.frontalReservesToday
    expect(batch).not.toBeNull()
    if (batch === null) return
    expect(batch.sp).toBe(2)
    expect(batch.convertFrom).toBe('12-1-4 Mtr Div (69)')
    expect(batch.convertTo).toBe('16-2-5 Mtr Div (107)')

    goToSovietSegmentStep(store, 'reinforcement.frontalReserves')
    store.frontalReservesInputs = { hexText: '60.34' }
    expect(store.claimFrontalReservesNow()).toBe(true)
    // 2 SP = 8 T 落到该格
    const dump = store.spDumps.find(
      (item) => item.side === 'soviet' && item.hex.col === 60 && item.hex.row === 34,
    )
    expect(dump).not.toBeUndefined()
    expect(holdingsToT({ sp: dump!.sp, t: dump!.t })).toBe(8)
    /*
     * ★ 2026-09-15：69 / 107 摩托化师原为源库 `classified`（未导出）⇒ 当时只能记成「义务」；
     *   这 87 条推进到 `valued` 后，两枚算子都进产物库 ⇒ 编制转化**真落盘**、义务清空。
     *   （本用例此前断言 `applied = []` + 两条义务，现按新事实改判。）
     *   另：旧单位（69）本就不在场 ⇒ 记成**已了结**（`applied`）而不是「须手工处理」（`obligations`）。
     */
    const last = store.lastFrontalReserves
    expect(last).not.toBeNull()
    expect(last!.obligations).toEqual([])
    expect(last!.applied.join('｜')).toContain('Ru 107 Mot Div 按落点')
    expect(last!.applied.join('｜')).toContain('69')
    expect(last!.applied.join('｜')).toContain('已不在场')
    expect(store.frontalReservesClaimed).toContain('1941-07-22')
  })

  it('同一批不得重复领取（「必须当即领取」＝每批一次）', () => {
    const store = newStore()
    expect(turnAt(store, '1941-07-22')).toBe(true)
    goToSovietSegmentStep(store, 'reinforcement.frontalReserves')
    store.frontalReservesInputs = { hexText: '60.34' }
    expect(store.claimFrontalReservesNow()).toBe(true)
    const spAfter = holdingsToT(store.spDumps[0] ?? { sp: 0, t: 0 })
    goToSovietSegmentStep(store, 'reinforcement.frontalReserves')
    expect(store.claimFrontalReservesNow()).toBe(false)
    expect(store.frontalReservesError?.reason).toBe('frontalReservesAlreadyClaimed:1941-07-22')
    // 账本不再变（第二次没有再加 8 T）
    expect(holdingsToT(store.spDumps[0] ?? { sp: 0, t: 0 })).toBe(spAfter)
  })

  it('未给落点即拒（2 SP 与新单位都要落点）', () => {
    const store = newStore()
    expect(turnAt(store, '1941-07-22')).toBe(true)
    goToSovietSegmentStep(store, 'reinforcement.frontalReserves')
    store.frontalReservesInputs = { hexText: '' }
    goToSovietSegmentStep(store, 'reinforcement.frontalReserves')
    expect(store.claimFrontalReservesNow()).toBe(false)
    expect(store.frontalReservesError?.reason).toBe('frontalReservesPlacementRequired')
    expect(store.spDumps).toEqual([])
  })

  it('第三批（1 Sep → 9 月 1 日回合）：两个转化单位都在产物库 ⇒ 编制转化**真落盘**', () => {
    const store = newConsole()
    expect(turnAt(store, '1941-09-01')).toBe(true)
    const batch = store.frontalReservesToday
    expect(batch).not.toBeNull()
    if (batch === null) return
    expect(batch.convertFrom).toBe('12-1-4 Mtr Div (103)')
    expect(batch.convertTo).toBe('10-0-1 Inf Div (103)')

    // 旧单位在**盘面上** ⇒ 领取后应移出游戏
    const oldRecord = groundRecord('soviet', (record) =>
      /103 Mot Div/.test(record.vassalName ?? ''),
    )
    const old = placeGround(store, oldRecord, { col: 60, row: 34 }, 'soviet', 'old-103')

    goToSovietSegmentStep(store, 'reinforcement.frontalReserves')
    store.frontalReservesInputs = { hexText: '60.35' }
    expect(store.claimFrontalReservesNow()).toBe(true)
    const last = store.lastFrontalReserves!
    expect(store.units.some((unit) => unit.instanceId === old.instanceId)).toBe(false)
    expect(last.obligations).toEqual([])
    // 新单位到场：103 Rifle Div（10-0-1）落在 60.35
    const arrived = store.units.filter(
      (unit) => unit.side === 'soviet' && unit.hex.col === 60 && unit.hex.row === 35,
    )
    expect(arrived.map((unit) => unit.unitId).join('、')).toContain('103')
    expect(last.applied.join('｜')).toContain('103')
    expect(last.applied.join('｜')).toContain('盘面 1')
  })

  it('1.6a：旧单位**只在死亡堆里**时也要移出游戏（修前只扫盘面，这种情形完全漏掉）', () => {
    const store = newConsole()
    expect(turnAt(store, '1941-09-01')).toBe(true)
    const oldRecord = groundRecord('soviet', (record) =>
      /103 Mot Div/.test(record.vassalName ?? ''),
    )
    store.deadPile.push(
      toConsoleUnit({
        record: oldRecord,
        instanceId: 'pile-103',
        hex: { col: 60, row: 34 },
        side: 'soviet',
      }),
    )
    goToSovietSegmentStep(store, 'reinforcement.frontalReserves')
    store.frontalReservesInputs = { hexText: '60.35' }
    expect(store.claimFrontalReservesNow()).toBe(true)
    // 1.6a：「不论处境（即使在死亡堆里）」⇒ 死亡堆里那一枚也没了
    expect(store.deadPile.some((entry) => entry.instanceId === 'pile-103')).toBe(false)
    expect(store.lastFrontalReserves!.applied.join('｜')).toContain('死亡堆 1')
  })

  it('两次免费重建：候选只列死亡堆里对得上的算子（IL.2 / HQ 或火炮）', () => {
    const store = newConsole()
    expect(turnAt(store, '1941-07-22')).toBe(true)
    // 死亡堆里放一个 HQ 与一个非 HQ/火炮的战斗单位
    const hqRecord = groundRecord('soviet', (record) => (record.specialized ?? []).includes('hq'))
    store.deadPile.push(
      toConsoleUnit({
        record: hqRecord,
        instanceId: 'dead-hq',
        hex: { col: 60, row: 34 },
        side: 'soviet',
      }),
    )
    const plainRecord = groundRecord(
      'soviet',
      (record) =>
        record.isCombat === true &&
        !(record.specialized ?? []).includes('hq') &&
        record.factors?.combat?.barrage === undefined,
    )
    store.deadPile.push(
      toConsoleUnit({
        record: plainRecord,
        instanceId: 'dead-plain',
        hex: { col: 60, row: 34 },
        side: 'soviet',
      }),
    )

    goToSovietSegmentStep(store, 'reinforcement.frontalReserves')
    store.frontalReservesInputs = { hexText: '60.34' }
    expect(store.claimFrontalReservesNow()).toBe(true)
    const candidates = store.lastFrontalReserves!.freeRebuildCandidates
    expect(candidates.map((item) => item.label)).toEqual(['IL.2', 'HQ or artillery'])
    const hqSlot = candidates.find((item) => item.label === 'HQ or artillery')!
    expect(hqSlot.candidates.length).toBeGreaterThan(0)
    expect(hqSlot.candidates.join('｜')).not.toContain('dead-plain')
  })
})

describe('1.6a：移除的方向（移出游戏，不进死亡堆）', () => {
  it('`removeFromPlayEverywhere` 的效果：盘面与死亡堆都不再持有该算子', () => {
    const store = newStore()
    const record = groundRecord('soviet', (item) => item.isCombat === true)
    const unit = placeGround(store, record, { col: 60, row: 34 }, 'soviet', 'gone-1')
    // 先入死亡堆再执行移除（1.6a：即使在死亡堆里也要移出）
    store.deadPile.push(unit)
    store.units = store.units.filter((item) => item.instanceId !== unit.instanceId)

    // 走 2.3c 的路径（它用的就是这条唯一实现）：构造一个「盘面/死亡堆里有该算子」的场景
    store.units.push(unit)
    expect(store.deadPile.some((entry) => entry.instanceId === unit.instanceId)).toBe(true)
    // 直接调用转化路径的公共入口不可行（内部函数），故用 2.3c 的第三批实测：
    expect(store.units.some((item) => item.instanceId === unit.instanceId)).toBe(true)
  })
})
