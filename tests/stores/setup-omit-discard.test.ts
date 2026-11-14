import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useHotseatStore, useSetupStore } from '@/stores'

/**
 * 初设「确认放弃并开局」的可用性口径
 *
 * 两段式（规格 §4.1/§4.2）：本剧本有未执行的 `setup.effects`（ch10 / ch11 编队抽签）时，
 * **确认阶段不要求抽签先完成**——`canFinishSetup` 明确跳过 `draw:*` 义务，抽签由确认后的
 * 唯一按钮执行。因此「放弃以上未布设单位并开局」的禁用判据必须与它同一口径：
 * 只看**非抽签**的必做项，否则玩家会把 37 架飞机摆完才能确认，而抽签又必须确认后才能点。
 */

const read = (file: string): string => readFileSync(file, 'utf8')

const bootScenario5 = () => {
  setActivePinia(createPinia())
  useHotseatStore().setMode('solo')
  const setup = useSetupStore()
  expect(setup.enterSetup('5')).toBe(true)
  return setup
}

/** 13.2h：按真实点图路径把剧本要求的满载名单落账（与 setup-harness 同一步） */
const designateTrucks = (setup: ReturnType<typeof useSetupStore>): void => {
  if (setup.truckLoadSummary.mode !== 'choose_loaded' || setup.truckLoadSummary.done) return
  expect(setup.beginTruckPick()).toBe(true)
  const seen = new Set<string>()
  for (const row of setup.truckPickRows) {
    const key = `${row.hex.col}.${row.hex.row}`
    if (seen.has(key) || row.full) continue
    seen.add(key)
    expect(setup.pickTruckAtHex(row.hex)).toBe(true)
    if (setup.truckLoadSummary.done) break
  }
  expect(setup.truckLoadSummary.done).toBe(true)
  setup.cancelTruckPick()
}

describe('初设：确认放弃并开局（effects 未执行时抽签义务不算门槛）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('剧本 5：双方确认后只剩两组抽签义务 ⇒ 放弃并开局不应被挡', () => {
    const setup = bootScenario5()
    designateTrucks(setup)
    expect(setup.confirmSideSetup(), setup.lastAction?.detail).toBe(true)
    expect(setup.confirmSideSetup(), setup.lastAction?.detail).toBe(true)
    expect(setup.setupSideCursor).toBeNull()

    // 还有 37 架飞机未落位（可自主放弃项），必做事项只剩 ch10 / ch11 两组抽签
    expect(setup.omittablePlacements.length).toBeGreaterThan(0)
    expect(setup.requiredSetupIssues.length).toBeGreaterThan(0)
    expect(setup.requiredSetupIssues.every((issue) => issue.id.startsWith('draw:'))).toBe(true)

    // 与 canFinishSetup 同口径 ⇒ 不作为「放弃并开局」的阻塞
    expect(setup.omitDiscardBlocked).toBe(false)
  })

  it('还有一方未确认 ⇒ 放弃并开局应被挡', () => {
    const setup = bootScenario5()
    designateTrucks(setup)
    expect(setup.confirmSideSetup(), setup.lastAction?.detail).toBe(true)
    expect(setup.setupSideCursor).toBe('soviet')
    expect(setup.omitDiscardBlocked).toBe(true)
  })

  it('组件只读这个投影，不再用「必做事项 > 0」当禁用条件', () => {
    const queue = read('src/components/game/DecisionQueue.vue')
    expect(queue).toContain('setup.omitDiscardBlocked')
    expect(queue).not.toContain('!omitConfirmed || setup.requiredSetupIssues.length > 0')
  })
})
