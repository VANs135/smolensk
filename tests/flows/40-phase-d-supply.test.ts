import { describe, expect, it } from 'vitest'

import {
  ACTIONS_BY_PHASE,
  DUMP_DESTRUCTION_SEGMENTS,
  FUEL_FORMATION_SP,
  FUEL_HQ_SP,
  FUEL_SINGLE_UNIT_T,
  attritionArOf,
  attritionStackAr,
  checkTiming,
  computeFuelCost,
  internalStocksReplenishCost,
  resolveAttrition,
  sopChainOf,
} from '@/engine/rules'
import {
  CORE_HEX,
  combatRecord,
  groundRecord,
  label,
  newConsole,
  placeGround,
  type Workbench,
} from './sop-harness'

/**
 * 环节 Ⓓ：**补给**（D 段）——OCS 12.0 章：12.1a / 12.3 / 12.6 / 12.8 / 12.10 / 12.11a
 *
 * D 段（H④ 起）按用户 2026-09-19 口径分**两环**：① **恢复部队储备**（12.10e）；
 * ② **补给检定**（12.6 判定 → 12.6c 吃图上补给 / 12.6d 标断补 → 12.8 断补堆叠的损耗）。
 * 12.5 燃料**不在本段**（12.5c：付款在消耗时刻 ⇒ C/E/G 的移动环节；见 §17.120 回执）。
 * 补给站的拆分/加总（12.1a）与销毁（12.11a）同属本段的账务。
 * 单独运行：`npx vitest run tests/flows/40-phase-d-supply.test.ts`
 */

/** 摆好「单位 + 同格补给站 + 同格补给源」的追溯补给现场 */
function setupTracedUnit(store: Workbench) {
  const unit = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
  store.setSupplyActive(true)
  // 12.1b：含 SP 的位置即补给站（同格 ⇒ 12.3a 距离 0）
  store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
  expect(store.addSpDump()).toBe(true)
  // 12.6a①：同格声明一个补给源 ⇒ 该堆叠有追溯补给
  store.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'supplySourceHex' }
  expect(store.addSupplySource()).toBe(true)
  return unit
}

/** 21.10：本方的指挥部记录（`isHqUnit` 认 `specialized` 含 `hq` 或带投递距离者） */
function hqRecord(side: 'axis' | 'soviet') {
  const found = groundRecord(side, (item) => (item.specialized ?? []).includes('hq'))
  return found
}

describe('Ⓓ D 段许可动作与段闸（2.2）', () => {
  it('2.2：D 段只做追溯判定 / 6c 吃图上补给 / 6d 断补 / 8 损耗；**没有加油**，移动与轰炸不在此段', () => {
    /*
     * ★ 契约变更（H④，用户 2026-09-19 口径，**不是放宽**）：原先本行断言含 `fuel`（D 段有个加油环节）。
     *   12.5c 把付款绑在**消耗时刻**，而补给段不发生燃料消耗 ⇒ 该环节已删；`fuel` 归入
     *   `TIMING_DEFERRED_ACTIONS`（出处 12.5c），D 段的许可动作只剩这两条。
     */
    expect([...ACTIONS_BY_PHASE.supply]).toEqual(['supplyTrace', 'hqThrow'])
    for (const action of ['move', 'barrage', 'attack', 'refit', 'railTransport'] as const) {
      const violations = checkTiming({
        action,
        side: 'axis',
        activeSide: 'axis',
        phase: 'supply',
        date: '1941-07-12',
      })
      expect(violations.map((item) => item.reason)).toContain('actionNotInSegment')
    }
    // 燃料：`checkTiming` 不判它（时机在 12.5c ＋ store 的闸门表），且**任何段**的许可集合里都没有它
    expect(
      checkTiming({
        action: 'fuel',
        side: 'axis',
        activeSide: 'axis',
        phase: 'supply',
        date: '1941-07-12',
      }),
    ).toEqual([])
    for (const phase of ['supply', 'movement', 'reaction', 'exploitation', 'combat'] as const) {
      expect([...ACTIONS_BY_PHASE[phase]]).not.toContain('fuel')
    }
    // 反过来：补给类动作不得出现在移动段
    const wrong = checkTiming({
      action: 'supplyTrace',
      side: 'axis',
      activeSide: 'axis',
      phase: 'movement',
      date: '1941-07-12',
    })
    expect(wrong.map((item) => item.reason)).toContain('actionNotInSegment')
  })

  it('H④：D 段两环的次序与标签（恢复部队储备 → 补给检定）', () => {
    const chain = sopChainOf('supply')
    expect(chain.steps.map((step) => step.id)).toEqual(['supply.recovery', 'supply.check'])
    expect(chain.steps.map((step) => step.label)).toEqual(['恢复部队储备', '补给检定'])
  })

  it('12.11a：销毁补给站只允许在移动 / 反应 / 进击三个**移动环节**（C/E/G）', () => {
    expect([...DUMP_DESTRUCTION_SEGMENTS]).toEqual(['movement', 'reaction', 'exploitation'])
    // 补给阶段（D）与战斗阶段（F）都不在列
    expect([...DUMP_DESTRUCTION_SEGMENTS]).not.toContain('supply')
    expect([...DUMP_DESTRUCTION_SEGMENTS]).not.toContain('combat')
  })
})

