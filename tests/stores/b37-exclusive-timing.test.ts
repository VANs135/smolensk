import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { actionGateOf, allowedActionsOf, useWorkbenchStore } from '@/stores'

/**
 * B37 切片 1：**专规动作的闸门与时机**（方案 §3 B37 步骤 1）
 *
 * 病灶：4 条专规无闸门 —— 界面照 `allowedActionsOf` 放行，玩家会在别的段点到"这条现在不该做"的动作。
 * 本轮补三条（原文已核，见 `docs/第二批修改方案.md` §3 B37 与 `rules.json`）：
 *   · **3.3b**：标记的**移除**只在 **H 清理段**（放置不限相位）；
 *   · **1.7 / 21.10**：补给缓存只在**补给段**；
 *   · **3.4a**：分界线义务是**段末**结算 ⇒ `ACTION_GATES` 新增 `at: 'end'` 这一类。
 *
 * ★ 一条**测法边界（如实）**：本文件钉的是**闸门表与查询语义**（含新时机类别"段末"的两态）；
 *   "面板真的把可做的专规置顶、会话入口真的自动出现"属渲染层，由**源码守卫 + 人眼**（下一轮切片）；
 *   引擎自身的同口径判定（`forageOnlyInSupplyPhase` / `removalAllowedNow`）仍由各自引擎用例覆盖 ——
 *   本轮把闸门加在**它们前面**（界面根本不该给出入口），两道都在。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

describe('B37：专规时机的闸门（1.7 Forage / 3.4a 段末）', () => {
  it('★ 两条闸门都在表里，且各带规则号（界面只查表，不比较规则号）', () => {
    expect(actionGateOf('exclusive.forage').rule).toBe('专规 1.7 / 21.10')
    // H④ 契约变更（用户 2026-09-19 口径）：D 段由三环并为两环（恢复部队储备 → 补给检定）
    // ⇒ 1.7/21.10 的 Forage 挂这两环（21.10 的 Forage 只在补给阶段，与段内分环无关）
    expect(actionGateOf('exclusive.forage').where.map((item) => item.segment)).toEqual([
      'supply.recovery',
      'supply.check',
    ])
    const obligation = actionGateOf('exclusive.panzerObligation')
    expect(obligation.rule).toBe('专规 3.4a')
    // 段末类：两条轴方移动环节，且**只在段末**
    expect(obligation.where.every((item) => item.at === 'end')).toBe(true)
    expect(obligation.where.every((item) => item.sides?.includes('axis') === true)).toBe(true)
  })

  it('★ 新增的"段末"类别：段中不放行、段末才放行（其余动作不受影响）', () => {
    const base = { phase: 'movement', segment: 'movement.modeAndMovement', side: 'axis' } as const
    const mid = allowedActionsOf({ ...base, role: 'active', atSegmentEnd: false })
    const end = allowedActionsOf({ ...base, role: 'active', atSegmentEnd: true })
    expect(mid.has('exclusive.panzerObligation')).toBe(false)
    expect(end.has('exclusive.panzerObligation')).toBe(true)
    // 不声明 atSegmentEnd（旧调用方）＝视为段中 ⇒ 不会意外放行段末动作
    expect(allowedActionsOf({ ...base, role: 'active' }).has('exclusive.panzerObligation')).toBe(
      false,
    )
    // 普通移动动作在段末照旧允许（新增类别没影响别的键）
    expect(end.has('move.order')).toBe(true)
    expect(mid.has('move.order')).toBe(true)
  })

  it('★ 1.7：补给缓存只在 D 段（两环都放行；移动段不放行）', () => {
    for (const segment of ['supply.recovery', 'supply.check']) {
      expect(
        allowedActionsOf({ phase: 'supply', segment, role: 'active', side: 'axis' }).has(
          'exclusive.forage',
        ),
      ).toBe(true)
    }
    expect(
      allowedActionsOf({
        phase: 'movement',
        segment: 'movement.modeAndMovement',
        role: 'active',
        side: 'axis',
      }).has('exclusive.forage'),
    ).toBe(false)
  })

  it('★ store 的段末声明与闸门一致：段末时 `panzerObligationActive` 为真、段中为假', () => {
    const store = newStore()
    store.setPhase('movement')
    const steps = store.playerSegmentSteps
    const moveIndex = steps.findIndex((step) => step.id === 'movement.modeAndMovement')
    if (moveIndex < 0) throw new Error('C 段没有移动环节？')

    // 段中（不是最后一步）：段末义务不生效
    store.setSegmentStepIndex(moveIndex)
    const isLast = moveIndex === steps.length - 1
    expect(store.panzerObligationActive).toBe(isLast)

    // 走到本段最后一个环节 ⇒ 段末 ⇒ 生效（若本段只有一个玩家环节，上面那步就已经是段末）
    if (!isLast) {
      store.setSegmentStepIndex(steps.length - 1)
      expect(store.panzerObligationActive).toBe(true)
    }
  })
})
