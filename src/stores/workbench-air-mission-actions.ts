/**
 * C9 空军交互四动作（14.2e 任务类型 / 14.2f-B 目标格 / 14.2a+14.2f 编成勾选 / 14.3d 主动返航）
 *
 * 从 `workbench.ts` 整段搬出（B3-2b21）：4 个声明 / 251 行，函数体零改写。
 * 端口 27 项 = 23 依赖 + 4 返回；依赖全部按值取（装配点在 `} = airDomain` 与
 * `} = airStateDomain`、`} = airPrimitivesDomain` 之后，那时 air 域与空军原语的解构项都已可见）。
 * 四道编成闸与返航判据仍取引擎唯一实现（`@/engine/rules`），本切片只做「盘面事实 → 引擎判据」的转述。
 */
import type { HexRef } from '@/data'
import {
  canAddAircraftAtStep,
  canFlyMission,
  canJoinMission,
  canPerformMissionThisPhase,
  canVoluntarilyReturn,
} from '@/engine/rules'
import type { AirCombatWindow, AirInteractionState, AirMissionKind } from '@/engine/rules'
import type { AirStatus } from '@/engine/state-types'
import type { createAirMissionDomain } from './air-mission'
import type { createAirSupplyDomain } from './air-supply'
import type { createAirUnitTransitDomain } from './air-unit-transit'
import { parseHexPath } from './workbench-model'
import type { AirInputs, ConsoleAirUnit, WorkbenchLogEntry } from './workbench-model'

export interface AirMissionActionsDeps {
  /** 全部空军单位（按下式找待勾选的机体） */
  airUnits: { readonly value: readonly ConsoleAirUnit[] }
  /** 格号 → 「列.行」文本（14.2f-B 目标格回显） */
  hexTextOf: (hex: HexRef) => string
  /** 写日志 */
  pushLog: (level: WorkbenchLogEntry['kind'], message: string, rule?: string) => void
  /** 空军任务域（14.2e 换类型前置裁定 / reset / start） */
  airMissionDomain: ReturnType<typeof createAirMissionDomain>
  /** 当前任务类型 */
  airMissionKind: { value: AirMissionKind | null }
  /** 交互状态机（含进行中任务的 assignment / step / 空战与高炮字段） */
  airState: { value: AirInteractionState | null }
  /** 交互错误（界面原样显示） */
  airError: { value: { rule: string; reason: string } | null }
  /** 14.2f-B 选定的任务格 */
  airTargetHex: { value: HexRef | null }
  /** 交互输入（目标格文本回填其中一项） */
  airInputs: { value: AirInputs }
  /** 已勾选的参战机体 */
  airMissionAirIds: { value: string[] }
  /** 任务内仍在飞的机体视图 */
  airMissionAirUnits: { readonly value: readonly ConsoleAirUnit[] }
  /** 空运域（14.9e 部分返航时把自载 SP 退回盒/格） */
  airSupply: ReturnType<typeof createAirSupplyDomain>
  /** 空运地面单位域（14.9e 部分返航时把自载地面单位落地） */
  airUnitTransit: ReturnType<typeof createAirUnitTransitDomain>
  /** 任务编成即时视图（14.9a 载货分配算 lostCarriers） */
  airMissionRosterNow: { readonly value: { lostCarriers?: number } | null | undefined }
  /** 宣布任务（14.2f 编成变更后重建） */
  beginAirMissionNow: () => boolean
  /** 14.9 待结货物损失（非空时不许主动返航） */
  airCargoLossPending: { readonly value: unknown }
  /** 14.9a 逐机货单归属是否可判 */
  hasCargoOwnership: (state: AirInteractionState) => boolean
  /** 14.9 直接结算货物 */
  resolveAirCargoNow: () => boolean
  /** 14.9 确认任务结论 */
  confirmAirMissionNow: () => boolean
  /** 14.9 完成返航收尾 */
  completeAirReturnNow: () => boolean
  /** 14.7 中止轰炸的记账 */
  recordAbortedAirBarrage: (state: AirInteractionState) => void
  /** 15.x 改机体状态（返航落地转非激活） */
  setAirStatus: (instanceId: string, status: AirStatus) => void
  /** 14.2e 记「本阶段已飞过」 */
  markAirMissionFlown: (instanceId: string) => void
}

