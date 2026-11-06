import type { HexRef, Side } from '@/data'
import { sameHex } from '../hex-geometry'
import { fail, succeed, type RuleOutcome } from '../result-types'
import { holdingsToT, tToHoldings, type SpHoldings } from './supply-interaction'

export interface AirSupplySource extends SpHoldings {
  id: string
  /** 地图内起点；离图盒来源（`offMap: true`）不带地图格。 */
  hex?: HexRef
  side: Side
  carriedBy?: string
  /** 14.9（T16）：来源是图外空军盒，库存由 `offMapSupplyStocks` 记账。 */
  offMap?: boolean
  /** 14.9（T16）：离图盒标识（`${side}:${box}` 的 box 部分）。 */
  box?: string
}
/** 14.9（T15）：一个装载起点及其需求 T；多起点时每项应带 `requestedT`。 */
export interface AirSupplyOrigin {
  hex?: HexRef
  offMap: boolean
  requestedT?: number
  /** 14.9（T16）：离图盒标识。 */
  box?: string
}
export type AirSupplyFate = 'aboard' | 'delivered' | 'lost' | 'returned'
export interface AirSupplyManifest {
  side: Side
  /** 兼容旧调用：首个装货起点（离图盒任务用占位格）。 */
  origin: HexRef
  /** 14.9（T15）：本次实际使用的全部起点。 */
  origins?: AirSupplyOrigin[]
  /** 14.9（T16）：起点全部/部分为离图盒时的盒标识。 */
  originOffMapBox?: string
  items: { id: string; sourceId: string; fate: AirSupplyFate }[]
}
export interface AirSupplyLoadPlan {
  manifest: AirSupplyManifest | null
  debits: {
    id: string
    after: SpHoldings
    side?: Side
    offMap?: boolean
    box?: string
  }[]
}

/**
 * 12.1a / 14.9a / 14.9（T15/T16）：装载实际 SP。
 *
 * 逐机货单确定每架机从**自己的起点**装多少 T；这里按起点分别校验并从同格（或同一离图盒）
 * 库存扣账。校验成功前不修改库存、不掷骰。
 */
export function planAirSupplyLoad(input: {
  side: Side
  requestedT: number
  origins: readonly AirSupplyOrigin[]
  sources: readonly AirSupplySource[]
}): RuleOutcome<AirSupplyLoadPlan> {
  const { side, origins } = input
  if (origins.length === 0) return fail('14.9a', 'airSupplyOriginMissing')
  if (
    origins.some(
      (origin) => !Number.isSafeInteger(origin.requestedT) && origin.requestedT !== undefined,
    )
  )
    return fail('14.9a', 'invalidAirSupplyQuantity')

  /*
   * 14.9（T15）：多起点按请求量相加；同格/同盒的多个起点合并为一次扣账，
   * 否则同一份库存会被两个重复起点各算一次。
   */
  const merged: { key: string; origin: AirSupplyOrigin; requestedT: number }[] = []
  const explicitPerOrigin = origins.some((origin) => origin.requestedT !== undefined)
  if (explicitPerOrigin && origins.some((origin) => origin.requestedT === undefined))
    return fail('14.9a', 'invalidAirSupplyQuantity')
  for (const [index, origin] of origins.entries()) {
    if (origin.offMap && origin.hex !== undefined) return fail('14.9a', 'airSupplyOriginAmbiguous')
    if (origin.offMap && typeof origin.box !== 'string')
      return fail('14.9a', 'airSupplyOffMapBoxMissing')
    if (!origin.offMap && origin.hex === undefined)
      return fail('14.9a', 'airSupplyOriginHexMissing')
    const requested = explicitPerOrigin
      ? (origin.requestedT ?? 0)
      : index === 0
        ? input.requestedT
        : 0
    if (!Number.isSafeInteger(requested) || requested < 0)
      return fail('12.1a / 14.9a', 'invalidAirSupplyQuantity')
    const key = origin.offMap
      ? `box:${origin.box ?? ''}`
      : `hex:${String(origin.hex!.col)},${String(origin.hex!.row)}`
    const existing = merged.find((entry) => entry.key === key)
    if (existing === undefined) merged.push({ key, origin: { ...origin }, requestedT: requested })
    else existing.requestedT += requested
  }
  const requestedT = merged.reduce((sum, entry) => sum + entry.requestedT, 0)
  if (requestedT === 0) return succeed('14.9a', { manifest: null, debits: [] })

  const eligible = input.sources.filter(
    (source) => source.side === side && source.carriedBy === undefined,
  )
  if (new Set(eligible.map((source) => source.id)).size !== eligible.length)
    return fail('12.1a', 'duplicateAirSupplySource')
  if (
    eligible.some(
      (source) =>
        !Number.isSafeInteger(source.sp) ||
        source.sp < 0 ||
        !Number.isSafeInteger(source.t) ||
        source.t < 0,
    )
  )
    return fail('12.1a', 'invalidAirSupplyStock')

  const items: AirSupplyManifest['items'] = []
  const debits: AirSupplyLoadPlan['debits'] = []
  for (const entry of merged) {
    if (entry.requestedT === 0) continue
    const origin = entry.origin
    const sources = eligible.filter((source) =>
      origin.offMap
        ? source.offMap === true && source.box === origin.box
        : source.offMap !== true &&
          source.hex !== undefined &&
          origin.hex !== undefined &&
          sameHex(source.hex, origin.hex),
    )
    // 14.9（T15）：每个起点只从**该起点格/该离图盒**的库存扣，不能借用异地或敌方库存。
    if (sources.reduce((sum, source) => sum + holdingsToT(source), 0) < entry.requestedT)
      return fail('14.9a', 'airSupplyStockInsufficient')
    let remaining = entry.requestedT
    for (const source of sources) {
      if (remaining === 0) break
      const stock = holdingsToT(source)
      const taken = Math.min(remaining, stock)
      if (taken === 0) continue
      debits.push({
        id: source.id,
        after: tToHoldings(stock - taken),
        ...(origin.offMap ? { side: source.side, offMap: true, box: origin.box } : {}),
      })
      for (let index = 0; index < taken; index += 1)
        items.push({ id: `sp:${items.length + 1}`, sourceId: source.id, fate: 'aboard' })
      remaining -= taken
    }
  }
  const first = merged[0]!.origin
  return succeed('14.9a', {
    manifest: {
      side,
      origin: first.offMap ? { col: 0, row: 0 } : { ...first.hex! },
      origins: merged.map((entry) => ({ ...entry.origin, requestedT: entry.requestedT })),
      ...(merged.some((entry) => entry.origin.offMap)
        ? { originOffMapBox: merged.find((entry) => entry.origin.offMap)?.origin.box }
        : {}),
      items,
    },
    debits,
  })
}

/** 14.4g / 14.9 / 14.10d：每1T只允许从在途变成一种最终去向，重试不重复结算。 */
export function settleAirSupply(
  manifest: AirSupplyManifest,
  ids: readonly string[],
  fate: Exclude<AirSupplyFate, 'aboard'>,
): AirSupplyManifest {
  const selected = new Set(ids)
  return {
    ...manifest,
    items: manifest.items.map((item) =>
      item.fate === 'aboard' && selected.has(item.id) ? { ...item, fate } : item,
    ),
  }
}
