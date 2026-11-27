/**
 * 训练候选动作表（v1）
 *
 * 这不是「引擎穷举合法动作」：本文件只把**快照已经给出的候选**翻译成可直接喂给
 * `TrainingEnv.step` 的 `AiAction`，因此每个候选都有明确的投影来源；是否最终被引擎接受
 * 仍由 `runAiStep` 的 store 入口判，训练侧据 `ok/rule` 记录负样本。
 *
 * v1 覆盖：
 * - 盘面提问 / 推进 / 初设 / 整备 / 到货 / 重建；
 * - 移动主链与 C 段支线（换模式、销毁补给站、突袭、铁路、装卸、建造标记、换轨）；
 * - 空军任务、炮击、战斗结算（含补给付不出时的 `combatSkip`）、补给、损耗。
 *
 * 不覆盖 / 只给一个候选的组合：
 * - 战斗撤退多单位路径只做受控笛卡尔积（上限 32），不声称穷举；
 * - 战斗补给按快照首个补给站组合，不枚举所有「站点 × 储备」组合；
 * - 炮击/战斗的入口合法性仍交给引擎。
 */
import {
  hexKeyOf,
  type AiAction,
  type AiCombatSnapshot,
  type AiHex,
  type AiSnapshot,
} from '../policy'
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

/**
 * 9.5 战斗补给步的候选（纯投影：只读 `AiCombatSnapshot`，不新增规则判据）
 *
 * - 攻方图上付不出整笔、又不能动储备 ⇒ 12.4「该方根本不攻击」，只给放弃战斗；
 * - 否则给三条补给落法（双方代答 / 只答攻方 / 只答守方），并保留 `combatSkip` 这个合法出口；
 * - 放弃只能在补给落盘前做（`combatCancelBlocker` 在 `combatSupplyCommitted` 后成立）。
 */
export function combatSupplyCandidates(combat: AiCombatSnapshot): AiAction[] {
  const attackerDump = combat.attackerDumpIds[0] ?? null
  const defenderDump = combat.defenderDumpIds[0] ?? null
  const attackerCanPay = attackerDump !== null || combat.attackerStocksApplicable
  const out: AiAction[] = []
  if (attackerCanPay) {
    out.push(
      {
        kind: 'combatSupply',
        side: 'advance',
        attackerDumpId: attackerDump,
        defenderDumpId: defenderDump,
        attackerUsesInternalStocks: combat.attackerStocksApplicable,
        defenderUsesInternalStocks: combat.defenderStocksApplicable,
      },
      {
        kind: 'combatSupply',
        side: 'attacker',
        attackerDumpId: attackerDump,
        defenderDumpId: null,
        attackerUsesInternalStocks: combat.attackerStocksApplicable,
      },
      {
        kind: 'combatSupply',
        side: 'defender',
        attackerDumpId: null,
        defenderDumpId: defenderDump,
        defenderUsesInternalStocks: combat.defenderStocksApplicable,
      },
    )
  }
  out.push({ kind: 'combatSkip' })
  return out
}

/**
 * 9.6「宣布行动值」这一步的候选：**先给换人**，再给宣布
 *
 * 为什么要换人这一步：web 面板是先点一枚单位（写 `combatInputs` 的预选）再按宣布；
 * 桥接端若只给"宣布"，就只能吃引擎默认值（可选前提下 AR 最高），玩家/AI 换不了。
 *
 * 口径：候选池取 store 的两份清单（守方那份已按专规 2.3b 收窄）；已选中的那枚不再列
 * （点了也不会变，属空转）。宣布只能做一侧：守方必须等攻方落定（9.6）。
 */
export function combatDeclareArCandidates(combat: AiCombatSnapshot): AiAction[] {
  const state = combat.state
  if (state === null || state.finished || state.step !== 'declareAr') return []
  const side: 'attacker' | 'defender' =
    state.declaredAttackerArUnitId === undefined ? 'attacker' : 'defender'
  const options =
    (side === 'attacker' ? combat.arOptions?.attacker : combat.arOptions?.defender) ?? []
  const out: AiAction[] = []
  for (const option of options) {
    if (option.selected) continue
    out.push({ kind: 'combatArUnit', side, unitId: option.unitId })
  }
  out.push({ kind: 'combatDeclareAr', side })
  return out
}