export function createAirMissionActionsDomain(deps: AirMissionActionsDeps) {
  const {
    airUnits,
    hexTextOf,
    pushLog,
    airMissionDomain,
    airMissionKind,
    airState,
    airError,
    airTargetHex,
    airInputs,
    airMissionAirIds,
    airMissionAirUnits,
    airSupply,
    airUnitTransit,
    airMissionRosterNow,
    beginAirMissionNow,
    airCargoLossPending,
    resolveAirCargoNow,
    confirmAirMissionNow,
    completeAirReturnNow,
    recordAbortedAirBarrage,
    setAirStatus,
    markAirMissionFlown,
  } = deps

  /** C9：切任务类型（14.2e；换类型即作废进行中的流程） */
  function setAirMissionKind(kind: AirMissionKind): void {
    if (!airMissionDomain.canReplace()) return
    airMissionKind.value = kind
    airState.value = null
    airError.value = null
  }

  /** C9：选定任务格（14.2f-B 的目标；输入 `列.行` 文本） */
  function setAirTargetFromText(text: string): boolean {
    if (!airMissionDomain.canReplace()) return false
    const hex = parseHexPath(text)[0] ?? null
    if (hex === null) {
      pushLog('warning', `任务格格号应为「列.行」（如 36.13），收到「${text}」`, '14.2f-B')
      return false
    }
    airTargetHex.value = hex
    airInputs.value = { ...airInputs.value, targetHexText: hexTextOf(hex) }
    airState.value = null
    airError.value = null
    return true
  }

  /**
   * C9：勾选/取消一架参战飞机（14.2a 的合计上限与 14.2f 的加机窗口都由引擎裁定）
   *
   * ★ 四道闸都取引擎的**唯一实现**，不在界面里自算：
   *   · **14.1a** 非激活飞机不能执行任务（`canFlyMission`；用户 2026-09-18 报告第 8 条：
   *     「可执行空军任务的环节时点击机场，**未激活的飞机应该不可选中**」）；
   *   · **14.2f**「步骤 C 之后不能再向任务中添加飞机」（`canAddAircraftAtStep`）；
   *   · **14.2a** 一次任务合计上限 4 个空军单位（`canJoinMission`）；
   *   · **14.2e** 同一机一阶段只执行一次任务（`canPerformMissionThisPhase`）。
   *   已宣布任务中的减机须执行合法的主动返航，不能擦除任务状态。
   */
  function toggleAirMissionUnit(instanceId: string): void {
    const current = airState.value
    if (current !== null && !current.finished && airMissionAirIds.value.includes(instanceId)) {
      voluntaryReturnNow([instanceId])
      return
    }
    if (airMissionAirIds.value.includes(instanceId)) {
      airMissionAirIds.value = airMissionAirIds.value.filter((id) => id !== instanceId)
      airState.value = null
      airError.value = null
      return
    }
    const plane = airUnits.value.find((item) => item.instanceId === instanceId)
    if (current !== null && !current.finished && current.assignment.cargo.length > 0) {
      airError.value = { rule: '14.9a', reason: 'airCargoAlreadyLoaded' }
      pushLog('warning', '本次货物已装载，请完成任务后重新编组；不能通过改选飞机重复装载', '14.9a')
      return
    }
    /*
     * 14.1a：**非激活飞机不能执行任务** —— 这道闸放在最前：它是"这架飞机此刻的状态"，
     * 与"任务进行到哪一步"（14.2f）和"编成还剩几个名额"（14.2a）无关。非激活要靠 14.1d 的
     * 整备（15.1，A 段）转激活，故这里照 14.1d 指路。
     */
    if (plane !== undefined && !canFlyMission(plane.airStatus)) {
      airError.value = { rule: '14.1a', reason: `aircraftNotActive:${instanceId}` }
      pushLog(
        'warning',
        `14.1a：${plane.name} 处于**非激活**状态 ⇒ 不能执行任务；` +
          `需在**整备阶段**（15.1，A 段）整备后转激活（14.1d）`,
        '14.1a',
      )
      return
    }
    const step = airState.value?.step
    // 14.2f：「步骤 C 之后不能再添加飞机」；已结束（done）当然也不能
    const canAdd = step === undefined ? true : step === 'done' ? false : canAddAircraftAtStep(step)
    if (!canAdd) {
      airError.value = { rule: '14.2f', reason: `cannotAddAircraftAtStep:${String(step)}` }
      pushLog(
        'warning',
        `14.2f：任务已过**移动**步（当前 ${String(step)}）⇒ 不能再添加飞机；如需改变编成请先放弃本次任务并重新宣布`,
        '14.2f',
      )
      return
    }
    /*
     * 14.7d-B（第五批批 C 切片 3）：「低空扫射必须由**单独一个飞机**完成」
     * ⇒ 任务类型为低空扫射时，编成上限 1 架（放在 14.2a 的 4 架上限之前——更具体的限制优先）。
     */
    if (airMissionKind.value === 'hip_shoot' && airMissionAirIds.value.length >= 1) {
      airError.value = { rule: '14.7d-B', reason: 'hipShootMustBeSingleAircraft' }
      pushLog(
        'warning',
        '14.7d-B：低空扫射必须由**单独一个**飞机完成 ⇒ 不能再加机（如需换机请先取消已选）',
        '14.7d-B',
      )
      return
    }
    const join = canJoinMission(airMissionAirIds.value.length, 1)
    if (!join.ok) {
      airError.value = { rule: join.rule, reason: join.reason }
      pushLog(
        'warning',
        `14.2a：一次任务合计上限 4 个空军单位 ⇒ 不能再加（已选 ${airMissionAirIds.value.length} 架）`,
        '14.2a',
      )
      return
    }
    if (plane !== undefined && !canPerformMissionThisPhase(plane.missionsFlownThisPhase)) {
      airError.value = {
        rule: '14.2e',
        reason: `aircraftAlreadyFlewMissionThisPhase:${instanceId}`,
      }
      pushLog('warning', `${plane.name} 本阶段已执行过一次任务（14.2e：一阶段一次）`, '14.2e')
      return
    }
    airMissionAirIds.value = [...airMissionAirIds.value, instanceId]
    if (current !== null && !current.finished) {
      airMissionDomain.reset(true)
      if (!beginAirMissionNow()) {
        airMissionDomain.start(current)
        airMissionAirIds.value = [...current.assignment.aircraftIds]
      }
      return
    }
    airState.value = null
    airError.value = null
  }

  /**
   * C9：14.3d 的**主动返航**（空战前 / 空战后两个窗口，空战中一律不许）
   *
   * 判据只有引擎一处（`canVoluntarilyReturn`）；本处只把「窗口」与「返航后仍留几架激活」
   * 这两项盘面事实填进去。★ 14.3d-A：空战前允许部分返航，但**至少留 1 架**保持激活并战斗。
   */
  function voluntaryReturnNow(aircraftIds: readonly string[]): boolean {
    const state = airState.value
    if (state === null) {
      airError.value = { rule: '14.3d', reason: 'noMissionInProgress' }
      pushLog('warning', '先宣布任务，再谈主动返航（14.3d）', '14.3d')
      return false
    }
    if (
      state.finished ||
      state.step === 'returnToBase' ||
      state.cargo !== null ||
      (state.interception?.declared && state.interception.combat === null)
    ) {
      airError.value = { rule: '14.2f', reason: 'completePendingAirStepBeforeReturn' }
      return false
    }
    // 14.3d 的窗口由空战步是否已结算推出：未宣告空战 ⇒ 空战前；已结算 ⇒ 空战后；正在打 ⇒ 空战中
    const window: AirCombatWindow =
      state.combat === null
        ? 'beforeAirCombat'
        : state.airCombat === null && state.combat.occurs
          ? 'duringAirCombat'
          : 'afterAirCombat'
    const flying = airMissionAirUnits.value.filter((air) => air.airStatus === 'active')
    const leaving = flying.filter((air) => aircraftIds.includes(air.instanceId))
    if (leaving.length === 0 || state.finished || airCargoLossPending.value !== null) {
      airError.value = { rule: '14.3d', reason: 'noEligibleVoluntaryReturn' }
      return false
    }
    const returnedCargoIds = new Set<string>()
    if (state.assignment.cargo.length > 0 && leaving.length < flying.length) {
      /*
       * 14.9a/14.9e（T15）：只有能按逐机货单归属时，才允许载货任务部分返航；
       * 返航机把**自载**货物带回自己的基地。
       *
       * 14.9（T16）+ 专规 1.4a：离图盒起飞的机体同样可以途中部分返航——机体回盒、
       * 自载 SP 加回盒库存；其余机体**留场**继续任务（14.9e：各机按自身归宿分别处理）。
       *
       * 2026-11-23（用户口径）：原本"无逐机货单 ⇒ 拒绝部分返航"。现在不再拒：
       * 无货单时**不猜**哪件货在谁机上（14.9a 允许同基地多机合并容量运输），
       * 返航机空机返回、货物仍随留场机继续任务；归属可判时照旧逐机带回。
       */
      const leavingOrigins = state.assignment.origins.filter((origin) =>
        leaving.some((air) => air.instanceId === origin.aircraftId),
      )
      for (const origin of leavingOrigins) {
        const ids =
          state.assignment.cargoByAircraft.find((entry) => entry.aircraftId === origin.aircraftId)
            ?.cargoIds ?? []
        const unitIds = ids.filter((id) => id.startsWith('unit:'))
        const spIds = ids.filter((id) => id.startsWith('sp:'))
        if (unitIds.length > 0) {
          if (!airUnitTransit.land(unitIds, origin.baseHex, 'returned')) return false
        }
        if (spIds.length > 0) {
          // 离图盒机：回任务来源盒（undefined ⇒ 用 manifest 的 originOffMapBox）；
          // 图上机场机：强制落地图格（null），避免混合来源时被误送进盒里。
          airSupply.returnRemaining(
            origin.baseHex,
            spIds,
            origin.fromOffMapBox === true ? undefined : null,
          )
        }
        ids.forEach((id) => returnedCargoIds.add(id))
      }
    }
    const verdict = canVoluntarilyReturn({
      window,
      friendlyActiveRemainingAfterReturn: flying.length - leaving.length,
    })
    if (!verdict.ok) {
      airError.value = { rule: verdict.rule, reason: verdict.reason }
      pushLog('warning', `主动返航被拒：${verdict.reason}（${verdict.rule}）`, verdict.rule)
      return false
    }
    if (state.assignment.cargo.length > 0 && leaving.length === flying.length) {
      if ((airMissionRosterNow.value?.lostCarriers ?? 0) > 0 && state.flak?.hit !== true) {
        airError.value = { rule: '14.9a', reason: 'cargoCarrierAllocationRequired' }
        return false
      }
      // 载货整组中止仍通过F/G提交，不能直接退款并擦除任务。
      for (const air of leaving) setAirStatus(air.instanceId, 'inactive')
      airState.value = { ...state, step: 'resolveMission' }
      if (!resolveAirCargoNow() || !confirmAirMissionNow()) return false
      return completeAirReturnNow()
    }
    const leavingIds = new Set(leaving.map((air) => air.instanceId))
    for (const air of leaving) {
      setAirStatus(air.instanceId, 'inactive')
      markAirMissionFlown(air.instanceId)
    }
    const remainingIds = state.assignment.aircraftIds.filter((id) => !leavingIds.has(id))
    if (remainingIds.length === 0) airSupply.returnRemaining()
    if (remainingIds.length === 0) recordAbortedAirBarrage(state)
    airState.value = {
      ...state,
      assignment: {
        ...state.assignment,
        aircraftIds: remainingIds,
        origins: state.assignment.origins.filter((origin) => !leavingIds.has(origin.aircraftId)),
        cargo: state.assignment.cargo.filter((item) => !returnedCargoIds.has(item.id)),
        cargoByAircraft: state.assignment.cargoByAircraft
          .filter((entry) => !leavingIds.has(entry.aircraftId))
          .map((entry) => ({
            ...entry,
            cargoIds: entry.cargoIds.filter((id) => !returnedCargoIds.has(id)),
          })),
      },
      ...(remainingIds.length === 0 ? { step: 'done', finished: true } : {}),
    }
    airMissionAirIds.value = airMissionAirIds.value.filter((id) => !leavingIds.has(id))
    airError.value = null
    pushLog(
      'success',
      `14.3d（${verdict.rule}）：${leaving.map((air) => air.name).join('、')} 主动返航 ⇒ 转非激活；` +
        `任务内仍留 ${flying.length - leaving.length} 架激活`,
      verdict.rule,
    )
    return true
  }

  return { setAirMissionKind, setAirTargetFromText, toggleAirMissionUnit, voluntaryReturnNow }
}
