import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

/**
 * 批 F·F2（条 17）＋ 4.5a-A：突袭强行进入敌方 ZOC 的格后，只有 **Truck MP** 单位
 * 「须再突袭或停、不得离开」；Leg / Track MP 不受 ZOC 影响，可继续移动（8.0）。
 *
 * 用真实地图与真实单位库（不造数）；4.5a 标记来自 `settleOverrunMove` 里
 * 对进入格的 `inEnemyZocAt` 判定，并按参突单位的机动类型过滤（引擎不造事实）。
 */

const DEFENDER_HEX: HexRef = (() => {
  for (const hex of mapLayers.hexes) {
    const onMapNeighbors = HEX_DIRECTIONS.filter((direction) => {
      const neighborHex = neighbor({ col: hex.col, row: hex.row }, direction)
      return (
        isOnMap(neighborHex) &&
        mapLayers.hexes.some((item) => item.col === neighborHex.col && item.row === neighborHex.row)
      )
    })
    if (onMapNeighbors.length === 6) return { col: hex.col, row: hex.row }
  }
  throw new Error('地图上找不到「六邻皆图内」的格')
})()

const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (
      isOnMap(candidate) &&
      mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
    ) {
      return candidate
    }
  }
  throw new Error('防御格没有图内邻格')
})()

/** 轮式用例的起点：城区低进格费，避免 2.2 一带的轮式进格费 >3（8.1b） */
const OPEN_START: HexRef = { col: 36, row: 13 }

function place(
  store: ReturnType<typeof useWorkbenchStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
  face: 'combat' | 'move' = 'combat',
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex: { ...hex }, side, face })
  store.units.push(unit)
  return unit
}

function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

const overrunMover = () =>
  pickRecord(
    'axis',
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.attack ?? 0) >= 20 &&
      (record.factors?.combat?.ma ?? 0) >= 4 &&
      (record.steps?.total ?? 0) >= 4,
  )
/** 守方取「AR 最低」的战斗单位：低 AR ⇒ 高 odds，尽量避免攻方在突袭中损失单位 */
const weakDefender = () =>
  unitChoices('soviet')
    .filter((record) => record.isCombat === true && record.branch !== 'replacement')
    .sort(
      (a, b) =>
        (a.factors?.combat?.ar ?? 9) - (b.factors?.combat?.ar ?? 9) ||
        (a.factors?.combat?.attack ?? 9) - (b.factors?.combat?.attack ?? 9),
    )[0]!
const anySoviet = () => pickRecord('soviet', (record) => record.isCombat === true)
const anyAxis = () => pickRecord('axis', (record) => record.isCombat === true)
const weakAxisDefender = () =>
  pickRecord(
    'axis',
    (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) <= 2,
  )
/** 纯轮式攻方：轴方摩托化步兵（移动面 truck，可攻击）——取两枚凑够攻击力 */
const wheeledMovers = () =>
  unitChoices('axis')
    .filter(
      (record) =>
        record.mobilityByFace?.move === 'truck' &&
        record.isCombat === true &&
        record.attackCapable === true,
    )
    .slice(0, 2)

function goToMovementStep(store: ReturnType<typeof useWorkbenchStore>): void {
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement')
  if (index >= 0) store.setSegmentStepIndex(index)
}

function driveCombatSteps(
  store: ReturnType<typeof useWorkbenchStore>,
  dumpHexes: readonly HexRef[],
): void {
  let declared = false
  let guard = 0
  while (guard < 16) {
    guard += 1
    const state = store.combatState
    if (state === null || state.finished) break
    if (state.step === 'combatSupply') {
      if (!declared) {
        // 战斗补给须在「拖得到」的范围内；同格给足 SP 与 T（轮式每枚 1 T，12.5）
        for (const hex of dumpHexes) {
          for (const side of ['axis', 'soviet'] as const) {
            const id = `sd-${side}-${hex.col}-${hex.row}`
            if (store.spDumps.some((dump) => dump.id === id)) continue
            store.spDumps.push({ id, hex: { ...hex }, side, sp: 8, t: 8 })
          }
        }
        for (const entry of store.combatSupplyDumps) {
          if (store.combatSupplyDumpIds[entry.side] !== null) continue
          const dump = entry.dumps[0]
          if (dump !== undefined) store.pickCombatSupplyDump(entry.side, dump.id)
        }
        declared = true
      }
      if (!store.confirmCombatSupply()) break
      continue
    }
    if (state.step === 'declareAr') {
      if (store.combatInputs.attackerArUnitId === null) {
        store.combatInputs.attackerArUnitId = store.combatAttackers[0]?.instanceId ?? null
      }
      if (!store.declareCombatArStep('attacker')) break
      if (store.combatInputs.defenderArUnitId === null) {
        store.combatInputs.defenderArUnitId = store.battleDefenders[0]?.instanceId ?? null
      }
      if (!store.declareCombatArStep('defender')) break
      continue
    }
    if (state.step === 'declareTerrain') {
      if (!store.declareCombatTerrainStep()) break
      continue
    }
    if (state.step === 'surprise') {
      if (!store.rollCombatSurprise()) break
      if (store.combatAwaitingShiftDie) store.rollCombatShiftDie()
      continue
    }
    if (state.step === 'battleDice') {
      if (!store.rollCombatDice()) break
      continue
    }
    break
  }
}

