import { ref } from 'vue'
import type { HexRef, Side } from '@/data'
import {
  settleAirSupply,
  type AirSupplyFate,
  type AirSupplyLoadPlan,
  type AirSupplyManifest,
} from '@/engine/rules/air-supply'

/** 14.9：任务在途SP的唯一账本；存档只允许在该任务完成后进行。 */
export function createAirSupplyDomain(ports: {
  returnSupply(origin: HexRef, side: Side, t: number): void
}) {
  const manifest = ref<AirSupplyManifest | null>(null)
  function load(plan: AirSupplyLoadPlan): void {
    manifest.value = plan.manifest
  }
  function settle(ids: readonly string[], fate: Exclude<AirSupplyFate, 'aboard'>): void {
    if (manifest.value !== null) manifest.value = settleAirSupply(manifest.value, ids, fate)
  }
  function returnRemaining(destination?: HexRef): void {
    const current = manifest.value
    if (current === null) return
    const ids = current.items.filter((item) => item.fate === 'aboard').map((item) => item.id)
    if (ids.length === 0) return
    ports.returnSupply(destination ?? current.origin, current.side, ids.length)
    settle(ids, 'returned')
  }
  function reset(): void {
    manifest.value = null
  }
  return { manifest, load, settle, returnRemaining, reset }
}
