import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { scenarios } from '@/data'
import { collectSetupGaps, setupGapText } from '@/engine/rules/setup-effects'
import { useContainersStore, useSetupStore, useWorkbenchStore } from '@/stores'

import { confirmSetupForStart } from '../flows/setup-harness'

/**
 * G3：初设字段缺失的加载期登记（规格 §3.4）
 *
 * 钉三件事：
 *   ① 只登记真正缺的字段：`modeConstraints` 缺失才登记，数据里写了的（未来）不登记；
 *   ② 加载（选剧本）时进 `notes` 可见一次；
 *   ③ 首局日志在建会话那一次写一次，重复 `startGameNow()` 不再追加。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return {
    setup: useSetupStore(),
    workbench: useWorkbenchStore(),
    containers: useContainersStore(),
  }
}

describe('G3：setupGaps 加载期登记', () => {
  let setup: ReturnType<typeof newStores>['setup']
  let workbench: ReturnType<typeof newStores>['workbench']

  beforeEach(() => {
    const stores = newStores()
    setup = stores.setup
    workbench = stores.workbench
  })

  it('只登记真正缺的字段（当前数据里没有 modeConstraints 的剧本才登记）', () => {
    for (const scenario of scenarios.scenarios) {
      const gaps = collectSetupGaps(scenario.id)
      if (scenario.setup.modeConstraints === undefined) {
        expect(
          gaps.map((gap) => gap.field),
          scenario.id,
        ).toEqual(['modeConstraints'])
        expect(gaps[0]?.action).toBe('skip+default')
      } else {
        expect(gaps, scenario.id).toEqual([])
      }
    }
  })

  it('加载（选剧本）时缺口进 notes，且换剧本后重算', () => {
    setup.selectScenario('1')
    expect(setup.setupGaps.map((gap) => gap.field)).toEqual(['modeConstraints'])
    expect(setup.notes.join('｜')).toContain(setupGapText(setup.setupGaps[0]!))

    setup.selectScenario('3')
    expect(setup.setupGaps.every((gap) => gap.scenarioId === '3')).toBe(true)
    expect(setup.notes.join('｜')).toContain('剧本 3')
  })

  it('首局日志写一次缺口，重复开局不再追加', () => {
    setup.selectScenario('1')
    const gapCount = setup.setupGaps.length
    expect(gapCount).toBeGreaterThan(0)
    confirmSetupForStart(setup)
    const logCount = () => workbench.log.filter((entry) => entry.rule === 'setupGaps').length
    expect(logCount()).toBe(0)

    expect(setup.startGameNow()).toBe(true)
    expect(logCount()).toBe(gapCount)
    expect(setup.startGameNow()).toBe(true)
    expect(logCount()).toBe(gapCount)
  })
})
