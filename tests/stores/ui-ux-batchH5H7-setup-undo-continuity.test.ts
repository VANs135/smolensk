import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useMapViewStore, useWorkbenchStore } from '@/stores'
import { fresh } from '../flows/flow-harness'

/**
 * 批 H5 / H7（用户 2026-11-16）
 *
 * H5：初设落位可**一步撤回** —— 算子 / 飞机 / 补给账 / 进度一起还原，撤回后仍停在同一项。
 * H7：连续同类操作**不被打断** —— 结束一次移动后移动会话不收，直接提示点下一支己方堆叠；
 *     初设队列在落完一格后仍开着（既有 B38 口径，补钉子）。
 */

const START: HexRef = { col: 36, row: 13 }

type Workbench = ReturnType<typeof useWorkbenchStore>

function combatRecord() {
  const found = unitChoices('axis').find(
    (record) =>
      record.isCombat === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )
  if (found === undefined) throw new Error('轴心单位库中没有徒步战斗单位')
  return found
}

function beginMove(store: Workbench) {
  store.setActiveSide('axis')
  store.setPhase('movement')
  const unit = toConsoleUnit({ record: combatRecord(), instanceId: 'a1', hex: START, side: 'axis' })
  store.units.push(unit)
  store.clickHex(START)
  expect(store.confirmMovePick()).toBe(true)
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('H5：初设落位一步撤回', () => {
  it('落一枚地面单位后可撤回：算子回到手牌、进度回到落之前，且仍停在同一项', () => {
    const ctx = fresh()
    expect(ctx.setup.enterSetup('1')).toBe(true)
    const entry = ctx.setup.pendingPlacement.find(
      (item) => item.kind === 'self' && !item.raw.includes('SP') && item.candidates.length > 0,
    )
    expect(entry, '剧本 1 应有可直接落位的地面单位项').toBeDefined()
    const hex = entry!.candidates[0]!
    const unitsBefore = ctx.w.units.length
    const pendingBefore = ctx.setup.pendingPlacement.length

    expect(ctx.setup.beginSelfPlacement(entry!.entryIndex)).toBe(true)
    expect(ctx.setup.placeAtHex(hex)).toBe(true)
    expect(ctx.w.units.length).toBeGreaterThan(unitsBefore)
    expect(ctx.setup.lastPlacement).not.toBeNull()

    expect(ctx.setup.undoLastPlacementNow()).toBe(true)
    expect(ctx.setup.lastPlacement).toBeNull()
    expect(ctx.w.units.length).toBe(unitsBefore)
    expect(ctx.setup.pendingPlacement.length).toBe(pendingBefore)
    // 撤回后卡片还开着：可以直接改落另一格（H7 的连续操作）
    expect(ctx.setup.placing).not.toBeNull()
  })

  it('没有落位时撤回入口不出现（不可用不出现）', () => {
    const ctx = fresh()
    expect(ctx.setup.enterSetup('1')).toBe(true)
    expect(ctx.setup.lastPlacement).toBeNull()
    expect(ctx.setup.undoLastPlacementNow()).toBe(false)
    const queue = readFileSync(
      new URL('../../src/components/game/DecisionQueue.vue', import.meta.url),
      'utf8',
    )
    expect(queue).toContain('v-if="setup.canUndoPlacement"')
  })
})

describe('H7：连续同类操作不打断', () => {
  it('结束一次移动后移动会话不收起，提示点下一支；Esc/× 可收掉', () => {
    const workbench = useWorkbenchStore()
    const mapView = useMapViewStore()
    beginMove(workbench)

    workbench.finishMove()
    expect(workbench.moveLinger).toBe(true)
    expect(mapView.session?.kind).toBe('move')
    expect(mapView.session?.title).toContain('点下一支己方堆叠')

    expect(mapView.cancelSession()).toBe(true)
    expect(workbench.moveLinger).toBe(false)
    expect(mapView.session).toBeNull()
  })

  it('移动面板给出"继续下一次"的一行提示，而不是空窗', () => {
    const panel = readFileSync(
      new URL('../../src/components/move/MovePanel.vue', import.meta.url),
      'utf8',
    )
    expect(panel).toContain('点地图上的己方堆叠，继续下一次移动')
  })
})
