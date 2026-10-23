import { describe, expect, it } from 'vitest'

import {
  airBoxRefitCapacity,
  refitCapacity,
  refitEligibility,
  resolveWeather,
} from '@/engine/rules'
import {
  CORE_HEX,
  NEAR_HEX,
  airBaseRecord,
  combatRecord,
  fighterRecord,
  groundRecord,
  label,
  newConsole,
  placeAir,
  placeGround,
  type Workbench,
} from './sop-harness'

/**
 * 环节 Ⓐ：**飞机整备**（A 段）——OCS 15.0 / 15.1 / 15.2 / 14.2a + 专规 1.4a
 *
 * 2.2 流程表把 A 段排在玩家回合之首，是**整备的唯一时机**（15.1A）；
 * 本文件独立验证该环节的全部判据：时机 / 每基地一次 / 费用 1T / 容量 / ZOC / 堆叠上限。
 * 单独运行：`npx vitest run tests/flows/10-phase-a-aircraft-refit.test.ts`
 */

/** 摆一个本方 1 级基地 + 1 架非激活战斗机 + 1 SP 付款站（12.1b），返回三件套 */
function setupRefitBase(store: Workbench, baseHex = CORE_HEX, level?: number) {
  const base = placeGround(store, airBaseRecord(level), baseHex, 'axis', 'base-1')
  const plane = placeAir(store, fighterRecord('axis'), baseHex, 'axis', 'air-1', 'inactive')
  store.setSupplyActive(true)
  store.spDumpDraft = { hexText: label(baseHex), sp: 1, t: 0 }
  store.addSpDump()
  return { base, plane }
}

describe('Ⓐ 15.1A：整备的时机闸门（只在 A 段，且每基地每阶段一次）', () => {
  it('15.1A：A 段整备成功；C 移动段整备被拒', () => {
    const store = newConsole()
    store.setAirActive(true)
    setupRefitBase(store)

    // C 移动段：不是整备时机
    expect(store.refitBaseNow('base-1')).toBe(false)
    // ★ B8：段/环节不对的拒绝由**统一闸门**给出（一次拦截，不再走引擎的 phase 判断）
    expect(store.actionRefusal).toMatchObject({ key: 'air.refit', rule: '15.1' })

    // A 整备段：成功
    store.setPhase('aircraftRefit')
    expect(store.refitBaseNow('base-1')).toBe(true)
  })

  it('15.1A：同一基地在同一个 A 段内只能整备一次', () => {
    const store = newConsole()
    store.setAirActive(true)
    const { plane } = setupRefitBase(store)
    store.setPhase('aircraftRefit')
    expect(store.refitBaseNow('base-1')).toBe(true)
    expect(store.refitDoneBases.map((base) => base.id)).toEqual(['base-1'])

    // 再弄出一架非激活机，仍不得再整备（每基地每阶段一次）
    plane.airStatus = 'inactive'
    expect(store.refitBaseNow('base-1')).toBe(false)
    expect(store.airError).toMatchObject({ rule: '15.1A', reason: 'baseAlreadyRefitThisPhase' })
  })

  it('15.1B：费用固定 1T（与等级、架数无关），从该基地可拖取的补给站扣款', () => {
    const store = newConsole()
    store.setAirActive(true)
    const { plane } = setupRefitBase(store)
    store.setPhase('aircraftRefit')
    expect(store.refitBaseNow('base-1')).toBe(true)

    expect(plane.airStatus).toBe('active')
    expect(store.lastRefit).toMatchObject({ costT: 1, activateAircraftIds: ['air-1'] })
    // 12.1a：1 SP = 4 T，付 1 T 后找零 ⇒ 0 SP + 3 T
    expect(store.spDumps[0]).toMatchObject({ sp: 0, t: 3 })
  })

  it('15.1B：可拖取范围内没有补给站 ⇒ T 不够，整备被拒（不静默）', () => {
    const store = newConsole()
    store.setAirActive(true)
    placeGround(store, airBaseRecord(), CORE_HEX, 'axis', 'base-1')
    placeAir(store, fighterRecord('axis'), CORE_HEX, 'axis', 'air-1', 'inactive')
    store.setPhase('aircraftRefit')
    expect(store.refitBaseNow('base-1')).toBe(false)
    expect(store.airError).toMatchObject({ rule: '15.1B', reason: 'insufficientRefitT' })
  })

  it('15.1B：容量＝等级 × 2（1 级基地 ⇒ 2 架），请求超容量即拒', () => {
    const store = newConsole()
    store.setAirActive(true)
    setupRefitBase(store)
    for (let index = 0; index < 2; index += 1)
      placeAir(store, fighterRecord('axis'), CORE_HEX, 'axis', `air-more-${index}`, 'inactive')
    store.setPhase('aircraftRefit')

    expect(refitCapacity({ level: 1 }).capacity).toBe(2)
    expect(refitCapacity({ isAirstrip: true }).capacity).toBe(1)

    store.airInputs.refitCount = 3
    expect(store.refitBaseNow('base-1')).toBe(false)
    expect(store.airError).toMatchObject({ rule: '15.1B', reason: 'refitCapacityExceeded:2' })
  })

  it('15.1C：基地处于**未抵消的敌方 ZOC** 内 ⇒ 不可整备（4.5b 的抵消另判）', () => {
    const store = newConsole()
    store.setAirActive(true)
    setupRefitBase(store)
    // 敌方战斗单位紧邻基地格 ⇒ 投射 ZOC（4.5a）
    placeGround(store, combatRecord('soviet'), NEAR_HEX, 'soviet', 'enemy-1')
    store.setPhase('aircraftRefit')

    expect(store.airBases[0]?.inUnnegatedEnemyZoc).toBe(true)
    expect(store.refitBaseNow('base-1')).toBe(false)
    expect(store.airError).toMatchObject({ rule: '15.1C', reason: 'unnegatedEnemyZoc' })

    // 4.5b：格内放一个己方战斗单位即抵消敌方 ZOC ⇒ 恢复可整备
    placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'friend-1')
    expect(store.airBases[0]?.inUnnegatedEnemyZoc).toBe(false)
    expect(store.refitBaseNow('base-1')).toBe(true)
  })

  it('14.2a：整备后的**激活**堆叠不得超限（4 + 基地等级）', () => {
    const store = newConsole()
    store.setAirActive(true)
    setupRefitBase(store)
    // 1 级基地 ⇒ 上限 5；已放 5 架激活机，再整备 1 架即 6 > 5
    for (let index = 0; index < 5; index += 1)
      placeAir(store, fighterRecord('axis'), CORE_HEX, 'axis', `filler-${index}`, 'active')
    store.setPhase('aircraftRefit')
    expect(store.refitBaseNow('base-1')).toBe(false)
    expect(store.airError).toMatchObject({
      rule: '14.2a',
      reason: 'activeStackingLimitExceeded:6>5',
    })
  })
})