/**
 * 9.11a/c：损失步的候选 —— **先给"改派给谁"，再给确认**
 *
 * 口径照 web `CombatPanel`：点一枚单位＝把规范分配里"多受的那一点"换给谁（两枚互换点数，仍满足 9.11c
 * 的均匀展开）；`unitId: null` ＝回到规范分配。候选池直接取 store 的 `combatLossSwapChoices`，
 * 没这种余地（没人受 2 点）时只给确认 —— 不造"改了也没用"的条目。
 */
export function combatLossCandidates(combat: AiCombatSnapshot): AiAction[] {
  const out: AiAction[] = []
  const plan = combat.lossPlan
  if (plan !== undefined) {
    if (plan.takerId !== null) out.push({ kind: 'combatLossTaker', unitId: null })
    for (const choice of plan.swapChoices) {
      if (choice.unitId === plan.takerId) continue
      out.push({ kind: 'combatLossTaker', unitId: choice.unitId })
    }
  }
  out.push({ kind: 'combatLosses' })
  return out
}

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
    /*
     * 6.1 回退：走过至少一步才给（没步可退是空转）。顺序与 web 面板一致：先「撤销一步」再「取消整次移动」，
     * 两者都在 `moveFinish` 之前 —— 退回去再另走，是这里的正常意图。
     */
    if (snapshot.move.hasStepped) {
      add({ kind: 'moveUndo' })
      add({ kind: 'moveCancel' })
    }
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
  if (snapshot.branch.dumpBlow !== null) add({ kind: 'dumpBlow', ...snapshot.branch.dumpBlow })

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
    /*
     * 10.0a：结果可以是「零损失」（noLossExpected），旧实现只在 lossTargets 非空时才给
     * 一条「全给损」的候选 ⇒ 碰上期望零损失的目标就只有一条必被拒的动作（自锁）。
     * 这里两条都给：零损失 + 各目标「给到步数」的全量分配，谁对由引擎判。
     */
    add({ kind: 'barrageOutcome', losses: [] })
    if (barrage.lossTargets.length > 0) {
      add({ kind: 'barrageOutcome', losses: barrage.lossTargets })
    }
  } else if (barrage.entryHexes !== undefined && barrage.entryHexes.length > 0) {
    /*
     * 炮击**入口**：`barrage.state === null` 也要给出「点目标格 + 宣布」两条腿。
     * 修前这两条腿被压在 `state !== null` 里，而 state 只有 `barrageBegin` 之后才建 ⇒
     * 自锁：训练/桥接端一辈子开不出一枪（web 端靠 UI 按钮绕过去了，所以只有 AI 侧发病）。
     * 候选池只取 store `barrageEntryEligible` 判过的格（driver 投影 entryHexes），不另立口径。
     */
    const tried = new Set(barrage.triedTargets)
    for (const hex of barrage.entryHexes) {
      if (!tried.has(hexKeyOf(hex))) add({ kind: 'barrageTarget', hex })
    }
    /*
     * 10.0：`beginBarrageNow` 前必须先点参炸单位（引擎原话「请先选择参炸单位」）。
     * 这些单位同样只在 state 内才会列 ⇒ 入口段一并给出，disabled 的照旧不列（不摆灰项）。
     */
    for (const choice of barrage.choices) {
      if (!choice.disabled) add({ kind: 'barrageToggleUnit', unitId: choice.unitId })
    }
    add({ kind: 'barrageBegin' })
  }

  /*
   * 9.1b：只有 `combat.combat` 环节才轮得到「选防御格 / 宣布进攻」。
   * `combat.*` 这一段里还有 `combat.barrage`（炮击环节，只认炮兵），
   * 旧口径按 phase 给 combatSelect ⇒ 炮击环节也会冒出防御格候选，点了必被 9.1a 拒。
   */
  const inCombatStep = snapshot.segment === 'combat.combat'
  if (inCombatStep) {
    for (const hex of snapshot.combat.adjacentDefenderHexes) add({ kind: 'combatSelect', hex })
    if (snapshot.combat.defenderHex !== null) add({ kind: 'combatBegin' })
  }
  const combatState = snapshot.combat.state
  if (combatState !== null && !combatState.finished) {
    switch (combatState.step) {
      case 'combatSupply':
        for (const action of combatSupplyCandidates(snapshot.combat)) add(action)
        break
      case 'declareAr':
        for (const action of combatDeclareArCandidates(snapshot.combat)) add(action)
        break
      case 'declareTerrain':
      case 'surprise':
      case 'battleDice':
        add({ kind: 'combatAutoResolve' })
        break
      case 'losses':
        for (const action of combatLossCandidates(snapshot.combat)) add(action)
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
