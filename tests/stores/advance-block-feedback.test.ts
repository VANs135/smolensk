import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { resolveAttrition } from '@/engine/rules'
import { toConsoleUnit, useGameSessionStore, useWorkbenchStore, type ConsoleUnit } from '@/stores'
import { CORE_HEX, combatRecord, label } from '../flows/sop-harness'

/**
 * 死操作①：「进入下一环节」在必须应答的场景（补给检定的损耗分摊等）**可点但无反应**。
 *
 * 病状：`advanceSegmentNow()` 在 `settleSegmentObligations()` 返回 false 时**静默 return null**
 *       —— 既不写日志、也不改按钮态 ⇒ 玩家连点，界面纹丝不动，看起来像程序坏了。
 * 期望：点一次就给**明确指引**（原因 + 规则号进日志，并投影到 `advanceBlock` 供流程条就地显示）；
 *       判据仍来自既有闸门/义务链，组件不新写规则。
 * 本文件按仓库惯例做「先红」：store 侧断言 `advanceBlock` 投影与日志，组件侧做源码守卫。
 */

const STRIP = readFileSync('src/components/session/FlowStrip.vue', 'utf8')

function newStores() {
  setActivePinia(createPinia())
  return { session: useGameSessionStore(), workbench: useWorkbenchStore() }
}

describe('死操作①：推进按钮不得「可点但无反应」', () => {
  it('补给检定：损耗须玩家分摊时，点一次推进即给出原因与日志', () => {
    const { session, workbench } = newStores()
    expect(session.startGame()).toBe(true)

    // 走**真实会话**到 D 段（不手切阶段：手切会与会话步指针不一致而被内核拒绝）
    for (let guard = 0; guard < 20 && session.records?.phase !== 'supply'; guard += 1) {
      workbench.advanceSegmentNow()
    }
    expect(session.records?.phase).toBe('supply')

    // 两枚同格断补战斗单位（各 3 军力）：损耗 1–5 点时必须由玩家分摊（不能自动决定输家）
    const record = combatRecord('axis')
    for (const instanceId of ['oos-1', 'oos-2']) {
      workbench.units.push(toConsoleUnit({ record, instanceId, hex: CORE_HEX, side: 'axis' }))
    }
    for (const instanceId of ['oos-1', 'oos-2']) {
      const unit = workbench.units.find((item) => item.instanceId === instanceId) as ConsoleUnit
      unit.steps = 3
      unit.hasTraceSupply = false
    }

    const checkIndex = workbench.playerSegmentSteps.findIndex((step) => step.id === 'supply.check')
    expect(checkIndex).toBeGreaterThanOrEqual(0)
    expect(workbench.setSegmentStepIndex(checkIndex)).toBe(true)
    expect(workbench.planSupplyPhaseNow()).toBe(true)

    const key = label(CORE_HEX)
    const duty = workbench.supplyPhasePlan?.attritionDuty.find(
      (item) => `${item.hex.col}.${item.hex.row}` === key,
    )
    expect(duty).toBeDefined()
    // 选一个「有损失但不足以全灭堆叠」的骰面 ⇒ 引擎的自动分摊返回 null
    const die = [4, 5, 6, 7, 8].find((face) => {
      const outcome = resolveAttrition({
        die: face,
        bestAr: duty!.bestAr,
        oosSteps: duty!.oosSteps,
      })
      return outcome.losses.kind === 'steps' && outcome.losses.steps > 0 && outcome.losses.steps < 6
    })
    expect(die).toBeGreaterThanOrEqual(2)
    expect(workbench.rollAttritionNow(key, die!)).toBe(true)

    // 修前：这里返回 null 且**无任何提示**（按钮可点、点了没反应）
    expect(workbench.advanceSegmentNow()).toBeNull()

    // 修后：原因投影到流程条，且以 warning + 规则号写进操作台日志
    expect(workbench.advanceBlock?.reason).toContain('损耗')
    expect(workbench.log.some((entry) => entry.rule === '12.8b' && entry.kind === 'warning')).toBe(
      true,
    )
  })

  it('流程条把 advanceBlock 的原因就地显示，且不因「上一次失败」把按钮永久置灰', () => {
    expect(STRIP).toContain('workbench.advanceBlock')
    expect(STRIP).toContain('liveBlock.value ?? workbench.advanceBlock')
    // 上次阻断只用于提示，按钮根据实时阻断判断。
    expect(STRIP).not.toMatch(/:disabled="[^"]*advanceBlock/)
  })
})
