import { computed, shallowRef } from 'vue'
import type { HexRef } from '@/data'
import { sameHex } from '@/engine/hex-geometry'
import { fail, succeed, type RuleOutcome } from '@/engine/result-types'
import type { AirMissionCargo } from '@/engine/rules'
import type { ConsoleUnit } from './workbench-model'

export type AirUnitTransitFate = 'aboard' | 'delivered' | 'returned' | 'lost'

export interface AirUnitTransitLoadPlan {
  readonly items: readonly {
    readonly cargoId: string
    readonly unit: ConsoleUnit
    readonly sourceHex: HexRef
  }[]
}

interface AirUnitTransitEntry {
  cargoId: string
  unit: ConsoleUnit
  sourceHex: HexRef
  fate: AirUnitTransitFate
}

/** 14.9 / 14.10：装载后由在途域持有单位；只有落地或退运才重新进入地图。 */
export function createAirUnitTransitDomain(ports: {
  units(): readonly ConsoleUnit[]
  removeFromMap(ids: readonly string[]): void
  addToMap(unit: ConsoleUnit): void
}) {
  // 保留原单位对象，不能把模式、移动消耗或其他状态另造一份后遗漏回写。
  const entries = shallowRef<AirUnitTransitEntry[]>([])
  const plans = new WeakMap<AirUnitTransitLoadPlan, number>()
  let generation = 0
  const manifest = computed(() =>
    Object.freeze(
      entries.value.map((entry) =>
        Object.freeze({
          cargoId: entry.cargoId,
          unitId: entry.unit.instanceId,
          name: entry.unit.name,
          sourceHex: Object.freeze({ ...entry.sourceHex }),
          fate: entry.fate,
        }),
      ),
    ),
  )

  function hasAboardUnits(): boolean {
    return entries.value.some((entry) => entry.fate === 'aboard')
  }

  function prepare(cargo: readonly AirMissionCargo[]): RuleOutcome<AirUnitTransitLoadPlan> {
    if (hasAboardUnits()) return fail('14.9a', 'airUnitCargoAlreadyLoaded')
    const items: AirUnitTransitLoadPlan['items'][number][] = []
    const ids = new Set<string>()
    for (const item of cargo) {
      if (item.kind !== 'unit') continue
      if (!item.id.startsWith('unit:') || item.id.length === 'unit:'.length)
        return fail('14.9a', 'invalidAirCargoUnitId')
      const unitId = item.id.slice('unit:'.length)
      if (ids.has(unitId)) return fail('14.9a', 'duplicateAirCargoUnit')
      ids.add(unitId)
      const matches = ports.units().filter((unit) => unit.instanceId === unitId)
      if (matches.length !== 1) return fail('14.9a', `cargoUnitMissingOrDuplicated:${unitId}`)
      const unit = matches[0]!
      items.push(
        Object.freeze({ cargoId: item.id, unit, sourceHex: Object.freeze({ ...unit.hex }) }),
      )
    }
    const plan: AirUnitTransitLoadPlan = Object.freeze({ items: Object.freeze(items) })
    plans.set(plan, generation)
    return succeed('14.9a', plan)
  }

  function load(plan: AirUnitTransitLoadPlan): boolean {
    if (plans.get(plan) !== generation || hasAboardUnits()) return false
    const board = ports.units()
    if (
      new Set(plan.items.map((item) => item.unit.instanceId)).size !== plan.items.length ||
      plan.items.some((item) => {
        const matches = board.filter((unit) => unit.instanceId === item.unit.instanceId)
        return (
          matches.length !== 1 ||
          matches[0] !== item.unit ||
          !sameHex(item.unit.hex, item.sourceHex)
        )
      })
    )
      return false
    if (plan.items.length > 0) ports.removeFromMap(plan.items.map((item) => item.unit.instanceId))
    entries.value = plan.items.map((item) => ({
      cargoId: item.cargoId,
      unit: item.unit,
      sourceHex: { ...item.sourceHex },
      fate: 'aboard',
    }))
    generation += 1
    return true
  }

  function find(cargoId: string): ConsoleUnit | undefined {
    return entries.value.find((entry) => entry.cargoId === cargoId && entry.fate === 'aboard')?.unit
  }

  function selectedAboard(ids: readonly string[]): AirUnitTransitEntry[] | null {
    if (new Set(ids).size !== ids.length) return null
    const selected = ids.map((id) =>
      entries.value.find((entry) => entry.cargoId === id && entry.fate === 'aboard'),
    )
    if (selected.some((entry) => entry === undefined)) return null
    return selected.filter((entry): entry is AirUnitTransitEntry => entry !== undefined)
  }

  function canLand(ids: readonly string[]): boolean {
    const selected = selectedAboard(ids)
    return (
      selected !== null &&
      selected.every(
        (entry) => !ports.units().some((unit) => unit.instanceId === entry.unit.instanceId),
      )
    )
  }

  function land(ids: readonly string[], hex: HexRef, fate: 'delivered' | 'returned'): boolean {
    if (!canLand(ids)) return false
    const selected = selectedAboard(ids)!
    for (const entry of selected) {
      entry.unit.hex = { ...hex }
      ports.addToMap(entry.unit)
    }
    const selectedIds = new Set(ids)
    entries.value = entries.value.map((entry) =>
      selectedIds.has(entry.cargoId) ? { ...entry, fate } : entry,
    )
    return true
  }

  function lose(ids: readonly string[]): ConsoleUnit[] | null {
    const selected = selectedAboard(ids)
    if (selected === null) return null
    const selectedIds = new Set(ids)
    entries.value = entries.value.map((entry) =>
      selectedIds.has(entry.cargoId) ? { ...entry, fate: 'lost' } : entry,
    )
    return selected.map((entry) => entry.unit)
  }

  /** 全盘重置/读档时丢弃任务账本；常规取消不能调用此入口遗失在途单位。 */
  function reset(): void {
    entries.value = []
    generation += 1
  }

  return { manifest, prepare, load, find, canLand, land, lose, reset }
}
