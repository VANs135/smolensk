import { computed, ref, type Ref } from 'vue'
import type { HexRef, Side } from '@/data'
import type { RuleOutcome, PendingEffect } from '@/engine/result-types'
import type { RngState, DiceRoll } from '@/engine/state-types'
import { roll1d6, roll2d6 } from '@/engine/rng'
import { DERIVATION_KEY, type Derivation } from '@/engine/derivation'
import { combatDerivation } from '@/engine/derivation-builders'
import {
  resolveSurprise,
  resolveCombatDice,
  resolveBarrageDice,
  planBarrageOutcome,
  isFacilityBarrage,
  optionsOf,
  parseFacilityCode,
  type CombatInteractionState,
  type CombatUnitPatch,
  type BarrageInteractionState,
  type BarrageUnitPatch,
  type FacilityPatch,
} from '@/engine/rules'
import {
  combatIsCommitted,
  barrageIsCommitted,
  engagementDecisionRole,
} from '@/engine/rules/engagement-progress'
import { createCombatInputs, createBarrageInputs } from './engagement-inputs'
import type { ConsoleUnit } from './workbench-model'

export interface FireResolutionPorts {
  rng: Ref<RngState>
  drawCount: Ref<number>
  acceptCombat<T>(outcome: RuleOutcome<T>, action: string): T | null
  acceptBarrage<T>(outcome: RuleOutcome<T>, action: string): T | null
  applyCombatPatches(patches: readonly CombatUnitPatch[]): void
  stripReserveMarkersAfterDefense(state: CombatInteractionState): void
  logCombatSurprise(state: CombatInteractionState, rolls: readonly DiceRoll[]): void
  pushLog(
    kind: 'info' | 'success' | 'warning' | 'danger',
    text: string,
    rule?: string,
    derivation?: Derivation,
  ): void
  recordSettlement(input: {
    action: string
    rule: string
    side?: Side
    rolls?: readonly DiceRoll[]
    pending?: PendingEffect[]
    data?: Record<string, unknown>
  }): boolean
  nameOf(id: string): string
  barrageLossTargets(): ConsoleUnit[]
  barrageAircraftTargets(): readonly { instanceId: string }[]
  applyBarragePatches(patches: readonly BarrageUnitPatch[]): void
  applyAirStepLoss(id: string): void
  applyFacilityPatch(patch: FacilityPatch, hex: HexRef): void
  facilityFacts(hex: HexRef): { baseLevel: number; isAirstrip: boolean; portDamageBefore: number }
  retreatPlans(): readonly { side: 'attacker' | 'defender'; complete: boolean }[]
  hasPendingSpecial(): boolean
  applyRetreatCrossing(crossing: { unitId: string; hex: HexRef }): void
}

