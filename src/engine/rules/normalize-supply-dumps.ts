import type { HexRef, Side } from '@/data'
import { sameHex } from '../hex-geometry'
import type { PanzerGroup } from './panzer-groups'
import { holdingsToT, tToHoldings } from './supply-interaction'

/** 12.1b/3.4b：恢复时同格同方同归属归并，并把归属待办迁移到保留的ID。 */
export function normalizeSupplyDumps<
  T extends { id: string; side: Side; hex: HexRef; sp: number; t: number },
>(dumps: readonly T[], groups: Readonly<Record<string, PanzerGroup>>, pending: readonly string[]) {
  const kept: T[] = []
  const aliases = new Map<string, string>()
  for (const dump of dumps) {
    const group = dump.side === 'axis' ? (groups[dump.id] ?? null) : null
    const first = kept.find(
      (item) =>
        item.side === dump.side &&
        sameHex(item.hex, dump.hex) &&
        (item.side === 'axis' ? (groups[item.id] ?? null) : null) === group,
    )
    if (first === undefined) {
      kept.push({ ...dump, hex: { ...dump.hex } })
      aliases.set(dump.id, dump.id)
    } else {
      const amount = tToHoldings(holdingsToT(first) + holdingsToT(dump))
      first.sp = amount.sp
      first.t = amount.t
      aliases.set(dump.id, first.id)
    }
  }
  const liveAxis = new Set(kept.filter((dump) => dump.side === 'axis').map((dump) => dump.id))
  const normalizedGroups = Object.fromEntries(
    Object.entries(groups).filter(([id]) => liveAxis.has(id)),
  )
  const normalizedPending = [...new Set(pending.map((id) => aliases.get(id) ?? id))].filter(
    (id) => liveAxis.has(id) && normalizedGroups[id] === undefined,
  )
  return {
    dumps: kept,
    groups: normalizedGroups,
    pending: normalizedPending,
    aliases: Object.fromEntries(aliases),
    merged: dumps.length - kept.length,
  }
}
