import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { boundarySideOf, PANZER_GROUP_OPTION_ITEM } from '@/engine/rules'
import { createMemoryStorage } from '@/shared'
import { useGameSessionStore, useSetupStore, useWorkbenchStore } from '@/stores'
import { confirmSetupForStart } from '../flows/setup-harness'

/**
 * 3.4b（用户 2026-11-11 裁定）：
 *   ① 自由摆放**摆一个确认一个**——德军 SP 落地即须常驻 Guderian / Hoth 二选一，未选不算摆完；
 *   ② 已预摆、尚未指定的德军 SP 在「初设完成」前可统一补指定（地图高亮、点它即可）；
 *   ③ 一键自动初设按 3.4a 分界线自动归属；
 *   ④ 点「初设完成」后不再有初设内的归属补指定入口；
 *   ⑤ 未勾 3.4b 或已过解除日：整条不出现（无 UI、不写账本）；
 *   ⑥ 同格只有一个集群也不自动继承。
 */
function boot(scenario = '1') {
  setActivePinia(createPinia())
  const setup = useSetupStore(),
    board = useWorkbenchStore(),
    game = useGameSessionStore()
  game.setSaveStorage(createMemoryStorage())
  const option = game.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM)
  game.setAgreedCheck(option, true)
  expect(setup.selectScenario(scenario)).toBe(true)
  // 换剧本会重置共识勾选（4.0）⇒ 选定后补回，供本用例观察 3.4b 生效态
  game.setAgreedCheck(option, true)
  return { setup, board, game }
}

/** 走完初设并开局（到达投放要求已离开初设阶段） */
function startedGame(scenario = '1') {
  const stores = boot(scenario)
  for (const dump of stores.setup.spDumpsOf('axis')) stores.setup.setSpAssignment(dump.id, 'hoth')
  expect(stores.setup.confirmSpOwnership()).toBe(true)
  confirmSetupForStart(stores.setup)
  expect(stores.setup.startGameNow()).toBe(true)
  return stores
}

function axisSpFreeEntry(setup: ReturnType<typeof useSetupStore>) {
  const entry = setup.selfChoiceEntries.find((item) => item.kind === 'sp' && item.side === 'axis')
  if (entry === undefined) throw new Error('所测剧本没有德军 SP 自由项，用例前提失效')
  return entry
}

describe('3.4b：自由摆放德军 SP —— 摆一个确认一个', () => {
  it('点格只暂存；未选集群不落账、不进进度、不能收束初设', () => {
    const { setup } = boot('3')
    setup.resetInputs()
    const entry = axisSpFreeEntry(setup)
    expect(setup.panzerGroupRulesOn()).toBe(true)
    expect(setup.beginSelfPlacement(entry.index)).toBe(true)
    const hex = setup.candidatesOf(entry.index)[0]!
    const dumpsBefore = setup.spDumps.length

    expect(setup.placeAtHex(hex)).toBe(true)
    expect(setup.pendingSpChoice).not.toBeNull()
    expect(setup.pendingSpChoice?.source).toBe('placement')
    expect(setup.spDumps).toHaveLength(dumpsBefore)
    expect(setup.placing?.placed ?? 0).toBe(0)

    // 未选集群时再点地图不算摆完
    expect(setup.placeAtHex(hex)).toBe(true)
    expect(setup.spDumps).toHaveLength(dumpsBefore)
    // 收束初设被这条暂存挡住
    expect(setup.finishSetup()).toBe(false)
    expect(setup.lastAction?.detail ?? '').toContain('尚未选装甲集群')

    expect(setup.choosePendingSpGroup('guderian')).toBe(true)
    expect(setup.pendingSpChoice).toBeNull()
    const dump = setup.spDumps.find((item) => item.side === 'axis')
    expect(dump).toBeDefined()
    expect(setup.spAssignments[dump!.id]).toBe('guderian')
  })

  it('取消摆放放弃未选集群的暂存（未选不算摆完）', () => {
    const { setup } = boot('3')
    setup.resetInputs()
    const entry = axisSpFreeEntry(setup)
    setup.beginSelfPlacement(entry.index)
    setup.placeAtHex(setup.candidatesOf(entry.index)[0]!)
    expect(setup.pendingSpChoice).not.toBeNull()
    setup.cancelPlacement()
    expect(setup.pendingSpChoice).toBeNull()
    expect(setup.spDumps).toHaveLength(0)
  })
})

