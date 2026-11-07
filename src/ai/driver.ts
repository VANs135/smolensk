/**
 * B3：基线 AI 的**驱动层**（把 `policy.ts` 的纯决策翻译成既有 submit 入口调用）
 *
 * 硬约束：
 * - 只调用 workbench / setup / session 已公开的提交入口；不直接改 `units` / `spDumps` / session 内部状态。
 *   仅按既有 UI 语义给「输入对象」赋值（`combatInputs` / `combatSupplyDumpIds` / `combatRetreatPlans` /
 *   `barrageInputs` / `attritionAllocation` / `selectedId`）。
 * - 不使用 `Math.random`，不额外消费引擎骰流；同种子 + 同盘面 ⇒ 同决策。
 * - 提交失败就记录（按 rule 分组）并换下一个候选，不做「我认为合法」的预判。
 */
import { nextTick } from 'vue'

import { formatHexPath } from '@/stores/workbench-model'
import type { useGameSessionStore } from '@/stores/session'
import type { useSetupStore } from '@/stores/setup'
import type { useWorkbenchStore } from '@/stores/workbench'

import {
  actionKeyOf,
  decideAiAction,
  hexKeyOf,
  type AiAction,
  type AiHex,
  type AiSnapshot,
  type AiSide,
} from './policy'

export interface AiContext {
  workbench: ReturnType<typeof useWorkbenchStore>
  session: ReturnType<typeof useGameSessionStore>
  setup: ReturnType<typeof useSetupStore>
}

export interface AiMemory {
  token: string
  movedUnitIds: string[]
  moveTargets: string[]
  reserveUnitIds: string[]
  barrageTargets: string[]
  combatHexes: string[]
}

export function createAiMemory(): AiMemory {
  return {
    token: '',
    movedUnitIds: [],
    moveTargets: [],
    reserveUnitIds: [],
    barrageTargets: [],
    combatHexes: [],
  }
}

export interface AiStepResult {
  turn: number
  phase: string
  segment: string
  side: AiSide
  intent: string
  ok: boolean
  rule?: string
  reason?: string
}

export interface AiRefusal {
  turn: number
  phase: string
  segment: string
  side: AiSide
  intent: string
  rule: string
  reason: string
}

export interface AiSelfPlayReport {
  scenarioId?: string
  turn: number
  phase: string
  segment: string
  activeSide: AiSide
  targetTurn: number
  reachedTarget: boolean
  terminated: boolean
  iterations: number
  stalls: string[]
  refused: AiRefusal[]
  refusedByRule: Record<string, number>
  warnings: string[]
  noLegal: number
  awaiting: boolean
}

export interface AiSelfPlayOptions {
  ctx: AiContext
  targetTurns: number
  scenarioId?: string
  limit?: number
  memory?: AiMemory
}

function tokenOf(w: ReturnType<typeof useWorkbenchStore>): string {
  return `${String(w.turn)}|${String(w.phase)}|${String(w.activeSide)}|${String(w.segmentStepIndex)}`
}

function sideOf(w: ReturnType<typeof useWorkbenchStore>): AiSide {
  return (w.segmentGateQuery.side ?? w.activeSide) as AiSide
}

function syncMemory(memory: AiMemory, w: ReturnType<typeof useWorkbenchStore>): void {
  const token = tokenOf(w)
  if (memory.token === token) return
  memory.token = token
  memory.movedUnitIds = []
  memory.moveTargets = []
  memory.reserveUnitIds = []
  memory.barrageTargets = []
  memory.combatHexes = []
}

function dedupeSortedHexes(hexes: readonly AiHex[]): AiHex[] {
  const seen = new Map<string, AiHex>()
  for (const hex of hexes) seen.set(hexKeyOf(hex), hex)
  return [...seen.values()].sort((a, b) => a.col - b.col || a.row - b.row)
}

/**
 * 稳定排序键：`格号|型号`
 *
 * `instanceId` 由 `shared/id.ts` 的 `Date.now()` + **未补零的 base36 序号**拼成，
 * 跨进程必然不同、且序号过 36 后字典序不再等于创建顺序 —— 用它做先后判据会让
 * 「同种子 + 同盘面」两次运行选出不同的单位（实测：剧本 1 的 drawCount 223 vs 234）。
 * 故快照里所有「需要挑一个」的列表都在这里按**盘面位置 + 型号**排好，策略层不再排序。
 */
