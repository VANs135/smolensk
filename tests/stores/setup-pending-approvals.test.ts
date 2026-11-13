import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers, scenarios } from '@/data'
import type { HexRef } from '@/data'
import { hexesWithin } from '@/engine/hex-geometry'
import {
  STACKING_LIMIT_RE,
  findUnitRecord,
  resolveModeStats,
  scenarioTurnRange,
} from '@/engine/rules'
import {
  availableMaOf,
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * ⑭/⑮/⑯ 的行为用例（沿用 3.3d 的做法：先写期望，再按原文接线）
 *
 * | 编号 | 条款 | 期望 | 现状 |
 * | --- | --- | --- | --- |
 * | ⑭ | IV-F / IV-I | 初设放置拒绝超堆叠、拒绝不可进入格 | **均已接线**：IV-F 注入 `existingRe`（4.8）；IV-I 逐棋子按**移动面**机动类型（3.1a）判地形禁止（6.2d），见 `factsFor.canEnter` |
 * | ⑮ | IV-J | 初设新建单位一律未加注燃料 | **已覆盖**：`toConsoleUnit` 默认 `fuelled: false`（12.5a，2026-09-16 用户裁定）⇒ 本文件用活动用例锁住该行为，不再作为待批项 |
 * | ⑯ | 剧本 1 首回合 | 苏方地面单位以 1/2 MA 移动 | **已接线并锁定**：`sovietFirstTurnMaFactor` 注入 `moveContext`，`availableMa` 按 `availableMa × scenarioMaFactor` 折算（6.1h 不取整）；本文件用活动用例锁住该行为 |
 *
 * ⑭/⑮/⑯ 均已接线，不再有待批项。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return {
    setup: useSetupStore(),
    workbench: useWorkbenchStore(),
    session: useGameSessionStore(),
  }
}

/** 地图上首个沼泽格（TEC：track/truck 为 P，leg 可进） */
const SWAMP_HEX: HexRef | null = (() => {
  const found = mapLayers.hexes.find((hex) => /swamp/i.test(hex.terrain))
  return found === undefined ? null : { col: found.col, row: found.row }
})()

/** 该条目里存在**移动面为 truck/tracked**的棋子（沼泽对这两类是 P，leg 可进） */
function hasWheeledOrTrackedPiece(entry: {
  pieces: readonly { unitId: string | null; unitIdKind: string | null }[]
}): boolean {
  for (const piece of entry.pieces) {
    if (piece.unitId === null || piece.unitIdKind === 'aircraft') continue
    const record = findUnitRecord(piece.unitId)
    if (record === undefined) continue
    const cls = record.mobilityByFace?.move ?? record.classes?.movementClass
    if (cls === 'truck' || cls === 'tracked') return true
  }
  return false
}