function driveResolutionLossFirst(store: ReturnType<typeof useWorkbenchStore>): void {
  let guard = 0
  while (guard < 12) {
    guard += 1
    const state = store.combatState
    if (state === null || state.finished) break
    if (state.step === 'losses') {
      if (!store.confirmCombatLosses()) break
      continue
    }
    if (state.step === 'options') {
      const requirement = store.combatRequirement!
      const isAttacker = state.resolution.stage === 'attackerOptions'
      const units = isAttacker ? store.combatAttackers : store.battleDefenders
      const capacity = units.reduce((sum, unit) => sum + unit.steps, 0)
      if (requirement.options <= capacity) {
        store.combatInputs.optionRetreatHexes = 0
        store.combatInputs.optionLossPoints = requirement.options
      } else {
        store.combatInputs.optionRetreatHexes = requirement.options
        store.combatInputs.optionLossPoints = 0
      }
      if (!store.confirmCombatOptions()) break
      continue
    }
    break
  }
}

describe('批 F·F2（条 17）：突袭进敌方 ZOC ⇒ 4.5a 标记', () => {
  let store: ReturnType<typeof useWorkbenchStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useWorkbenchStore()
    store.resetAll(11)
  })

  type OverrunCast = {
    moverSide?: 'axis' | 'soviet'
    mover?: ReturnType<typeof unitChoices>[number]
    extraMover?: ReturnType<typeof unitChoices>[number]
    defenderSide?: 'axis' | 'soviet'
    defender?: ReturnType<typeof unitChoices>[number]
    witness?: ReturnType<typeof unitChoices>[number]
    /** 攻方起点；默认 ATTACKER_HEX。轮式用例换到低进格费的 START */
    origin?: HexRef
    moverFace?: 'combat' | 'move'
    extraMoverFace?: 'combat' | 'move'
  }

  /** 摆攻/守/见证 ⇒ 返回满足 8.1 的目标格与见证格（守方格处于敌方 ZOC） */
  function placeDefenderForZocOverrun(cast: OverrunCast = {}): {
    target: HexRef
    witnessHex: HexRef
  } {
    const moverSide = cast.moverSide ?? 'axis'
    const defenderSide = cast.defenderSide ?? 'soviet'
    const origin = cast.origin ?? ATTACKER_HEX
    const mover = place(
      store,
      cast.mover ?? overrunMover(),
      origin,
      moverSide,
      'ov1',
      cast.moverFace ?? 'combat',
    )
    const extra =
      cast.extraMover === undefined
        ? null
        : place(store, cast.extraMover, origin, moverSide, 'ov2', cast.extraMoverFace ?? 'combat')
    store.setPhase('movement')
    store.setActiveSide(moverSide)
    // 轮式战斗单位动前须已加注（12.5a）；本用例只测 ZOC，燃料按夹具直接给足
    if (mover.raw.mobility === 'truck') mover.fuelled = true
    if (extra?.raw.mobility === 'truck') extra.fuelled = true
    if (extra !== null) store.stackSelect = true
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    store.clickHex(mover.hex)
    expect(
      store.confirmMovePick(),
      JSON.stringify({ blocked: store.moveBlocked, log: store.log[0]?.text }),
    ).toBe(true)
    expect(store.moveInteraction).not.toBeNull()

    const defenderRecord =
      cast.defender ?? (defenderSide === 'soviet' ? weakDefender() : weakAxisDefender())
    const witnessRecord = cast.witness ?? (defenderSide === 'soviet' ? anySoviet() : anyAxis())

    for (const direction of HEX_DIRECTIONS) {
      const candidate = neighbor(origin, direction)
      if (
        !isOnMap(candidate) ||
        !mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)
      ) {
        continue
      }
      place(store, defenderRecord, candidate, defenderSide, 'ovd')
      // 防御格旁再摆一枚同阵营 ⇒ 防御格处于敌方 ZOC（4.5a 的来源）
      let witnessHex: HexRef | null = null
      for (const d2 of HEX_DIRECTIONS) {
        const witness = neighbor(candidate, d2)
        if (
          !isOnMap(witness) ||
          !mapLayers.hexes.some((w) => w.col === witness.col && w.row === witness.row)
        ) {
          continue
        }
        if (
          (witness.col === origin.col && witness.row === origin.row) ||
          (witness.col === candidate.col && witness.row === candidate.row)
        ) {
          continue
        }
        place(store, witnessRecord, witness, defenderSide, 'ovz')
        witnessHex = witness
        break
      }
      if (
        witnessHex !== null &&
        store.overrunTargets.some((hint) => hexDistance(hint.hex, candidate) === 0)
      ) {
        return { target: candidate, witnessHex }
      }
      // 该格不满足 8.1 ⇒ 收回（含见证）
      store.units = store.units.filter(
        (unit) => unit.instanceId !== 'ovd' && unit.instanceId !== 'ovz',
      )
    }
    throw new Error(
      `起点周围找不到满足 8.1 的突袭目标格 ${JSON.stringify({
        side: store.activeSide,
        phase: store.phase,
        stack: store.overrunStackHex,
        targets: store.overrunTargets.map((item) => item.hex),
        step: store.segmentStep?.id,
        ctxSide: store.moveContext?.activeSide,
        ctxPhase: store.moveContext?.phase,
        ids: store.moveInteraction?.unitIds,
      })}`,
    )
  }

  function resolveOverrunToFinished(dumpHexes: readonly HexRef[]): void {
    driveCombatSteps(store, dumpHexes)
    driveResolutionLossFirst(store)
    if (store.combatState?.step === 'retreat') {
      for (const plan of store.combatRetreatPlans) {
        for (const row of plan.units) {
          expect(store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)).toBe(true)
        }
      }
      expect(store.confirmCombatRetreats()).toBe(true)
    }
    // 突袭推进步（8.0 进入）由其收束
    if (!store.confirmCombatAdvance()) {
      store.clearAdvanceNow()
      expect(
        store.confirmCombatAdvance(),
        JSON.stringify({
          step: store.combatState?.step,
          log: store.log.slice(0, 4).map((e) => e.text),
        }),
      ).toBe(true)
    }
    expect(store.combatState?.finished).toBe(true)
    expect(store.overrunContext).toBeNull()
  }

  function freeNeighborOf(target: HexRef, avoid: readonly HexRef[]): HexRef {
    for (const direction of HEX_DIRECTIONS) {
      const hex = neighbor(target, direction)
      if (!isOnMap(hex) || !mapLayers.hexes.some((h) => h.col === hex.col && h.row === hex.row))
        continue
      if (avoid.some((item) => item.col === hex.col && item.row === hex.row)) continue
      if (store.units.some((unit) => unit.hex.col === hex.col && unit.hex.row === hex.row)) continue
      return hex
    }
    throw new Error('目标格周围没有空格')
  }

  it('4.5a-A：徒步突袭进入敌方 ZOC 不受 ZOC 限制，8.0 剩余 MP 继续可走', () => {
    const { target } = placeDefenderForZocOverrun()
    expect(store.overrunNow(target)).toBe(true)
    expect(store.combatState?.attackType).toBe('overrun')
    resolveOverrunToFinished([ATTACKER_HEX, target])

    // 原文 4.5a-A：Leg / Track MP 不受 ZOC 影响 ⇒ 不置「不得离开」
    expect(store.overrunZocHeld).toBeNull()
    expect(store.overrunZocHeldUnitIds).toEqual([])

    // 8.0：不撤退且还有 MP ⇒ 可以继续移动（尝试六邻，找一步付得起的落点）
    const unit = () => store.units.find((item) => item.instanceId === 'ov1')!
    const candidates = HEX_DIRECTIONS.map((direction) => neighbor(target, direction)).filter(
      (hex) =>
        isOnMap(hex) &&
        mapLayers.hexes.some((item) => item.col === hex.col && item.row === hex.row) &&
        store.units.every((item) => item.hex.col !== hex.col || item.hex.row !== hex.row),
    )
    const movedTo = candidates.find((hex) => {
      store.clickHex(hex)
      return unit().hex.col === hex.col && unit().hex.row === hex.row
    })
    expect(
      movedTo,
      JSON.stringify({
        candidates,
        blocked: store.moveBlocked,
        log: store.log.slice(0, 5).map((entry) => entry.text),
      }),
    ).toBeDefined()
    expect(store.moveBlocked?.rule).not.toBe('4.5a')
  }, 30_000)

  it('纯轮式突袭进入敌方 ZOC ⇒ 仍被锁：不得离开，须再突袭或停', () => {
    const [wheelA, wheelB] = wheeledMovers()
    const { target } = placeDefenderForZocOverrun({
      mover: wheelA,
      moverFace: 'move',
      extraMover: wheelB,
      extraMoverFace: 'move',
      defenderSide: 'soviet',
      defender: weakDefender(),
      witness: anySoviet(),
      origin: OPEN_START,
    })
    expect(store.overrunNow(target)).toBe(true)
    resolveOverrunToFinished([OPEN_START, target])

    expect(store.overrunZocHeld).toEqual(target)
    expect(store.overrunZocHeldUnitIds.slice().sort()).toEqual(['ov1', 'ov2'])

    const dest = freeNeighborOf(target, [OPEN_START, target])
    store.clickHex(dest)
    expect(store.moveBlocked?.rule).toBe('4.5a')
    for (const id of ['ov1', 'ov2'])
      expect(store.units.find((unit) => unit.instanceId === id)!.hex).toMatchObject(target)
  }, 30_000)

  it('混合堆叠：只锁轮式那一枚，徒步/履带不在名单里', () => {
    const [wheel] = wheeledMovers()
    const { target } = placeDefenderForZocOverrun({
      mover: overrunMover(),
      extraMover: wheel,
      extraMoverFace: 'move',
      defenderSide: 'soviet',
      defender: weakDefender(),
      witness: anySoviet(),
      origin: OPEN_START,
    })
    expect(store.overrunNow(target)).toBe(true)
    resolveOverrunToFinished([OPEN_START, target])

    expect(store.overrunZocHeld).toEqual(target)
    expect(store.overrunZocHeldUnitIds).toEqual(['ov2'])
    expect(store.overrunZocHeldUnitIds).not.toContain('ov1')
  }, 30_000)

  it('对照：突袭进入非 ZOC 格（见证苏军在不相邻的第二环）⇒ 不标 4.5a', () => {
    const mover = place(store, overrunMover(), ATTACKER_HEX, 'axis', 'ov1')
    store.setPhase('movement')
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    store.clickHex(mover.hex)
    expect(store.confirmMovePick()).toBe(true)

    let target: HexRef | null = null
    for (const direction of HEX_DIRECTIONS) {
      const candidate = neighbor(ATTACKER_HEX, direction)
      if (
        !isOnMap(candidate) ||
        !mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)
      ) {
        continue
      }
      const defender = place(store, weakDefender(), candidate, 'soviet', 'ovd')
      // 见证苏军摆在「不相邻的第二环」⇒ 防御格不处于敌方 ZOC（进入格也就不在 ZOC）
      let witnessPlaced = false
      for (const d1 of HEX_DIRECTIONS) {
        const ring1 = neighbor(candidate, d1)
        if (
          !isOnMap(ring1) ||
          !mapLayers.hexes.some((w) => w.col === ring1.col && w.row === ring1.row)
        ) {
          continue
        }
        for (const d2 of HEX_DIRECTIONS) {
          const ring2 = neighbor(ring1, d2)
          if (
            isOnMap(ring2) &&
            mapLayers.hexes.some((w) => w.col === ring2.col && w.row === ring2.row) &&
            hexDistance(candidate, ring2) >= 2
          ) {
            place(store, anySoviet(), ring2, 'soviet', 'ovz')
            witnessPlaced = true
            break
          }
        }
        if (witnessPlaced) break
      }
      if (store.overrunTargets.some((hint) => hexDistance(hint.hex, candidate) === 0)) {
        target = candidate
        break
      }
      store.units = store.units.filter(
        (unit) => unit.instanceId !== defender.instanceId && unit.instanceId !== 'ovz',
      )
    }
    expect(target, '应找到满足 8.1 的相邻守方').not.toBeNull()

    expect(store.overrunNow(target!)).toBe(true)
    driveCombatSteps(store, [ATTACKER_HEX, target!])
    driveResolutionLossFirst(store)
    if (store.combatState?.step === 'retreat') {
      // 守方撤退 ⇒ 离开防御格 ⇒ 攻方按 8.0 进入（进入格不在 ZOC ⇒ 不标 4.5a）
      for (const plan of store.combatRetreatPlans) {
        for (const row of plan.units) {
          expect(store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)).toBe(true)
        }
      }
      expect(store.confirmCombatRetreats()).toBe(true)
      expect(store.confirmCombatAdvance()).toBe(true)
    }
    // 守方未离格（持有）⇒ 8.0 不满足、无法进入 ⇒ 同样不标 4.5a（两种情形 flag 都应为 null）
    expect(store.overrunZocHeld).toBeNull()
  }, 30_000)
})
