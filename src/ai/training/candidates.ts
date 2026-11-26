/**
 * 训练候选动作表（v1）
 *
 * 这不是「引擎穷举合法动作」：本文件只把**快照已经给出的候选**翻译成可直接喂给
 * `TrainingEnv.step` 的 `AiAction`，因此每个候选都有明确的投影来源；是否最终被引擎接受
 * 仍由 `runAiStep` 的 store 入口判，训练侧据 `ok/rule` 记录负样本。
 *
 * v1 覆盖：
 * - 盘面提问 / 推进 / 初设 / 整备 / 到货 / 重建；
 * - 移动主链与 C 段支线（换模式、突袭、铁路、装卸、建造标记、换轨）；
 * - 空军任务、炮击、战斗结算、补给、损耗。
 *
 * 不覆盖 / 只给一个候选的组合：
 * - 战斗撤退多单位路径只做受控笛卡尔积（上限 32），不声称穷举；
 * - 战斗补给按快照首个补给站组合，不枚举所有「站点 × 储备」组合；
 * - 炮击/战斗的入口合法性仍交给引擎。
 */
import type { AiAction, AiHex, AiSnapshot } from '../policy'
import { canonicalActionKeyOf } from './action-key'
import type { TrainingIdentity } from './identity'

export interface TrainingCandidate {
  /** canonical action key（训练动作空间的键） */
  key: string
  action: AiAction
  /** 动作族，便于按 kind 做粗粒度 mask / 统计 */
  family: AiAction['kind']
  /** 投影来源（当前只有快照） */
  source: 'snapshot'
}

const MAX_RETREAT_COMBOS = 32

function pushUnique(
  out: TrainingCandidate[],
  seen: Set<string>,
  action: AiAction,
  identity: TrainingIdentity,
): void {
  const key = canonicalActionKeyOf(action, identity.actionIds)
  if (seen.has(key)) return
  seen.add(key)
  out.push({ key, action, family: action.kind, source: 'snapshot' })
}

function combatRetreatCandidates(snapshot: AiSnapshot): AiAction[] {
  const plans = snapshot.combat.retreatPlans.filter((plan) => plan.chosen === null)
  if (plans.length === 0) return []
  const choices = plans.map((plan) => ({
    unitId: plan.unitId,
    paths: plan.destinations.filter((dest) => !dest.forcedDestruction).map((dest) => dest.path),
  }))
  const lists = choices.map((choice) => choice.paths)
  if (lists.some((paths) => paths.length === 0)) return []
  const total = lists.reduce((count, paths) => count * paths.length, 1)
  if (total > MAX_RETREAT_COMBOS) {
    // 组合过多时只给每个单位的第一条安全路线，明确不声称穷举。
    return [
      {
        kind: 'combatRetreatPaths',
        paths: choices.map((choice) => ({ unitId: choice.unitId, path: choice.paths[0]! })),
      },
    ]
  }
  const out: AiAction[] = []
  const walk = (index: number, paths: { unitId: string; path: readonly AiHex[] }[]) => {
    if (index === choices.length) {
      out.push({ kind: 'combatRetreatPaths', paths })
      return
    }
    const choice = choices[index]!
    for (const path of choice.paths) walk(index + 1, [...paths, { unitId: choice.unitId, path }])
  }
  walk(0, [])
  return out
}