/** 一条"移动面为轮式/履带"的自由项，且某沼泽格在其 `w/i X` 范围（含边界）内 */
function wheeledEntryCoveringSwamp(
  setup: ReturnType<typeof newStores>['setup'],
): { index: number; hex: HexRef } | null {
  const swamps: HexRef[] = mapLayers.hexes
    .filter((hex) => /swamp/i.test(hex.terrain))
    .map((hex) => ({ col: hex.col, row: hex.row }))
  for (const entry of setup.selfChoiceEntries) {
    if (entry.placement !== 'radius' || entry.radius === null) continue
    if (!hasWheeledOrTrackedPiece(entry)) continue
    for (const anchor of entry.anchors) {
      const within = hexesWithin(anchor, entry.radius, { onMapOnly: true })
      const hit = within.find((hex) =>
        swamps.some((swamp) => swamp.col === hex.col && swamp.row === hex.row),
      )
      if (hit !== undefined) return { index: entry.index, hex: hit }
    }
  }
  return null
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('⑮ IV-J：初设/增援新建单位一律未加注燃料（已覆盖，锁行为）', () => {
  it('新建算子默认 fuelled=false（12.5a）', () => {
    const record = unitChoices('axis')[0]
    if (record === undefined) throw new Error('单位库为空')
    const unit = toConsoleUnit({
      record,
      instanceId: 'iv-j',
      hex: { col: 1, row: 1 },
      side: 'axis',
    })
    expect(unit.fuelled).toBe(false)
  })
})

/** 条目各棋子印值 RE 之和（与引擎 `reOfEntry` 同口径；用于挑选 reSize>0 的用例条目） */
function printedReOf(entry: {
  pieces: readonly { unitId: string | null; unitIdKind: string | null }[]
}): number {
  let total = 0
  for (const piece of entry.pieces) {
    if (piece.unitId === null || piece.unitIdKind === 'aircraft') continue
    total += findUnitRecord(piece.unitId)?.reSize ?? 0
  }
  return total
}

describe('⑭ IV-F：初设不得超堆叠（通规 IV-F + 4.8 的 10 RE）', () => {
  it('目标格已有满堆叠 ⇒ 拒绝放置，规则号 IV-F', () => {
    const { setup, workbench } = newStores()
    setup.selectScenario('1')
    const entry = setup.selfChoiceEntries.find(
      (item) =>
        item.side === 'soviet' &&
        item.kind === 'unit' &&
        item.placement === 'radius' &&
        printedReOf(item) > 0,
    )
    if (entry === undefined) throw new Error('剧本 1 没有 RE>0 的可自由放置苏方单位条目')
    const target = setup.candidatesOf(entry.index)[0]
    if (target === undefined) throw new Error('该条目没有候选格')

    const record = unitChoices('axis')[0]!
    const blocker = toConsoleUnit({ record, instanceId: 'blk', hex: target, side: 'axis' })
    blocker.re = STACKING_LIMIT_RE
    workbench.units.push(blocker)

    expect(setup.placeSelfEntry(entry.index, target)).toBe(false)
    expect(setup.lastAction?.rule).toBe('IV-F')
  })

  it('对照：目标格无既有堆叠 ⇒ 允许放置', () => {
    const { setup } = newStores()
    setup.selectScenario('1')
    const entry = setup.selfChoiceEntries.find(
      (item) =>
        item.side === 'soviet' &&
        item.kind === 'unit' &&
        item.placement === 'radius' &&
        printedReOf(item) > 0,
    )
    if (entry === undefined) throw new Error('剧本 1 没有 RE>0 的可自由放置苏方单位条目')
    const target = setup.candidatesOf(entry.index)[0]
    if (target === undefined) throw new Error('该条目没有候选格')

    expect(setup.placeSelfEntry(entry.index, target)).toBe(true)
  })
})

describe('⑭-IV-I：不可进入格', () => {
  it('IV-I：目标格为沼泽（轮式/履带禁入）⇒ 拒绝放置，规则号 IV-I', () => {
    if (SWAMP_HEX === null) throw new Error('地图上没有沼泽格，无法构成 IV-I 用例')
    const { setup } = newStores()
    setup.selectScenario('1')
    const hit = wheeledEntryCoveringSwamp(setup)
    if (hit === null) throw new Error('没有"移动面轮式/履带"且范围覆盖沼泽格的自由项')

    expect(setup.placeSelfEntry(hit.index, hit.hex)).toBe(false)
    expect(setup.lastAction?.rule).toBe('IV-I')
  })
})

describe('⑯ 取整口径（已裁定：4.1 + 6.1h 保留小数）', () => {
  it('6.1h：1/2 后的 MA 保留小数（MA 5 ⇒ 2.5，不向上/向下取整）', () => {
    const r = resolveModeStats(
      { attack: 1, ar: 1, ma: 5 },
      { mode: 'combat', orientation: 'combat', dg: true, exploit: false },
      'movement',
    )
    expect(r.ma).toBe(2.5)
  })

  it('苏方首回合 1/2 MA 接线（availableMa × scenarioMaFactor）', () => {
    const { session, workbench } = newStores()
    expect(session.setScenarioId('1')).toBe(true)
    const firstTurn = scenarioTurnRange('1').firstTurn
    workbench.turn = firstTurn

    const record = unitChoices('soviet').find(
      (item) => item.classes?.movementClass === 'leg' && item.attackCapable === true,
    )
    if (record === undefined) throw new Error('单位库中没有满足条件的苏军 leg 记录')
    const soviet = toConsoleUnit({
      record,
      instanceId: 'half-ma-1',
      hex: SWAMP_HEX ?? { col: 57, row: 35 },
      side: 'soviet',
      face: 'combat',
    })
    workbench.units.push(soviet)

    // 剧本 1 首回合 ⇒ 系数 0.5，额度按引擎同一口径折算（6.1h 不取整）
    expect(workbench.sovietFirstTurnMaFactor(soviet)).toBe(0.5)
    expect(availableMaOf(soviet, 'movement', workbench.sovietFirstTurnMaFactor(soviet))).toBe(
      soviet.raw.ma * 0.5,
    )

    // 只限首回合：回合前进后恢复 1
    workbench.turn = firstTurn + 1
    expect(workbench.sovietFirstTurnMaFactor(soviet)).toBe(1)
    expect(availableMaOf(soviet, 'movement', workbench.sovietFirstTurnMaFactor(soviet))).toBe(
      soviet.raw.ma,
    )
  })
})

/** 数据存在性（活动用例）：剧本 1 确实写了这条专规，避免"字段没了没人发现" */
describe('⑯ 数据存在性（不涉及取整口径）', () => {
  it('剧本 1 带有苏方首回合 1/2 MA 的原文', () => {
    expect(scenarios.scenarios[0]?.sovietFirstTurnHalfMa).toMatch(/1\/2/)
  })
})
