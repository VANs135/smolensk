import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  allocateBattleLosses,
  validateBattleLossAllocation,
  type BattleUnitView,
} from '@/engine/rules'

/**
 * 批 F 切片 2（B49 清单前两项）
 *
 * ## ① 9.11a 损失分配自由（§17.94 登记的**过度约束**）
 *
 * 原文：「**在 9.11c 的限制范围内**，由**拥有者玩家**决定由哪个或哪些单位承受军力损失。」（9.11a）
 *       「AR 单位必须承受己方第一点；在有多点损失时，**所有单位必须先各承受一点**，
 *         然后才能有单位承受第二点。」（9.11c）
 * 修前 `validateBattleLossAllocation` 要求玩家提交的分配与**规范分配逐单位一致** ⇒
 * 「同样是未受损单位之间选谁承受」会被误判违规（报 9.11c）——与 9.11a 的授权冲突。
 *
 * ## ② 专规 3.2 轴方不得整编（`axis_special.no_consolidation`）
 *
 * `consolidateUnitsNow` / `consolidateAircraftNow` 修前**不看阵营** ⇒ 轴方也能合并。
 *
 * ## 测法边界（如实交代）
 *   · 引擎侧用**合成单位**（只给 9.11 需要的字段），断言到条文号一级；
 *   · 专规 3.2 的**行为**用例在 store 层（`tests/stores/consolidation-axis-ban.test.ts`），
 *     本文件只钉引擎侧的分配判据与源码守卫（"两处都看阵营"）；
 *   · **不覆盖**「轰炸与撤退造成的损失可自由指定」（9.11c 末段）：那两条走的是别的函数
 *     （轰炸 `resolveOptionChoice` / 撤退 `takeCombatLoss`），本轮未动。
 */

function unit(id: string, steps: number): BattleUnitView {
  return {
    id,
    hex: { col: 36, row: 13 },
    side: 'axis',
    attackerType: 'other',
    attack: 5,
    ar: 2,
    dg: false,
    mode: 'combat',
    printedSteps: steps,
    steps,
    re: 1,
    internalStocks: null,
    outOfSupply: false,
    mobility: 'leg',
    attackCapable: true,
    isCombat: true,
  }
}

describe('批 F 切片 2①：9.11a 的分配自由（9.11c 的两条约束之内）', () => {
  it('★ 4 点损失落在三个未受损单位上：改派"多受的那一点"**合法**（修前被判违规）', () => {
    const units = [unit('a1', 3), unit('b1', 3), unit('c1', 3)]
    /*
     * 3 枚单位、**4 点**损失：AR 单位 a1 先受第一点，其余按"每人先各受一点"铺开
     * ⇒ 规范分配形状 **{2,1,1}**（谁受那"第二点"由拥有者定）。
     * （3 点损失时是 {1,1,1} —— 人人都只受一点，没有可改派的余地。）
     */
    const canonical = allocateBattleLosses({ required: 4, units, arUnitId: 'a1' })
    expect(canonical.allocation.map((item) => `${item.unitId}:${item.steps}`)).toEqual([
      'a1:2',
      'b1:1',
      'c1:1',
    ])

    // 拥有者改派：把"多受的那一点"从 a1 换给 c1（总量与形状都不变，仍是 {2,1,1}，且 AR 仍 ≥1）
    const swapped = validateBattleLossAllocation({
      required: 4,
      units,
      arUnitId: 'a1',
      allocation: [
        { unitId: 'a1', steps: 1 },
        { unitId: 'c1', steps: 2 },
        { unitId: 'b1', steps: 1 },
      ],
    })
    expect(swapped.ok).toBe(true)
    if (swapped.ok) {
      // 返回的是**玩家给的**分配（9.11a 的授权所在），不是规范分配
      expect(swapped.data.allocation.map((item) => `${item.unitId}:${item.steps}`).sort()).toEqual([
        'a1:1',
        'b1:1',
        'c1:2',
      ])
    }
  })

  it('★ 违反 9.11c 的"均匀展开"（形状不符）⇒ 拒并给 9.11c', () => {
    const units = [unit('a1', 3), unit('b1', 3), unit('c1', 3)]
    // 规范是 {2,1}；这里给 {3} ⇒ 有人受第二点之前 c1 一点没受 ⇒ 违规
    const bad = validateBattleLossAllocation({
      required: 3,
      units,
      arUnitId: 'a1',
      allocation: [{ unitId: 'a1', steps: 3 }],
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.rule).toBe('9.11c')
  })

  it('★ 违反"AR 单位必须受第一点" ⇒ 拒并给 9.11c', () => {
    const units = [unit('a1', 3), unit('b1', 3), unit('c1', 3)]
    const bad = validateBattleLossAllocation({
      required: 3,
      units,
      arUnitId: 'a1',
      allocation: [
        { unitId: 'b1', steps: 2 },
        { unitId: 'c1', steps: 1 },
      ],
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.rule).toBe('9.11c')
  })

  it('★ 总量不符 / 超过某单位可用军力 ⇒ 各自按 9.11c / 9.11 拒', () => {
    const units = [unit('a1', 3), unit('b1', 1)]
    const short = validateBattleLossAllocation({
      required: 2,
      units,
      arUnitId: 'a1',
      allocation: [{ unitId: 'a1', steps: 1 }],
    })
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.rule).toBe('9.11c')

    const over = validateBattleLossAllocation({
      required: 2,
      units,
      arUnitId: 'a1',
      allocation: [
        { unitId: 'a1', steps: 1 },
        { unitId: 'b1', steps: 2 },
      ],
    })
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.rule).toBe('9.11')
  })
})

describe('批 F 切片 2②：专规 3.2 轴方不得整编（源码守卫）', () => {
  it('★ 地面与飞机两处合并共用一处阵营判据（两处各写一遍会在改口径时漂移）', () => {
    const store = readFileSync('src/stores/workbench.ts', 'utf8')
    // 判据实现只有一处：禁条原话 + 规则号都在那一个函数里
    const helper = store.slice(store.indexOf('function axisConsolidationRefused'))
    expect(helper.slice(0, 700)).toContain('轴心国不得整编')
    expect(helper.slice(0, 700)).toContain('专规 3.2')
    // 13.9-1（地面）与 13.9-4（飞机）两处都调用它
    const ground = store.slice(store.indexOf('function consolidateUnitsNow'))
    expect(ground.slice(0, 1200)).toContain('axisConsolidationRefused')
    const air = store.slice(store.indexOf('function consolidateAircraftNow'))
    expect(air.slice(0, 900)).toContain('axisConsolidationRefused')
  })
})
