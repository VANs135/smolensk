import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { resolveAttrition } from '@/engine/rules'
import { useWorkbenchStore } from '@/stores'

import { CORE_HEX, combatRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 12.8b 损耗骰（断补堆叠逐格）
 *
 * 条文要点：
 *   · 「在补给阶段中，无法获得追溯补给或吃图上补给的友方堆叠会被标记为断补，**并检查损耗**」（12.8a）；
 *   · 「掷两枚骰子，使用标为断补的单位中**行动值最高**单位的行动值，找到对应的一列，并计算格中的
 *     断补单位的**军力数量**」；表注：断补军力 ≥5 时 **+3**；
 *   · 「表格的结果代表该堆叠**必须损失的军力点数总量**。堆叠的拥有者玩家可以选择如何让该堆叠中的
 *     断补单位承受这些损失。**没有**让 AR 最高的单位必须承受损失的要求」；
 *   · 结果可为 `-N Steps` 或 `-All Steps`。
 *
 * ★ 修前：引擎的 `resolveAttrition` / `validateAttritionAllocation` 零消费，计划里**已算出**
 *   `attritionDuty`（按格汇总 + 最高 AR + 断补军力），但**掷骰与损失分配都没接** ⇒ 断补永远不掉血。
 */
/** B8/H④：断补损耗分配在 D 段的**第二环**（补给检定：12.6 判定 → 12.6c/d 处置 → 12.8 损耗）⇒ 调用前先进入该环 */
function goToAttritionStep(store: ReturnType<typeof newStore>): void {
  store.setPhase('supply')
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'supply.check')
  if (index < 0) throw new Error('D 段没有「补给检定」环节')
  if (!store.setSegmentStepIndex(index)) throw new Error('进入断补损耗环节失败')
}

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 摆一个断补的轴方单位并载入计划，返回其格键 */
function oosDuty(store: Workbench, id = 'u1') {
  store.setPhase('supply')
  const unit = placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', id)
  unit.hasTraceSupply = false
  store.planSupplyPhaseNow()
  /*
   * ★ 2026-10-25：12.8b 的掷骰现在过 `ACTION_GATES['supply.attrition']`（只在 D 段的
   *   「补给检定」这一环）⇒ 夹具必须真的站在那一环上（修前 `rollAttritionNow` 不过闸）。
   */
  goToAttritionStep(store)
  return { unit, key: `${CORE_HEX.col}.${CORE_HEX.row}` }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('12.8b：计划给出损耗义务（按格汇总 + 最高 AR + 断补军力）', () => {
  it('断补堆叠进入 attritionDuty；有追溯补给者不进', () => {
    const store = newStore()
    const { key } = oosDuty(store)
    const duty = store.supplyPhasePlan?.attritionDuty.find(
      (item) => `${item.hex.col}.${item.hex.row}` === key,
    )
    expect(duty).toBeDefined()
    expect(duty?.oosSteps).toBe(1)
    expect(duty?.bestAr).toBeGreaterThanOrEqual(0)
  })
})

describe('12.8b：掷骰（2 骰 + 断补军力 ≥5 的 +3）', () => {
  it('掷出的结论与引擎 `resolveAttrition` 同值（唯一实现）', () => {
    const store = newStore()
    const { key } = oosDuty(store)
    const duty = store.supplyPhasePlan!.attritionDuty[0]!
    store.setAttritionDie(key, 8)
    expect(store.rollAttritionNow(key, 8)).toBe(true)
    const rolled = store.attritionResults[key]!
    const engine = resolveAttrition({ die: 8, bestAr: duty.bestAr, oosSteps: duty.oosSteps })
    expect(rolled.modifiedDice).toBe(engine.modifiedDice)
    expect(rolled.drm).toBe(engine.drm)
    expect(rolled.raw).toBe(engine.raw)
    expect(rolled.losses).toEqual(engine.losses)
  })

  it('断补军力 ≥5 ⇒ 命中 +3 修正', () => {
    const store = newStore()
    store.setPhase('supply')
    for (let index = 0; index < 5; index += 1)
      placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', `u${index}`).hasTraceSupply = false
    store.planSupplyPhaseNow()
    goToAttritionStep(store) // 12.8b 只在 D 段的「补给检定」这一环（闸门 supply.attrition）
    const key = `${CORE_HEX.col}.${CORE_HEX.row}`
    const duty = store.supplyPhasePlan!.attritionDuty[0]!
    expect(duty.oosSteps).toBe(5)
    store.setAttritionDie(key, 7)
    store.rollAttritionNow(key, 7)
    expect(store.attritionResults[key]!.drm).toBe(3)
  })

  it('不在计划之列的格 ⇒ 拒', () => {
    const store = newStore()
    store.setPhase('supply')
    placeGround(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1').hasTraceSupply = false
    store.planSupplyPhaseNow()
    expect(store.rollAttritionNow('99.99')).toBe(false)
  })
})

describe('12.8b：分摊落盘（恰好满足义务、不得超过现有军力、归零进死亡堆）', () => {
  /** 找一个**确实产生损失**的骰面（2–12 里必存在；否则本批用例空转） */
  function rollUntilLoss(store: Workbench, key: string): number {
    const duty = store.supplyPhasePlan!.attritionDuty.find(
      (item) => `${item.hex.col}.${item.hex.row}` === key,
    )!
    for (let die = 12; die >= 2; die -= 1) {
      const probe = resolveAttrition({ die, bestAr: duty.bestAr, oosSteps: duty.oosSteps })
      const lossy = probe.losses.kind === 'allSteps' || probe.losses.steps > 0
      if (lossy) {
        store.setAttritionDie(key, die)
        store.rollAttritionNow(key, die)
        return die
      }
    }
    throw new Error('该 duty 在任何骰面下都无损失（夹具异常）')
  }

  it('分摊不足或超出 ⇒ 拒，且账本不动', () => {
    const store = newStore()
    const { unit, key } = oosDuty(store)
    rollUntilLoss(store, key)

    store.setAttritionAllocation(key, unit.instanceId, 0)

    goToAttritionStep(store)

    expect(store.applyAttritionNow(key)).toBe(false)
    expect(unit.steps).toBe(1)

    store.setAttritionAllocation(key, unit.instanceId, 99)

    goToAttritionStep(store)

    expect(store.applyAttritionNow(key)).toBe(false)
    expect(unit.steps).toBe(1)
  })

  it('恰好满足义务 ⇒ 扣军力；归零者进死亡堆（与地面/空军**同一个**死亡堆）', () => {
    const store = newStore()
    const { unit, key } = oosDuty(store)
    rollUntilLoss(store, key)
    const losses = store.attritionResults[key]!.losses
    const required = losses.kind === 'allSteps' ? unit.steps : losses.steps
    expect(required).toBeGreaterThan(0)

    const before = store.units.length + store.deadPile.length
    store.setAttritionAllocation(key, unit.instanceId, required)

    goToAttritionStep(store)

    expect(store.applyAttritionNow(key)).toBe(true)
    expect(unit.steps).toBe(1 - required)
    if (unit.steps <= 0) {
      expect(store.units.some((item) => item.instanceId === unit.instanceId)).toBe(false)
      expect(store.deadPile.some((item) => item.instanceId === unit.instanceId)).toBe(true)
    }
    // 账本闭合：盘面 + 死亡堆守恒（B0④ 的不变量）
    expect(store.units.length + store.deadPile.length).toBe(before)
  })

  it('未掷骰就分摊 ⇒ 拒（先掷后分）', () => {
    const store = newStore()
    const { key } = oosDuty(store)

    goToAttritionStep(store)

    expect(store.applyAttritionNow(key)).toBe(false)
  })

  it('分摊给不在该格断补单位之列的算子 ⇒ 拒（12.8b 只分摊给该格断补单位）', () => {
    const store = newStore()
    const { key } = oosDuty(store)
    rollUntilLoss(store, key)
    store.setAttritionAllocation(key, 'not-in-hex', 1)

    goToAttritionStep(store)

    expect(store.applyAttritionNow(key)).toBe(false)
  })
})