/** 9.2 / 10.0：每局独立的交战现场与骰序，盘面变更经显式端口提交。 */
export function createFireResolutionDomain(ports: FireResolutionPorts) {
  const {
    rng,
    drawCount,
    acceptCombat,
    acceptBarrage,
    applyCombatPatches,
    stripReserveMarkersAfterDefense,
    logCombatSurprise,
    pushLog,
    recordSettlement,
    nameOf,
    applyBarragePatches,
    applyAirStepLoss,
  } = ports
  const combatState = ref<CombatInteractionState | null>(null)
  const combatError = ref<{ rule: string; reason: string } | null>(null)
  const combatSurpriseDie = ref<number | null>(null)
  const combatSurpriseRoll = ref<DiceRoll | null>(null),
    combatShiftRoll = ref<DiceRoll | null>(null),
    combatDiceRoll = ref<DiceRoll | null>(null)
  const combatAwaitingShiftDie = ref(false),
    combatInputs = ref(createCombatInputs())
  const barrageState = ref<BarrageInteractionState | null>(null),
    barrageError = ref<{ rule: string; reason: string } | null>(null)
  const barrageAwaitingHalfDie = ref(false),
    barrageInputs = ref(createBarrageInputs())
  const combatSpecialPending = ref(false)
  let retreatCrossings: { unitId: string; hex: HexRef }[] = []
  const combatSupplyCommitted = computed(
    () => combatIsCommitted(combatState.value) || combatSpecialPending.value,
  )
  const barrageCommitted = computed(() => barrageIsCommitted(barrageState.value))
  const decisionRole = computed(() =>
    engagementDecisionRole(
      combatState.value,
      barrageState.value,
      combatState.value?.step === 'retreat' ? ports.retreatPlans() : [],
    ),
  )
  function resetCombat() {
    retreatCrossings = []
    combatSpecialPending.value = false
    combatState.value = null
    combatError.value = null
    combatSurpriseDie.value = null
    combatSurpriseRoll.value = null
    combatShiftRoll.value = null
    combatDiceRoll.value = null
    combatAwaitingShiftDie.value = false
    combatInputs.value = createCombatInputs()
  }
  function resetBarrage() {
    barrageState.value = null
    barrageError.value = null
    barrageAwaitingHalfDie.value = false
    barrageInputs.value = createBarrageInputs()
  }
  const barrageLossTargets = computed(ports.barrageLossTargets)
  /** 9.12f：每次外部位移决定完成后续跑剩余路径，每格只消费一次。 */
  function resumeRetreatCrossings(): void {
    while (retreatCrossings.length > 0 && !ports.hasPendingSpecial())
      ports.applyRetreatCrossing(retreatCrossings.shift()!)
    combatSpecialPending.value = ports.hasPendingSpecial()
  }
  function scheduleRetreatCrossings(crossings: readonly { unitId: string; hex: HexRef }[]): void {
    retreatCrossings = crossings.map((crossing) => ({ ...crossing, hex: { ...crossing.hex } }))
    resumeRetreatCrossings()
  }
  function trackSpecialPending(): void {
    combatSpecialPending.value = ports.hasPendingSpecial()
  }
  function rollCombatSurprise(): boolean {
    const state = combatState.value
    if (state === null || state.step !== 'surprise' || state.finished) return false
    if (combatAwaitingShiftDie.value) return rollCombatShiftDie()
    const draw = roll2d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    combatSurpriseDie.value = draw.value.total
    combatSurpriseRoll.value = draw.value
    const data = acceptCombat(resolveSurprise(state, { die: draw.value.total }), '奇袭判定')
    if (data === null) return false
    if (data.awaitingShiftDie) {
      combatAwaitingShiftDie.value = true
      // 此处引擎尚未给出奇袭方（要等横移骰），故不附复核过程 —— 不臆造结论
      pushLog(
        'warning',
        `奇袭判定 2d6 = ${draw.value.faces.join('+')} = ${draw.value.total}（DRM ${state.ar?.drm ?? 0}）：发生奇袭，须再掷 1 骰做横移（9.8）`,
        '9.8',
      )
      // ⑭ 接线：本笔只掷了奇袭 2d6（横移骰在下一步）⇒ rolls 只报这一颗
      recordSettlement({
        action: 'combatSurprise',
        rule: '9.8',
        rolls: [draw.value],
        data: {
          die: draw.value.total,
          drm: state.ar?.drm ?? 0,
          awaitingShiftDie: true,
        },
      })
      return true
    }
    combatState.value = data.state
    combatAwaitingShiftDie.value = false
    logCombatSurprise(data.state, [draw.value])
    return true
  }

  function rollCombatShiftDie(): boolean {
    const state = combatState.value
    const die = combatSurpriseDie.value
    if (
      state === null ||
      state.step !== 'surprise' ||
      !combatAwaitingShiftDie.value ||
      die === null
    )
      return false
    const draw = roll1d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    combatShiftRoll.value = draw.value
    const data = acceptCombat(
      resolveSurprise(state, { die, shiftDie: draw.value.total }),
      '奇袭横移',
    )
    if (data === null) return false
    combatState.value = data.state
    combatAwaitingShiftDie.value = false
    pushLog('info', `横移骰 = ${draw.value.total}（9.8）`, '9.8')
    logCombatSurprise(data.state, [draw.value])
    return true
  }

  function rollCombatDice(): boolean {
    const state = combatState.value
    if (state === null || state.step !== 'battleDice' || state.finished) return false
    const draw = roll2d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    combatDiceRoll.value = draw.value
    const data = acceptCombat(resolveCombatDice(state, { die: draw.value.total }), '战斗掷骰')
    if (data === null) return false
    combatState.value = data.state
    // 9.12a：战斗表 DG ⇒ 全部防御单位立即 DG（必须在撤退之前落盘，9.12e 要用这一事实）
    applyCombatPatches(data.patches)
    const dice = data.state.dice!
    /*
     * 5.7d：守方一旦**有战斗结果**（损失 / 选项 / DG，`Do1` 即便被忽略也算）即移除预备标记。
     * 判据取自引擎解析出的守方段 —— 攻方独占的结果（如 `Ae4`）不触发（守方没"承受"任何结果）。
     */
    if (
      dice.result.defender.losses > 0 ||
      dice.result.defender.hasOption ||
      dice.result.defender.disorganized
    )
      stripReserveMarkersAfterDefense(data.state)
    const ar = data.state.ar
    // W7 C11：附着本次战斗的复核过程（骰点 / 修正项与来源 / 合计 / 取列查表 / 结果）
    const derivation = combatDerivation({
      roll: draw.value,
      die: dice.die,
      attackerAr: ar?.attackerAr ?? 0,
      attackerArSource: ar === undefined ? '未指定' : `攻方 AR 单位 ${nameOf(ar.attackerUnitId)}`,
      defenderAr: ar?.defenderAr ?? 0,
      defenderArSource: ar === undefined ? '未指定' : `守方 AR 单位 ${nameOf(ar.defenderUnitId)}`,
      hedgehogLevel: state.hedgehogLevel,
      modifiedDice: dice.modifiedDice,
      raw: dice.result.raw,
      terrainLine: dice.result.terrainLine,
      columnLabel: data.state.surprise?.finalColumnLabel ?? data.state.odds?.columnLabel ?? '',
      ...(data.state.odds === undefined ? {} : { oddsLabel: data.state.odds.oddsLabel }),
      ...(data.state.odds === undefined
        ? {}
        : { terrain: data.state.odds.terrain.defenderTerrain }),
    })
    pushLog(
      'success',
      `战斗掷骰（9.9）：2d6 = ${draw.value.faces.join('+')} = ${draw.value.total}；` +
        `修正骰 ${dice.modifiedDice}（AR ${state.ar?.attackerAr ?? 0}−${state.ar?.defenderAr ?? 0}，工事 −${state.hedgehogLevel}）⇒ CRT「${dice.result.raw}」`,
      '9.9',
      derivation,
    )
    // ⑭ 接线：战斗掷骰（9.9）入会话日志；rolls＝本次 2d6，data 附逐项复核过程；
    // 9.10 的选项仍未结清 ⇒ 挂 pending（按 CRT 给出的选项点数分别给攻守双方）
    const pending: PendingEffect[] = []
    if (optionsOf(dice.result, 'attacker') > 0)
      pending.push({
        kind: 'option',
        unitIds: [...data.state.composition.attackerIds],
        rule: '9.10',
      })
    if (optionsOf(dice.result, 'defender') > 0)
      pending.push({
        kind: 'option',
        unitIds: [...data.state.composition.defenderIds],
        rule: '9.10',
      })
    recordSettlement({
      action: 'combatDice',
      rule: '9.9',
      rolls: [draw.value],
      pending,
      data: {
        [DERIVATION_KEY]: derivation,
        modifiedDice: dice.modifiedDice,
        raw: dice.result.raw,
      },
    })
    return true
  }

  function drawBarrageDie(state: BarrageInteractionState): number {
    // 10.0c：对设施掷一个骰子；10.0a：对战斗单位掷两枚骰子
    const draw = isFacilityBarrage(state) ? roll1d6(rng.value) : roll2d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    return draw.value.total
  }

  function rollBarrageDiceStep(): boolean {
    const state = barrageState.value
    if (state === null) return false
    if (state.step !== 'dice' || state.finished) {
      acceptBarrage({ ok: false, rule: '10.0', reason: `notAtDiceStep:${state.step}` }, '掷骰')
      return false
    }
    const inputs = barrageInputs.value
    const facility = isFacilityBarrage(state)
    if (
      (inputs.die !== null &&
        (!Number.isInteger(inputs.die) ||
          inputs.die < (facility ? 1 : 2) ||
          inputs.die > (facility ? 6 : 12))) ||
      (inputs.halfDie !== null &&
        (!Number.isInteger(inputs.halfDie) || inputs.halfDie < 1 || inputs.halfDie > 6))
    ) {
      acceptBarrage({ ok: false, rule: '10.0', reason: 'invalidBarrageDice' }, '掷骰')
      return false
    }
    // ⑭ 接线：`drawBarrageDie` 只回报数字（不改它）⇒ 先记下掷骰前的骰源，按同一颗 PRNG
    // 复算出 DiceRoll（10.0c 1 骰 / 10.0a 2 骰）供会话日志复算
    const rngBefore = rng.value
    let cursor = rngBefore
    const rolls: DiceRoll[] = []
    const die = inputs.die ?? drawBarrageDie(state)
    if (inputs.die === null) {
      const derived = isFacilityBarrage(state) ? roll1d6(cursor) : roll2d6(cursor)
      rolls.push(derived.value)
      cursor = derived.rng
    }

    let data = acceptBarrage(
      resolveBarrageDice(state, {
        die,
        ...(inputs.halfDie === null ? {} : { halfDie: inputs.halfDie }),
      }),
      '掷骰',
    )
    if (data === null) return false
    if (data.awaitingHalfDie) {
      const halfDraw = inputs.halfDie === null ? roll1d6(rng.value) : null
      if (halfDraw !== null) {
        rng.value = halfDraw.rng
        drawCount.value += 1
      }
      const halfDie = inputs.halfDie ?? halfDraw!.value.total
      if (inputs.halfDie === null) {
        const derived = roll1d6(cursor)
        rolls.push(derived.value)
        cursor = derived.rng
      }
      data = acceptBarrage(resolveBarrageDice(state, { die, halfDie }), '取整骰')
      if (data === null) return false
    }
    barrageState.value = data.state
    barrageAwaitingHalfDie.value = data.awaitingHalfDie
    const result = data.state.result
    pushLog(
      'success',
      `掷骰 ${die}${isFacilityBarrage(state) ? '（1 骰，10.0c）' : '（2 骰，10.0a）'}` +
        ` ⇒ 格值 ${result?.code ?? '?'}` +
        `${data.state.dice?.halfDie === undefined ? '' : `（取整骰 ${data.state.dice.halfDie}）`}`,
      isFacilityBarrage(state) ? '10.0c' : '10.0a',
    )
    // ⑭ 接线：轰炸掷骰（10.0a / 10.0c）入会话日志；rolls＝本笔真实掷出的骰子（含 10.0a 的取整骰）
    recordSettlement({
      action: 'barrageDice',
      rule: isFacilityBarrage(state) ? '10.0c' : '10.0a',
      rolls,
      data: {
        facility: isFacilityBarrage(state),
        die,
        halfDie: data.state.dice?.halfDie ?? null,
        code: result?.code ?? null,
      },
    })
    return true
  }

  function confirmBarrageOutcomeStep(): boolean {
    const state = barrageState.value
    if (state === null || state.step !== 'outcome' || state.finished) return false
    const inputs = barrageInputs.value
    // 10.0a：损失承受者只能是**目标格内的敌方战斗单位**（与面板输入共用同一投影）
    const eligibleUnitIds = barrageLossTargets.value.map((unit) => unit.instanceId)
    const losses = Object.entries(inputs.losses)
      .map(([unitId, steps]) => ({ unitId, steps }))
      .filter((loss) => loss.steps > 0)
    const aircraftIds =
      state.targetKind === 'airBase'
        ? ports.barrageAircraftTargets().map((air) => air.instanceId)
        : []
    if (
      Object.entries(inputs.aircraftRolls).some(
        ([id, roll]) =>
          !aircraftIds.includes(id) || !Number.isInteger(roll) || roll < 1 || roll > 6,
      )
    ) {
      acceptBarrage({ ok: false, rule: '10.0c-A', reason: 'invalidAircraftLossRoll' }, '逐机损失')
      return false
    }
    const rolls: DiceRoll[] = []
    const aircraft = (
      state.result !== undefined && parseFacilityCode(state.result.code).aircraftThreshold !== null
        ? aircraftIds
        : []
    ).map((id) => {
      const manual = inputs.aircraftRolls[id]
      if (manual !== undefined) return { id, roll: manual }
      const draw = roll1d6(rng.value)
      rng.value = draw.rng
      drawCount.value += 1
      rolls.push(draw.value)
      return { id, roll: draw.value.total }
    })

    const data = acceptBarrage(
      planBarrageOutcome(state, {
        eligibleUnitIds,
        eligibleUnits: barrageLossTargets.value.map((unit) => ({
          id: unit.instanceId,
          steps: unit.steps,
        })),
        losses,
        ...ports.facilityFacts(state.targetHex),
        aircraft,
      }),
      '结果确认',
    )
    if (data === null) return false
    barrageState.value = data.state
    applyBarragePatches(data.patches)
    // 10.0c-A：括号结果 ⇒ 格内掷骰 ≥# 的飞机各损 1 军力（引擎逐机判定；修前在交互层被丢弃、从未落盘）
    const aircraftLossIds = data.aircraftLossIds ?? []
    for (const id of aircraftLossIds) applyAirStepLoss(id)
    if (aircraftLossIds.length > 0)
      pushLog(
        'warning',
        `10.0c-A：${aircraftLossIds.length} 架飞机掷骰达标 ⇒ 各损失 1 点军力`,
        '10.0c-A',
      )
    if (data.facility !== undefined) ports.applyFacilityPatch(data.facility, state.targetHex)

    const outcome = data.state.outcome
    if (outcome?.table === 'barrage') {
      pushLog(
        'success',
        `轰炸结果（10.0a）：${outcome.value.detail}` +
          `${outcome.value.stepLosses > 0 ? `；承受者 ${losses.map((loss) => `${nameOf(loss.unitId)} ${loss.steps} 点`).join('、')}` : ''}`,
        '10.0a',
      )
    } else if (outcome?.table === 'barrage-vs-facility') {
      pushLog('success', `对设施轰炸结果（10.0c）：${outcome.value.detail}`, outcome.value.rule)
    }
    // ⑭ 接线：轰炸结果确认（10.0a 损失分配 / 10.0c 设施结果）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'barrageOutcome',
      rolls,
      rule:
        outcome === undefined
          ? '10.0a'
          : outcome.table === 'barrage-vs-facility'
            ? outcome.value.rule
            : '10.0a',
      data: {
        table: outcome?.table ?? null,
        detail: outcome?.value.detail ?? null,
        losses: losses.map((loss) => ({ unitId: loss.unitId, steps: loss.steps })),
        aircraft,
        ...(aircraftLossIds.length > 0 ? { aircraftLossIds } : {}),
        facilityPatch:
          data.facility === undefined
            ? null
            : {
                baseLevelAfter: data.facility.baseLevelAfter ?? null,
                portDamage: data.facility.portDamage ?? null,
                trainbustingPlaced: data.facility.trainbustingPlaced === true,
              },
      },
    })
    return true
  }

  return {
    combatState,
    combatError,
    combatSurpriseDie,
    combatSurpriseRoll,
    combatShiftRoll,
    combatDiceRoll,
    combatAwaitingShiftDie,
    combatInputs,
    combatSupplyCommitted,
    barrageState,
    barrageError,
    barrageInputs,
    barrageAwaitingHalfDie,
    barrageCommitted,
    resetCombat,
    resetBarrage,
    scheduleRetreatCrossings,
    resumeRetreatCrossings,
    trackSpecialPending,
    decisionRole,
    rollCombatSurprise,
    rollCombatShiftDie,
    rollCombatDice,
    rollBarrageDiceStep,
    confirmBarrageOutcomeStep,
  }
}
