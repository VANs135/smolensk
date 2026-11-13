import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useHotseatStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 4.5b「垫人」（许诺本阶段不再消耗 MP 以抵消所在格敌方 ZOC）的入口判据
 *
 * 用户 2026-11-14 口径「不可用项不出现」：修前移动面板只要处在移动环节就摆这个按钮，
 * 选中运输点数 / 空军基地时按钮也可点——点下去只得到「不是战斗单位」的警告。
 * 现在按钮只在「选中的是战斗单位、且尚未承诺过」时出现（判据由 store 给）。
 */

const HEX: HexRef = { col: 36, row: 13 }

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setScenarioId('1')
  workbench.setActiveSide('axis')
  useHotseatStore().setViewerSide('axis')
  workbench.setPhase('movement')
  useMapViewStore()
  return workbench
}

beforeEach(() => setActivePinia(createPinia()))

describe('4.5b：垫人入口只在能垫的时候出现', () => {
  it('选中的是非战斗单位（运输点数）⇒ 不提供垫人', () => {
    const workbench = stores()
    const transport = placeGround(
      workbench,
      groundRecord('axis', (record) => record.noncombatKind === 'transport_point'),
      HEX,
      'axis',
      'tp1',
    )
    workbench.selectedId = transport.instanceId
    expect(workbench.canLockZocNegationNow).toBe(false)
  })

  it('选中战斗单位 ⇒ 可垫；承诺之后不再出现（本阶段已锁 MP）', () => {
    const workbench = stores()
    const unit = placeGround(
      workbench,
      groundRecord(
        'axis',
        (record) => record.isCombat === true && record.classes?.movementClass === 'leg',
      ),
      HEX,
      'axis',
      'a1',
    )
    workbench.selectedId = unit.instanceId
    expect(workbench.canLockZocNegationNow).toBe(true)
    workbench.lockZocNegation(unit.instanceId)
    expect(unit.mpLockedThisPhase).toBe(true)
    expect(workbench.canLockZocNegationNow).toBe(false)
  })

  it('源码守卫：移动面板按 store 判据显示，不再用 `:disabled` 摆一个点不动的按钮', () => {
    const panel = readFileSync('src/components/move/MovePanel.vue', 'utf8')
    expect(panel).toContain('workbench.canLockZocNegationNow')
    // 4.5b 那个按钮不再靠 disabled 顶着（不可用直接不渲染）
    expect(panel).not.toContain(':disabled="selected === null"')
  })
})