describe('Ⓓ 12.1a：SP 账本的加总与拆分', () => {
  it('12.1a：加总把满 4 的 T 并为 SP；拆分把整 SP 找零为 T（总额不变，1 SP = 4 T）', () => {
    const store = newConsole()
    store.setSupplyActive(true)
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 6 }
    expect(store.addSpDump()).toBe(true)
    const id = store.spDumps[0]!.id

    expect(store.mergeSpDumpHoldings(id)).toBe(true)
    expect(store.spDumps[0]).toMatchObject({ sp: 2, t: 2 })
    expect(store.splitSpDumpHoldings(id, 1)).toBe(true)
    expect(store.spDumps[0]).toMatchObject({ sp: 1, t: 6 })
  })

  it('12.1a：拆分超过持有量即被拒（不静默、不改账本）', () => {
    const store = newConsole()
    store.setSupplyActive(true)
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    store.addSpDump()
    const id = store.spDumps[0]!.id
    expect(store.splitSpDumpHoldings(id, 5)).toBe(false)
    expect(store.supplyError?.rule).toBe('12.1a')
    expect(store.spDumps[0]).toMatchObject({ sp: 1, t: 0 })
  })
})

describe('Ⓓ 12.6 → 12.3：追溯判定、选源与拖取（端到端）', () => {
  it('12.6/12.3：有追溯补给 ⇒ trace 分支；选同格补给站拖取 1T 后账本按 12.1a 找零', () => {
    const store = newConsole()
    const unit = setupTracedUnit(store)
    // 注：操作台的可选阶段里**没有 D 段**（只有 A/C/E/F/G 五段，见 workbench.ts 的 ConsolePhase），
    //     故补给检查不带阶段闸门；D 段的段闸由引擎的 ACTIONS_BY_PHASE 表达（见上一组用例）。

    // B8：D 段的动作只在 D 段放行 ⇒ 先声明段（本段第 1 环＝追溯/拖取）

    store.setPhase('supply')

    expect(store.beginSupplyCheckNow(unit.instanceId)).toBe(true)
    expect(store.supplySummary?.status).toBe('inSupply')
    expect(store.supplyState?.step).toBe('selectSource')

    const dumpIndex = store.supplySources.findIndex((source) => source.kind === 'dump')
    expect(dumpIndex).toBeGreaterThanOrEqual(0)
    expect(store.supplySources[dumpIndex]).toMatchObject({ ok: true, distanceMp: 0 })

    expect(store.chooseSupplySourceNow(dumpIndex)).toBe(true)
    expect(store.supplyState?.step).toBe('pickup')

    /*
     * ★ 契约变更（批 B 切片 2，**不是放宽**）：用途 `combat` → `fuel`。
     *   裁定⑥「12.4 战斗补给只在战斗会话内付」⇒ 本条链（12.3 拖取/投递）选 `combat` 会被按 12.4 拒。
     *   本条考的是「12.6 → 12.3 选源与拖取 + 12.1a 找零」，与用途无关；用途的两面由
     *   `tests/stores/supply-purpose-landing-flow.test.ts` 钉住。
     */
    store.supplyInputs.amountT = 1
    store.supplyInputs.purpose = 'fuel'
    expect(store.confirmSupplyPickupNow()).toBe(true)
    expect(store.supplyState?.step).toBe('done')
    // 12.1a：1 SP = 4 T，按 12.5c-C 的费率付 1 T ⇒ 0 SP + 3 T
    expect(store.spDumps[0]).toMatchObject({ sp: 0, t: 3 })
  })

  it('12.6c：有追溯补给的堆叠**不能**吃图上补给（选项被引擎否决）', () => {
    const store = newConsole()
    const unit = setupTracedUnit(store)

    // B8：D 段的动作只在 D 段放行 ⇒ 先声明段（本段第 1 环＝追溯/拖取）

    store.setPhase('supply')

    store.beginSupplyCheckNow(unit.instanceId)
    const eatOffMap = store.supplySources.find((source) => source.kind === 'eatOffTheMap')
    expect(eatOffMap?.ok).toBe(false)
  })

  it('12.6：只能对**当前方**的单位做补给检查（补给按方归属）', () => {
    const store = newConsole()
    store.setSupplyActive(true)
    const enemy = placeGround(store, combatRecord('soviet'), CORE_HEX, 'soviet', 'e1')

    // B8：D 段的动作只在 D 段放行 ⇒ 先声明段（本段第 1 环＝追溯/拖取）

    store.setPhase('supply')

    expect(store.beginSupplyCheckNow(enemy.instanceId)).toBe(false)
    expect(store.supplyState).toBeNull()
  })

  it('12.6a：追溯源本身不含 SP 时不能作为拖取来源（12.1b）', () => {
    const store = newConsole()
    store.setSupplyActive(true)
    const unit = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    store.addSpDump()
    store.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'edgeRail' }
    store.addSupplySource()

    // B8：D 段的动作只在 D 段放行 ⇒ 先声明段（本段第 1 环＝追溯/拖取）

    store.setPhase('supply')

    store.beginSupplyCheckNow(unit.instanceId)

    const baseIndex = store.supplySources.findIndex((source) => source.kind === 'baseSource')
    expect(baseIndex).toBeGreaterThanOrEqual(0)
    expect(store.chooseSupplySourceNow(baseIndex)).toBe(false)
    expect(store.supplyError?.reason).toBe('sourceHasNoSp:baseSource')
    expect(store.supplyState?.step).toBe('selectSource')
  })
})

