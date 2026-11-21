/**
 * workbench-air-barrage-chain.ts —— B2-2c 轰炸结算链（从 workbench-air.ts 第三刀切出）
 *
 * 5 声明：beginAirBarrageNow / runBarrageChainNow / airMissionResultReady /
 * settleAirMissionNow / recordAbortedAirBarrage（两段不连续，中间夹 confirmAirMissionNow 留原处）。
 *
 * 端口 34 项：14 air 内部 + 17 按值 + 3 晚绑定（getter 传入，正文写 deps.x.value）。
 * air 的 AirDomainPorts 因此 76 → 63（删 15 个轰炸输入、加 2 个函数口）。
 */
import type { HexRef } from '@/data'
import { sameHex } from '@/engine/hex-geometry'
import type { Derivation } from '@/engine/derivation'
import type { BarrageInteractionState } from '@/engine/rules/barrage-interaction'
import type { BarrageInputs } from './engagement-inputs'
import type { createAirMissionDomain } from './air-mission'
import { hexLabel } from './workbench-model'
import type { AirInputs, ConsoleAirUnit, WorkbenchLogEntry } from './workbench-model'
import type {
  AirInteractionState,
  AirMissionKind,
  BarrageKind,
  BarrageTargetKind,
} from '@/engine/rules'

interface DepRef<T> {
  value: T
}

/** 轰炸链端口。ref/computed 一律用 DepRef 接（readonly 与 mutable 属性双向兼容）。 */
export interface AirBarrageChainDeps {
  /* air 内部（14） */
  airState: DepRef<AirInteractionState | null>
  airError: DepRef<{ rule: string; reason: string } | null>
  airInputs: DepRef<AirInputs>
  airTargetHex: DepRef<HexRef | null>
  airMissionFlyingUnits: DepRef<ConsoleAirUnit[]>
  airMissionDomain: ReturnType<typeof createAirMissionDomain>
  airMissionAbortPending: DepRef<boolean>
  airMissionKindLabel: (kind: AirMissionKind) => string
  resolveAirCargoNow: () => boolean
  finishAbortedAirMission: () => boolean
  finishAutomaticAirReturn: () => boolean
  confirmAirMissionNow: () => boolean

  /* 按值 ports（17） */
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  barrageState: DepRef<BarrageInteractionState | null>
  barrageInputs: DepRef<BarrageInputs>
  barrageKind: DepRef<BarrageKind>
  barrageTargetKind: DepRef<BarrageTargetKind>
  barrageUnitIds: DepRef<string[]>
  barragedHexesThisPhase: DepRef<string[]>
  barragedUnitIdsThisPhase: DepRef<string[]>
  barrageAirIds: DepRef<string[]>
  canReplaceBarrage: () => boolean
  clearBarrage: () => void
  beginBarrageNow: () => boolean
  confirmBarrageSupplyStep: () => boolean
  confirmBarrageShiftsStep: () => boolean
  confirmBarrageLossNow: () => boolean
  rollBarrageDiceStep: () => boolean
  confirmBarrageOutcomeStep: () => boolean

  /* 晚绑定（3，facade 用 get 传） */
  barragePickHex: DepRef<HexRef | null>
  barrageLossRequired: DepRef<number>
  barrageLossReady: DepRef<boolean>
}