function compareStableUnit(
  a: { hex: AiHex; unitId: string },
  b: { hex: AiHex; unitId: string },
): number {
  const ac = a.hex.col
  const bc = b.hex.col
  if (ac !== bc) return ac - bc
  if (a.hex.row !== b.hex.row) return a.hex.row - b.hex.row
  return a.unitId.localeCompare(b.unitId)
}

function snapshotOf(ctx: AiContext, memory: AiMemory): AiSnapshot {
  const w = ctx.workbench
  const side = sideOf(w)
  syncMemory(memory, w)

  const friendly = w.units.filter((unit) => unit.side === side)
  const enemy = w.units.filter((unit) => unit.side !== side)
  const enemyHexes = dedupeSortedHexes(enemy.map((unit) => unit.hex))
  const participating = [...w.participatingUnitIds]
  const candidates = participating
    .map((id) => w.units.find((unit) => unit.instanceId === id))
    .filter((unit): unit is NonNullable<typeof unit> => unit !== undefined)
    .filter((unit) => unit.side === side && !unit.movementEnded)
    .sort(compareStableUnit)
    .map((unit) => unit.instanceId)

  const interaction = w.moveInteraction
  const moveActive = interaction !== null && !interaction.finished
  const hasStepped = interaction !== null && interaction.steps.length > 0
  const currentHexKeys = new Set(friendly.map((unit) => hexKeyOf(unit.hex)))
  const visitedHexKeys = new Set(interaction?.steps.map((step) => hexKeyOf(step.to)) ?? [])
  // 仅「刚开拔、还没落子」时算可达格（groupReachable 是重投影，别每步都算）
  const reachableHexes =
    moveActive && !hasStepped
      ? (w.groupReachable.hexes as { hex: AiHex }[])
          .map((node) => node.hex)
          .filter((hex) => !visitedHexKeys.has(hexKeyOf(hex)) && !currentHexKeys.has(hexKeyOf(hex)))
      : []

  // 相邻的敌方守方格（仅作候选；合法性由 select/begin 入口判定）
  const combatRelevant =
    w.phase === 'combat' ||
    w.phase === 'exploitation' ||
    w.combatState !== null ||
    w.battleTarget !== null
  const adjacentDefenderHexes = combatRelevant
    ? dedupeSortedHexes(
        enemy
          .filter((unit) => unit.isCombat)
          .filter((unit) =>
            friendly.some((friend) => {
              if (!friend.attackCapable) return false
              const d = Math.abs(friend.hex.col - unit.hex.col)
              const r = Math.abs(friend.hex.row - unit.hex.row)
              return (d === 1 && r === 0) || (d === 0 && r === 1) || (d === 1 && r === 1)
            }),
          )
          .map((unit) => unit.hex),
      ).filter((hex) => !w.attackPhaseLedger.hexes.some((key) => key === hexKeyOf(hex)))
    : []

  const supplyDumps = combatRelevant ? w.combatSupplyDumps : []
  const attackerDumpIds = supplyDumps
    .filter((entry) => entry.side === 'attacker')
    .flatMap((entry) => entry.dumps.map((dump) => dump.id))
  const defenderDumpIds = supplyDumps
    .filter((entry) => entry.side === 'defender')
    .flatMap((entry) => entry.dumps.map((dump) => dump.id))

  const barrageState = w.barrageState
  const barrageRelevant = barrageState !== null || (w.segmentStep?.id ?? '').endsWith('.barrage')
  const barrageOutcome = barrageState?.outcome
  const outcomeStepLosses =
    barrageOutcome !== undefined &&
    barrageOutcome !== null &&
    'value' in barrageOutcome &&
    typeof barrageOutcome.value === 'object' &&
    barrageOutcome.value !== null &&
    'stepLosses' in barrageOutcome.value &&
    typeof barrageOutcome.value.stepLosses === 'number'
      ? barrageOutcome.value.stepLosses
      : 0

  const plan = w.phase === 'supply' ? w.supplyPhasePlan : null
  const duties =
    plan?.attritionDuty.map((duty) => {
      const key = `${String(duty.hex.col)}.${String(duty.hex.row)}`
      const result = w.attritionResults[key]
      return {
        key,
        applied: w.attritionAppliedHexes.includes(key),
        rolled: result !== undefined,
        needAllocation: result !== undefined && w.attritionNeedsAllocation(key),
        lossesKind: result?.losses.kind ?? 'none',
        lossesSteps: result?.losses.kind === 'steps' ? result.losses.steps : 0,
        units: duty.unitIds
          .map((id) => w.units.find((unit) => unit.instanceId === id))
          .filter((unit): unit is NonNullable<typeof unit> => unit !== undefined)
          .sort(compareStableUnit)
          .map((unit) => ({ id: unit.instanceId, steps: unit.steps })),
      }
    }) ?? []

  // 与 legal-actions-store 的 `advance.available` 同一口径（段锁定 / 初设时不可推进）
  const advanceAvailable = !w.segmentLocked && !w.initialSetupInProgress

  return {
    turn: w.turn,
    phase: w.phase,
    segment: w.segmentStep?.id ?? '',
    segmentStepIndex: w.segmentStepIndex,
    activeSide: w.activeSide as AiSide,
    terminated: ctx.session.terminated,
    awaitingOptionIds: ctx.session.awaiting
      ? (ctx.session.question?.options ?? []).map((o) => o.id)
      : [],
    setupInProgress: w.initialSetupInProgress,
    locked: w.segmentLocked,
    can: w.segmentActionKeys,
    advanceAvailable: advanceAvailable && !w.initialSetupInProgress,
    pendingZocConfirm: w.pendingZocConfirm !== null,
    specialPending: w.specialPending !== null,
    reserveUnitIds: friendly
      .filter((unit) => unit.mode.mode === 'reserve' && participating.includes(unit.instanceId))
      .sort(compareStableUnit)
      .map((unit) => unit.instanceId),
    reserveTriedUnitIds: memory.reserveUnitIds,
    move: {
      active: moveActive,
      hasStepped,
      selectedIds: moveActive ? (interaction?.unitIds ?? []) : [],
      reachableHexes,
      triedUnits: memory.movedUnitIds,
      triedTargets: memory.moveTargets,
      candidates,
      enemyHexes,
    },
    barrage: {
      state:
        barrageState === null
          ? null
          : {
              step: barrageState.step,
              kind: barrageState.kind,
              targetHex: barrageState.targetHex ?? null,
              costT: barrageState.table.costT,
            },
      choices: barrageRelevant
        ? w.barrageUnitChoices
            .map((choice) => choice.unit)
            .sort(compareStableUnit)
            .map((unit) => ({
              unitId: unit.instanceId,
              disabled: w.barrageUnitChoices.find((c) => c.unit.instanceId === unit.instanceId)
                ?.disabledReason
                ? true
                : false,
            }))
        : [],
      selectedUnitIds: barrageRelevant ? w.barrageUnits.map((unit) => unit.instanceId) : [],
      targetHex: barrageRelevant ? w.barrageTargetHex : null,
      supplyDumpIds: barrageRelevant ? w.barrageSupplyDumpChoices.map((dump) => dump.id) : [],
      triedTargets: memory.barrageTargets,
      enemyHexes,
      outcomeStepLosses,
      lossTargets: barrageRelevant
        ? w.barrageLossTargets
            .slice()
            .sort(compareStableUnit)
            .map((unit) => ({ unitId: unit.instanceId, steps: unit.steps }))
        : [],
    },
    combat: {
      state:
        w.combatState === null
          ? null
          : {
              step: w.combatState.step,
              finished: w.combatState.finished,
              declaredAttackerArUnitId: w.combatState.declaredAttackerArUnitId,
            },
      defenderHex: w.battleTarget?.hex ?? null,
      adjacentDefenderHexes,
      attackerDumpIds,
      defenderDumpIds,
      requirement:
        w.combatRequirement === null
          ? null
          : {
              side: w.combatRequirement.side,
              losses: w.combatRequirement.losses,
              options: w.combatRequirement.options,
            },
      retreatPlans: combatRelevant
        ? w.combatRetreatPlans.flatMap((plan) =>
            plan.units.map((row) => ({
              unitId: row.unitId,
              chosen: row.chosen,
              destinations: row.destinations.map((destination) => ({
                hex: destination.hex,
                forcedDestruction: destination.forcedDestruction,
                inEnemyZoc: destination.inEnemyZoc,
                path: destination.path,
              })),
            })),
          )
        : [],
      triedDefenderHexes: memory.combatHexes,
    },
    supply: {
      planLoaded: plan !== null && plan !== undefined,
      recoverySettled: w.supplyRecoverySettled,
      feedingSettled: w.supplyFeedingSettled,
      duties,
    },
  }
}