describe('Ⓓ 专规 1.7 / 21.10：补给缓存 Forage（应急征粮）只在 D 段', () => {
  /**
   * B37：1.7 补给缓存加上了**闸门**（只在补给段的三个环节）⇒ 正向用例要先走到补给环节。
   * 负向用例断的是**闸门**拒绝（界面根本不该在别的段给出入口）；引擎自身的
   * `forageOnlyInSupplyPhase` 仍由 `tests/engine/supply-cache.test.ts` 覆盖（两道都在）。
   */
  function goToSupplyStep(store: ReturnType<typeof newConsole>): void {
    store.setPhase('supply')
    const index = store.playerSegmentSteps.findIndex((step) => step.id.startsWith('supply.'))
    if (index < 0) throw new Error('D 段没有玩家环节？')
    expect(store.setSegmentStepIndex(index)).toBe(true)
  }

  it('21.10：D 段 + 断补首回合 ⇒ 花 1 枚，为 HQ 投递距离内全部战斗单位提供追溯补给', () => {
    const store = newConsole()
    goToSupplyStep(store)
    /*
     * ★ 契约变更（批 F 切片 5，**不是放宽**）：21.10 的「断补的第一个回合」修前由裁判在面板上勾选
     *   （`supplyCacheInputs.firstTurnOfBeingCut`），现已删除 ⇒ 判据改按盘面事实算（`cutSinceTurn`）。
     *   故本用例改为**摆出一个真的首回合**：把 HQ 摆在 CORE_HEX 上、不给任何补给源，重判一次
     *   追溯补给（12.6）即落成"连续断补起点＝当前回合"。
     */
    placeGround(store, hqRecord('axis'), CORE_HEX, 'axis', 'hq-1')
    store.evaluateTraceSupplyNow()
    store.supplyCacheInputs.use = 'forage'
    store.supplyCacheInputs.hexText = label(CORE_HEX)
    expect(store.spendSupplyCacheNow()).toBe(true)
    expect(store.supplyCacheHoldings.axis).toBe(1)
  })

  it('21.10：其它段（C/E/F/G）一律不可用——Forage 只在补给阶段', () => {
    for (const phase of ['movement', 'reaction', 'combat', 'exploitation'] as const) {
      const store = newConsole()
      store.setPhase(phase)
      store.supplyCacheInputs.use = 'forage'
      store.supplyCacheInputs.hexText = label(CORE_HEX)
      expect(store.spendSupplyCacheNow()).toBe(false)
      expect(store.actionRefusal?.key).toBe('exclusive.forage')
      expect(store.supplyCacheHoldings.axis).toBe(2)
    }
  })

  it('21.10：非「断补的第一个回合」不可用', () => {
    const store = newConsole()
    goToSupplyStep(store)
    // 契约变更（批 F 切片 5）：不再由裁判勾选 ⇒ 用"断补已到第二个回合"造出非首回合的事实
    const hq = placeGround(store, hqRecord('axis'), CORE_HEX, 'axis', 'hq-1')
    store.evaluateTraceSupplyNow()
    expect(hq.cutSinceTurn).toBe(store.turn)
    store.setTurn(store.turn + 1)
    store.setPhase('supply')
    store.evaluateTraceSupplyNow()
    expect(hq.cutSinceTurn).toBe(store.turn - 1)

    store.supplyCacheInputs.use = 'forage'
    store.supplyCacheInputs.hexText = label(CORE_HEX)
    expect(store.spendSupplyCacheNow()).toBe(false)
    expect(store.exclusiveError?.reason).toBe('forageOnlyOnFirstTurnOfBeingCut')
  })
})

