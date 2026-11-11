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
  /**
   * 14.9（T16）：`fromOffMapBox` 非空时把 SP 加回离图盒库存，否则加到地图格。
   */
  returnSupply(origin: HexRef, side: Side, t: number, fromOffMapBox?: string): void
}) {
  const manifest = ref<AirSupplyManifest | null>(null)
  function load(plan: AirSupplyLoadPlan): void {
    manifest.value = plan.manifest
  }
  function settle(ids: readonly string[], fate: Exclude<AirSupplyFate, 'aboard'>): void {
    if (manifest.value !== null) manifest.value = settleAirSupply(manifest.value, ids, fate)
  }
  function returnRemaining(
    destination?: HexRef,
    ids?: readonly string[],
    /**
     * `undefined`：按任务来源（离图盒任务回盒）；
     * `null`：**强制回地图格**（混合来源任务里从图上机场起飞的机体用）；
     * 字符串：回指定离图盒。
     */
    offMapBox?: string | null,
  ): void {
    const current = manifest.value
    if (current === null) return
    const selected = ids === undefined ? null : new Set(ids)
    const returning = current.items.filter(
      (item) => item.fate === 'aboard' && (selected === null || selected.has(item.id)),
    )
    if (returning.length === 0) return
    const box = offMapBox === undefined ? current.originOffMapBox : (offMapBox ?? undefined)
    ports.returnSupply(destination ?? current.origin, current.side, returning.length, box)
    settle(
      returning.map((item) => item.id),
      'returned',
    )
  }
  function reset(): void {
    manifest.value = null
  }
  return { manifest, load, settle, returnRemaining, reset }
}
