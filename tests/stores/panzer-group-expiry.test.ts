import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { PANZER_GROUP_OPTION_ITEM } from '@/engine/rules'
import { useGameSessionStore, useWorkbenchStore } from '@/stores'

import { CORE_HEX, groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 3.4 / 3.4a / 3.4b 的时限：**1941-08-19 当天起失效**（18 Aug 仍生效）
 *
 * 原文：3.4 首段「This rule only applies before 19 August…」；增援表行 90 在「19 Aug 41」栏
 *   「No more Guderian & Hoth (3.4).」两处一致，故 19 Aug 起：
 *   - 3.4a 不再产生越线义务；
 *   - 3.4b（即使勾选）不再要求 SP 归属、不再按集群限制付款；
 *   - 已有的归属标记保留，不回写历史。
 */

function newStore(): Workbench {
  setActivePinia(createPinia())
  const store = useWorkbenchStore()
  const session = useGameSessionStore()
  const index = session.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM)
  if (index < 0) throw new Error('开场共识清单里没有 3.4b 这一条')
  session.setAgreedCheck(index, true)
  return store
}

function guderianUnit(store: Workbench) {
  const record = groundRecord('axis', (item) => item.panzerGroup === 'guderian')
  return placeGround(store, record, CORE_HEX, 'axis', 'gud')
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('3.4 族规则：19 Aug 边界', () => {
  it('约束期（1941-08-15）：3.4b 仍在 ⇒ 错集群付款被拒，新 SP 进待归属', () => {
    const store = newStore()
    store.setTurn(12)
    expect(store.date).toBe('1941-08-15')
    expect(store.panzerGroupRulesOn).toBe(true)

    store.spDumps.push({ id: 'sd-hoth', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 0 })
    store.setDumpPanzerGroupNow('sd-hoth', 'hoth')
    const unit = guderianUnit(store)
    expect(
      store.panzerGroupSpGate({
        dumpId: 'sd-hoth',
        purpose: 'combat',
        beneficiaryUnitIds: [unit.instanceId],
      }),
    ).toMatchObject({ rule: '3.4b' })

    // 3.4b：新到的德军 SP 不选归属 ⇒ 拒；选了 ⇒ 当场归属，不进待办
    store.spDumpDraft = { hexText: `${CORE_HEX.col + 1}.${CORE_HEX.row}`, sp: 2, t: 0 }
    expect(store.addSpDump()).toBe(false)
    store.setSpDumpDraftGroup('guderian')
    expect(store.addSpDump()).toBe(true)
    expect(store.pendingSpGroupAssignment).toEqual([])
  })

  it('失效日（1941-08-19）：3.4b 关闭 ⇒ 不要求归属、错集群付款放行，历史归属保留', () => {
    const store = newStore()
    store.setTurn(12)
    store.spDumps.push({ id: 'sd-hoth', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 0 })
    store.setDumpPanzerGroupNow('sd-hoth', 'hoth')
    const unit = guderianUnit(store)
    expect(
      store.panzerGroupSpGate({
        dumpId: 'sd-hoth',
        purpose: 'combat',
        beneficiaryUnitIds: [unit.instanceId],
      }),
    ).toMatchObject({ rule: '3.4b' })

    store.setTurn(13)
    expect(store.date).toBe('1941-08-19')
    expect(store.panzerGroupRulesOn).toBe(false)
    // 历史归属不被反向改写
    expect(store.spDumpPanzerGroups['sd-hoth']).toBe('hoth')
    // 付款不再受集群限制
    expect(
      store.panzerGroupSpGate({
        dumpId: 'sd-hoth',
        purpose: 'combat',
        beneficiaryUnitIds: [unit.instanceId],
      }),
    ).toBeNull()

    // 新落的 SP 不再进待归属（界面条件 `panzerGroupRulesOn` 也为假）
    store.spDumpDraft = { hexText: `${CORE_HEX.col + 1}.${CORE_HEX.row}`, sp: 2, t: 0 }
    expect(store.addSpDump()).toBe(true)
    expect(store.pendingSpGroupAssignment).toEqual([])
    expect(store.panzerGroupUnassignedDumps).toEqual([])
  })
})