describe('3.4b：已预摆未指定的德军 SP（地图高亮 + 点选）', () => {
  it('高亮待指定格；点格选中并二选一后写归属', () => {
    const { setup, board } = boot()
    setup.resetInputs()
    setup.spDumps = [{ id: 'sp:2.10', side: 'axis', hex: { col: 2, row: 10 }, points: 2 }]
    expect(setup.pendingSpOwnershipHexes).toEqual([{ col: 2, row: 10 }])
    expect(setup.pickPendingOwnershipHex({ col: 2, row: 10 })).toBe(true)
    expect(setup.pendingSpChoice?.source).toBe('ownership')
    expect(setup.choosePendingSpGroup('hoth')).toBe(true)
    expect(setup.spAssignments['sp:2.10']).toBe('hoth')
    expect(board.panzerGroupOfDump('sp:2.10')).toBe('hoth')
    expect(setup.pendingSpOwnershipHexes).toHaveLength(0)
  })

  it('19.xx 以西的德军 SP 仍必须指定集群（以西豁免只作用于越线判据，不作用于 3.4b 归属）', () => {
    const { setup, board } = boot()
    setup.resetInputs()
    const boundary = board.panzerGroupBoundaryWithPath
    expect(boundary).not.toBeNull()
    const hex = { col: boundary!.west.col - 5, row: 10 }
    const id = `sp:${hex.col}.${hex.row}`
    setup.spDumps = [{ id, side: 'axis', hex, points: 2 }]

    expect(hex.col).toBeLessThan(boundary!.west.col)
    expect(setup.panzerGroupRulesOn()).toBe(true)
    // 以西不豁免归属：仍进待指定清单、账本无归属、不能收束
    expect(setup.pendingSpOwnershipHexes).toEqual([hex])
    expect(board.panzerGroupOfDump(id)).toBeNull()
    expect(setup.confirmSpOwnership()).toBe(false)
    expect(setup.lastAction?.detail ?? '').toContain('spOwnershipMissing')

    // 玩家点了才写账本（确认归属时才落 workbench 账）
    setup.setSpAssignment(id, 'hoth')
    expect(setup.confirmSpOwnership()).toBe(true)
    expect(board.panzerGroupOfDump(id)).toBe('hoth')
    expect(setup.pendingSpOwnershipHexes).toHaveLength(0)
  })

  it('初设收束后：无入口、不可补指定', () => {
    const { setup, game } = boot()
    for (const dump of setup.spDumpsOf('axis')) setup.setSpAssignment(dump.id, 'hoth')
    expect(setup.confirmSpOwnership()).toBe(true)
    confirmSetupForStart(setup)
    expect(setup.startGameNow()).toBe(true)
    expect(setup.finished).toBe(true)
    expect(setup.spOwnershipEntryVisible).toBe(false)
    expect(setup.pendingSpOwnershipHexes).toHaveLength(0)
    const before = { ...setup.spAssignments }
    setup.setSpAssignment(setup.spDumpsOf('axis')[0]!.id, 'guderian')
    expect(setup.spAssignments).toEqual(before)
    expect(setup.choosePendingSpGroup('guderian')).toBe(false)
    expect(game.session).not.toBeNull()
  })
})