describe('Ⓓ 12.5c：加油三法的费用与到期（引擎判据）', () => {
  it('12.5c：编队法 / HQ 法付 SP，单单位法付 T；到期点不同（12.5d）', () => {
    const formation = computeFuelCost({ method: 'formation', commonSource: true })
    expect(formation).toMatchObject({
      ok: true,
      sp: FUEL_FORMATION_SP,
      duration: 'untilNextFriendlyCleanUp',
    })

    const hq = computeFuelCost({ method: 'hq' })
    expect(hq).toMatchObject({ ok: true, sp: FUEL_HQ_SP, duration: 'untilNextFriendlyCleanUp' })

    const single = computeFuelCost({ method: 'singleUnit', unitsNeedingFuel: 3 })
    expect(single).toMatchObject({
      ok: true,
      t: FUEL_SINGLE_UNIT_T * 3,
      duration: 'currentPhaseOnly',
    })
  })

  it('12.5c-A：编队内单位未共用同一来源 ⇒ 编队法非法，须改走单单位法', () => {
    const bad = computeFuelCost({ method: 'formation', commonSource: false })
    expect(bad).toMatchObject({ ok: false, rule: '12.5c-A' })
    const none = computeFuelCost({ method: 'singleUnit', unitsNeedingFuel: 0 })
    expect(none).toMatchObject({ ok: false, rule: '12.5c-C' })
  })
})

describe('Ⓓ 12.8：断补判定与损耗（12.8b/c）', () => {
  it('12.8b：取列＝断补单位中最高 AR；格中断补军力 ≥5 时 +3 掷骰修正', () => {
    expect(
      attritionStackAr([
        { id: 'a', ar: 2, mode: 'combat' },
        { id: 'b', ar: 4, mode: 'combat' },
      ]),
    ).toBe(4)

    const low = resolveAttrition({ die: 7, bestAr: 3, oosSteps: 4 })
    const high = resolveAttrition({ die: 7, bestAr: 3, oosSteps: 5 })
    expect(low.drm).toBe(0)
    expect(high.drm).toBe(3)
    expect(high.modifiedDice).toBe(low.modifiedDice + 3)
    expect(high.rule).toBe('12.8b')
  })

  it('12.8c：DG 不修正 AR；战略模式 AR 按 0 计', () => {
    expect(attritionArOf({ ar: 4, mode: 'combat' })).toBe(4)
    expect(attritionArOf({ ar: 4, mode: 'strat' })).toBe(0)
    // DG 不是 mode（是被动标记），故 ar 照给 ⇒ 不受 DG 影响
    expect(attritionArOf({ ar: 4, mode: 'move' })).toBe(4)
  })

  it('12.8b：骰值越界即抛错（不给静默默认值）', () => {
    expect(() => resolveAttrition({ die: 1, bestAr: 2, oosSteps: 0 })).toThrow(RangeError)
    expect(() => resolveAttrition({ die: 13, bestAr: 2, oosSteps: 0 })).toThrow(RangeError)
  })
})

describe('Ⓓ 12.10e：部队储备恢复成本（Low / Exhausted）', () => {
  it('12.10e：低档按单位/RE 计价；耗尽是低档的两倍', () => {
    const single = internalStocksReplenishCost({ level: 'low', reSize: 1, multiStep: false })
    const singleExhausted = internalStocksReplenishCost({
      level: 'exhausted',
      reSize: 1,
      multiStep: false,
    })
    expect(single.ok).toBe(true)
    expect(singleExhausted.ok).toBe(true)
    if (!single.ok || !singleExhausted.ok) return
    expect(singleExhausted.t).toBe(single.t * 2)
    expect(single.rule).toBe('12.10e')

    // 多军力单位按 RE 计 ⇒ 成本随 RE 增长
    const multi = internalStocksReplenishCost({ level: 'low', reSize: 3, multiStep: true })
    expect(multi.ok).toBe(true)
    if (!multi.ok) return
    expect(multi.t).toBeGreaterThanOrEqual(single.t)

    // RE 非正数即拒绝
    expect(internalStocksReplenishCost({ level: 'low', reSize: 0, multiStep: true })).toMatchObject(
      {
        ok: false,
        rule: '12.10e',
      },
    )
  })
})
