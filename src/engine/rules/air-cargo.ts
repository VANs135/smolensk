import type { HexRef, Side } from '@/data'
import { sameHex } from '../hex-geometry'
import { fail, succeed, type RuleOutcome } from '../result-types'
import { transportEquivalentOf } from './rail'
import { SP_TO_T } from './supply'
import type { MobilityType } from './terrain'

/** 14.9c：可空运单位的移动面步行MA上限。 */
export const CARGO_UNIT_MAX_WALKING_MA = 10

/** 6.1g / 14.9d：只允许把当前尚未完成移动的单位交接给它自身的空运。 */
export function checkAirTransportMovementHandoff(input: {
  cargoUnitIds: readonly string[]
  movingUnitIds: readonly string[]
}): RuleOutcome<{ detachMovement: boolean }> {
  if (input.cargoUnitIds.length === 0) return succeed('14.9d', { detachMovement: false })
  const cargoIds = new Set(input.cargoUnitIds)
  if (input.movingUnitIds.some((id) => !cargoIds.has(id)))
    return fail('6.1g', 'finishOtherGroundMovementBeforeAirTransport')
  return succeed('6.1g / 14.9d', { detachMovement: input.movingUnitIds.length > 0 })
}

export interface AirCargoLoadView {
  id: string
  kind: 'sp' | 'unit'
  t?: number
  re?: number
  mobility?: MobilityType
  /** 移动面的印刷MA（4.7b / 14.9c），不能使用战斗面的MA。 */
  ma?: number
  side?: Side
  sourceHex?: HexRef
  isCombat?: boolean
}

/** 4.7a/b / 14.9a：单位与SP使用同一T计量；不在这里进行损失取整。 */
export function airCargoTransportT(cargo: AirCargoLoadView): number {
  if (cargo.kind === 'sp') return cargo.t ?? NaN
  if (cargo.mobility === undefined) return NaN
  return (
    transportEquivalentOf({
      kind: 'unit',
      re: cargo.re ?? NaN,
      mobility: cargo.mobility,
      moveMa: cargo.ma ?? NaN,
    }) * SP_TO_T
  )
}

/** 14.9c / 4.7：只判单位自身资格；归属、基地、模式和实际运力由各自入口核对。 */
export function isAirTransportableUnit(item: AirCargoLoadView): boolean {
  const sizeT = airCargoTransportT(item)
  return (
    item.kind === 'unit' &&
    item.isCombat === true &&
    item.mobility === 'leg' &&
    item.ma !== undefined &&
    Number.isFinite(item.ma) &&
    item.ma >= 0 &&
    item.ma <= CARGO_UNIT_MAX_WALKING_MA &&
    Number.isFinite(sizeT) &&
    sizeT > 0
  )
}

/** 14.9a/c：核对货物真实归属、起点与每个基地的可用运输容量。 */
export function checkAirCargoLoad(input: {
  side: Side
  cargo: readonly AirCargoLoadView[]
  origins: readonly { hex: HexRef; capacityT: number; offMap: boolean }[]
}): RuleOutcome<{ loadedT: number }> {
  const { cargo, origins, side } = input
  if (new Set(cargo.map((item) => item.id)).size !== cargo.length)
    return fail('14.9a', 'duplicateAirCargo')
  let loadedT = 0
  for (const item of cargo) {
    if (item.kind === 'unit') {
      if (!isAirTransportableUnit(item))
        return fail('14.9c', `cargoUnitNotAirTransportable:${item.id}`)
      if (item.side !== side) return fail('14.9c', `cargoUnitNotFriendly:${item.id}`)
      if (
        item.sourceHex === undefined ||
        !origins.some(
          (origin) =>
            !origin.offMap && origin.capacityT > 0 && sameHex(origin.hex, item.sourceHex!),
        )
      )
        return fail('14.9a', `cargoUnitNotAtOrigin:${item.id}`)
    }
    const amount = airCargoTransportT(item)
    if (!Number.isFinite(amount) || amount <= 0)
      return fail('4.7 / 14.9a', `invalidAirCargoSize:${item.id}`)
    loadedT += amount
  }
  // 各基地只能合并本基地飞机的运力，不可借另一基地的闲置运力搬走单位。
  for (const item of cargo) {
    if (item.kind !== 'unit' || item.sourceHex === undefined) continue
    const originHex = item.sourceHex
    const localCargoT = cargo
      .filter(
        (other) =>
          other.kind === 'unit' &&
          other.sourceHex !== undefined &&
          sameHex(other.sourceHex, originHex),
      )
      .reduce((sum, other) => sum + airCargoTransportT(other), 0)
    const localCapacityT = origins
      .filter((origin) => !origin.offMap && sameHex(origin.hex, originHex))
      .reduce((sum, origin) => sum + origin.capacityT, 0)
    if (localCargoT > localCapacityT) return fail('14.9a', `cargoExceedsOriginCapacity:${item.id}`)
  }
  return succeed('4.7 / 14.9a', { loadedT })
}