describe('3.4a/3.4b：一键自动初设的归属边界', () => {
  it('分界线能定一侧的格自动归属；线上与 19.xx 以西留给玩家二选一', () => {
    const { setup, board } = boot()
    const boundary = board.panzerGroupBoundaryWithPath
    expect(boundary).not.toBeNull()
    const dumps = setup.spDumpsOf('axis')
    expect(dumps.length).toBeGreaterThan(0)
    let autoAssigned = 0
    for (const dump of dumps) {
      const side = boundarySideOf(dump.hex, boundary!)
      // 3.4a：线上两侧都合规、19.xx 以西不受约束 ⇒ 分界线给不出唯一归属
      if (side === 'onLine' || dump.hex.col < boundary!.west.col) {
        expect(setup.spAssignments[dump.id]).toBeUndefined()
        continue
      }
      const expected = side === 'north' ? 'hoth' : 'guderian'
      expect(setup.spAssignments[dump.id]).toBe(expected)
      expect(board.panzerGroupOfDump(dump.id)).toBe(expected)
      autoAssigned += 1
    }
    expect(setup.pendingSpOwnershipHexes).toHaveLength(dumps.length - autoAssigned)
  })
})

describe('3.4b：未勾选 / 已过解除日 ⇒ 整条不出现', () => {
  it('未勾选：自由摆放直接落账、无二选一、无高亮、不写归属账本', () => {
    const { setup, game } = boot('3')
    game.setAgreedCheck(game.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM), false)
    expect(setup.selectScenario('3')).toBe(true)
    setup.resetInputs()
    expect(setup.panzerGroupRulesOn()).toBe(false)
    expect(setup.spOwnershipEntryVisible).toBe(false)

    const entry = axisSpFreeEntry(setup)
    expect(setup.beginSelfPlacement(entry.index)).toBe(true)
    expect(setup.placeAtHex(setup.candidatesOf(entry.index)[0]!)).toBe(true)
    expect(setup.pendingSpChoice).toBeNull()
    expect(setup.spDumps.length).toBeGreaterThan(0)
    expect(setup.spAssignments).toEqual({})
    expect(setup.pendingSpOwnershipHexes).toHaveLength(0)
  })

  it('已过 19 Aug：无入口、不写归属账本', () => {
    const { setup, board } = boot()
    expect(setup.selectScenario('7')).toBe(true)
    expect(setup.panzerGroupRulesOn()).toBe(false)
    expect(setup.spOwnershipEntryVisible).toBe(false)
    expect(setup.pendingSpOwnershipHexes).toHaveLength(0)
    const dump = setup.spDumpsOf('axis')[0]!
    expect(setup.pickPendingOwnershipHex(dump.hex)).toBe(false)
    expect(setup.choosePendingSpGroup('hoth')).toBe(false)
    expect(board.spDumpPanzerGroups).toEqual({})
  })
})

describe('3.4b：随运输队入场的 SP（13.6c）', () => {
  it('非编队运输点带来的 SP：未选集群拒绝投放；选定后按选定归属落账', () => {
    const { board } = startedGame()
    board.setActiveSide('axis')
    board.setTurn(2)
    board.setPhase('reinforcement')
    const plan = board.arrivalPlan
    expect(plan).not.toBeNull()
    const index = plan!.units.findIndex(
      (unit) => unit.loadedWithSp && unit.kind === 'transportPoint',
    )
    expect(index).toBeGreaterThanOrEqual(0)
    const before = new Set(board.units.map((unit) => unit.instanceId))

    expect(board.placeArrivalNow(index)).toBe(false)
    expect(board.reinforcementError?.reason).toBe('arrivalSpGroupRequired')
    expect(board.units.every((unit) => before.has(unit.instanceId))).toBe(true)

    board.setTransportSpGroupDraftNow('guderian')
    expect(board.placeArrivalNow(index)).toBe(true)
    const arrived = board.units.find((unit) => !before.has(unit.instanceId) && unit.loadedSpT > 0)
    expect(arrived).toBeDefined()
    expect(board.panzerGroupOfDump(`unit:${arrived!.instanceId}`)).toBe('guderian')
    expect(board.transportSpGroupDraft).toBeNull()
  })
})