describe('Ⓐ 15.1D / 15.2B / 专规 1.4a：天气与特殊基地的整备额度', () => {
  it('15.1D：天气**从不**禁止整备（天气表掷出 1＝受限飞行，整备仍全额可用）', () => {
    const limited = resolveWeather(1)
    expect(limited.isLimited).toBe(true)
    // 判据函数没有天气入参 ⇒ 天气结构上不可能禁止整备（15.1D）
    const outcome = refitEligibility({
      isAirstrip: false,
      level: 2,
      phase: 'aircraftRefit',
      alreadyRefitThisPhase: false,
      inUnnegatedEnemyZoc: false,
      requestedAircraft: 4,
      availableT: 1,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data).toMatchObject({ capacity: 4, costT: 1 })
  })

  it('15.2B：简易机场每阶段只整备 1 架，且永不缩减（等级恒 0）', () => {
    const store = newConsole()
    store.setAirActive(true)
    setupRefitBase(store)
    // 再放一架非激活机，使「容量」而非「非激活机数量」成为拦截点
    placeAir(store, fighterRecord('axis'), CORE_HEX, 'axis', 'air-2', 'inactive')
    store.toggleAirstripBase('base-1')
    expect(store.airBases[0]).toMatchObject({ isAirstrip: true, level: 0 })
    store.setPhase('aircraftRefit')

    store.airInputs.refitCount = 2
    expect(store.refitBaseNow('base-1')).toBe(false)
    expect(store.airError).toMatchObject({ rule: '15.1B', reason: 'refitCapacityExceeded:1' })
    store.airInputs.refitCount = 1
    expect(store.refitBaseNow('base-1')).toBe(true)
  })

  it('专规 1.4a：图外空军盒容量无限且**免费**整备', () => {
    const capacity = airBoxRefitCapacity()
    expect(capacity.unlimited).toBe(true)
    expect(capacity.capacity).toBe(Number.POSITIVE_INFINITY)
    expect(capacity.costT).toBe(0)
  })

  it('15.0 / 15.1：非本方基地不得整备（★ 基地归属权）', () => {
    const store = newConsole()
    store.setAirActive(true)
    // 苏方基地，但当前方是轴方
    placeGround(store, airBaseRecord(), CORE_HEX, 'soviet', 'base-su')
    placeAir(store, fighterRecord('axis'), CORE_HEX, 'axis', 'air-1', 'inactive')
    store.setSupplyActive(true)
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    store.addSpDump()
    store.setPhase('aircraftRefit')

    // 该基地不属于当前方 ⇒ 不在 ownAirBases 里，操作台无从整备
    expect(store.ownAirBases).toHaveLength(0)
    expect(store.refitBaseNow('base-su')).toBe(false)
  })
})

describe('Ⓐ 15.1B：盘面整备交互（点机场 → 勾飞机 → 点地图上的补给付款）', () => {
  it('15.1B：beginRefitNow 建立中间态；勾选后点补给站 ⇒ 只整备勾选的那几架并扣 1T', () => {
    const store = newConsole()
    store.setAirActive(true)
    const { plane } = setupRefitBase(store)
    const second = placeAir(store, fighterRecord('axis'), CORE_HEX, 'axis', 'air-2', 'inactive')
    store.setPhase('aircraftRefit')

    expect(store.beginRefitNow('base-1')).toBe(true)
    expect(store.refitBase?.id).toBe('base-1')
    expect(
      store.refitCandidates
        .map((air) => air.instanceId)
        .slice()
        .sort(),
    ).toEqual(['air-1', 'air-2'])
    expect(store.refitPayDumps.length).toBeGreaterThan(0)
    expect(store.refitSelectedIds).toEqual([])

    // 一架都没勾 ⇒ 不给结算（如实提示，不静默）
    expect(store.pickRefitPayDump(store.refitPayDumps[0]!.id)).toBe(false)

    store.toggleRefitAircraft('air-1')
    store.toggleRefitAircraft('air-1') // 再点一次＝取消
    store.toggleRefitAircraft('air-2')
    expect(store.refitSelectedIds).toEqual(['air-2'])

    expect(store.pickRefitPayDump(store.refitPayDumps[0]!.id)).toBe(true)
    expect(second.airStatus).toBe('active')
    expect(plane.airStatus).toBe('inactive') // 未勾选的不动
    expect(store.lastRefit).toMatchObject({ costT: 1, activateAircraftIds: ['air-2'] })
    // 12.1a：1 SP = 4 T ⇒ 付 1 T 后找零 0 SP + 3 T
    expect(store.spDumps[0]).toMatchObject({ sp: 0, t: 3 })
    // 交互已收束（不再停在「选飞机」的中间态）
    expect(store.refitBase).toBeNull()
    expect(store.refitSelectedIds).toEqual([])
  })

  it('15.1：未开始交互 / 非本方基地 / 已整备过的基地 ⇒ beginRefitNow 一律拒绝并留痕', () => {
    const store = newConsole()
    store.setAirActive(true)
    // 非本方基地
    placeGround(store, airBaseRecord(), CORE_HEX, 'soviet', 'base-su')
    placeAir(store, fighterRecord('axis'), CORE_HEX, 'axis', 'air-su', 'inactive')
    store.setPhase('aircraftRefit')
    expect(store.beginRefitNow('base-su')).toBe(false)
    expect(store.refitBase).toBeNull()

    // 本方基地：先走一次盘面交互，之后同阶段不得再开
    const { plane } = setupRefitBase(store)
    expect(store.beginRefitNow('base-1')).toBe(true)
    store.toggleRefitAircraft(plane.instanceId)
    expect(store.pickRefitPayDump(store.refitPayDumps[0]!.id)).toBe(true)
    expect(store.beginRefitNow('base-1')).toBe(false)
    expect(store.refitBase).toBeNull()

    // 没有进行中的交互时点补给站 ⇒ 什么也不做
    expect(store.pickRefitPayDump(store.spDumps[0]!.id)).toBe(false)
  })
})

describe('Ⓐ 段闸：A 段不得出现其他环节的动作（2.2 / ACTIONS_BY_PHASE）', () => {
  it('2.2：A 段没有移动环节——点己方算子不会进入移动交互', () => {
    const store = newConsole()
    store.setPhase('aircraftRefit')
    const unit = placeGround(
      store,
      groundRecord('axis', (record) => record.isCombat === true && record.attackCapable === true),
      CORE_HEX,
      'axis',
      'u1',
    )
    store.clickHex(CORE_HEX)
    expect(store.moveInteraction).toBeNull()
    expect(unit.movementEnded).toBe(false)
  })
})