function ruleFromStores(w: ReturnType<typeof useWorkbenchStore>): string | null {
  return (
    w.actionRefusal?.rule ??
    w.moveBlocked?.rule ??
    w.combatError?.rule ??
    w.barrageError?.rule ??
    w.supplyPhaseError?.rule ??
    null
  )
}

function execute(action: AiAction, ctx: AiContext, memory: AiMemory): boolean {
  const w = ctx.workbench
  switch (action.kind) {
    case 'answer':
      return ctx.session.answerNow(action.optionId)
    case 'advance':
      return w.advanceSegmentNow() !== null
    case 'preset': {
      const result = ctx.setup.presetSelfSetupNow()
      return result.remaining === 0
    }
    case 'modeChange': {
      memory.reserveUnitIds.push(action.unitId)
      w.selectedId = action.unitId
      w.switchUnitMode('combat')
      const unit = w.units.find((item) => item.instanceId === action.unitId)
      return unit !== undefined && unit.mode.mode === 'combat'
    }
    case 'moveBegin': {
      memory.movedUnitIds.push(action.unitId)
      return w.beginMoveFor([action.unitId])
    }
    case 'moveClick': {
      const stepsBefore = w.moveInteraction?.steps.length ?? 0
      w.clickHex(action.hex)
      const stepsAfter = w.moveInteraction?.steps.length ?? 0
      const zoc = w.pendingZocConfirm !== null
      const finished = w.moveInteraction?.finished ?? false
      const ok = zoc || finished || stepsAfter > stepsBefore
      if (!ok) memory.moveTargets.push(hexKeyOf(action.hex))
      return ok
    }
    case 'moveFinish':
      w.finishMove()
      return true
    case 'zocConfirm':
      w.confirmZocEntry()
      return w.pendingZocConfirm === null
    case 'specialConfirm': {
      for (const item of w.specialPending?.items ?? []) {
        const candidate = item.candidates[0]
        if (item.chosen === null && candidate !== undefined)
          w.setSpecialDisplacement(item.unitId, candidate)
      }
      return w.confirmSpecialCombatNow()
    }
    case 'barrageTarget': {
      w.clickHex(action.hex)
      return w.barrageTargetHex !== null && hexKeyOf(w.barrageTargetHex) === hexKeyOf(action.hex)
    }
    case 'barrageToggleUnit': {
      w.toggleBarrageUnit(action.unitId)
      return w.barrageUnits.some((unit) => unit.instanceId === action.unitId)
    }
    case 'barrageBegin': {
      const ok = w.beginBarrageNow()
      if (!ok && w.barrageTargetHex !== null)
        memory.barrageTargets.push(hexKeyOf(w.barrageTargetHex))
      return ok
    }
    case 'barrageSupply':
      if (action.dumpId !== null) w.pickBarrageSupplyDump(action.dumpId)
      return w.confirmBarrageSupplyStep()
    case 'barrageShifts':
      return w.confirmBarrageShiftsStep()
    case 'barrageDice':
      return w.rollBarrageDiceStep()
    case 'barrageOutcome': {
      const losses: Record<string, number> = {}
      for (const loss of action.losses) losses[loss.unitId] = loss.steps
      w.barrageInputs = { ...w.barrageInputs, losses }
      return w.confirmBarrageOutcomeStep()
    }
    case 'barrageCancel':
      w.cancelBarrage()
      return true
    case 'combatSelect': {
      w.selectCombatDefenderHex(action.hex)
      const ok = w.battleTarget !== null && hexKeyOf(w.battleTarget.hex) === hexKeyOf(action.hex)
      if (!ok) memory.combatHexes.push(hexKeyOf(action.hex))
      return ok
    }
    case 'combatBegin': {
      const ok = w.beginCombatNow()
      if (!ok && w.battleTarget !== null) memory.combatHexes.push(hexKeyOf(w.battleTarget.hex))
      return ok
    }
    case 'combatSupply': {
      w.pickCombatSupplyDump('attacker', action.attackerDumpId)
      if (action.defenderDumpId !== null) w.pickCombatSupplyDump('defender', action.defenderDumpId)
      else w.combatInputs = { ...w.combatInputs, defenderProvides: false }
      const ok = w.confirmCombatSupply()
      if (!ok && w.battleTarget !== null) {
        memory.combatHexes.push(hexKeyOf(w.battleTarget.hex))
        w.cancelCombat()
      }
      return ok
    }
    case 'combatDeclareAr':
      return w.declareCombatArStep(action.side)
    case 'combatAutoResolve':
      return w.autoResolveCombatToOutcome()
    case 'combatLosses':
      return w.confirmCombatLosses()
    case 'combatOptions': {
      const requirement = w.combatRequirement
      if (requirement === null) return false
      const attempt = (
        retreatHexes: number,
        lossPoints: number,
        ignoreOptions: boolean,
      ): boolean => {
        w.combatInputs = {
          ...w.combatInputs,
          optionRetreatHexes: retreatHexes,
          optionLossPoints: lossPoints,
          ignoreOptions,
        }
        return w.confirmCombatOptions()
      }
      if (attempt(action.retreatHexes, action.lossPoints, action.ignoreOptions)) return true
      if (attempt(0, requirement.options, false)) return true
      if (requirement.side === 'defender' && attempt(requirement.options, 0, true)) return true
      return false
    }
    case 'combatRetreatPaths': {
      const retreatPaths = { ...w.combatInputs.retreatPaths }
      for (const entry of action.paths) retreatPaths[entry.unitId] = formatHexPath(entry.path)
      w.combatInputs = { ...w.combatInputs, retreatPaths }
      return w.confirmCombatRetreats()
    }
    case 'combatAdvance':
      return w.confirmCombatAdvance()
    case 'combatSkip':
      if (w.battleTarget !== null) memory.combatHexes.push(hexKeyOf(w.battleTarget.hex))
      w.cancelCombat()
      return true
    case 'supplyPlan':
      return w.planSupplyPhaseNow()
    case 'supplyRecovery':
      return w.applySupplyPhaseRecoveryNow()
    case 'supplyFeeding':
      return w.applySupplyPhaseFeedingNow()
    case 'attritionRoll':
      return w.rollAttritionNow(action.key)
    case 'attritionApply': {
      for (const entry of action.allocation)
        w.setAttritionAllocation(action.key, entry.unitId, entry.steps)
      return w.applyAttritionNow(action.key)
    }
    case 'none':
      return false
  }
}

