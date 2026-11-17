import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useHotseatStore, useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * B 段顶栏提示与「结束本段」按钮的一致性（2026-11-17 实走）
 *
 * 实走：进入第二段后 1.6b 已掷（手牌里有 SP），而 1.6c 还未掷时，
 * 面板里「结束本段」整块**不出现**（`rollPlacementOpen === false`），
 * 但顶栏阻断文案却写「或在『结束本段』确认放弃上场」——指着不存在的按钮。
 * 正确口径：判定阶段没走完时，阻断原因应指向**缺的那次掷骰**。
 */
describe('B 段推进提示：1.6c 未掷前不得指向「结束本段」', () => {
  it('★ 1.6b 已掷 / 手牌非空 / 1.6c 未掷 ⇒ 阻断原因指向 1.6c', () => {
    setActivePinia(createPinia())
    useSetupStore().finished = true
    const w = useWorkbenchStore()
    w.setActiveSide('axis')
    useHotseatStore().setViewerSide('axis')
    w.setPhase('reinforcement')

    const index = w.playerSegmentSteps.findIndex((step) => step.id === 'reinforcement.replRoll')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(w.setSegmentStepIndex(index)).toBe(true)

    expect(w.variableReplRolled).toBe(false)
    expect(w.rollVariableReplNow()).toBe(true)
    expect(w.variableReplRolled).toBe(true)
    // 手牌至少会有补给表 SP；极端表值下没有就补一条 Pax 待放（只为触发闸门）
    if (!w.rollHandPending) w.replPending = { ...w.replPending, pax: 1 }
    expect(w.rollHandPending).toBe(true)

    expect(w.specialReplDue).toBe(true)
    const block = w.currentAdvanceBlock
    expect(block?.reason ?? '').toContain('1.6c')
    expect(block?.reason ?? '').not.toContain('结束本段')
  })
})
