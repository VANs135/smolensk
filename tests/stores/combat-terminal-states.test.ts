import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  beginCombat,
  declareCombatAr,
  declareCombatTerrain,
  planCombatSupply,
  planLosses,
  planOptions,
  resolveCombatDice,
  resolveSurprise,
  type BattleFacts,
  type BattleUnitView,
  type CombatInteractionState,
  type CombatUnitPatch,
} from '@/engine/rules'
import {
  defenseTerrainChoices,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'
import { useGameSessionStore } from '@/stores/session'

/**
 * 战斗/突袭结算：**终局组合收束**（用户 2026-11-10 阻断级）
 *
 * 用户报的卡死：突袭里「攻方需撤退」与「守方被全部消灭」同时出现时流程不推进。
 * 本文件按终局组合穷举 7 种 + 连续两场突袭，逐条断言「能收束且日志完整」：
 *   · 关窗：`combatLiveStep === null`
 *   · 落账：`session.log` 里有 `combatRetreat` / `combatAdvance` 结算条目
 *   · 可继续：`combatState.finished === true`
 *
 * 终局状态由真实 CRT 结果推进得到，不手写 `resolution` 结论：
 *   · 2:1 / 修正骰 8（奇袭横移 1 列）＝`Ao1 DL1o1`：攻方 1 点选项、守方 1 点强制损失；
 *   · 1:1 / 骰 5 ＝`AL1o1 Do1`：攻方 1 点强制损失、守方 1 点选项。
 */

const DEFENDER_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    if (defenseTerrainChoices(ref).length === 0) return false
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到「六邻皆图内且可作防御格」的格')
  return { col: found.col, row: found.row }
})()

const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (
      isOnMap(candidate) &&
      mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
    )
      return candidate
  }
  throw new Error('防御格没有图内邻格')
})()

type Store = ReturnType<typeof useWorkbenchStore>
type Record_ = ReturnType<typeof unitChoices>[number]

function place(
  store: Store,
  record: Record_,
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
  steps?: number,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex: { ...hex }, side })
  if (steps !== undefined) unit.steps = steps
  store.units.push(unit)
  return unit
}