export function runAiStep(ctx: AiContext, options?: { memory?: AiMemory }): AiStepResult {
  const memory = options?.memory ?? createAiMemory()
  const w = ctx.workbench
  const snapshot = snapshotOf(ctx, memory)
  const action = decideAiAction(snapshot)

  /*
   * 诊断：`pushLog` 用 `unshift` 且把 `log` 截到 60 条（workbench.ts:4968-4975），
   * 满 60 后长度不再增长 ⇒ 用「执行前后的长度差」取新增日志会在整局后段恒为空，
   * 拒绝原因随之退化成 `unknown`。改为按**栈顶 id** 取边界：新条目都在旧栈顶之上。
   */
  const topBefore = w.log[0]?.id ?? null
  const ok = execute(action, ctx, memory)
  const added =
    topBefore === null
      ? [...w.log]
      : w.log.slice(
          0,
          Math.max(
            0,
            w.log.findIndex((entry) => entry.id === topBefore),
          ),
        )
  /*
   * 取「本次提交最早一条带 rule 的新增日志」：日志是 `unshift`（新在前），故从尾部回溯。
   * 驱动自身的收尾日志（如 `combatSupply` 失败后补 `cancelCombat`）会盖在最上面，
   * 用最新的那条会把真实拒绝原因遮成「放弃本场战斗（9.2）」。
   */
  let failureEntry: (typeof w.log)[number] | undefined
  for (let index = added.length - 1; index >= 0; index -= 1) {
    const entry = added[index]!
    if (typeof entry.rule === 'string') {
      failureEntry = entry
      break
    }
  }
  failureEntry ??= added[added.length - 1]
  const rule = ok ? undefined : (failureEntry?.rule ?? ruleFromStores(w) ?? 'unknown')
  const reason = ok ? undefined : (failureEntry?.text ?? `提交被拒：${action.kind}`)

  return {
    turn: snapshot.turn,
    phase: snapshot.phase,
    segment: snapshot.segment,
    side: sideOf(w),
    intent: actionKeyOf(action),
    ok,
    rule,
    reason,
  }
}

