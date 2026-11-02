import type { HexRef, Side } from '@/data'
import { sameHex } from '../hex-geometry'
import { fail, succeed, type RuleOutcome } from '../result-types'
import { holdingsToT, tToHoldings, type SpHoldings } from './supply-interaction'

export interface AirSupplySource extends SpHoldings {
  id: string
  hex: HexRef
  side: Side
  carriedBy?: string
}
export type AirSupplyFate = 'aboard' | 'delivered' | 'lost' | 'returned'
export interface AirSupplyManifest {
  side: Side
  origin: HexRef
  items: { id: string; sourceId: string; fate: AirSupplyFate }[]
}
export interface AirSupplyLoadPlan {
  manifest: AirSupplyManifest | null
  debits: { id: string; after: SpHoldings }[]
}

/** 12.1a / 14.9a：地图基地装载实际SP。校验成功前不修改库存、不掷骰。 */
export function planAirSupplyLoad(input: {
  side: Side
  requestedT: number
  origins: readonly { hex: HexRef; offMap: boolean }[]
  sources: readonly AirSupplySource[]
}): RuleOutcome<AirSupplyLoadPlan> {
  const { requestedT, side, origins } = input
  if (!Number.isSafeInteger(requestedT) || requestedT < 0)
    return fail('12.1a / 14.9a', 'invalidAirSupplyQuantity')
  if (requestedT === 0) return succeed('14.9a', { manifest: null, debits: [] })
  const first = origins[0]
  if (first === undefined) return fail('14.9a', 'airSupplyOriginMissing')
  if (origins.some((origin) => origin.offMap))
    return fail('14.9a', 'airSupplyOffMapSourceUnavailable')
  // 合并运输容量须在同一基地；多基地分装须先有逐机货单，不能跨基地自动拿货。
  if (origins.some((origin) => !sameHex(origin.hex, first.hex)))
    return fail('14.9a', 'airSupplyRequiresSingleOrigin')
  const sources = input.sources.filter(
    (source) =>
      source.side === side && source.carriedBy === undefined && sameHex(source.hex, first.hex),
  )
  if (new Set(sources.map((source) => source.id)).size !== sources.length)
    return fail('12.1a', 'duplicateAirSupplySource')
  if (
    sources.some(
      (source) =>
        !Number.isSafeInteger(source.sp) ||
        source.sp < 0 ||
        !Number.isSafeInteger(source.t) ||
        source.t < 0,
    )
  )
    return fail('12.1a', 'invalidAirSupplyStock')
  if (sources.reduce((sum, source) => sum + holdingsToT(source), 0) < requestedT)
    return fail('14.9a', 'airSupplyStockInsufficient')
  let remaining = requestedT
  const items: AirSupplyManifest['items'] = []
  const debits: AirSupplyLoadPlan['debits'] = []
  for (const source of sources) {
    if (remaining === 0) break
    const stock = holdingsToT(source)
    const taken = Math.min(remaining, stock)
    if (taken === 0) continue
    debits.push({ id: source.id, after: tToHoldings(stock - taken) })
    for (let index = 0; index < taken; index += 1)
      items.push({ id: `sp:${items.length + 1}`, sourceId: source.id, fate: 'aboard' })
    remaining -= taken
  }
  return succeed('14.9a', {
    manifest: { side, origin: { ...first.hex }, items },
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