function pickRecord(side: 'axis' | 'soviet', predicate: (record: Record_) => boolean): Record_ {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

const combatAxis = () => pickRecord('axis', (record) => record.isCombat === true)
const combatSoviet = () => pickRecord('soviet', (record) => record.isCombat === true)

const applyPatches = (
  units: readonly BattleUnitView[],
  patches: readonly CombatUnitPatch[],
): BattleUnitView[] =>
  units.map((view) => {
    const patch = patches.find((item) => item.unitId === view.id)
    if (patch === undefined) return view
    return {
      ...view,
      ...(patch.steps === undefined ? {} : { steps: patch.steps }),
      ...(patch.hex === undefined ? {} : { hex: patch.hex }),
      ...(patch.dg === true ? { dg: true } : {}),
    }
  })

function unwrap<T>(o: { ok: true; data: T } | { ok: false; rule: string; reason: string }): T {
  if (!o.ok) throw new Error(`预期成功，实得失败：${o.rule} / ${o.reason}`)
  return o.data
}

const view = (over: Partial<BattleUnitView> & { id: string }): BattleUnitView => ({
  side: 'axis',
  hex: ATTACKER_HEX,
  attackerType: 'other',
  attack: 10,
  ar: 4,
  dg: false,
  mode: 'combat',
  printedSteps: 1,
  steps: 1,
  re: 1,
  internalStocks: null,
  outOfSupply: false,
  mobility: 'leg',
  attackCapable: true,
  ...over,
})

const facts = (): BattleFacts => ({
  canEnterForAttack: () => true,
  hedgehogLevelAt: () => 0,
  hexsideTerrainsBetween: () => [],
  hexTerrainsAt: () => ['Open'],
  defenderAtLevelAt: () => 'none',
  attackedThisSegmentBy: () => false,
  attackedThisSegmentAt: () => false,
})

function toDice(opts: {
  attackerSteps: number
  defenderSteps: number
  die: number
  shiftDie?: number
  attackType?: 'regular' | 'overrun'
}): { state: CombatInteractionState; units: BattleUnitView[] } {
  const attackers = [view({ id: 'a1', steps: opts.attackerSteps, printedSteps: 3 })]
  const defenders = [
    view({
      id: 'd1',
      side: 'soviet',
      hex: DEFENDER_HEX,
      ar: 2,
      steps: opts.defenderSteps,
      printedSteps: 3,
    }),
  ]
  const mapFacts = facts()
  const begin = unwrap(
    beginCombat({
      attackers,
      defenders,
      facts: mapFacts,
      attackType: opts.attackType ?? 'regular',
      phase: 'combat',
    }),
  )
  const supplied = unwrap(
    planCombatSupply(begin, {
      attackers,
      defenders,
      attackerAvailableT: 9,
      defenderProvides: true,
      defenderAvailableT: 9,
    }),
  )
  const declared = unwrap(
    declareCombatAr(supplied.state, {
      attackers,
      defenders,
      attackerUnitId: 'a1',
      defenderUnitId: 'd1',
    }),
  )
  const terrain = unwrap(
    declareCombatTerrain(declared.state, { attackers, defenders, facts: mapFacts }),
  )
  const surprise = unwrap(
    resolveSurprise(terrain.state, {
      die: opts.die,
      ...(opts.shiftDie === undefined ? {} : { shiftDie: opts.shiftDie }),
    }),
  )
  const dice = unwrap(resolveCombatDice(surprise.state, { die: opts.die }))
  return { state: dice.state, units: [...attackers, ...defenders] }
}

/** 用真实引擎把状态推到撤退步（可指定双方选项） */
function toRetreatStep(opts: {
  attackerSteps: number
  defenderSteps: number
  die: number
  shiftDie?: number
  attackerRetreat: number
  attackerLoss: number
  defenderRetreat?: number
  defenderLoss?: number
  attackType?: 'regular' | 'overrun'
}): { state: CombatInteractionState; units: BattleUnitView[] } {
  const start = toDice(opts)
  let current = start.units
  const attackerLosses = unwrap(planLosses(start.state, { units: current }))
  current = applyPatches(current, attackerLosses.patches)
  let state = attackerLosses.state
  if (state.resolution.stage === 'attackerOptions') {
    const attackerOptions = unwrap(
      planOptions(state, {
        units: current.filter((item) => item.id === 'a1' && item.steps > 0),
        retreatHexes: opts.attackerRetreat,
        lossPoints: opts.attackerLoss,
      }),
    )
    state = attackerOptions.state
    current = applyPatches(current, attackerOptions.patches)
  }
  const defenderLosses = unwrap(planLosses(state, { units: current }))
  state = defenderLosses.state
  current = applyPatches(current, defenderLosses.patches)
  if (state.resolution.stage === 'defenderOptions') {
    const defenderOptions = unwrap(
      planOptions(state, {
        units: current.filter((item) => item.side === 'soviet' && item.steps > 0),
        retreatHexes: opts.defenderRetreat ?? 0,
        lossPoints: opts.defenderLoss ?? 0,
      }),
    )
    state = defenderOptions.state
    current = applyPatches(current, defenderOptions.patches)
  }
  return { state, units: current }
}

function mount(
  store: Store,
  state: CombatInteractionState,
  opts: { attackerSteps: number; defenderSteps: number },
): void {
  store.units = []
  // 0 = 该单位在终局状态里已被消灭（已进死亡堆、不在盘面）：不得再挂到 store 上，
  // 否则 `combatAttackers` / `combatAdvanceCandidates` 会把死人当成还能动作的对象。
  if (opts.attackerSteps > 0)
    place(store, combatAxis(), ATTACKER_HEX, 'axis', 'a1', opts.attackerSteps)
  if (opts.defenderSteps > 0)
    place(store, combatSoviet(), DEFENDER_HEX, 'soviet', 'd1', opts.defenderSteps)
  store.battleTarget = { hex: { ...DEFENDER_HEX }, defenderIds: ['d1'] }
  store.combatInputs.retreatPaths = {}
  store.combatInputs.advanceUnitIds = []
  store.combatInputs.optionRetreatHexes = 0
  store.combatInputs.optionLossPoints = 0
  store.combatState = state
}

const retreatLogs = (store: Store) => store.log.filter((line) => line.rule === '9.12')

function chooseAllRetreatDestinations(store: Store): void {
  for (const plan of store.combatRetreatPlans) {
    for (const row of plan.units) {
      expect(row.destinations.length).toBeGreaterThan(0)
      expect(store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)).toBe(true)
    }
  }
}