/**
 * 双 AI 自对打：同一进程内驱动到 `targetTurns`（或会话正常终止）。
 *
 * 死锁判据：`turn|phase|activeSide|segmentStepIndex` + awaiting + 已落盘损耗数
 * 与**同一条决策**连续 3 次无进展 ⇒ 记录 stall 并停止。
 */
export async function runAiSelfPlay(options: AiSelfPlayOptions): Promise<AiSelfPlayReport> {
  const { ctx } = options
  const w = ctx.workbench
  const memory = options.memory ?? createAiMemory()
  const limit = options.limit ?? 12000
  const targetTurn = w.turn + options.targetTurns
  const stalls: string[] = []
  const refused: AiRefusal[] = []
  const refusedByRule: Record<string, number> = {}
  const warnings: string[] = []
  let noLegal = 0
  let iterations = 0
  let lastToken = ''
  let lastDecision = ''
  let sameState = 0
  let logLength = w.log.length

  // 到达目标回合时若还挂着盘面提问（回合开始的天气/先手等），先把它答完再收尾——
  // 否则报告会停在「有未处理 awaiting」的状态，而这并非 AI 漏判。
  while (
    !ctx.session.terminated &&
    (w.turn < targetTurn || ctx.session.awaiting) &&
    iterations < limit
  ) {
    const result = runAiStep(ctx, { memory })
    iterations += 1

    const fresh = logLength <= w.log.length ? w.log.slice(0, w.log.length - logLength) : []
    logLength = w.log.length
    for (const entry of fresh) {
      if (entry.kind === 'warning' || entry.kind === 'danger') warnings.push(entry.text)
    }

    if (!result.ok) {
      const rule = result.rule ?? 'unknown'
      refused.push({
        turn: result.turn,
        phase: result.phase,
        segment: result.segment,
        side: result.side,
        intent: result.intent,
        rule,
        reason: result.reason ?? '',
      })
      refusedByRule[rule] = (refusedByRule[rule] ?? 0) + 1
    }

    if (result.intent === 'none') noLegal += 1

    const token = `${String(w.turn)}|${String(w.phase)}|${String(w.activeSide)}|${String(w.segmentStepIndex)}|${String(
      ctx.session.awaiting,
    )}|${String(w.attritionAppliedHexes.length)}`
    if (token === lastToken && result.intent === lastDecision) sameState += 1
    else {
      sameState = 1
      lastToken = token
      lastDecision = result.intent
    }
    if (sameState >= 3) {
      const latest = w.log[0]?.text ?? ''
      stalls.push(
        `剧本 ${options.scenarioId ?? '?'} 回合 ${String(w.turn)} 阶段 ${w.phase} 环节 ${w.segmentStep?.id ?? ''} ` +
          `决策 ${result.intent} 连续 3 次无进展；rule=${result.rule ?? 'unknown'} reason=${result.reason ?? ''} 最近日志=${latest}`,
      )
      break
    }

    if (noLegal >= 3) {
      stalls.push(
        `剧本 ${options.scenarioId ?? '?'} 回合 ${String(w.turn)} 阶段 ${w.phase} 环节 ${w.segmentStep?.id ?? ''} ` +
          `noLegal 连续 ${String(noLegal)} 次：视图无可提交动作且无法推进/无待答`,
      )
      break
    }

    await nextTick()
  }

  return {
    scenarioId: options.scenarioId,
    turn: w.turn,
    phase: w.phase,
    segment: w.segmentStep?.id ?? '',
    activeSide: w.activeSide as AiSide,
    targetTurn,
    reachedTarget: w.turn >= targetTurn,
    terminated: ctx.session.terminated,
    iterations,
    stalls,
    refused,
    refusedByRule,
    warnings,
    noLegal,
    awaiting: ctx.session.awaiting,
  }
}
