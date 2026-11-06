import { ref } from 'vue'
import type { RngState, DiceRoll } from '@/engine/state-types'
import type { RuleOutcome } from '@/engine/result-types'
import { roll2d6 } from '@/engine/rng'
import { planAirCargoContinuation, type airMissionRoster } from '@/engine/rules/air-mission-roster'
import {
  resolveAirTransportDelivery,
  resolveAirCargoDrop,
  type AirInteractionState,
  type AirCargoResolution,
} from '@/engine/rules/air-interaction'
import {
  planAirCargoUnload,
  applyAirCargoUnloadResult,
  type AirCargoUnloadPlan,
} from '@/engine/rules/air-cargo-unload'

export interface AirCargoResolutionInputs {
  cargoDice: number | null
  targetFriendlyAtPhaseStart: boolean
  gliderLanding: boolean
  optionalTerrainDrm: number
  enemyCombatUnitInTarget: boolean
  unloadCargoIds: string[] | null
}
export function createAirCargoResolutionDomain(ports: {
  state(): AirInteractionState | null
  rng(): RngState
  inputs(): AirCargoResolutionInputs
  facts(): {
    closedTerrain: boolean
    baseLevel: number
    isAirstrip: boolean
    usedT: number
    overLimitAircraftInactive: boolean
  }
  lossPending(): boolean
  roster(): ReturnType<typeof airMissionRoster>
  unitExists(cargoId: string): boolean
  draw2d6(): number
  accept<T>(outcome: RuleOutcome<T>, action: string): T | null
  commit(state: AirInteractionState, result: AirCargoResolution, plan: AirCargoUnloadPlan): boolean
  pushLog(kind: 'info' | 'success' | 'warning' | 'danger', text: string, rule?: string): void
  record(input: {
    action: string
    rule: string
    rolls: DiceRoll[]
    data: Record<string, unknown>
  }): boolean
}) {
  const receipt = ref<AirCargoUnloadPlan | null>(null)
  function reset(): void {
    receipt.value = null
  }
  function resolveAirCargoNow(): boolean {
    const state = ports.state()
    if (state === null) return false
    if (state.cargo !== null) return true
    if (ports.lossPending()) {
      ports.pushLog('warning', '先处理防空造成的超容货损，再结算货物', '14.4g')
      return false
    }
    if (
      state.step !== 'resolveMission' ||
      (state.kind !== 'air_transport' && state.kind !== 'air_drop')
    ) {
      ports.pushLog('warning', '货物只能在空运/空投任务F步结算', '14.2f-F')
      return false
    }
    if (state.assignment.cargo.some((item) => item.kind === 'unit' && !ports.unitExists(item.id))) {
      ports.pushLog('warning', '载货单位已不存在，不能提交不完整的结算', '14.9a')
      return false
    }
    const inputs = ports.inputs(),
      facts = ports.facts()
    const continuation = ports.accept(
      planAirCargoContinuation(
        state.assignment.cargo,
        ports.roster(),
        state.flak?.hit === true,
        state.assignment.cargoByAircraft,
      ),
      '承运状态',
    )
    if (continuation === null) {
      ports.pushLog(
        'warning',
        '承运机已中止或运力不足；请整组返航，部分货物分流需要先明确分机货单',
        '14.9a',
      )
      return false
    }
    const returnOnly = continuation.returnOnly
    /*
     * 14.9a / 14.9e（T14）：被摧毁承运机的货物是确定损失 —— 先从本次结算中剔除，
     * 作为 `destroyed` 结果交给同一提交入口结清；其余货物才进入投送/卸载判定。
     * 同一件货物只会在这两处之一出现，不会重复结算。
     */
    const lostIds = new Set(continuation.lostCargoIds)
    const lostCargoIds = continuation.lostCargoIds
    const lostItems = lostCargoIds.map((id) => {
      const item = state.assignment.cargo.find((entry) => entry.id === id)
      return {
        id,
        kind: item?.kind ?? ('sp' as const),
        die2d6: null,
        modified: null,
        threshold: null,
        success: false,
        fate: 'destroyed' as const,
        detail: `${id}：承运机被毁 ⇒ 货物损失（14.9a / 14.9e）`,
      }
    })
    const activeCargo = state.assignment.cargo.filter((item) => !lostIds.has(item.id))
    const rngBefore = ports.rng()
    const dice =
      state.kind === 'air_drop' && !returnOnly
        ? activeCargo.map(() => inputs.cargoDice ?? ports.draw2d6())
        : []
    const rolls: DiceRoll[] = []
    if (inputs.cargoDice === null) {
      let cursor = rngBefore
      for (let i = 0; i < dice.length; i += 1) {
        const draw = roll2d6(cursor)
        cursor = draw.rng
        rolls.push(draw.value)
      }
    }
    const result = ports.accept(
      state.kind === 'air_transport' || returnOnly
        ? resolveAirTransportDelivery(activeCargo)
        : resolveAirCargoDrop({
            cargo: activeCargo,
            side: state.side,
            friendlyAtPhaseStart: inputs.targetFriendlyAtPhaseStart,
            closedTerrain: facts.closedTerrain,
            glider: inputs.gliderLanding,
            optionalTerrainDrm: inputs.optionalTerrainDrm,
            enemyCombatUnitInHex: inputs.enemyCombatUnitInTarget,
            dice,
          }),
      '货物结算',
    )
    if (result === null) return false
    const placed = new Set(
      result.items.filter((item) => item.fate === 'placed').map((item) => item.id),
    )
    const plan = ports.accept(
      planAirCargoUnload({
        ...facts,
        kind: returnOnly ? 'air_transport' : state.kind,
        cargo: activeCargo.filter((item) => placed.has(item.id)),
        selectedIds: returnOnly ? [] : inputs.unloadCargoIds,
        // 14.9f（T15）：按逐机货单定位承运超额部分的那几架。
        cargoByAircraft: state.assignment.cargoByAircraft,
      }),
      '卸载计划',
    )
    if (plan === null) {
      ports.pushLog(
        'warning',
        '请勾选本次卸下的完整货物；选择总量不能超过剩余卸载限额，未选货物保留退运',
        '14.9f',
      )
      return false
    }
    const resolved = applyAirCargoUnloadResult(result, plan)
    const final: AirCargoResolution = {
      ...resolved,
      items: [...lostItems, ...resolved.items],
      detail:
        lostCargoIds.length === 0
          ? resolved.detail
          : `${resolved.detail}；承运机被毁致 ${String(lostCargoIds.length)} 件货物损失（14.9e）`,
    }
    // 全部判定成功后只经过这一个盘面提交入口；先失败的预览不改单位、库存或账本。
    if (!ports.commit(state, final, plan)) {
      ports.pushLog('warning', '任务状态已变化，请重新检查货物结算', '14.2f-F')
      return false
    }
    receipt.value = plan
    ports.pushLog(plan.refusedT > 0 ? 'warning' : 'info', plan.detail, plan.rule)
    for (const item of final.items)
      ports.pushLog(item.fate === 'placed' ? 'info' : 'warning', item.detail, final.rule)
    ports.record({
      action: 'airCargo',
      rule: final.rule,
      rolls,
      data: {
        kind: state.kind,
        items: final.items.map((item) => ({ id: item.id, fate: item.fate, detail: item.detail })),
        unload: plan,
        detail: final.detail,
      },
    })
    return true
  }
  return { receipt, reset, resolveAirCargoNow }
}