describe('战斗终局组合：7 种都必须收束（9.2 / 9.10a / 9.11 / 9.12 / 9.12g）', () => {
  let store: Store
  let session: ReturnType<typeof useGameSessionStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useWorkbenchStore()
    session = useGameSessionStore()
    store.resetAll(11)
    expect(session.startGame()).toBe(true)
  })

  it('A1 守灭、攻存（攻方把选项吃成损失）⇒ 撤退步空转，推进后收束', () => {
    const { state } = toRetreatStep({
      attackerSteps: 3,
      defenderSteps: 1,
      die: 8,
      shiftDie: 1,
      attackerRetreat: 0,
      attackerLoss: 1,
    })
    expect(state.step).toBe('retreat')
    expect(state.resolution.defender.optionsSkipped).toBe('defenderWipedOut')
    mount(store, state, { attackerSteps: 2, defenderSteps: 0 })
    expect(store.combatRetreatPlans).toHaveLength(0)
    expect(store.confirmCombatRetreats()).toBe(true)
    expect(store.combatLiveStep).toBe('advance')
    expect(store.confirmCombatAdvance()).toBe(true)

    expect(store.combatState!.finished).toBe(true)
    expect(store.combatLiveStep).toBeNull()
    expect(session.log.some((entry) => entry.action === 'combatRetreat')).toBe(true)
    expect(session.log.some((entry) => entry.action === 'combatAdvance')).toBe(true)
    expect(store.log.some((line) => line.rule === '9.12g')).toBe(true)
  })

  it('A2 守灭、攻需撤退（当前卡死组合）⇒ 攻方按自己的选项撤退后收束', () => {
    const { state } = toRetreatStep({
      attackerSteps: 3,
      defenderSteps: 1,
      die: 8,
      shiftDie: 1,
      attackerRetreat: 1,
      attackerLoss: 0,
      attackType: 'overrun',
    })
    expect(state.step).toBe('retreat')
    expect(state.resolution.attacker.option?.retreatHexes).toBe(1)
    expect(state.resolution.defender.optionsSkipped).toBe('defenderWipedOut')
    mount(store, state, { attackerSteps: 3, defenderSteps: 0 })

    expect(store.combatRetreatPlans.map((plan) => plan.side)).toEqual(['attacker'])
    expect(store.combatRetreatPlans[0]!.units.map((row) => row.unitId)).toEqual(['a1'])

    chooseAllRetreatDestinations(store)
    expect(store.confirmCombatRetreats()).toBe(true)

    // 9.12g-B：攻方撤退 ⇒ 不推进；突袭推进步由 store 自动收束
    expect(store.combatState!.finished).toBe(true)
    expect(store.combatLiveStep).toBeNull()
    expect(retreatLogs(store).some((line) => line.text.includes('撤退至'))).toBe(true)
    expect(session.log.some((entry) => entry.action === 'combatRetreat')).toBe(true)
  })

  it('A3 攻灭、守存（攻方强制损失全灭）⇒ 跳过攻方选项，守方结算后收束', () => {
    const { state } = toRetreatStep({
      attackerSteps: 1,
      defenderSteps: 3,
      die: 5,
      attackerRetreat: 0,
      attackerLoss: 0,
      defenderRetreat: 0,
      defenderLoss: 1,
    })
    expect(state.resolution.attacker.optionsSkipped).toBe('attackerWipedOut')
    mount(store, state, { attackerSteps: 0, defenderSteps: 2 })

    expect(store.confirmCombatRetreats()).toBe(true)
    expect(store.combatState!.finished).toBe(true)
    expect(store.combatLiveStep).toBeNull()
    expect(store.log.some((line) => line.rule === '9.12g')).toBe(true)
    expect(session.log.some((entry) => entry.action === 'combatRetreat')).toBe(true)
  })

  it('A4 攻灭、守需撤退 ⇒ 守方单独撤退后收束', () => {
    const { state } = toRetreatStep({
      attackerSteps: 1,
      defenderSteps: 3,
      die: 5,
      attackerRetreat: 0,
      attackerLoss: 0,
      defenderRetreat: 1,
      defenderLoss: 0,
    })
    expect(state.resolution.attacker.optionsSkipped).toBe('attackerWipedOut')
    expect(state.resolution.defender.option?.retreatHexes).toBe(1)
    mount(store, state, { attackerSteps: 0, defenderSteps: 3 })

    expect(store.combatRetreatPlans.map((plan) => plan.side)).toEqual(['defender'])
    chooseAllRetreatDestinations(store)
    expect(store.confirmCombatRetreats()).toBe(true)

    expect(store.combatState!.finished).toBe(true)
    expect(store.combatLiveStep).toBeNull()
    expect(session.log.some((entry) => entry.action === 'combatRetreat')).toBe(true)
  })

  it('A5 双方全灭 ⇒ 无撤退对象、无推进对象，直接收束', () => {
    // 攻方 1 军力把 1 点选项吃成损失 ⇒ 与守方的 DL1 同时全灭
    const { state } = toRetreatStep({
      attackerSteps: 1,
      defenderSteps: 1,
      die: 8,
      shiftDie: 1,
      attackerRetreat: 0,
      attackerLoss: 1,
    })
    expect(state.step).toBe('retreat')
    expect(state.resolution.attacker.option?.retreatHexes).toBe(0)
    mount(store, state, { attackerSteps: 0, defenderSteps: 0 })

    expect(store.combatRetreatPlans).toHaveLength(0)
    expect(store.confirmCombatRetreats()).toBe(true)
    expect(store.combatState!.finished).toBe(true)
    expect(store.combatLiveStep).toBeNull()
    expect(session.log.some((entry) => entry.action === 'combatRetreat')).toBe(true)
  })

  it('A6 双方留存、各自需撤退 ⇒ 先攻后守各自落点，9.12g-B 不推进', () => {
    const { state } = toRetreatStep({
      attackerSteps: 3,
      defenderSteps: 3,
      die: 8,
      shiftDie: 1,
      attackerRetreat: 1,
      attackerLoss: 0,
      defenderRetreat: 1,
      defenderLoss: 0,
    })
    expect(state.step).toBe('retreat')
    mount(store, state, { attackerSteps: 3, defenderSteps: 2 })

    expect(store.combatRetreatPlans.map((plan) => plan.side)).toEqual(['attacker', 'defender'])
    chooseAllRetreatDestinations(store)
    expect(store.confirmCombatRetreats()).toBe(true)

    expect(store.combatState!.step).toBe('advance')
    expect(store.confirmCombatAdvance()).toBe(true)
    expect(store.combatState!.finished).toBe(true)
    expect(store.combatLiveStep).toBeNull()
    expect(session.log.some((entry) => entry.action === 'combatRetreat')).toBe(true)
  })

  it('A7 守灭、攻存且无后续（突袭）⇒ 撤退步一次确认即自动收束', () => {
    const { state } = toRetreatStep({
      attackerSteps: 3,
      defenderSteps: 1,
      die: 8,
      shiftDie: 1,
      attackerRetreat: 0,
      attackerLoss: 1,
      attackType: 'overrun',
    })
    mount(store, state, { attackerSteps: 2, defenderSteps: 0 })

    expect(store.confirmCombatRetreats()).toBe(true)
    expect(store.combatState!.finished).toBe(true)
    expect(store.combatLiveStep).toBeNull()
    expect(store.log.some((line) => line.rule === '9.12g-D')).toBe(true)
    expect(store.units.find((unit) => unit.instanceId === 'a1')?.hex).toEqual(DEFENDER_HEX)
  })

  it('A9 参战集合里残留已进死亡堆的成员 ⇒ 撤退只对存活单位，不报 retreatPathMissing', () => {
    const { state } = toRetreatStep({
      attackerSteps: 3,
      defenderSteps: 1,
      die: 8,
      shiftDie: 1,
      attackerRetreat: 1,
      attackerLoss: 0,
      attackType: 'overrun',
    })
    mount(store, state, { attackerSteps: 3, defenderSteps: 0 })
    // 模拟死亡堆成员仍留在盘面：a2 军力为 0，但仍在 units.value 且挂在参战集合里
    place(store, combatAxis(), ATTACKER_HEX, 'axis', 'a2', 0)
    store.combatState = {
      ...store.combatState!,
      composition: {
        ...store.combatState!.composition,
        attackerIds: [...store.combatState!.composition.attackerIds, 'a2'],
      },
    }

    // 计划行只含存活单位；已死者不进入等待集合
    expect(store.combatRetreatPlans).toHaveLength(1)
    expect(store.combatRetreatPlans[0]!.units.map((row) => row.unitId)).toEqual(['a1'])
    expect(store.combatRetreatSkippedSides).toEqual([])

    chooseAllRetreatDestinations(store)
    expect(store.confirmCombatRetreats()).toBe(true)
    // 旧实现会把 a2 也算进 sideUnits，因缺路径而硬失败 retreatPathMissing ⇒ 卡死
    expect(store.log.some((line) => line.text.includes('retreatPathMissing'))).toBe(false)
    expect(store.combatState!.finished).toBe(true)
    expect(store.combatLiveStep).toBeNull()
    expect(session.log.some((entry) => entry.action === 'combatRetreat')).toBe(true)
  })

  it('A8 连续两场突袭 ⇒ 第二场不带入第一场的参战名单 / 撤退计划', () => {
    const first = toRetreatStep({
      attackerSteps: 3,
      defenderSteps: 1,
      die: 8,
      shiftDie: 1,
      attackerRetreat: 1,
      attackerLoss: 0,
      attackType: 'overrun',
    })
    mount(store, first.state, { attackerSteps: 3, defenderSteps: 0 })
    chooseAllRetreatDestinations(store)
    expect(store.confirmCombatRetreats()).toBe(true)
    expect(store.combatState!.finished).toBe(true)
    const settledAfterFirst = session.log.filter((entry) => entry.action === 'combatRetreat').length

    // 第二场：不同单位、不同攻击格（守方仍是同一防御格）
    const secondHex = HEX_DIRECTIONS.map((direction) => neighbor(DEFENDER_HEX, direction)).find(
      (hex) =>
        isOnMap(hex) &&
        mapLayers.hexes.some((item) => item.col === hex.col && item.row === hex.row) &&
        !(hex.col === ATTACKER_HEX.col && hex.row === ATTACKER_HEX.row),
    )!
    const second = toRetreatStep({
      attackerSteps: 3,
      defenderSteps: 1,
      die: 8,
      shiftDie: 1,
      attackerRetreat: 1,
      attackerLoss: 0,
      attackType: 'overrun',
    })
    store.units = []
    place(store, combatAxis(), secondHex, 'axis', 'a9', 3)
    store.battleTarget = { hex: { ...DEFENDER_HEX }, defenderIds: ['d9'] }
    store.combatInputs.retreatPaths = {}
    store.combatInputs.advanceUnitIds = []
    store.combatState = {
      ...second.state,
      finished: false,
      retreats: [],
      composition: {
        ...second.state.composition,
        attackerIds: ['a9'],
        defenderIds: ['d9'],
        attackerHexes: [{ ...secondHex }],
      },
    }

    const plans = store.combatRetreatPlans
    expect(plans).toHaveLength(1)
    expect(plans[0]!.units.map((row) => row.unitId)).toEqual(['a9'])
    expect(plans[0]!.units.some((row) => row.unitId === 'a1')).toBe(false)

    chooseAllRetreatDestinations(store)
    expect(store.confirmCombatRetreats()).toBe(true)
    expect(store.combatState!.finished).toBe(true)
    expect(session.log.filter((entry) => entry.action === 'combatRetreat').length).toBe(
      settledAfterFirst + 1,
    )
    // 第一场的撤退记录仍在，但结算按场次递增（不覆盖、不串场）
    const retreatEntries = session.log.filter((entry) => entry.action === 'combatRetreat')
    expect(
      retreatEntries.map((entry) =>
        (entry.outcome as { data?: { results?: { unitId: string }[] } }).data?.results?.map(
          (item) => item.unitId,
        ),
      ),
    ).toEqual([['a1'], ['a9']])
  })
})