export function createAirBarrageChainDomain(deps: AirBarrageChainDeps) {
  const {
    airState,
    airError,
    airInputs,
    airTargetHex,
    airMissionFlyingUnits,
    airMissionDomain,
    airMissionAbortPending,
    airMissionKindLabel,
    resolveAirCargoNow,
    finishAbortedAirMission,
    finishAutomaticAirReturn,
    confirmAirMissionNow,
    pushLog,
    barrageState,
    barrageInputs,
    barrageKind,
    barrageTargetKind,
    barrageUnitIds,
    barragedHexesThisPhase,
    barragedUnitIdsThisPhase,
    barrageAirIds,
    canReplaceBarrage,
    clearBarrage,
    beginBarrageNow,
    confirmBarrageSupplyStep,
    confirmBarrageShiftsStep,
    confirmBarrageLossNow,
    rollBarrageDiceStep,
    confirmBarrageOutcomeStep,
  } = deps

  /**
   * 14.7b / 10.2：**空军轰炸任务**在 14.2f-F（结算任务）步入轰炸结算链
   *
   * 条文依据：10.2a「空军单位**需要放置在目标上**来结算它们的轰炸」；10.0 的通用流程
   * （加总轰炸值 → 定纵列 → 目标玩家选地形横移 → 2 骰 → 结算）对空军轰炸同样适用；
   * 10.2b 短程 +1 列；**10.2c 空军轰炸没有补给消耗**；14.7「最多四个飞机可以参与同一次轰炸」
   * （超限由引擎的 `barrageEligibility` 拦）。
   *
   * ★ 做法：**复用炮兵那条交互链**（`barrageState`：宣布 → 付款 → 横移 → 骰 → 战果），
   *   只把 kind 设成 `'air'`、参炸机对齐到本任务已宣布的编成 —— 于是"结果真的落 CRT"
   *   与炮兵走同一条路径，不另造第二套结算。
   * ★ 闸门照旧留给引擎/统一闸门：本函数只对齐盘面事实，宣布是否合法由 `beginBarrageNow` 判。
   */
  function beginAirBarrageNow(): boolean {
    const state = airState.value
    const target = airTargetHex.value
    if (state === null || target === null) {
      pushLog('warning', '空军轰炸：请先选定任务格（14.2f-B）', '14.2f-B')
      return false
    }
    if (state.step !== 'resolveMission') {
      pushLog(
        'warning',
        `空军轰炸在 14.2f 的 F 步（结算任务）进行，当前步：${state.step}（14.2f-F）`,
        '14.2f-F',
      )
      return false
    }
    if (airMissionFlyingUnits.value.length === 0) {
      airError.value = { rule: '14.7', reason: 'noActiveMissionAircraft' }
      return false
    }
    /*
     * 14.7b / 14.7d：**空军轰炸与低空扫射**都走 10.2 的轰炸结算（10.0 的通用流程）——
     *   空军轰炸（14.7b）：10.2a 飞机放在目标上结算、10.2c **无补给消耗**、14.7 最多 4 机；
     *   低空扫射（14.7d）：**单机**（14.7d-B）+ 正确观察员（10.0b）+ 不得运输破坏（14.7d-D）。
     * 两者都把 kind 设成 `'air'` 并复用炮兵那条交互链（宣布 → 付款 → 横移 → 骰 → 战果）。
     */
    if (state.kind !== 'barrage' && state.kind !== 'hip_shoot' && state.kind !== 'trainbusting') {
      pushLog(
        'warning',
        `该任务不是空军轰炸（${airMissionKindLabel(state.kind)}）⇒ 不需要轰炸结算（14.7b）`,
        '14.7b',
      )
      return false
    }
    const existing = barrageState.value
    if (
      existing !== null &&
      airMissionDomain.ownsBarrage(existing) &&
      existing.kind === 'air' &&
      sameHex(existing.targetHex, target) &&
      existing.units.every((unit) => state.assignment.aircraftIds.includes(unit.unitId))
    )
      return true
    /*
     * 上一趟任务**已结算**的轰炸仍留在 `barrageState` 里 ⇒ `barrageAirUnits` 会读它的旧 `units`：
     * 新任务会带着旧飞机去宣布（`unitAlreadyBarraged`，10.0e-B），或把旧机算进本次参炸。
     * 那不归本趟任务 ⇒ 先收掉再开新场。本趟任务自己的轰炸（含未结算）不进这个分支。
     */
    if (existing !== null && existing.finished) clearBarrage()
    if (!canReplaceBarrage()) return false
    //
    // ★ 批 A 切片 2：对齐的是**轰炸目标格**，不再去改"战斗目标" ——
    //   空军轰炸借战斗工具的选定是修前的耦合（对局台没有工具时就点不出来）。
    deps.barragePickHex.value = { ...target }
    barrageKind.value = 'air'
    if (state.kind === 'trainbusting') barrageTargetKind.value = 'trainbusting'
    barrageUnitIds.value = []
    barrageAirIds.value = airMissionFlyingUnits.value.map((air) => air.instanceId)
    // 14.7d：低空扫射的标记随任务类型带入（10.0b 的观察员仍由面板声明）
    barrageInputs.value = { ...barrageInputs.value, hipShoot: state.kind === 'hip_shoot' }
    if (!beginBarrageNow()) return false
    const started = barrageState.value
    if (started === null) return false
    airMissionDomain.bindBarrage(started)
    return true
  }

  /**
   * 10.0 / 10.2：把**轰炸交互链**一次跑完（宣布 → 补给 → 横移 → 骰 → 战果）
   *
   * 只服务"自动连跑"的调用方（空军任务的 14.2f-F 步）：每一步的拒绝都会立刻返回 false 并把原因留在
   * `barrageError` 与日志里，绝不吞掉。**横移**（10.0a）是**目标玩家**的选择 ⇒ 自动连跑取
   * "不横移"（合法选择之一）；要自己选横移仍走轰炸面板的逐步按钮（验证页）。
   */
  function runBarrageChainNow(): boolean {
    for (let guard = 0; guard < 8; guard += 1) {
      const step = barrageState.value?.step
      if (step === undefined || barrageState.value?.finished === true) break
      const advanced =
        step === 'supply'
          ? confirmBarrageSupplyStep()
          : step === 'shifts'
            ? confirmBarrageShiftsStep()
            : step === 'dice'
              ? rollBarrageDiceStep()
              : step === 'outcome'
                ? confirmBarrageOutcomeStep()
                : false
      if (!advanced) return false
    }
    return barrageState.value?.finished === true
  }

  function airMissionResultReady(state: AirInteractionState): boolean {
    if (['barrage', 'hip_shoot', 'trainbusting'].includes(state.kind)) {
      // 14.2f-E：任务机全失，或轰炸宣布已被引擎拒（中止）⇒ 没有对地战果可等
      if (airMissionFlyingUnits.value.length === 0 || airMissionAbortPending.value) return true
      const barrage = barrageState.value
      if (
        barrage === null ||
        !airMissionDomain.ownsBarrage(barrage) ||
        !barrage.finished ||
        barrage.outcome === undefined ||
        !sameHex(barrage.targetHex, state.targetHex) ||
        barrage.kind !== 'air'
      ) {
        airError.value = { rule: '14.2f-F', reason: 'barrageOutcomePending' }
        pushLog('warning', '先完成本任务的轰炸结果，再确认返航', '14.2f-F')
        return false
      }
    }
    if ((state.kind === 'air_transport' || state.kind === 'air_drop') && state.cargo === null) {
      airError.value = { rule: '14.2f-F', reason: 'cargoOutcomePending' }
      pushLog('warning', '先完成货物检定和落盘，再确认返航', '14.2f-F')
      return false
    }
    return true
  }
  /**
   * 14.2f-F：面板 2 的**唯一决定**。对地三类若战果链还没跑完、空运/空投货物还没落盘，
   * 这里先补跑（10.2c：空军对地无补给消耗），再记录任务结算。
   */
  function settleAirMissionNow(): boolean {
    const state = airState.value
    if (state === null) return false
    if ((state.kind === 'air_transport' || state.kind === 'air_drop') && state.cargo === null) {
      if (!resolveAirCargoNow()) return false
    }
    const ground =
      state.kind === 'barrage' || state.kind === 'hip_shoot' || state.kind === 'trainbusting'
    if (ground && airMissionFlyingUnits.value.length === 0) {
      // 14.2f-E：任务机全被防空击落/中止 ⇒ 没有对地战果，如实记到任务结果里
      airInputs.value = {
        ...airInputs.value,
        missionNote: '任务机已中止或被摧毁，没有执行对地任务',
      }
    } else if (ground) {
      const barrage = barrageState.value
      const owns =
        barrage !== null &&
        airMissionDomain.ownsBarrage(barrage) &&
        barrage.kind === 'air' &&
        sameHex(barrage.targetHex, state.targetHex)
      const finished = barrage !== null && owns && barrage.finished && barrage.outcome !== undefined
      if (barrage !== null && owns && !barrage.finished) {
        /*
         * 10.0a：战果链停在「目标方分配损失」⇒ 面板 2 里那块选择分完再点一次「结算任务」；
         * 没分够就如实拒绝（不要静默重开会把已选的损失冲掉）。
         */
        if (deps.barrageLossRequired.value > 0 && !deps.barrageLossReady.value) {
          airError.value = { rule: '10.0a', reason: 'barrageLossPending' }
          pushLog('warning', '先给目标方分配完军力损失，再结算任务', '10.0a')
          return false
        }
        if (!confirmBarrageLossNow()) return false
        if (!runBarrageChainNow()) return false
      } else if (!finished) {
        // 轰炸宣布被引擎拒（如 10.0b 观察员不合法）⇒ 任务按中止处理并返航，
        // 否则任务态永远停在结算步：`cancelAir` 与环节推进都会以 14.1c 拒绝（状态不一致）
        if (!beginAirBarrageNow()) return finishAbortedAirMission()
        if (!runBarrageChainNow()) return false
        // 刚停在受损分配 ⇒ 停在面板 2（选完损失再点「结算任务」）
        if (barrageState.value?.finished !== true) return false
      }
      /*
       * 14.2f-F 的"任务结果"由**轰炸结论**填（G①：不能是空备注框，
       * 否则日志每次都是「（未填结果）」）。
       */
      const done = barrageState.value
      const summary =
        done?.outcome === undefined
          ? `${airMissionKindLabel(state.kind)}：轰炸已结算`
          : `${airMissionKindLabel(state.kind)}：列 ${done.table.initialColumn} → ${done.finalColumn}；${done.outcome.value.detail}`
      airInputs.value = { ...airInputs.value, missionNote: summary }
    }
    if (!confirmAirMissionNow()) return false
    // 14.2f-G：低空扫射的返航缺省即起飞基地（14.1c）⇒ 自动补完，不多出一个空返航步
    return finishAutomaticAirReturn()
  }

  /** 10.0e / 14.7d：中止的轰炸也算尝试；低空扫射不占目标格额度。 */
  function recordAbortedAirBarrage(state: AirInteractionState): void {
    if (!['barrage', 'hip_shoot', 'trainbusting'].includes(state.kind)) return
    if (state.kind !== 'hip_shoot')
      barragedHexesThisPhase.value = [
        ...new Set([...barragedHexesThisPhase.value, hexLabel(state.targetHex)]),
      ]
    barragedUnitIdsThisPhase.value = [
      ...new Set([...barragedUnitIdsThisPhase.value, ...state.assignment.aircraftIds]),
    ]
  }

  return {
    beginAirBarrageNow,
    runBarrageChainNow,
    airMissionResultReady,
    settleAirMissionNow,
    recordAbortedAirBarrage,
  }
}
