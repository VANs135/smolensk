import { computed, ref, shallowRef } from 'vue'
import type { HexRef } from '@/data'
import type { AirStatus } from '@/engine/state-types'
import type { RuleOutcome } from '@/engine/result-types'
import {
  confirmMissionStep,
  completeAirReturnStep,
  type AirInteractionState,
  type AirBaseView,
  type BarrageInteractionState,
  type AirCargoResolution,
  transportCapacityOf,
} from '@/engine/rules'
import { validateAirCargoReturns } from '@/engine/rules/air-cargo-unload'
import type { ConsoleAirUnit } from './workbench-model'
import { parseHexPath, hexLabel } from './workbench-model'
export interface AirMissionPorts {
  inputs(): { missionNote: string; returnHexText: Record<string, string> }
  profiles(): readonly { aircraftId: string; profile: string }[]
  bases(): readonly AirBaseView[]
  aircraft(): ConsoleAirUnit[]
  target(): HexRef | null
  acceptAir<T>(outcome: RuleOutcome<T>, action: string): T | null
  resultReady(state: AirInteractionState): boolean
  returnSupply(): void
  resetSupply(): void
  resetCargo(): void
  mustStayAtTarget(): boolean
  setAirStatus(id: string, status: AirStatus): void
  markAirMissionFlown(id: string): void
  nameOf(id: string): string
  pushLog(kind: 'info' | 'success' | 'warning' | 'danger', text: string, rule?: string): void
  recordSettlement(input: { action: string; rule: string; data: Record<string, unknown> }): boolean
}
/** 14.2f：飞行任务状态与返航；不使用地面MP或地面ZOC路径。 */
export function createAirMissionDomain(ports: AirMissionPorts) {
  const airState = ref<AirInteractionState | null>(null),
    airError = ref<{ rule: string; reason: string } | null>(null)
  // 14.2f-F：绑定本趟任务实际宣布的轰炸，不能借用上一趟同格的战果。
  const barrageUnits = shallowRef<BarrageInteractionState['units'] | null>(null)
  function start(state: AirInteractionState): void {
    barrageUnits.value = null
    ports.resetCargo()
    airState.value = state
  }
  function bindBarrage(state: BarrageInteractionState): void {
    barrageUnits.value = state.units
  }
  function ownsBarrage(state: BarrageInteractionState): boolean {
    return barrageUnits.value !== null && barrageUnits.value === state.units
  }
  /** 14.2f-F：任务状态由本域提交；失效计划不能再改盘面或覆盖新任务。 */
  function commitCargo(
    state: AirInteractionState,
    result: AirCargoResolution,
    apply: () => void,
  ): boolean {
    if (airState.value !== state || state.step !== 'resolveMission' || state.cargo !== null)
      return false
    apply()
    airState.value = { ...state, cargo: result }
    return true
  }
  const airInputs = computed(ports.inputs),
    airTransportProfiles = computed(ports.profiles),
    airBases = computed(ports.bases),
    airUnits = computed(ports.aircraft)
  const airTargetHex = computed(() => airState.value?.targetHex ?? ports.target())
  const { acceptAir, setAirStatus, markAirMissionFlown, nameOf, pushLog, recordSettlement } = ports
  function canReplace(): boolean {
    if (airState.value === null || airState.value.finished) return true
    airError.value = { rule: '14.2f', reason: 'airMissionInProgress' }
    pushLog(
      'warning',
      '已宣布的空军任务须完成结算及返航；如需中止，请使用规则允许的主动返航',
      '14.1c / 14.2f',
    )
    return false
  }
  function reset(force = false): boolean {
    if (!force && !canReplace()) return false
    airState.value = null
    airError.value = null
    barrageUnits.value = null
    ports.resetSupply()
    ports.resetCargo()
    return true
  }
  function confirmAirMissionNow(): boolean {
    const state = airState.value
    if (state === null) return false
    if (!ports.resultReady(state)) return false
    const note = airInputs.value.missionNote
    const data = acceptAir(confirmMissionStep(state, { note }), '任务结算')
    if (data === null) return false
    airState.value = data.state
    pushLog('success', `任务结算（14.2f-F）：${note === '' ? '（未填结果）' : note}`, '14.2f-F')
    // ⑭ 接线：任务结果记录（14.2f-F）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'airMissionResolve',
      rule: '14.2f-F',
      data: {
        kind: state.kind,
        aircraftIds: [...state.assignment.aircraftIds],
        note,
      },
    })
    return true
  }

  function completeAirReturnNow(): boolean {
    const state = airState.value
    if (state === null) return false
    /*
     * 14.9e-A（第五批批 C 切片 2）：**双程档机不返航** —— 它「在目的地空军基地变为非激活」
     * ⇒ 不进 returns（引擎对"出现在 returns 里的 A 档机"直接拒，规则号 14.9e-A），
     * 落位由引擎返回的 `stayedAircraftIds` 处理。
     */
    const aProfileIds = new Set(
      airTransportProfiles.value
        .filter((item) => item.profile === 'A')
        .map((item) => item.aircraftId),
    )
    const forcedIds = ports.mustStayAtTarget()
      ? airUnits.value.filter((air) => transportCapacityOf(air) > 0).map((air) => air.instanceId)
      : []
    const returns = state.assignment.origins
      .filter((origin) => !aProfileIds.has(origin.aircraftId))
      .map((origin) => {
        const text = airInputs.value.returnHexText[origin.aircraftId]
        const parsed = text === undefined ? null : (parseHexPath(text)[0] ?? null)
        // 未填即回原起飞基地（合法：14.1c 只要求「距离内的一个友方空军基地」）
        return {
          aircraftId: origin.aircraftId,
          baseHex:
            parsed ?? (forcedIds.includes(origin.aircraftId) ? state.targetHex : origin.baseHex),
        }
      })
    if (
      acceptAir(
        validateAirCargoReturns({
          requiresStay: ports.mustStayAtTarget(),
          transportIds: forcedIds,
          targetHex: state.targetHex,
          returns,
        }),
        '超限卸载返航',
      ) === null
    )
      return false
    const data = acceptAir(completeAirReturnStep(state, { returns, bases: airBases.value }), '返航')
    if (data === null) return false
    ports.returnSupply()
    airState.value = data.state
    for (const returned of data.state.returns) {
      const origin = state.assignment.origins.find(
        (item) => item.aircraftId === returned.aircraftId,
      )
      const air = airUnits.value.find((item) => item.instanceId === returned.aircraftId)
      if (air !== undefined && origin?.fromOffMapBox !== true) air.hex = { ...returned.baseHex }
    }
    // 14.1c：常规任务返航一律变为非激活（例外只给成功拦截的战斗机与正常距离转移的战斗机）
    for (const id of data.inactiveAircraftIds) setAirStatus(id, 'inactive')
    // 14.9e-A：双程档机留在**目的地（任务格）**（引擎已把它列入 inactive 名单）
    const stayHex = airTargetHex.value
    if (data.stayedAircraftIds.length > 0) {
      for (const id of data.stayedAircraftIds) {
        const air = airUnits.value.find((entry) => entry.instanceId === id)
        if (air !== undefined && stayHex !== null) air.hex = { ...stayHex }
      }
      pushLog(
        'info',
        `14.9e-A：${data.stayedAircraftIds.map((id) => nameOf(id)).join('、')} 双程飞法 ⇒ 在目的地变非激活（不返航）`,
        '14.9e-A',
      )
    }
    // 14.2e：本阶段这些飞机已执行过任务
    for (const origin of state.assignment.origins) markAirMissionFlown(origin.aircraftId)
    if (returns.length > 0)
      pushLog(
        'info',
        `返航（14.1c）：${returns.map((item) => `${hexLabel(item.baseHex)}`).join('、')}；均转非激活`,
        '14.1c',
      )
    // ⑭ 接线：任务返航（14.1c）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'airReturn',
      rule: '14.1c',
      data: {
        kind: state.kind,
        returns: returns.map((item) => ({
          aircraftId: item.aircraftId,
          baseHex: { ...item.baseHex },
        })),
        inactiveAircraftIds: [...data.inactiveAircraftIds],
      },
    })
    return true
  }

  return {
    airState,
    airError,
    start,
    bindBarrage,
    ownsBarrage,
    commitCargo,
    canReplace,
    reset,
    confirmAirMissionNow,
    completeAirReturnNow,
  }
}