export function candidateActionsOf(
  snapshot: AiSnapshot,
  identity: TrainingIdentity,
): TrainingCandidate[] {
  const out: TrainingCandidate[] = []
  const seen = new Set<string>()
  const add = (action: AiAction) => pushUnique(out, seen, action, identity)

  if (snapshot.terminated) return out

  for (const optionId of snapshot.awaitingOptionIds) add({ kind: 'answer', optionId })
  if (snapshot.airInterception !== null) add({ kind: 'interceptAnswer' })
  if (snapshot.locked || snapshot.advanceAvailable) add({ kind: 'advance' })
  if (snapshot.specialPending) add({ kind: 'specialConfirm' })

  if (snapshot.setup.active) {
    if (snapshot.setup.cursorActive) add({ kind: 'setupPreset' })
    for (const formationId of snapshot.setup.shiftFormationIds)
      add({ kind: 'setupShiftPlace', formationId })
    if (snapshot.setup.drawVisible) add({ kind: 'setupDraw' })
    if (!snapshot.setup.cursorActive && !snapshot.setup.drawVisible) add({ kind: 'setupConfirm' })
  }

  if (snapshot.move.active) {
    if (!snapshot.move.hasStepped) {
      for (const hex of snapshot.branch.overrunTargets) add({ kind: 'overrun', hex })
    }
    for (const hex of snapshot.move.reachableHexes) add({ kind: 'moveClick', hex })
    if (snapshot.branch.gauge !== null) add({ kind: 'gaugeConvert', ...snapshot.branch.gauge })
    add({ kind: 'moveFinish' })
  } else {
    for (const unitId of snapshot.reserveUnitIds) {
      if (snapshot.can.has('move.modeChange')) add({ kind: 'modeChange', unitId })
      if (snapshot.reserveOnHedgehogIds.includes(unitId)) add({ kind: 'reserveRelease', unitId })
    }
    for (const unitId of snapshot.fuel.unfuelledUnitIds) {
      if (!snapshot.fuel.triedUnitIds.includes(unitId)) add({ kind: 'fuelPay', unitId })
    }
    for (const unitId of snapshot.move.candidates) {
      if (!snapshot.move.triedUnits.includes(unitId)) add({ kind: 'moveBegin', unitId })
    }
  }

  if (snapshot.branch.modeSwitch !== null)
    add({ kind: 'modeChangeTo', ...snapshot.branch.modeSwitch })
  if (snapshot.branch.railUnit !== null) add({ kind: 'railMove', ...snapshot.branch.railUnit })
  if (snapshot.branch.railSp !== null) add({ kind: 'railMoveSp', ...snapshot.branch.railSp })
  if (snapshot.branch.transport !== null) {
    const transport = snapshot.branch.transport
    add({
      kind: transport.mode === 'load' ? 'transportLoad' : 'transportUnload',
      pointId: transport.pointId,
      amount: transport.amount,
    })
  }
  if (snapshot.branch.constructionMarker !== null) {
    add({ kind: 'constructionMarker', ...snapshot.branch.constructionMarker })
  }

  for (const base of snapshot.refit.bases) {
    add({
      kind: 'refitBase',
      baseId: base.baseId,
      aircraftIds: base.aircraftIds,
      dumpId: base.dumpId,
    })
  }

  if (snapshot.rein.arrival.removalsPending) add({ kind: 'arrivalRemovals' })
  for (const entry of snapshot.rein.arrival.entries) {
    add({ kind: 'arrivalPlace', index: entry.index, hex: entry.hex })
    add({ kind: 'arrivalSkip', index: entry.index })
  }
  for (const hex of snapshot.rein.supply.cityCandidates) add({ kind: 'supplyArrivalPick', hex })
  for (const target of snapshot.rein.supply.groupTargets) {
    if (target.group !== null) {
      add({ kind: 'supplyArrivalGroup', hexText: target.hexText, group: target.group })
    }
  }
  if (snapshot.rein.supply.planReady) add({ kind: 'supplyArrivals' })
  if (snapshot.rein.supply.trainPending) {
    for (const hex of snapshot.rein.supply.trainHexes) add({ kind: 'supplyTrainPlace', hex })
    if (snapshot.rein.supply.trainGroupRequired) {
      add({ kind: 'supplyTrainGroup', group: 'guderian' })
      add({ kind: 'supplyTrainGroup', group: 'hoth' })
    }
  }

  const rebuild = snapshot.rein.rebuild
  if (rebuild !== null) {
    add({ kind: 'rebuild', unitId: rebuild.unitId, mode: rebuild.kind, hex: rebuild.hex })
    if (rebuild.consolidate !== null) add({ kind: 'consolidate', ...rebuild.consolidate })
  }
  if (snapshot.overstack.active) add({ kind: 'overstackDestroy' })

  if (snapshot.air.inProgress) {
    add({ kind: 'airMission', target: null, aircraftId: null })
  } else if (snapshot.air.target !== null && snapshot.air.aircraftId !== null) {
    add({ kind: 'airMission', target: snapshot.air.target, aircraftId: snapshot.air.aircraftId })
  }

  const barrage = snapshot.barrage
  if (barrage.state !== null) {
    add({ kind: 'barrageCancel' })
    for (const hex of barrage.enemyHexes) add({ kind: 'barrageTarget', hex })
    add({ kind: 'barrageBegin' })
    for (const choice of barrage.choices) {
      if (!choice.disabled) add({ kind: 'barrageToggleUnit', unitId: choice.unitId })
    }
    for (const dumpId of barrage.supplyDumpIds) add({ kind: 'barrageSupply', dumpId })
    add({ kind: 'barrageSupply', dumpId: null })
    if (barrage.state.step === 'barrageShifts' || barrage.state.step.includes('shift')) {
      add({ kind: 'barrageShifts' })
    }
    if (barrage.state.step === 'barrageDice' || barrage.state.step.includes('dice')) {
      add({ kind: 'barrageDice' })
    }
    if (barrage.lossTargets.length > 0) {
      add({ kind: 'barrageOutcome', losses: barrage.lossTargets })
    } else {
      add({ kind: 'barrageOutcome', losses: [] })
    }
  }

  for (const hex of snapshot.combat.adjacentDefenderHexes) add({ kind: 'combatSelect', hex })
  if (snapshot.combat.defenderHex !== null) add({ kind: 'combatBegin' })
  const combatState = snapshot.combat.state
  if (combatState !== null && !combatState.finished) {
    switch (combatState.step) {
      case 'combatSupply': {
        const attackerDump = snapshot.combat.attackerDumpIds[0] ?? null
        const defenderDump = snapshot.combat.defenderDumpIds[0] ?? null
        add({
          kind: 'combatSupply',
          side: 'advance',
          attackerDumpId: attackerDump,
          defenderDumpId: defenderDump,
          attackerUsesInternalStocks: snapshot.combat.attackerStocksApplicable,
          defenderUsesInternalStocks: snapshot.combat.defenderStocksApplicable,
        })
        add({
          kind: 'combatSupply',
          side: 'attacker',
          attackerDumpId: attackerDump,
          defenderDumpId: null,
          attackerUsesInternalStocks: snapshot.combat.attackerStocksApplicable,
        })
        add({
          kind: 'combatSupply',
          side: 'defender',
          attackerDumpId: null,
          defenderDumpId: defenderDump,
          defenderUsesInternalStocks: snapshot.combat.defenderStocksApplicable,
        })
        break
      }
      case 'declareAr':
        add({ kind: 'combatDeclareAr', side: 'attacker' })
        add({ kind: 'combatDeclareAr', side: 'defender' })
        break
      case 'declareTerrain':
      case 'surprise':
      case 'battleDice':
        add({ kind: 'combatAutoResolve' })
        break
      case 'losses':
        add({ kind: 'combatLosses' })
        break
      case 'options': {
        const requirement = snapshot.combat.requirement
        if (requirement !== null) {
          for (let retreatHexes = 0; retreatHexes <= requirement.options; retreatHexes += 1) {
            const lossPoints = requirement.options - retreatHexes
            if (lossPoints <= snapshot.combat.optionCapacity) {
              add({ kind: 'combatOptions', retreatHexes, lossPoints, ignoreOptions: false })
            }
          }
        }
        break
      }
      case 'retreat':
        for (const action of combatRetreatCandidates(snapshot)) add(action)
        add({ kind: 'combatAdvance' })
        break
      default:
        break
    }
  }

  if (!snapshot.supply.planLoaded) add({ kind: 'supplyPlan' })
  if (!snapshot.supply.recoverySettled) add({ kind: 'supplyRecovery' })
  if (!snapshot.supply.feedingSettled) add({ kind: 'supplyFeeding' })
  for (const duty of snapshot.supply.duties) {
    if (!duty.rolled) add({ kind: 'attritionRoll', key: duty.key })
    if (duty.needAllocation) {
      add({
        kind: 'attritionApply',
        key: duty.key,
        allocation: duty.units.map((unit) => ({ unitId: unit.id, steps: unit.steps })),
      })
    }
  }

  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
