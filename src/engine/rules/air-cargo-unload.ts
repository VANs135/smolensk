import { fail, succeed, type RuleOutcome } from '../result-types'
import { planAirUnload } from './air'
import { airCargoTransportT, type AirCargoLoadView } from './air-cargo'
import type { AirCargoResolution } from './air-interaction'
import type { HexRef } from '@/data'
import { sameHex } from '../hex-geometry'

export interface AirCargoUnloadPlan {
  deliveredIds: string[]
  refusedIds: string[]
  deliveredT: number
  refusedT: number
  deliveredSpT: number
  consumedT: number
  requiresDestinationStay: boolean
  /**
   * 14.9f（T15）：因 14.9f 例外而必须留在目的地的**具体运输机**。
   * 只含承运「超额部分」货物的飞机，不再把整组运输机一刀切留场。
   */
  stayAircraftIds: string[]
  rule: string
  detail: string
}

/** 14.9f：SP与不可拆分的单位共用卸载限额；需要玩家选择时不擅自选货。 */
export function planAirCargoUnload(input: {
  kind: 'air_transport' | 'air_drop'
  cargo: readonly AirCargoLoadView[]
  baseLevel: number
  isAirstrip: boolean
  usedT: number
  overLimitAircraftInactive: boolean
  selectedIds: readonly string[] | null
  /** 14.9a/14.9e（T15）：逐机货单，用于确定超额货物由哪几架承运。 */
  cargoByAircraft?: readonly { aircraftId: string; cargoIds: readonly string[] }[]
}): RuleOutcome<AirCargoUnloadPlan> {
  const cargo = input.cargo
  const ids = new Set(cargo.map((item) => item.id))
  if (ids.size !== cargo.length) return fail('14.9f', 'duplicateUnloadCargo')
  const sizes = cargo.map(airCargoTransportT)
  if (sizes.some((size) => !Number.isFinite(size) || size <= 0))
    return fail('14.9f', 'invalidUnloadCargoSize')
  const totalT = sizes.reduce((sum, size) => sum + size, 0)
  const budget = planAirUnload({ ...input, cargoT: totalT })
  if (!budget.ok) return budget
  let chosen: Set<string>
  if (input.kind === 'air_drop') chosen = ids
  else if (input.selectedIds !== null) {
    if (
      new Set(input.selectedIds).size !== input.selectedIds.length ||
      input.selectedIds.some((id) => !ids.has(id))
    )
      return fail('14.9f', 'invalidUnloadSelection')
    chosen = new Set(input.selectedIds)
  } else if (budget.data.refusedT === 0) chosen = ids
  else {
    if (cargo.some((item) => item.kind === 'unit'))
      return fail('14.9f', 'airUnloadSelectionRequired')
    chosen = new Set<string>()
    let remaining = budget.data.allowedT
    for (const [index, item] of cargo.entries()) {
      if (sizes[index]! <= remaining) {
        chosen.add(item.id)
        remaining -= sizes[index]!
      }
    }
  }
  const delivered = cargo.filter((item) => chosen.has(item.id))
  const deliveredT = delivered.reduce((sum, item) => sum + airCargoTransportT(item), 0)
  if (deliveredT > budget.data.allowedT) return fail('14.9f', 'selectedCargoExceedsUnloadLimit')
  const remainingLimit =
    budget.data.limitT === null ? null : Math.max(0, budget.data.limitT - input.usedT)
  const requiresDestinationStay =
    input.kind === 'air_transport' && remainingLimit !== null && deliveredT > remainingLimit
  /*
   * 14.9f（T15）：超额部分对应的运输机在目的地变非活跃。
   * 按卸货顺序累计；某件货物使累计超过限额时，该件（不可拆）及其后的货物都算超额部分，
   * 由承运它们的飞机留场，其余飞机仍可正常返航。
   */
  const overLimitIds = new Set<string>()
  if (requiresDestinationStay && remainingLimit !== null) {
    let cumulative = 0
    for (const item of delivered) {
      const size = airCargoTransportT(item)
      if (cumulative >= remainingLimit || cumulative + size > remainingLimit)
        overLimitIds.add(item.id)
      cumulative += size
    }
  }
  const stayAircraftIds =
    overLimitIds.size === 0
      ? []
      : input.cargoByAircraft === undefined
        ? []
        : [
            ...new Set(
              input.cargoByAircraft
                .filter((entry) => entry.cargoIds.some((id) => overLimitIds.has(id)))
                .map((entry) => entry.aircraftId),
            ),
          ]
  return succeed(budget.rule, {
    deliveredIds: delivered.map((item) => item.id),
    refusedIds: cargo.filter((item) => !chosen.has(item.id)).map((item) => item.id),
    deliveredT,
    refusedT: totalT - deliveredT,
    deliveredSpT: delivered
      .filter((item) => item.kind === 'sp')
      .reduce((sum, item) => sum + airCargoTransportT(item), 0),
    consumedT: input.kind === 'air_transport' ? deliveredT : 0,
    requiresDestinationStay,
    stayAircraftIds,
    rule: budget.rule,
    detail: `本次卸载 ${deliveredT} T；${totalT - deliveredT} T不能卸载，保留退运（${budget.rule}）`,
  })
}

/** 14.9f：14.9f 例外留场的运输机，返航选择不能再把它们带离目的地。 */
export function validateAirCargoReturns(input: {
  /** 14.9f（T15）：精确留场名单；给出时优先于旧的全组判据。 */
  stayAircraftIds?: readonly string[]
  requiresStay?: boolean
  transportIds?: readonly string[]
  targetHex: HexRef
  returns: readonly { aircraftId: string; baseHex: HexRef }[]
}): RuleOutcome<{ ok: true }> {
  const stayAircraftIds =
    input.stayAircraftIds ?? (input.requiresStay === true ? (input.transportIds ?? []) : [])
  if (
    stayAircraftIds.some((aircraftId) => {
      const entry = input.returns.find((item) => item.aircraftId === aircraftId)
      return entry !== undefined && !sameHex(entry.baseHex, input.targetHex)
    })
  )
    return fail('14.9f', 'overLimitTransportMustStayAtTarget')
  return succeed('14.9f', { ok: true })
}

/** 将未卸货物明确标成留存，不能伪装为已送达或按空投失败摧毁。 */
export function applyAirCargoUnloadResult(
  result: AirCargoResolution,
  plan: AirCargoUnloadPlan,
): AirCargoResolution {
  const refused = new Set(plan.refusedIds)
  return {
    ...result,
    items: result.items.map((item) =>
      refused.has(item.id)
        ? {
            ...item,
            fate: 'retained',
            success: false,
            detail: `${item.id}：未卸载，保留退运（14.9f）`,
          }
        : item,
    ),
    detail: `${result.detail}；${plan.detail}`,
  }
}
